"""Display-only WCS alignment and wavelength-matched time sequences."""

import json
import math
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

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
from .schemas import Frame, Manifest, Query, ObservationRecord, Sequence, SpectralSample

PIPELINE_VERSION = "2.1.0"
# SOURCE (21) identifies known objects, not defective pixels. Mask all other bits.
# Official IRSA flag semantics: https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html
SOURCE_BIT = 1 << 21
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
    spectral_sample: SpectralSample | None = None


def native_sample(data, variance_hdu, flags, valid, wcs, spectral, pixel):
    """Sample one original pixel. Never infer physical flux from a rendered PNG.

    This is surface brightness including sky background, not point-source
    photometry. Native sampling avoids an unpropagated interpolation covariance.
    WCS-WAVE wavelengths are suitable for visualization, not precision analysis.
    """
    x, y = (int(np.floor(float(v) + 0.5)) for v in pixel)
    sample = SpectralSample(pixel_x=x, pixel_y=y)
    if not (0 <= y < data.shape[0] and 0 <= x < data.shape[1]):
        sample.reason = "Nearest native pixel is outside the cutout."
        return sample
    sample.flags = int(flags[y, x])
    sky = wcs.pixel_to_world(x, y)
    sample.ra_deg, sample.dec_deg = float(sky.ra.deg), float(sky.dec.deg)
    wave, band = spectral.pixel_to_world(x, y)
    wave, band = float(wave.to_value(u.um)), float(band.to_value(u.um))
    if not (np.isfinite(wave) and np.isfinite(band) and wave > 0 and band > 0):
        sample.reason = "Native pixel has invalid wavelength metadata."
        return sample
    sample.wavelength_um, sample.bandwidth_um = wave, band
    if not valid[y, x]:
        sample.reason = "Target pixel is quality-masked or has invalid image/variance data."
        return sample
    try:
        variance_unit = u.Unit(variance_hdu.header.get("BUNIT", ""))
        variance = float(variance_hdu.data[y, x]) * variance_unit.to((u.MJy / u.sr) ** 2)
    except (ValueError, TypeError):
        sample.reason = "Variance units are unavailable or unsupported."
        return sample
    if not (np.isfinite(variance) and variance > 0):
        sample.reason = "Target pixel has invalid variance."
        return sample
    sample.value_mjy_sr = float(data[y, x])
    sample.sigma_mjy_sr = math.sqrt(variance)
    return sample


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
        if np.count_nonzero(valid) < 16:
            raise ValueError("Too few pixels remain after conservative quality masking")
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
            coord.spherical_offsets_by(x * u.arcmin, y * u.arcmin)
            for x, y in [
                (-query.fov_arcsec / 200, -query.fov_arcsec / 200),
                (-query.fov_arcsec / 200, query.fov_arcsec / 200),
                (query.fov_arcsec / 200, -query.fov_arcsec / 200),
                (query.fov_arcsec / 200, query.fov_arcsec / 200),
            ]
        ]
        pixels = [wcs.world_to_pixel(c) for c in positions]
        if not (0 <= pixels[0][0] < shape[1] and 0 <= pixels[0][1] < shape[0]):
            raise ValueError("Exposure does not cover the target")
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
            or np.any(bands[np.isfinite(bands)] <= 0)
        ):
            raise ValueError("Cutout spectral WCS is invalid")
        return Cutout(
            obs,
            data.copy(),
            valid.copy(),
            wcs,
            waves,
            bands,
            str(hdus[0].header.get("VERSION", "unknown")),
            source,
            native_sample(data, hdus["VARIANCE"], flags, valid, wcs, spectral, pixels[0]),
        )


