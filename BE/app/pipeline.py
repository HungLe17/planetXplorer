"""Display-only WCS alignment and wavelength-matched time sequences."""

import hashlib
import json
import math
import time
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
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

from .archive import Archive, ArchiveError, Observation, evenly_spaced
from .config import Settings
from .exposure_cache import CachedExposure, ExposureCache
from .pixel_quality import SOURCE_BIT, PixelQuality, PixelState
from .schemas import Frame, Manifest, Query

PIPELINE_VERSION = "2.0.0"
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
        if any(not (0 <= x < shape[1] and 0 <= y < shape[0]) for x, y in pixels):
            raise ValueError(
                "Exposure does not cover the target and interior field samples"
            )
        spectral_header = image.header.copy()
        # SIP describes celestial distortion, not the alternate spectral table WCS.
        import re

        for key in list(spectral_header):
            if re.fullmatch(r"(A|B|AP|BP)_(ORDER|DMAX|\d+_\d+)", key):
                del spectral_header[key]
        spectral = WCS(spectral_header, fobj=hdus, key="W")
        spectral.sip = None
        waves, bands = [], []
        for x, y in pixels:
            wave, band = spectral.pixel_to_world(x, y)
            waves.append(float(wave.to_value(u.um)))
            bands.append(float(band.to_value(u.um)))
        waves, bands = np.array(waves), np.array(bands)
        if (
            not np.all(np.isfinite(waves))
            or not np.all(np.isfinite(bands))
            or np.any(bands <= 0)
        ):
            raise ValueError("Cutout spectral WCS is invalid")
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
             if k in ("L1DQAFLG", "L2DQAFLG", "SPS_FLAGS", "NON_SURVEY", "PXSRCMSK") or k.startswith("L2 N_")},
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
    arrays: list[np.ndarray], paths: list[Path], quality: list[PixelQuality] | None = None
) -> dict:
    if quality is not None:
        arrays = [q.display_values(a) for a, q in zip(arrays, quality, strict=True)]
    samples = np.concatenate([a[np.isfinite(a)] for a in arrays])
    # An overflow-only field has markers but no measured values for a stretch.
    low, high = np.percentile(samples, [1, 99.5]) if samples.size else (0.0, 1.0)
    if high <= low:
        high = low + max(abs(low) * 1e-6, 1e-6)
    for index, (array, path) in enumerate(zip(arrays, paths, strict=True)):
        values = np.clip((np.nan_to_num(array, nan=low) - low) / (high - low), 0, 1)
        grey = np.round(np.arcsinh(10 * values) / np.arcsinh(10) * 255).astype(np.uint8)
        visible = np.isfinite(array)
        if quality is not None:
            maximum = quality[index].states == PixelState.OVERFLOW_MAX
            grey[maximum] = 255
            visible |= maximum
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


