"""Display-only WCS alignment and wavelength-matched time sequences."""

import hashlib
import json
import math
import time
from collections.abc import Callable
from collections import deque
from concurrent.futures import ThreadPoolExecutor, wait
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from queue import Queue

import astropy.units as u
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
from PIL import Image
from reproject import reproject_interp

from .archive import Archive, ArchiveError, Observation
from .config import Settings
from .exposure_cache import CachedExposure, ExposureCache
from .pixel_quality import SOURCE_BIT, PixelQuality, PixelState
from .schemas import Frame, Manifest, Query, Sequence
from .visits import field_visits
from .spectral import spectral_wcs
from .transfers import CutoutQueue, PriorityLoads

PIPELINE_VERSION = "3.0.0"
# Quantitative samples retain the conservative mask independently of display policy.
BAD_BITS = np.uint64(0xFFFFFFFFFFFFFFFF ^ SOURCE_BIT)


@dataclass
class Cutout:
    observation: Observation
    data: np.ndarray
    valid: np.ndarray
    wcs: WCS
    wavelengths: np.ndarray
    bandwidths: np.ndarray
    version: str
    source: str
    metadata: dict | None = None
    flag_names: dict | None = None
    quality: PixelQuality | None = None


def decode(path: Path, obs: Observation, query: Query, source: str) -> Cutout:
    with fits.open(path, memmap=False, lazy_load_hdus=True) as hdus:
        image = hdus["IMAGE"]
        shape = (image.header.get("NAXIS2", 0), image.header.get("NAXIS1", 0))
        if image.header.get("NAXIS") != 2 or min(shape) < 2 or max(shape) > 512:
            raise ValueError("Cutout image dimensions are outside supported limits")
        for name in ("FLAGS", "VARIANCE"):
            h = hdus[name].header
            if (h.get("NAXIS2"), h.get("NAXIS1")) != shape:
                raise ValueError("Quality/variance geometry does not match the cutout")
        unit = u.Unit(image.header.get("BUNIT", ""))
        if not unit.is_equivalent(u.MJy / u.sr):
            raise ValueError("Cutout has unsupported brightness units")
        data = np.asarray(image.data, dtype=np.float64) * unit.to(u.MJy / u.sr)
        flags = np.asarray(hdus["FLAGS"].data)
        variance = np.asarray(hdus["VARIANCE"].data)
        if not np.issubdtype(flags.dtype, np.integer):
            raise ValueError("Quality flags must be an integer bitmask")
        valid = (
            np.isfinite(data)
            & np.isfinite(variance)
            & (variance > 0)
            & ((flags.astype(np.uint64) & BAD_BITS) == 0)
        )
        quality = PixelQuality.from_detector(data, flags, variance)
        wcs = WCS(image.header).celestial
        for name in ("FLAGS", "VARIANCE"):
            other_wcs = WCS(hdus[name].header).celestial
            if not other_wcs.has_celestial or not wcs.wcs.compare(other_wcs.wcs):
                raise ValueError("Quality/variance sky grid differs from IMAGE")
            if (wcs.sip is None) != (other_wcs.sip is None) or (
                wcs.sip is not None
                and not all(
                    np.array_equal(getattr(wcs.sip, key), getattr(other_wcs.sip, key))
                    for key in ("a", "b", "ap", "bp", "crpix")
                )
            ):
                raise ValueError("Quality/variance distortion differs from IMAGE")
        coord = SkyCoord(query.ra_deg * u.deg, query.dec_deg * u.deg, frame="icrs")
        # Match spectral response at the target and four points within the field.
        # A wavelength match at the center alone is not sufficient for field blinking.
        positions = [coord] + [
            coord.spherical_offsets_by(x * query.fov_arcsec / 300 * u.arcmin, y * query.fov_arcsec / 300 * u.arcmin)
            for x, y in [(-1.5, -1.5), (-1.5, 1.5), (1.5, -1.5), (1.5, 1.5)]
        ]
        pixels = [wcs.world_to_pixel(c) for c in positions]
        if not (0 <= pixels[0][0] < shape[1] and 0 <= pixels[0][1] < shape[0]):
            raise ValueError(
                "Exposure does not cover the target"
            )
        spectral = spectral_wcs(image.header, hdus)
        waves, bands = [], []
        for x, y in pixels:
            if not (0 <= x < shape[1] and 0 <= y < shape[0]):
                waves.append(float("nan"))
                bands.append(float("nan"))
                continue
            wave, band = spectral.pixel_to_world(x, y)
            waves.append(float(wave.to_value(u.um)))
            bands.append(float(band.to_value(u.um)))
        waves, bands = np.array(waves), np.array(bands)
        if (
            not np.isfinite(waves[0])
            or not np.isfinite(bands[0])
            or np.any(bands <= 0)
        ):
            raise ValueError("Cutout spectral WCS is invalid")
        yy, xx = np.indices(shape)
        wave_grid, band_grid = spectral.pixel_to_world(xx, yy)
        quality.spectral = np.stack([wave_grid.to_value(u.um), band_grid.to_value(u.um)]).astype("<f4")
        return Cutout(
            obs,
            data,
            valid.copy(),
            wcs,
            waves,
            bands,
            str(hdus[0].header.get("VERSION", "unknown")),
            source,
            {k: image.header[k] for k in image.header
             if k in ("L1DQAFLG", "L2DQAFLG", "SPS_FLAGS", "NON_SURVEY", "PXSRCMSK",
                      "SPS_EPA", "SPS_PA_ECL", "SPS_TARGET", "OBSID") or k.startswith("L2 N_")},
            {int(k[4:]): str(hdus["FLAGS"].header[k]) for k in hdus["FLAGS"].header
             if k.startswith("MSKN") and k[4:].isdigit()},
            quality,
        )