def compatible(a: Cutout, b: Cutout, tolerance: float) -> bool:
    return (
        a.observation.detector == b.observation.detector
        and a.version == b.version
        and a.version != "unknown"
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
    n = math.ceil((query.fov_arcsec / 3600) / scale)
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
    arrays: list[np.ndarray], paths: list[Path], bounds: dict | None = None
) -> dict:
    samples = np.concatenate([a[np.isfinite(a)] for a in arrays])
    if samples.size < 16:
        raise ValueError("No valid aligned pixels to display")
    low, high = (
        (bounds["vmin"], bounds["vmax"])
        if bounds
        else np.percentile(samples, [1, 99.5])
    )
    if high <= low:
        high = low + max(abs(low) * 1e-6, 1e-6)
    for array, path in zip(arrays, paths):
        values = np.clip((np.nan_to_num(array, nan=low) - low) / (high - low), 0, 1)
        grey = np.round(np.arcsinh(10 * values) / np.arcsinh(10) * 255).astype(np.uint8)
        rgba = np.dstack(
            [grey, grey, grey, np.where(np.isfinite(array), 255, 0).astype(np.uint8)]
        )
        # WCS numpy row zero is south; PNG row zero is top (north).
        Image.fromarray(np.flipud(rgba)).save(path, format="PNG")
    return {"vmin": float(low), "vmax": float(high), "asinh_a": 0.1, "units": "MJy/sr"}


def atomic_json(path: Path, value: dict):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, indent=2, allow_nan=False), encoding="utf-8")
    temp.replace(path)


