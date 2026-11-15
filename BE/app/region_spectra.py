"""All-date region catalog and bounded batches of calibrated aperture measurements."""

import math
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

import numpy as np
from astropy.time import Time
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from .archive import Archive, ArchiveError, RELEASES
from .pipeline import decode, target_grid
from .schemas import Frame, Manifest, ObservationRecord, Query
from .visits import field_visits


class Aperture(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    ra_deg: float = Field(ge=0, lt=360)
    dec_deg: float = Field(ge=-90, le=90)
    fov_arcsec: float = Field(ge=30, le=1800)
    width: int = Field(ge=1, le=512)
    height: int = Field(ge=1, le=512)
    box: tuple[int, int, int, int]


class Batch(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=8)


class RegionCatalog:
    def __init__(self, aperture: Aperture):
        self.field = Query(ra_deg=aperture.ra_deg, dec_deg=aperture.dec_deg, fov_arcsec=aperture.fov_arcsec, live=True)
        wcs, shape = target_grid(self.field)
        self.same_cache_grid = shape == (aperture.height, aperture.width)
        wcs.wcs.crpix = [(aperture.width + 1) / 2, (aperture.height + 1) / 2]
        x0, y0, x1, y1 = aperture.box
        if not (0 <= x0 <= x1 < aperture.width and 0 <= y0 <= y1 < aperture.height):
            raise ValueError("Selection lies outside the field pixel grid")
        # Display y runs south; the processing array runs north.
        self.slices = (slice(aperture.height - y1 - 1, aperture.height - y0), slice(x0, x1 + 1))
        self.grid = wcs.slice(self.slices)
        self.shape = (y1 - y0 + 1, x1 - x0 + 1)
        h, w = self.shape
        sky = self.grid.pixel_to_world(np.array([-.5, -.5, w-.5, w-.5]),
                                       np.array([-.5, h-.5, h-.5, -.5]))
        center = self.grid.pixel_to_world((w-1)/2, (h-1)/2)
        radius = float(max(center.separation(sky).degree))
        self.search_position = f"CIRCLE {center.ra.deg:.12f} {center.dec.deg:.12f} {radius + 1e-8:.12f}"
        # A detector-oriented cutout must enclose the rotated rectangle.
        width = max(30.0, 2 * radius * 3600 + 2 * 6.14)
        self.cutout = self.field.model_copy(update={"ra_deg": float(center.ra.deg),
            "dec_deg": float(center.dec.deg), "fov_arcsec": float(width)})
        self.windows = [(name, None, None) for _, names in RELEASES.values() for name in names]
        self.by_id = {}
        self.results = {}
        self.validation_frames = {}
        self.lock = threading.Lock()
        self.touched = time.monotonic()

    def intersects(self, footprint: str) -> bool:
        # SIA returns convex ICRS polygons with great-circle edges. Gnomonic
        # projection maps those edges to lines even when the field crosses RA=0.
        parts = footprint.split()
        if not parts or parts[0].upper() != "POLYGON":
            raise ArchiveError("The archive omitted the exposure footprint. Coverage could not be verified.")
        try:
            offset = 2 if len(parts) > 1 and parts[1].upper() == "ICRS" else 1
            vertices = np.array(parts[offset:], dtype=float).reshape(-1, 2)
            x, y = self.grid.world_to_pixel_values(*vertices.T)
            points = np.column_stack((x, y))
        except (ValueError, TypeError) as exc:
            raise ArchiveError("The archive returned an invalid exposure polygon.") from exc
        if len(points) < 3 or not np.isfinite(points).all():
            raise ArchiveError("The archive footprint cannot be projected onto the region grid.")
        h, w = self.shape
        corners = np.array([[-.5, -.5], [-.5, h-.5], [w-.5, h-.5], [w-.5, -.5]])
        edges = np.roll(points, -1, axis=0) - points
        # Separating-axis test for the convex exposure footprint and pixel rectangle.
        axes = np.vstack((np.eye(2), np.column_stack((-edges[:, 1], edges[:, 0]))))
        image, box = points @ axes.T, corners @ axes.T
        return not np.any((image.max(axis=0) < box.min(axis=0)) | (box.max(axis=0) < image.min(axis=0)))

    def catalog(self, pipeline):
        if self.windows:
            rows, subwindows = pipeline.archive.region_page(self.search_position, self.windows[-1], self.intersects)
            self.windows.pop()
            self.windows.extend(subwindows)
            for obs in rows:
                prior = self.by_id.get(obs.identity)
                if prior is None or Archive._version_key(obs) > Archive._version_key(prior):
                    self.by_id[obs.identity] = obs
        if self.windows:
            return {"discovering": True, "count": len(self.by_id)}
        records = [ObservationRecord(id=o.identity, detector=o.detector, release=o.release,
                   source_url=o.uri, observed_at=Time(o.mjd, format="mjd").to_datetime(timezone=UTC).isoformat())
                   for o in sorted(self.by_id.values(), key=lambda o: (o.mjd, o.identity))]
        manifest = Manifest(query=self.field, retrieved_at=datetime.now(UTC).isoformat(),
                            observations=records, discovery_complete=True)
        visits = field_visits(manifest, list(self.validation_frames.values()))
        return {"discovering": False, "count": len(records), "visits": visits,
                "records": [{"id": r.id, "detector": r.detector, "observed_at": r.observed_at,
                             "release": r.release} for r in records]}

    def measure(self, pipeline, obs):
        hit = pipeline.exposure_cache.get(self.field, obs) if self.same_cache_grid else None
        if hit and hit.quality and hit.quality.spectral is not None:
            q = hit.quality
            if np.all(q.states[self.slices] != 0):
                return self.reduce(obs, q.values[self.slices], q.spectral[(slice(None), *self.slices)],
                                   q.states[self.slices], hit.frame.exposure_flags)
        with TemporaryDirectory(dir=pipeline.settings.cache_dir) as folder:
            path = Path(folder) / "region.fits"
            source = pipeline.archive.fetch(obs, self.cutout, path,
                                            time.monotonic() + pipeline.settings.job_seconds)
            cut = decode(path, obs, self.cutout, source, region=True)
        q = cut.quality.align(cut.wcs, self.grid, self.shape)
        return self.reduce(obs, q.values, q.spectral, q.states, cut.metadata or {})

    def reduce(self, obs, values, spectral, states, headers):
        waves, widths = spectral
        valid = (states != 0) & np.isfinite(values) & np.isfinite(waves) & (waves > 0)
        result = {"id": obs.identity, "finite": int(valid.sum()), "pixels": int(values.size),
                  "covered": int(np.count_nonzero(states)), "bins": []}
        if valid.any():
            # A wide region can span multiple resolution elements within one
            # exposure. A single mean would erase spectral structure.
            w = waves[valid].astype(np.float64)
            bands = widths[valid]
            bands = bands[np.isfinite(bands) & (bands > 0)]
            labels = np.floor((w - w.min()) / float(bands.min())) if bands.size else w
            _, group = np.unique(labels, return_inverse=True)
            counts = np.bincount(group)
            means = np.bincount(group, weights=values[valid]) / counts
            centers = np.bincount(group, weights=w) / counts
            result["bins"] = [{"wave": float(x), "mean": float(y), "finite": int(n)}
                              for x, y, n in zip(centers, means, counts, strict=True)]
        # Validation needs a wavelength measured at the same position in every
        # exposure. Edge-only measurements without this sample remain provisional.
        mid = ((waves.shape[0] - 1) // 2, (waves.shape[1] - 1) // 2)
        wave, band = float(waves[mid]), float(widths[mid])
        frame = None
        if states[mid] and math.isfinite(wave) and wave > 0 and math.isfinite(band) and band > 0:
            frame = Frame(id=obs.identity, observation_id=obs.identity, detector=obs.detector,
                          observed_at=Time(obs.mjd, format="mjd").to_datetime(timezone=UTC).isoformat(),
                          wavelength_um=wave, bandwidth_um=band, release=obs.release,
                          url=obs.uri, source_url=obs.uri, exposure_flags=headers)
        return result, frame

    def batch(self, pipeline, ids):
        if self.windows or any(i not in self.by_id for i in ids):
            raise ValueError("Request an exposure from the completed region catalog")
        pending = {i: pipeline.transfers.submit(self.measure, pipeline, self.by_id[i])
                   for i in dict.fromkeys(ids) if i not in self.results}
        errors = {}
        for i, future in pending.items():
            try:
                measurement, frame = future.result()
                self.results[i] = measurement
                if frame is not None:
                    self.validation_frames[i] = frame
            except (ArchiveError, ValueError, OSError, KeyError) as exc:
                errors[i] = str(exc)
        return {"measurements": [self.results[i] for i in ids if i in self.results], "errors": errors}


def region_router(settings):
    router = APIRouter(prefix="/api/region-spectra")
    catalogs = {}
    registry_lock = threading.Lock()

    def lookup(key):
        with registry_lock:
            catalog = catalogs.get(key)
            if catalog is None or time.monotonic() - catalog.touched > settings.ttl_seconds:
                raise HTTPException(404, {"code": "region_expired", "message":
                    "This region catalog expired. Start a new lookup to continue."})
            catalog.touched = time.monotonic()
            return catalog

    @router.post("", status_code=201)
    def open_region(aperture: Aperture):
        try:
            region = RegionCatalog(aperture)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        with registry_lock:
            for key in list(catalogs):
                if time.monotonic() - catalogs[key].touched > settings.ttl_seconds:
                    del catalogs[key]
            if len(catalogs) >= 64:
                raise HTTPException(429, "Region catalog capacity reached. Retry later.")
            key = uuid4().hex
            catalogs[key] = region
        return {"id": key}

    @router.post("/{key}/catalog")
    def catalog_page(key: str, request: Request):
        region = lookup(key)
        with region.lock:
            try:
                return region.catalog(request.app.state.jobs.pipeline)
            except ArchiveError as exc:
                raise HTTPException(502, {"code": "region_catalog", "message": str(exc)}) from exc

    @router.post("/{key}/measure")
    def measurements(key: str, body: Batch, request: Request):
        region = lookup(key)
        with region.lock:
            try:
                return region.batch(request.app.state.jobs.pipeline, body.ids)
            except ValueError as exc:
                raise HTTPException(422, str(exc)) from exc
    return router