def compatible(a: Cutout, b: Cutout, tolerance: float) -> bool:
    return same_channel(a, b, a.version, b.version, tolerance)


def same_channel(a, b, first_version: str, second_version: str, tolerance: float) -> bool:
    return (
        a.observation.detector == b.observation.detector
        and first_version == second_version
        and first_version != "unknown"
        and bool(
            np.all(
                np.abs(a.wavelengths - b.wavelengths)
                <= tolerance * np.minimum(a.bandwidths, b.bandwidths)
            )
        )
    )


def choose_group(cutouts: list[Cutout], tolerance: float) -> list[Cutout]:
    best = []
    # A group is pairwise compatible, not just compatible with its first frame.
    for seed in cutouts:
        group = [seed]
        for c in sorted(
            cutouts, key=lambda c: abs(c.wavelengths[0] - seed.wavelengths[0])
        ):
            if c is not seed and all(compatible(c, old, tolerance) for old in group):
                group.append(c)

        def score(g):
            return (
                (
                    len(g),
                    max(c.observation.mjd for c in g)
                    - min(c.observation.mjd for c in g),
                )
                if g
                else (0, 0)
            )

        if score(group) > score(best):
            best = group
    return sorted(best, key=lambda c: c.observation.mjd)


def target_grid(query: Query) -> tuple[WCS, tuple[int, int]]:
    scale = 6.14 / 3600
    n = math.ceil(query.fov_arcsec / 3600 / scale)
    w = WCS(naxis=2)
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.crval = [query.ra_deg, query.dec_deg]
    w.wcs.cdelt = [-scale, scale]
    w.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    w.wcs.radesys = "ICRS"
    return w, (n, n)


def align(cutout: Cutout, grid: WCS, shape: tuple[int, int]) -> np.ndarray:
    image, footprint = reproject_interp(
        (np.where(cutout.valid, cutout.data, 0), cutout.wcs),
        grid,
        shape_out=shape,
        order="bilinear",
        roundtrip_coords=True,
    )
    support, _ = reproject_interp(
        (cutout.valid.astype(float), cutout.wcs),
        grid,
        shape_out=shape,
        order="bilinear",
    )
    image[(footprint < 0.999) | (support < 0.999) | ~np.isfinite(support)] = np.nan
    return image


def render_pngs(
    arrays: list[np.ndarray], paths: list[Path], quality: list[PixelQuality | None] | None = None,
    *, stretch: dict | None = None,
) -> dict:
    if quality is not None:
        arrays = [q.display_values(a) if q is not None else a for a, q in zip(arrays, quality, strict=True)]
    arrays = [np.where(a >= 0, a, np.nan) for a in arrays]
    samples = np.concatenate([a[np.isfinite(a)] for a in arrays])
    # An overflow-only field has markers but no measured values for a stretch.
    if stretch:
        low, high = stretch["vmin"], stretch["vmax"]
    else:
        low, high = np.percentile(samples, [1, 99.5]) if samples.size else (0.0, 1.0)
    if high <= low:
        high = low + max(abs(low) * 1e-6, 1e-6)
    for index, (array, path) in enumerate(zip(arrays, paths, strict=True)):
        visible = np.isfinite(array)
        if quality is not None and quality[index] is not None:
            q = quality[index]
            maximum = np.isnan(q.values) & ((q.flags & (1 << 1)) != 0)
            if maximum.any():
                reference = np.max(array[visible]) if visible.any() else high
                array = np.where(maximum, reference, array)
                visible |= maximum
        values = np.clip((np.nan_to_num(array, nan=low) - low) / (high - low), 0, 1)
        grey = np.round(np.arcsinh(10 * values) / np.arcsinh(10) * 255).astype(np.uint8)
        rgba = np.dstack([grey, grey, grey, visible.astype(np.uint8) * 255])
        # WCS numpy row zero is south; PNG row zero is top (north).
        Image.fromarray(np.flipud(rgba)).save(path, format="PNG")
    return {"vmin": float(low), "vmax": float(high), "asinh_a": 0.1, "units": "MJy/sr"}