class Pipeline:
    def __init__(self, settings: Settings, archive: Archive):
        self.settings, self.archive = settings, archive

    def run(
        self, query: Query, directory: Path, job_id: str, report: Callable[[str], None]
    ) -> Manifest:
        report("query")
        observations, notes = self.archive.search(
            query, time.monotonic() + self.settings.metadata_seconds
        )
        result = Manifest(
            query=query,
            retrieved_at=datetime.now(UTC).isoformat(),
            warnings=notes,
            discovery_complete=not any(
                n.startswith(
                    ("Partial metadata:", "Truncated metadata:", "TAP results may")
                )
                for n in notes
            ),
            observations=[
                ObservationRecord(
                    id=o.identity,
                    source_url=o.uri,
                    observed_at=Time(o.mjd, format="mjd", scale="utc")
                    .to_datetime(timezone=UTC)
                    .isoformat(),
                    detector=o.detector,
                    release=o.release,
                )
                for o in observations
            ],
            processing={
                "version": PIPELINE_VERSION,
                "revision": 0,
                "batch_size": self.settings.batch_size,
                "flag_policy": "mask all FLAGS except SOURCE (bit 21)",
                "zodi_subtracted": False,
                "psf_matched": False,
                "spectral_sampling": "nearest_native_pixel; IMAGE in MJy/sr; 1-sigma from VARIANCE; WCS-WAVE visualization wavelengths; no background subtraction or PSF/aperture correction",
            },
        )
        # Start one detector in chronological order; every other record remains loadable.
        counts = {
            d: sum(o.detector == d for o in observations)
            for d in ("D1", "D2", "D3", "D4", "D5", "D6")
        }
        detector = max(counts, key=counts.get)
        ids = [o.identity for o in observations if o.detector == detector][
            : self.settings.batch_size
        ]
        return self.load(result, ids, directory, job_id, report)

    def load(
        self,
        result: Manifest,
        ids: list[str],
        directory: Path,
        job_id: str,
        report: Callable[[str], None],
    ) -> Manifest:
        deadline = time.monotonic() + self.settings.job_seconds
        result.cached = False
        records = {o.id: o for o in result.observations}
        batch = [records[i] for i in ids]
        grid, shape = target_grid(result.query)
        result.grid = f"ICRS TAN; north up, east left; 6.14 arcsec/pixel; {result.query.fov_arcsec:g} arcsec field"
        for o in batch:
            o.status = "loading"
            o.reason = None
        result.omissions = [
            o for o in result.omissions if o["observation_id"] not in ids
        ]

        def publish():
            result.frames.sort(key=lambda f: (f.observed_at, f.observation_id))
            result.processing["revision"] += 1
            result.processing["counts"] = {
                state: sum(o.status == state for o in result.observations)
                for state in ("pending", "loading", "ready", "failed")
            }
            atomic_json(directory / "manifest.json", result.model_dump(mode="json"))
            callback = getattr(report, "publish", None)
            if callback:
                callback(result)

        publish()

        def retrieve(i, record):
            report("fetch")
            path = directory / f"raw-{i}.fits"
            try:
                if time.monotonic() >= deadline - 10:
                    raise ArchiveError(
                        "Batch time limit reached; retry this observation"
                    )
                obs = Observation(
                    record.id,
                    record.source_url,
                    float(Time(datetime.fromisoformat(record.observed_at)).mjd),
                    record.detector,
                    record.release,
                )
                source = self.archive.fetch(obs, result.query, path, deadline - 10)
                return decode(path, obs, result.query, source)
            finally:
                path.unlink(missing_ok=True)

        pool = ThreadPoolExecutor(max_workers=self.settings.cutout_workers)
        futures = {pool.submit(retrieve, i, o): o for i, o in enumerate(batch)}
        try:
            for completed, future in enumerate(as_completed(futures), 1):
                record = futures[future]
                report(f"fetch:{completed}/{len(batch)}")
                try:
                    c = future.result()
                    report("align")
                    array = align(c, grid, shape)
                    if np.count_nonzero(np.isfinite(array)) < 16:
                        raise ValueError(
                            "Insufficient valid pixels on the display grid"
                        )

                    def matches(frame):
                        if (
                            frame.detector != c.observation.detector
                            or frame.processing_version != c.version
                            or c.version == "unknown"
                        ):
                            return False
                        if len(frame.match_wavelengths) != 5 or any(
                            v is None
                            for v in frame.match_wavelengths + frame.match_bandwidths
                        ):
                            return False
                        return bool(
                            np.all(
                                np.abs(
                                    np.array(frame.match_wavelengths) - c.wavelengths
                                )
                                <= self.settings.spectral_tolerance
                                * np.minimum(
                                    np.array(frame.match_bandwidths), c.bandwidths
                                )
                            )
                        )

                    sequence = next(
                        (
                            g
                            for g in result.sequences
                            if g.detector == c.observation.detector
                            and g.processing_version == c.version
                            and all(
                                matches(f)
                                for f in result.frames
                                if f.sequence_id == g.id
                            )
                        ),
                        None,
                    )
                    if sequence is None:
                        sequence = Sequence(
                            id=f"sequence-{len(result.sequences):04}",
                            detector=c.observation.detector,
                            wavelength_um=float(c.wavelengths[0]),
                            processing_version=c.version,
                        )
                        result.sequences.append(sequence)
                    frame_id = f"frame-{len(result.frames):04}.png"
                    report("render")
                    sequence.stretch = render_pngs(
                        [array], [directory / frame_id], sequence.stretch or None
                    )
                    sequence.frame_ids.append(frame_id)
                    partial = not np.all(np.isfinite(c.wavelengths))
                    result.frames.append(
                        Frame(
                            id=frame_id,
                            url=f"/api/assets/{job_id}/{frame_id}",
                            observation_id=record.id,
                            observed_at=record.observed_at,
                            detector=record.detector,
                            release=record.release,
                            wavelength_um=float(c.wavelengths[0]),
                            bandwidth_um=float(c.bandwidths[0]),
                            source_url=c.source,
                            spectral_sample=c.spectral_sample,
                            processing_version=c.version,
                            mask_fraction=float(np.mean(~np.isfinite(array))),
                            sequence_id=sequence.id,
                            match_wavelengths=[
                                float(x) if np.isfinite(x) else None
                                for x in c.wavelengths
                            ],
                            match_bandwidths=[
                                float(x) if np.isfinite(x) else None
                                for x in c.bandwidths
                            ],
                            warnings=["Partial field; inspect individually."]
                            if partial
                            else [],
                        )
                    )
                    record.status = "ready"
                    record.frame_id = frame_id
                    result.processing["stretch"] = sequence.stretch
                except (ArchiveError, ValueError, KeyError, OSError) as exc:
                    record.status = "failed"
                    record.reason = str(exc)[:200]
                    result.omissions.append(
                        {"observation_id": record.id, "reason": record.reason}
                    )
                publish()
        finally:
            pool.shutdown(wait=True, cancel_futures=True)
        report("align")
        report("render")
        publish()
        return result
