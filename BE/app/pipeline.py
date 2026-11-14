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

from .archive import Archive, ArchiveError, Observation, evenly_spaced
from .config import Settings
from .schemas import Frame, Manifest, Query

PIPELINE_VERSION = "1.0.0"
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
            data.copy(),
            valid.copy(),
            wcs,
            waves,
            bands,
            str(hdus[0].header.get("VERSION", "unknown")),
            source,
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
    n = math.ceil((5 / 60) / scale)
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


def render_pngs(arrays: list[np.ndarray], paths: list[Path]) -> dict:
    samples = np.concatenate([a[np.isfinite(a)] for a in arrays])
    if samples.size < 16:
        raise ValueError("No valid aligned pixels to display")
    low, high = np.percentile(samples, [1, 99.5])
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
        deadline = time.monotonic() + self.settings.job_seconds
        report("query")
        observations, notes = self.archive.search(query, deadline)
        omissions, cutouts = [], []
        def retrieve(i, obs):
            path = directory / f"raw-{i}.fits"
            try:
                # report checks cancellation before a queued download starts.
                report("fetch")
                if time.monotonic() >= deadline:
                    raise ArchiveError("Search time limit reached")
                source = self.archive.fetch(obs, query, path, deadline)
                return decode(path, obs, query, source)
            finally:
                path.unlink(missing_ok=True)

        # IRSA's cutout tutorial supports bounded parallel retrieval. Each file,
        # FITS object and WCS belongs to one worker; compatibility is checked below.
        pool = ThreadPoolExecutor(max_workers=self.settings.cutout_workers)
        futures = {pool.submit(retrieve, i, obs): obs for i, obs in enumerate(observations)}
        try:
            for completed, future in enumerate(as_completed(futures), 1):
                obs = futures[future]
                report(f"fetch:{completed}/{len(observations)}")
                try:
                    cutouts.append(future.result())
                except (ArchiveError, ValueError, KeyError, OSError) as exc:
                    omissions.append({"observation_id": obs.identity, "reason": str(exc)[:200]})
        finally:
            pool.shutdown(wait=True, cancel_futures=True)
        cutouts.sort(key=lambda c: (c.observation.mjd, c.observation.identity))
        if observations and not cutouts:
            raise ArchiveError(
                "No usable cutouts could be decoded. "
                + (omissions[0]["reason"] if omissions else "")
            )
        group = evenly_spaced(
            choose_group(cutouts, self.settings.spectral_tolerance),
            self.settings.max_frames,
        )
        selected = {id(c) for c in group}
        for c in cutouts:
            if id(c) not in selected:
                omissions.append(
                    {
                        "observation_id": c.observation.identity,
                        "reason": "Outside selected spectral group or frame limit",
                    }
                )
        grid, shape = target_grid(query)
        arrays, accepted = [], []
        report("align")
        for c in group:
            if time.monotonic() > deadline:
                omissions.append(
                    {
                        "observation_id": c.observation.identity,
                        "reason": "Job deadline reached",
                    }
                )
                continue
            array = align(c, grid, shape)
            if np.count_nonzero(np.isfinite(array)) < 16:
                omissions.append(
                    {
                        "observation_id": c.observation.identity,
                        "reason": "Insufficient valid common-grid coverage",
                    }
                )
            else:
                arrays.append(array)
                accepted.append(c)
        report("render")
        paths = [directory / f"frame-{i:02}.png" for i in range(len(arrays))]
        stretch = render_pngs(arrays, paths) if arrays else {}
        frames = []
        for i, (c, array) in enumerate(zip(accepted, arrays)):
            frames.append(
                Frame(
                    id=f"frame-{i:02}.png",
                    url=f"/api/assets/{job_id}/frame-{i:02}.png",
                    observation_id=c.observation.identity,
                    observed_at=Time(c.observation.mjd, format="mjd", scale="utc")
                    .to_datetime(timezone=UTC)
                    .isoformat(),
                    detector=c.observation.detector,
                    wavelength_um=float(c.wavelengths[0]),
                    bandwidth_um=float(c.bandwidths[0]),
                    release=c.observation.release,
                    source_url=c.source,
                    processing_version=c.version,
                    mask_fraction=float(np.mean(~np.isfinite(array))),
                    warnings=[
                        "Display preview; no PSF/background matching or photometric inference."
                    ],
                )
            )
        if omissions:
            notes.append(
                f"{len(omissions)} candidate exposure(s) omitted; see the manifest for reasons."
            )
        if len(frames) < 2:
            notes.append(
                "Fewer than two compatible frames; motion playback is unavailable."
            )
        notes += [
            "Detector D2/D6 candidate search; not all 102 spectral channels.",
            "Spectral response matched at the target and four points in the central 3 arcminutes within half the narrower bandwidth; exploratory comparison, not a full-field spectral equivalence guarantee.",
            "All archive flags except SOURCE (bit 21) are masked; invalid pixels remain transparent.",
        ]
        result = Manifest(
            frames=frames,
            warnings=notes,
            retrieved_at=datetime.now(UTC).isoformat(),
            query=query,
            omissions=omissions,
            processing={
                "version": PIPELINE_VERSION,
                "spectral_tolerance": self.settings.spectral_tolerance,
                "flag_policy": "mask all FLAGS except SOURCE (bit 21)",
                "zodi_subtracted": False,
                "grid_header": dict(grid.to_header()),
                "stretch": stretch,
                "output_shape": list(shape),
                "psf_matched": False,
            },
        )
        atomic_json(directory / "manifest.json", result.model_dump(mode="json"))
        return result