def atomic_json(path: Path, value: dict):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, indent=2, allow_nan=False), encoding="utf-8")
    temp.replace(path)


Timing = Callable[[str, float, str | None, str], None]


@contextmanager
def timed(timing: Timing | None, stage: str, observation: str | None = None):
    start = time.monotonic()
    outcome = "ok"
    try:
        yield
    except Exception:
        outcome = "error"
        raise
    finally:
        if timing:
            timing(stage, time.monotonic() - start, observation, outcome)


def assign_sequence(frame: Frame, existing: list[Frame], sequences: list[Sequence], tolerance: float):
    """Extend a sequence only when every member agrees at all five field samples."""
    def matches(other):
        if len(other.match_wavelengths) != 5 or len(other.match_bandwidths) != 5:
            return False
        waves = np.asarray(frame.match_wavelengths, dtype=float)
        other_waves = np.asarray(other.match_wavelengths, dtype=float)
        widths = np.minimum(np.asarray(frame.match_bandwidths, dtype=float),
                            np.asarray(other.match_bandwidths, dtype=float))
        return np.all(np.abs(waves - other_waves) <= tolerance * widths)

    sequence = next((s for s in sequences
                     if frame.processing_version != "unknown"
                     and s.detector == frame.detector and s.processing_version == frame.processing_version
                     and all(matches(f) for f in existing if f.sequence_id == s.id)), None)
    if sequence is None:
        key = hashlib.sha256(frame.observation_id.encode()).hexdigest()[:24]
        sequence = Sequence(id="sequence-" + key, detector=frame.detector,
                            wavelength_um=frame.wavelength_um, processing_version=frame.processing_version)
        sequences.append(sequence)
    frame.sequence_id = sequence.id
    frame.channel = f"{sequence.detector} {sequence.wavelength_um:.6f} µm ({sequence.processing_version})"
    sequence.frame_ids.append(frame.id)
    return sequence


def update_counts(manifest):
    manifest.processing["counts"] = {
        status: sum(o.status == status for o in manifest.observations)
        for status in ("pending", "loading", "ready", "failed")
    }


def product_stem(obs: Observation) -> str:
    # A previous manifest can still be in flight when a better revision arrives.
    key = json.dumps([obs.identity, obs.uri]).encode()
    return "frame-" + hashlib.sha256(key).hexdigest()[:24]


def materialize(e: CachedExposure, directory: Path, job_id: str, stem: str, preview: bool):
    pixels = f"{stem}.bin"
    quality_file = f"{stem}-quality.bin" if e.quality is not None else None
    png = f"{stem}-preview.png" if preview else f"{stem}.png"
    np.flipud(e.array).astype("<f4").tofile(directory / pixels)
    if e.quality is not None:
        (directory / quality_file).write_bytes(e.quality.to_bytes())
    spectral_file = None
    if e.quality is not None and e.quality.spectral is not None:
        spectral_file = f"{stem}-spectral.bin"
        np.flip(e.quality.spectral, axis=1).astype("<f4").tofile(directory / spectral_file)
    if preview:
        render_pngs([e.array], [directory / png], [e.quality] if e.quality is not None else None)
    e.frame = e.frame.model_copy(update={
        "id": f"{stem}.png", "url": f"/api/assets/{job_id}/{png}", "pixels": pixels,
        "quality": quality_file, "spectral": spectral_file,
    })


def frame_metadata(c: Cutout, quality: PixelQuality) -> Frame:
    return Frame(
        id="", url="", observation_id=c.observation.identity,
        observed_at=Time(c.observation.mjd, format="mjd", scale="utc")
        .to_datetime(timezone=UTC)
        .isoformat(),
        detector=c.observation.detector,
        wavelength_um=float(c.wavelengths[0]),
        bandwidth_um=float(c.bandwidths[0]),
        release=c.observation.release,
        source_url=c.source,
        processing_version=c.version,
        exposure_flags=c.metadata or {},
        flag_names=c.flag_names or {},
        mask_fraction=float(np.mean(~((np.isfinite(quality.values) & (quality.values >= 0))
                                      | (np.isnan(quality.values) & ((quality.flags & 2) != 0))))),
        match_wavelengths=[float(v) if np.isfinite(v) else None for v in c.wavelengths],
        match_bandwidths=[float(v) if np.isfinite(v) else None for v in c.bandwidths],
        warnings=["Display preview; no PSF/background matching or photometric inference."],
    )