def channel_frames(accepted: list[CachedExposure], tolerance: float):
    channels: list[list[CachedExposure]] = []
    frames = []
    for e in accepted:
        group = next((g for g in channels if all(
            same_channel(e, other, e.frame.processing_version, other.frame.processing_version,
                         tolerance) for other in g
        )), None)
        if group is None:
            group = []
            channels.append(group)
        group.append(e)
        anchor = group[0]
        name = (f"{anchor.observation.detector} {anchor.wavelengths[0]:.6f} µm "
                f"({anchor.frame.processing_version})")
        frames.append(e.frame.model_copy(update={"channel": name}))
    return frames, channels


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
    if preview:
        render_pngs([e.array], [directory / png], [e.quality] if e.quality is not None else None)
    e.frame = e.frame.model_copy(update={
        "id": f"{stem}.png", "url": f"/api/assets/{job_id}/{png}", "pixels": pixels,
        "quality": quality_file,
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
        mask_fraction=float(np.mean(~np.isin(quality.states, (
            PixelState.NORMAL, PixelState.WARNING, PixelState.OVERFLOW_MAX,
        )))),
        warnings=["Display preview; no PSF/background matching or photometric inference."],
    )


class Pipeline:
    def __init__(self, settings: Settings, archive: Archive):
        self.settings, self.archive = settings, archive
        self.exposure_cache = ExposureCache(settings, PIPELINE_VERSION, quality_mask=int(BAD_BITS))

    def run(self, query: Query, directory: Path, job_id: str, report: Callable[[str], None],
            *, publish: Callable[[Manifest], None] | None = None, timing: Timing | None = None):
        return _FrameJob(self, query, directory, job_id, report, publish, timing).run()


class _FrameJob:
    """The job thread publishes snapshots while catalog and transfer threads report results."""

    def __init__(self, pipeline, query, directory, job_id, report, publish, timing):
        self.settings, self.archive, self.cache = pipeline.settings, pipeline.archive, pipeline.exposure_cache
        self.query, self.directory, self.job_id = query, directory, job_id
        self.report, self.publish, self.timing = report, publish, timing
        self.progressive = query.live and publish is not None
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
                "archive_products": {},
                "archive_complete": False,
                "spectral_tolerance": self.settings.spectral_tolerance,
                "flag_policy": "Flag-aware display; quantitative samples require valid variance and no flags except SOURCE.",
                "zodi_subtracted": False,
                "grid_header": dict(self.grid.to_header()),
                "output_shape": list(self.shape),
                "psf_matched": False,
            },
        )
    def ordered(self):
        return sorted(self.accepted.values(), key=lambda e: (e.observation.mjd, e.observation.identity))

    def snapshot(self):
        if self.progressive:
            frames, _ = channel_frames(self.ordered(), self.settings.spectral_tolerance)
            self.publish(self.result.model_copy(update={
                "frames": frames, "stretch": "asinh (individual preview scales while loading)",
            }, deep=True))

    def install(self, entry, index=None):
        stem = product_stem(entry.observation) if self.query.live else f"frame-{index:02}"
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
                source = self.archive.fetch(obs, self.query, path, self.download_deadline, **kwargs)
            with timed(self.timing, "fits_decode", obs.identity):
                return decode(path, obs, self.query, source)
        finally:
            path.unlink(missing_ok=True)

    def accept(self, c, index=None):
        obs = c.observation
        with timed(self.timing, "align", obs.identity):
            if time.monotonic() > self.deadline:
                raise ValueError("Job deadline reached")
            array = align(c, self.grid, self.shape)
            if c.quality is None:
                raise ValueError("Missing detector quality information")
            quality = c.quality.align(c.wcs, self.grid, self.shape)
            if np.count_nonzero(np.isin(quality.states, (
                PixelState.NORMAL, PixelState.WARNING, PixelState.OVERFLOW_MAX, PixelState.INSPECT_ONLY,
            ))) < 16:
                raise ValueError("Insufficient usable common-grid coverage")
        entry = CachedExposure(obs, frame_metadata(c, quality), array, c.wavelengths, c.bandwidths, quality)
        self.install(entry, index)
        if self.query.live:
            self.fresh.add((obs.identity, obs.uri))
            self.snapshot()
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
        selected = Archive.candidates(rows, self.settings.max_candidates)
        self.result.warnings.extend(notes)
        if len(selected) < len(rows):
            self.result.warnings.append(
                f"Processing {len(selected)} of {len(rows)} distinct exposures "
                "sampled across dates and detectors. Narrow dates for additional frames."
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

        events = Queue()
        early_obs, early_future, early_error = None, None, None
        with ThreadPoolExecutor(max_workers=1) as metadata:
            lookup = metadata.submit(self.catalog, events.put)
            lookup.add_done_callback(events.put)
            while True:
                event = events.get()
                if event is lookup:
                    break
                if isinstance(event, Future):
                    try:
                        self.accept(event.result())
                    except (ArchiveError, ValueError, KeyError, OSError) as exc:
                        early_error = str(exc)
                elif not warm:
                    early_obs = event
                    if self.restore(event):
                        self.snapshot()
                    else:
                        early_future = pool.submit(self.retrieve, event)
                        early_future.add_done_callback(events.put)
            try:
                rows, notes = lookup.result()
            except ArchiveError as exc:
                if not self.accepted and early_future is None:
                    raise
                rows = [early_obs] if early_obs else []
                notes = [f"Partial metadata: archive refresh unavailable. {exc}"]
                self.result.processing["cache_fallback"] = warm

        rows, selected, complete = self.resolve(rows, notes)
        self.cache.reconcile(self.query, rows, complete, as_of=search_started)
        targets = {o.identity: o.uri for o in selected}
        old_ids = set(self.accepted)
        self.accepted = {k: e for k, e in self.accepted.items() if targets.get(k) == e.observation.uri}
        futures = {}
        for obs in selected:
            if self.restore(obs):
                continue
            if early_obs == obs and early_future is not None:
                if early_error:
                    self.omit(obs, early_error)
                else:
                    futures[early_future] = obs
            else:
                futures[pool.submit(self.retrieve, obs)] = obs
        if warm or set(self.accepted) != old_ids:
            self.snapshot()
        if early_future and early_future not in futures:
            early_future.cancel()
        for completed, future in enumerate(as_completed(futures), len(selected) - len(futures) + 1):
            self.report(f"fetch:{completed}/{len(selected)}")
            try:
                self.accept(future.result())
            except (ArchiveError, ValueError, KeyError, OSError) as exc:
                self.omit(futures[future], exc)
        self.result.cached = bool(self.accepted) and not any(
            (e.observation.identity, e.observation.uri) in self.fresh for e in self.accepted.values()
        )
        return bool(selected)

    def omit(self, obs, exc):
        self.result.omissions.append({"observation_id": obs.identity, "reason": str(exc)[:200]})

    def matched(self, pool):
        rows, notes = self.catalog()
        _, selected, _ = self.resolve(rows, notes)
        pending = {pool.submit(self.retrieve, obs): obs for obs in selected}
        cutouts = []
        for completed, future in enumerate(as_completed(pending), 1):
            self.report(f"fetch:{completed}/{len(selected)}")
            try:
                cutouts.append(future.result())
            except (ArchiveError, ValueError, KeyError, OSError) as exc:
                self.omit(pending[future], exc)
        cutouts.sort(key=lambda c: (c.observation.mjd, c.observation.identity))
        group = evenly_spaced(choose_group(cutouts, self.settings.spectral_tolerance), self.settings.max_frames)
        ids = {c.observation.identity for c in group}
        for c in cutouts:
            if c.observation.identity not in ids:
                self.omit(c.observation, "Outside selected spectral group or frame limit")
        self.report("align")
        for c in group:
            try:
                self.accept(c, len(self.accepted))
            except (ValueError, KeyError, OSError) as exc:
                self.omit(c.observation, exc)
        return bool(selected)

    def run(self):
        self.report("query")
        with ThreadPoolExecutor(max_workers=self.settings.cutout_workers) as pool:
            candidates = self.live(pool) if self.query.live else self.matched(pool)
        result = self.result
        if candidates and not self.accepted:
            raise ArchiveError("No usable cutouts could be decoded or aligned. " +
                               (result.omissions[0]["reason"] if result.omissions else ""))
        accepted = self.ordered()
        self.report("render")
        with timed(self.timing, "finalize"):
            frames, channels = channel_frames(accepted, self.settings.spectral_tolerance)
            # Final PNGs share one stretch. Published preview PNGs and raw pixels stay immutable.
            paths = [self.directory / frame.id for frame in frames]
            result.processing["stretch"] = (
                render_pngs([e.array for e in accepted], paths, [e.quality for e in accepted]) if paths else {}
            )
            for frame in frames:
                frame.url = f"/api/assets/{self.job_id}/{frame.id}"
            result.frames = frames
            result.retrieved_at = datetime.now(UTC).isoformat()
            if result.omissions:
                result.warnings.append(
                    f"{len(result.omissions)} candidate exposure(s) omitted; see the manifest for reasons."
                )
            if not any(len(channel) >= 2 for channel in channels):
                result.warnings.append(
                    "No wavelength channel has two usable exposures for a time comparison."
                    if self.query.live else
                    "Fewer than two compatible frames; motion playback is unavailable."
                )
            result.warnings.extend([
                "Bounded exposure sample across available detectors.",
                "Wavelength groups match the detector, processing version and spectral response at five field positions within half the narrower bandwidth.",
                "Overflow with unavailable archived brightness is marked at display maximum; flagged measurements retain their recorded brightness for inspection.",
            ])
            atomic_json(self.directory / "manifest.json", result.model_dump(mode="json"))
        return result