class Pipeline:
    def __init__(self, settings: Settings, archive: Archive):
        self.settings, self.archive = settings, archive
        self.exposure_cache = ExposureCache(settings, PIPELINE_VERSION, quality_mask=int(BAD_BITS))
        self.transfers = CutoutQueue(min(settings.cutout_workers, 2))

    def run(self, query: Query, directory: Path, job_id: str, report: Callable[[str], None],
            *, publish: Callable[[Manifest], None] | None = None, timing: Timing | None = None, priority=None):
        return _FrameJob(self, query, directory, job_id, report, publish, timing, priority).run()


    def load(self, manifest, ids, directory, job_id, report, *, publish=None, timing=None, channels=None, priority=None):
        job = _FrameJob(self, manifest.query, directory, job_id, report, publish, timing, priority)
        job.result = manifest.model_copy(deep=True)
        job.result.cached = False
        job.result.omissions = [item for item in job.result.omissions if item.get("observation_id") not in ids]
        records = {r.id: r for r in job.result.observations}
        rows = [Observation(r.id, r.source_url, float(Time(datetime.fromisoformat(r.observed_at)).mjd),
                            r.detector, r.release) for r in (records[key] for key in ids)]
        job.batch(rows, extra_channels=channels)
        return job.finalize()


class _FrameJob:
    """The job thread publishes snapshots while catalog and transfer threads report results."""

    def __init__(self, pipeline, query, directory, job_id, report, publish, timing, priority=None):
        self.settings, self.archive, self.cache = pipeline.settings, pipeline.archive, pipeline.exposure_cache
        self.query, self.directory, self.job_id = query, directory, job_id
        self.report, self.publish, self.timing = report, publish, timing
        self.progressive = publish is not None
        self.transfers = pipeline.transfers
        self.priority = priority or PriorityLoads()
        self.batch_records = set()
        self.early_metadata = {}
        self.alloc_index = 0
        self.deadline = time.monotonic() + self.settings.job_seconds
        self.download_deadline = self.deadline - min(10, self.settings.job_seconds / 4)
        self.accepted: dict[str, CachedExposure] = {}
        self.fresh: set[tuple[str, str]] = set()
        self.grid, self.shape = target_grid(query)
        self.result = Manifest(
            retrieved_at=datetime.now(UTC).isoformat(),
            query=query,
            processing={
                "version": PIPELINE_VERSION,
                "batch_size": self.settings.batch_size,
                "revision": 0,
                "archive_products": {},
                "archive_complete": False,
                "spectral_tolerance": self.settings.spectral_tolerance,
                "flag_policy": "Display archived nonnegative finite readings regardless of flags. "
                               "Quantitative .bin samples still use positive variance and no flags except SOURCE.",
                "zodi_subtracted": False,
                "grid_header": dict(self.grid.to_header()),
                "output_shape": list(self.shape),
                "psf_matched": False,
            },
        )
    def ordered(self):
        return sorted(self.accepted.values(), key=lambda e: (e.observation.mjd, e.observation.identity))

    def refresh_records(self, frames):
        catalog = {r.id: r.source_url for r in self.result.observations}
        available = {}
        for frame in frames:
            entry = self.accepted.get(frame.observation_id)
            product = entry.observation.uri if entry else frame.source_url.partition("?")[0]
            if product == catalog.get(frame.observation_id):
                available[frame.observation_id] = frame
        failures = {o["observation_id"]: o["reason"] for o in self.result.omissions}
        for record in self.result.observations:
            frame = available.get(record.id)
            if frame is not None:
                record.status, record.frame_id, record.reason = "ready", frame.id, None
            elif record.id in failures:
                record.status, record.frame_id, record.reason = "failed", None, failures[record.id]
            elif record.id in self.batch_records:
                record.status, record.frame_id, record.reason = "loading", None, None
            elif record.selection == "unavailable":
                record.status, record.frame_id = "pending", None
            else:
                record.status, record.frame_id, record.reason = "pending", None, None
        self.result.visits = field_visits(self.result, list(available.values()))
        update_counts(self.result)

    def grouped(self):
        frames = list(self.result.frames)
        sequences = [s.model_copy(deep=True) for s in self.result.sequences]
        for entry in self.ordered():
            f = entry.frame.model_copy(deep=True)
            assign_sequence(f, frames, sequences, self.settings.spectral_tolerance)
            frames.append(f)
        frames.sort(key=lambda f: (f.observed_at, f.observation_id))
        return frames, sequences

    def snapshot(self):
        if self.progressive:
            frames, sequences = self.grouped()
            self.refresh_records(frames)
            self.result.processing["revision"] += 1
            self.publish(self.result.model_copy(update={
                "frames": frames, "sequences": sequences,
                "stretch": "asinh (individual preview scales while loading)",
            }, deep=True))

    def install(self, entry):
        if self.query.live:
            stem = product_stem(entry.observation)
        else:
            # A cancelled batch may leave unpublished files or published previews.
            # Never allocate an existing basename to another observation.
            while True:
                stem = f"frame-{self.alloc_index:02}"
                self.alloc_index += 1
                if not (self.directory / f"{stem}.bin").exists() and not (self.directory / f"{stem}.png").exists():
                    break
        # Older cache rows store the five samples beside the frame metadata.
        entry.frame.match_wavelengths = [float(v) if np.isfinite(v) else None for v in entry.wavelengths]
        entry.frame.match_bandwidths = [float(v) if np.isfinite(v) else None for v in entry.bandwidths]
        with timed(self.timing, "write_assets", entry.observation.identity):
            materialize(entry, self.directory, self.job_id, stem, self.progressive)
        self.accepted[entry.observation.identity] = entry

    def retrieve(self, obs):
        path = self.directory / (product_stem(obs) + ".fits")
        try:
            self.report("fetch")
            with timed(self.timing, "cutout_download", obs.identity):
                if time.monotonic() >= self.download_deadline:
                    raise ArchiveError("Search time limit reached")
                kwargs = (
                    {"timing": self.timing, "on_wait": lambda: self.report("fetch")}
                    if isinstance(self.archive, Archive) else {}
                )
                source = self.archive.fetch(obs, self.query, path, self.download_deadline, **kwargs)
            with timed(self.timing, "fits_decode", obs.identity):
                return decode(path, obs, self.query, source)
        finally:
            path.unlink(missing_ok=True)

    def submit_transfer(self, obs):
        return self.transfers.submit(self.retrieve, obs)

    def accept(self, c):
        obs = c.observation
        with timed(self.timing, "align", obs.identity):
            if time.monotonic() > self.deadline:
                raise ValueError("Job deadline reached")
            array = align(c, self.grid, self.shape)
            if c.quality is None:
                raise ValueError("Missing detector quality information")
            quality = c.quality.align(c.wcs, self.grid, self.shape)
            if not np.any(quality.states != PixelState.OUTSIDE):
                raise ValueError("No common-grid coverage")
        entry = CachedExposure(obs, frame_metadata(c, quality), array, c.wavelengths, c.bandwidths, quality)
        self.install(entry)
        self.snapshot()
        if self.query.live:
            self.fresh.add((obs.identity, obs.uri))
            self.cache.store(self.query, obs, entry.frame, array, entry.wavelengths, entry.bandwidths, quality)

    def catalog(self, on_candidate=None):
        with timed(self.timing, "metadata_search"):
            if isinstance(self.archive, Archive) and self.query.live:
                return self.archive.search(self.query, self.deadline, on_candidate=on_candidate, timing=self.timing)
            return self.archive.search(self.query, self.deadline)

    def resolve(self, rows, notes):
        complete = not any(w.startswith("Partial metadata:") for w in notes)
        by_id = {o.identity: o for o in rows}
        if not complete:
            # A failed collection lookup cannot establish that a preferred product was withdrawn.
            for entry in self.accepted.values():
                obs = entry.observation
                listed = by_id.get(obs.identity)
                if listed is None or Archive._version_key(obs) > Archive._version_key(listed):
                    by_id[obs.identity] = obs
        rows = list(by_id.values())
        self.result.processing.update(refreshing_cache=False, archive_complete=complete,
                                      archive_products={o.identity: o.uri for o in rows})
        rows.sort(key=lambda o: (o.mjd, o.identity))
        self.result.discovery_complete = complete
        self.result.observations = [o.record() for o in rows]
        indexed = self.cache.field_index(self.query) if self.query.live else {}
        eligible = []
        known_matches = set()
        for obs, record in zip(rows, self.result.observations, strict=True):
            cached = indexed.get((obs.identity, obs.uri))
            if not cached and obs.detector in self.query.channels and isinstance(self.archive, Archive):
                cached = self.archive.cached_spectral(obs.uri, self.query)
            if cached:
                record.set_spectral(cached)
            record.selection = record.band_match(self.query)
            if record.selection != "excluded":
                eligible.append(obs)
                if record.selection == "matched":
                    known_matches.add(obs.identity)
        if self.query.live:
            limit = min(self.settings.max_candidates, self.settings.max_frames)
            if self.query.detectors is None:
                selected = Archive.candidates(eligible, limit)
            else:
                # Finish requested measurements within a well-covered field visit first.
                # The frontend can extend it in bounded batches before moving to another.
                visits = field_visits(self.result, [])
                by_id = {obs.identity: obs for obs in eligible}
                available_detectors = {r.id: r.detector for r in self.result.observations}
                ranked = sorted(visits, key=lambda v: (
                    v.kind == "cycle" and v.status != "invalid",
                    len({available_detectors[i] for i in v.observation_ids}), v.start_utc
                ), reverse=True)
                selected = []
                # A confirmed wavelength in an older cycle can yield an image while
                # newer exposures still need metadata. Preserve visit ranking within each pass.
                for confirmed in (True, False):
                    for visit in ranked:
                        group = [by_id[i] for i in visit.observation_ids
                                 if i in by_id and (i in known_matches) == confirmed]
                        selected.extend(Archive.candidates(group, limit - len(selected)))
                        if len(selected) >= limit:
                            break
                    if len(selected) >= limit:
                        break
        else:
            detectors = [f"D{i}" for i in range(1, 7)]
            detector = max(detectors, key=lambda d: sum(o.detector == d for o in rows))
            selected = ([o for o in eligible if o.detector == detector] if self.query.detectors is None
                        else eligible)[:min(self.settings.batch_size, self.settings.max_frames)]
        self.result.warnings.extend(notes)
        if len(selected) < len(rows):
            self.result.warnings.append(
                f"Processing {len(selected)} of {len(rows)} distinct exposures "
                "in the initial batch. Use the observation catalog to load additional frames."
            )
        return rows, selected, complete

    def restore(self, obs):
        existing = self.accepted.get(obs.identity)
        if existing and existing.observation.uri == obs.uri:
            return True
        hit = self.cache.get(self.query, obs)
        if hit is None:
            return False
        self.install(hit)
        return True

    def confirm(self, obs, record, extra_channels=None):
        """Verify the search selection and any narrower load request before opening a cutout."""
        record.selection = record.band_match(self.query)
        if record.selection == "excluded":
            return False
        narrower = self.query.model_copy(update={"channels": extra_channels}) if extra_channels else None
        if record.selection == "unknown" or (narrower and record.band_match(narrower) == "unknown"):
            probe = getattr(self.archive, "probe_spectral", None)
            existing = self.early_metadata.pop(obs, None)
            if existing is not None:
                info = existing.result()
            else:
                info = probe(obs, self.query, self.download_deadline) if probe else None
            if not info:
                record.selection = "unavailable"
                record.reason = "Wavelength metadata unavailable. Retry to check this exposure."
                return False
            record.set_spectral(info)
            record.selection = record.band_match(self.query)
        record.reason = None
        return record.selection == "matched" and (not narrower or record.band_match(narrower) == "matched")

    def live(self, pool):
        search_started = time.time()
        with timed(self.timing, "cache_load"):
            for hit in self.cache.load(self.query):
                self.install(hit)
        warm = bool(self.accepted)
        if warm:
            self.result.cached = True
            self.result.processing["refreshing_cache"] = True
            self.snapshot()

        events, candidates = Queue(), deque()
        early_obs, early_future, early_error = None, None, None
        probe, probing = None, None
        checked = {}

        def start_early(obs):
            nonlocal early_obs, early_future
            early_obs = obs
            if self.restore(obs):
                self.snapshot()
            else:
                early_future = self.submit_transfer(obs)
                early_future.add_done_callback(events.put)

        with ThreadPoolExecutor(max_workers=1) as metadata:
            lookup = metadata.submit(self.catalog, None if warm else events.put)
            lookup.add_done_callback(events.put)
            while not lookup.done():
                event = events.get()
                if event is lookup:
                    break
                if event is early_future:
                    try:
                        self.accept(event.result())
                    except (ArchiveError, ValueError, KeyError, OSError) as exc:
                        early_error = str(exc)
                elif event is probe:
                    record = probing.record()
                    if self.confirm(probing, record) and early_obs is None:
                        start_early(probing)
                    checked[probing] = record
                    probe = None
                elif early_obs is None and not warm:
                    record = event.record()
                    if event.detector in self.query.channels:
                        cached = self.archive.cached_spectral(event.uri, self.query)
                        if cached:
                            record.set_spectral(cached)
                    match = record.band_match(self.query)
                    if match == "matched":
                        start_early(event)
                    elif match == "unknown":
                        candidates.append(event)
                if early_obs is None and not probe and candidates:
                    probing = candidates.popleft()
                    probe = pool.submit(self.archive.probe_spectral, probing, self.query, self.download_deadline)
                    self.early_metadata[probing] = probe
                    probe.add_done_callback(events.put)
            try:
                rows, notes = lookup.result()
            except ArchiveError as exc:
                if not self.accepted and early_future is None:
                    raise
                rows = [early_obs] if early_obs else []
                notes = [f"Partial metadata: archive refresh unavailable. {exc}"]
                self.result.processing["cache_fallback"] = warm

        rows, selected, complete = self.resolve(rows, notes)
        for obs, record in zip(rows, self.result.observations, strict=True):
            if obs in checked:
                old = checked[obs]
                record.selection, record.reason = old.selection, old.reason
                record.channel, record.wavelength_um, record.bandwidth_um = old.channel, old.wavelength_um, old.bandwidth_um
        selected = [obs for obs in selected if obs not in checked or checked[obs].selection == "matched"]
        # Catalog consumers can browse or prioritize records immediately, even when
        # every candidate still needs a wavelength check and the image cache is cold.
        self.snapshot()
        self.cache.reconcile(self.query, rows, complete, as_of=search_started)
        if early_obs in rows and early_obs not in selected:
            selected = [early_obs, *selected][:min(self.settings.max_candidates, self.settings.max_frames)]
        if early_future is not None and early_obs not in selected:
            early_future.cancel()
        targets = {o.identity: o.uri for o in selected}
        old_ids = set(self.accepted)
        # Keep a published revision visible until its replacement has usable assets.
        self.accepted = {k: e for k, e in self.accepted.items() if k in targets}
        if warm or set(self.accepted) != old_ids:
            self.snapshot()
        self.batch(selected, early=(early_obs, early_future, early_error))
        current = {o.identity: o.uri for o in rows}
        valid = {k: e for k, e in self.accepted.items() if e.observation.uri == current.get(k)}
        if len(valid) < len(self.accepted):
            self.accepted = valid
            self.snapshot()
        if self.query.channels and not self.accepted:
            self.find_first_subband(rows, selected)
        self.result.cached = bool(self.accepted) and not any(
            (e.observation.identity, e.observation.uri) in self.fresh for e in self.accepted.values()
        )
        return bool(selected)

    def find_first_subband(self, rows, attempted):
        """A bounded initial image allowance should count transfers, not metadata misses."""
        records = {r.id: r for r in self.result.observations}
        used = {o.identity for o in attempted}
        cycles = {v.id for v in self.result.visits if v.kind == "cycle" and v.status != "invalid"}
        eligible = (o for o in rows if o.identity not in used and records[o.identity].status == "pending"
                    and records[o.identity].selection in ("matched", "unknown"))
        remaining = deque(sorted(eligible, key=lambda o: (
            records[o.identity].selection != "matched", records[o.identity].visit_id not in cycles, -o.mjd,
        )))
        limit = min(self.settings.max_candidates, self.settings.max_frames)
        while remaining and not self.accepted and time.monotonic() < self.download_deadline:
            slots = limit - len(self.result.omissions)
            if slots <= 0:
                break
            count = min(slots, self.settings.batch_size, len(remaining))
            self.batch([remaining.popleft() for _ in range(count)])

    def omit(self, obs, exc):
        self.result.omissions.append({"observation_id": obs.identity, "reason": str(exc)[:200]})

    def batch(self, selected, early=(None, None, None), extra_channels=None):
        # Only this coordinator materializes assets and publishes manifests. Workers
        # confirm the search selection on a private record before any full download.
        records = {r.id: r for r in self.result.observations}
        existing = {f.observation_id for f in self.result.frames}
        early_obs, early_future, early_error = early
        early_used = False
        self.batch_records.clear()
        pending = {}
        clicked = set()
        checking = set()
        completed = 0
        events = Queue()
        # A click on an unindexed wavelength can be confirmed while both image
        # transfers are still active. The eventual worker shares this probe.
        priority_probes = ThreadPoolExecutor(max_workers=1, thread_name_prefix="priority-wavelength")

        def probe_clicked(obs, record):
            if record.band_match(self.query) == "unknown" and obs not in self.early_metadata:
                probe = getattr(self.archive, "probe_spectral", None)
                if probe:
                    self.early_metadata[obs] = priority_probes.submit(probe, obs, self.query, self.download_deadline)

        def retrieve_match(obs, record, channels):
            self.report("fetch")
            with self.priority.lock:
                checking.add(obs.identity)
                narrowed = None if obs.identity in clicked else channels
            if not self.confirm(obs, record, narrowed):
                if not (channels and obs.identity in clicked and record.selection == "matched"):
                    return None
            events.put((obs.identity, None))
            if self.query.live:
                cached = self.cache.get(self.query, obs)
                if cached is not None:
                    return cached
            return self.retrieve(obs)

        def submit(obs, priority=False):
            nonlocal early_used
            key = obs.identity
            if key in existing or (key in self.accepted and self.accepted[key].observation.uri == obs.uri):
                return
            if priority:
                clicked.add(key)
            if key in pending:
                if priority:
                    future, record, original = pending[key]
                    if key not in checking and future is not early_future:
                        probe_clicked(original, record)
                    self.transfers.promote(future)
                return
            if len(existing | self.accepted.keys() | pending.keys() | {key}) > self.settings.max_frames:
                if not priority:
                    return
                # Release a reserved background place, leaving active workers alone.
                for other in reversed(pending):
                    if pending[other][0].cancel():
                        del pending[other]
                        break
                else:
                    raise ValueError("This field reached the loaded-image limit")
            record = records[key].model_copy()
            reuse_early = (not early_used and early_obs and obs.uri == early_obs.uri
                           and key == early_obs.identity and early_future is not None)
            if reuse_early and not (early_error and priority):
                early_used = True
                if early_error:
                    self.omit(obs, early_error)
                    return
                future = early_future
            else:
                if priority:
                    probe_clicked(obs, record)
                future = self.transfers.submit(retrieve_match, obs, record,
                                               None if priority else extra_channels, priority=priority)
            pending[key] = (future, record, obs)
            future.add_done_callback(lambda done: events.put((key, done)))

        def prioritize(key):
            record = records.get(key)
            if record is None or record.selection == "excluded":
                return
            obs = Observation(key, record.source_url, float(Time(datetime.fromisoformat(record.observed_at)).mjd),
                              record.detector, record.release)
            submit(obs, priority=True)

        try:
            with self.priority.lock:
                self.priority.dispatch = prioritize
                for key in self.priority.take_waiting():
                    prioritize(key)
                for obs in selected:
                    submit(obs)
            while True:
                with self.priority.lock:
                    if not pending:
                        self.priority.dispatch = None
                        break
                key, future = events.get()
                if future is None:
                    self.batch_records.add(key)
                    self.snapshot()
                    continue
                with self.priority.lock:
                    entry = pending.get(key)
                    total = completed + len(pending)
                if not entry or entry[0] is not future:
                    continue
                completed += 1
                self.report(f"fetch:{completed}/{total}")
                _, checked, obs = entry
                self.batch_records.discard(key)
                record = records[key]
                record.selection, record.reason = checked.selection, checked.reason
                record.channel, record.bandwidth_um = checked.channel, checked.bandwidth_um
                record.wavelength_um = checked.wavelength_um
                self.result.omissions = [o for o in self.result.omissions if o.get("observation_id") != key]
                publish_outcome = False
                try:
                    value = future.result()
                    if isinstance(value, CachedExposure):
                        self.install(value)
                        self.snapshot()
                    elif value is not None:
                        self.accept(value)
                    else:
                        publish_outcome = True
                except (ArchiveError, ValueError, KeyError, OSError) as exc:
                    self.omit(obs, exc)
                    publish_outcome = True
                with self.priority.lock:
                    del pending[key]
                    checking.discard(key)
                # A newly visible Retry must enqueue fresh work even if the user
                # clicks it as soon as the polling thread receives the publication.
                if publish_outcome:
                    self.snapshot()
            self.report("align")
        finally:
            with self.priority.lock:
                self.priority.dispatch = None
                unfinished = [entry[0] for entry in pending.values()]
            if early_future is not None:
                unfinished.append(early_future)
            wait([future for future in unfinished if not future.cancel() and not future.done()])
            priority_probes.shutdown(wait=True, cancel_futures=True)

    def run(self):
        self.report("query")
        with ThreadPoolExecutor(max_workers=self.settings.cutout_workers) as pool:
            if self.query.live:
                self.live(pool)
            else:
                rows, notes = self.catalog()
                _, selected, _ = self.resolve(rows, notes)
                self.batch(selected)
        return self.finalize()

    def finalize(self):
        self.report("render")
        result = self.result
        with timed(self.timing, "finalize"):
            frames, sequences = self.grouped()
            by_id = {e.frame.id: e for e in self.accepted.values()}
            for sequence in sequences:
                # Resume a cancelled batch from its immutable preview and saved numeric planes.
                pending = [f for f in frames if f.sequence_id == sequence.id and (
                    f.id in by_id or (f.pixels and f.url.rsplit("/", 1)[-1] != f.id)
                )]
                if not pending:
                    continue
                arrays, quality = [], []
                for frame in pending:
                    entry = by_id.get(frame.id)
                    if entry is not None:
                        array, flags = entry.array, entry.quality
                    else:
                        array = np.flipud(np.fromfile(self.directory / frame.pixels, dtype="<f4").reshape(self.shape))
                        flags = (PixelQuality.from_bytes((self.directory / frame.quality).read_bytes(), self.shape)
                                 if frame.quality else None)
                    arrays.append(array)
                    quality.append(flags)
                sequence.stretch = render_pngs(
                    arrays, [self.directory / f.id for f in pending], quality,
                    stretch=sequence.stretch,
                )
                for frame in pending:
                    frame.url = f"/api/assets/{self.job_id}/{frame.id}"
            result.frames, result.sequences = frames, sequences
            self.refresh_records(frames)
            result.processing["revision"] += 1
            if len(sequences) == 1:
                result.processing["stretch"] = sequences[0].stretch
            else:
                result.processing.pop("stretch", None)
            result.retrieved_at = datetime.now(UTC).isoformat()
            result.warnings = [w for w in result.warnings if not (
                w.startswith("No wavelength channel") or w.startswith("Fewer than two compatible")
                or "candidate exposure(s) omitted" in w)]
            if result.omissions:
                result.warnings.append(f"{len(result.omissions)} candidate exposure(s) omitted; see the manifest for reasons.")
            if not any(len(s.frame_ids) >= 2 for s in sequences):
                result.warnings.append(
                    "No wavelength channel has two usable exposures for a time comparison."
                    if self.query.live else "Fewer than two compatible frames; motion playback is unavailable."
                )
            for warning in (
                "Wavelength groups match the detector, processing version and spectral response at five field positions within half the narrower bandwidth.",
                "NaN overflow uses the maximum measured nonnegative brightness in the field, or a high-end display marker when none exists. Archived readings and flags are retained.",
            ):
                if warning not in result.warnings:
                    result.warnings.append(warning)
            atomic_json(self.directory / "manifest.json", result.model_dump(mode="json"))
        return result
