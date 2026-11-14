"""Persistent, disposable cache of quality-masked, sky-aligned SPHEREx exposures."""

import json
import logging
import sqlite3
import time
from contextlib import closing, contextmanager
from dataclasses import dataclass

import numpy as np
from astropy.time import Time

from .archive import ASSET_PREFIX, ORIGIN, RELEASES, Archive, Observation
from .config import Settings
from .pixel_quality import PixelQuality
from .schemas import Frame, Query

logger = logging.getLogger(__name__)


@dataclass
class CachedExposure:
    observation: Observation
    frame: Frame
    array: np.ndarray
    wavelengths: np.ndarray
    bandwidths: np.ndarray
    quality: PixelQuality | None = None


class ExposureCache:
    def __init__(self, settings: Settings, pipeline_version: str, *, quality_mask: int):
        self.settings = settings
        self.path = settings.cache_dir / "exposures-v1.sqlite3"
        self.namespace = (ORIGIN, ASSET_PREFIX, RELEASES, pipeline_version, quality_mask)
        # Job files and active downloads share the configured disk budget.
        self.limit = settings.max_cache_bytes // 4

    def _field(self, query: Query) -> str:
        return json.dumps(
            (self.namespace, query.ra_deg, query.dec_deg, query.fov_arcsec),
            separators=(",", ":"), sort_keys=True,
        )

    @contextmanager
    def _open(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.path, timeout=2)) as db, db:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA auto_vacuum = FULL")
            db.execute("""
                CREATE TABLE IF NOT EXISTS exposure (
                    field TEXT, identity TEXT, uri TEXT, mjd REAL, detector TEXT,
                    release TEXT, stored REAL, metadata TEXT, pixels BLOB,
                    PRIMARY KEY (field, identity, uri)
                ) WITHOUT ROWID
            """)
            yield db

    @staticmethod
    def _dates(query):
        return (
            Time(query.start_utc).mjd if query.start_utc else -float("inf"),
            Time(query.end_utc).mjd if query.end_utc else float("inf"),
        )

    @staticmethod
    def _trim(db, limit):
        page_size = db.execute("PRAGMA page_size").fetchone()[0]
        while True:
            pages = db.execute("PRAGMA page_count").fetchone()[0]
            free = db.execute("PRAGMA freelist_count").fetchone()[0]
            if (pages - free) * page_size <= limit:
                return
            removed = db.execute("""
                DELETE FROM exposure WHERE (field,identity,uri) IN
                    (SELECT field,identity,uri FROM exposure ORDER BY stored LIMIT 1)
            """).rowcount
            if not removed:
                return

    def prune(self, needed_bytes: int = 0) -> int:
        """Expire old rows and free space for a job if the shared cache is full."""
        if not self.path.is_file():
            return 0
        try:
            before = self.path.stat().st_size
            with self._open() as db:
                db.execute("DELETE FROM exposure WHERE stored < ?",
                           (time.time() - self.settings.ttl_seconds,))
                if needed_bytes:
                    self._trim(db, max(0, before - needed_bytes))
            return max(0, before - self.path.stat().st_size)
        except (OSError, sqlite3.Error):
            logger.warning("Could not prune exposure cache", exc_info=True)
            return 0

    def store(
        self, query: Query, observation: Observation, frame: Frame, array: np.ndarray,
        wavelengths: np.ndarray, bandwidths: np.ndarray, quality: PixelQuality | None = None,
    ) -> None:
        if self.limit < 16 * 1024:
            return
        try:
            pixels = np.asarray(array, dtype="<f8")
            metadata = json.dumps(
                {"frame": frame.model_dump(mode="json"), "shape": pixels.shape,
                 "waves": [float(x) if np.isfinite(x) else None for x in wavelengths],
                 "bands": [float(x) if np.isfinite(x) else None for x in bandwidths]},
                separators=(",", ":"), allow_nan=False,
            )
            # Keep the measurements and their provenance in one atomic cache record.
            blob = pixels.tobytes() + (quality.to_bytes() if quality is not None else b"")
            if len(metadata) + len(blob) > self.limit:
                return
            with self._open() as db:
                now = time.time()
                db.execute("DELETE FROM exposure WHERE stored < ?", (now - self.settings.ttl_seconds,))
                db.execute("INSERT OR REPLACE INTO exposure VALUES (?,?,?,?,?,?,?,?,?)",
                           (self._field(query), observation.identity, observation.uri,
                            observation.mjd, observation.detector, observation.release, now,
                            metadata, blob))
                self._trim(db, self.limit)
        except (OSError, sqlite3.Error, TypeError, ValueError):
            logger.warning("Could not cache exposure %s", observation.identity, exc_info=True)

    def _read(self, db, field, obs, since):
        row = db.execute("""
            SELECT metadata,pixels FROM exposure
            WHERE field=? AND identity=? AND uri=? AND stored>=?
        """, (field, obs.identity, obs.uri, since)).fetchone()
        if row is None:
            return None
        try:
            meta = json.loads(row["metadata"])
            frame = Frame.model_validate(meta["frame"])
            blob = row["pixels"]
            shape = tuple(meta["shape"])
            array = np.frombuffer(blob, dtype="<f8", count=int(np.prod(shape))).reshape(shape)
            sidecar = memoryview(blob)[array.nbytes:]
            quality = PixelQuality.from_bytes(sidecar, shape) if len(sidecar) else None
            if frame.quality and quality is None:
                raise ValueError("Incomplete exposure quality data")
            waves, bands = np.array(meta["waves"], dtype=float), np.array(meta["bands"], dtype=float)
            if array.ndim != 2 or waves.shape != (5,) or bands.shape != (5,):
                raise ValueError("Inconsistent exposure dimensions")
            return CachedExposure(obs, frame, array, waves, bands, quality)
        except (ValueError, TypeError, KeyError):
            logger.warning("Ignoring unreadable cached exposure %s", obs.identity)
            return None

    def get(self, query: Query, observation: Observation) -> CachedExposure | None:
        if not self.path.is_file():
            return None
        try:
            with self._open() as db:
                return self._read(db, self._field(query), observation,
                                  time.time() - self.settings.ttl_seconds)
        except (OSError, sqlite3.Error):
            logger.warning("Could not read exposure cache", exc_info=True)
            return None

    def load(self, query: Query) -> list[CachedExposure]:
        """Find the preferred known revisions within the requested field and date range."""
        if not self.path.is_file():
            return []
        field = self._field(query)
        since = time.time() - self.settings.ttl_seconds
        try:
            with self._open() as db:
                available = {}
                for row in db.execute("""
                    SELECT identity,uri,mjd,detector,release FROM exposure
                    WHERE field=? AND stored>=? AND mjd BETWEEN ? AND ?
                """, (field, since, *self._dates(query))):
                    obs = Observation(**dict(row))
                    old = available.get(obs.identity)
                    if obs.release.lower() in RELEASES and (
                        old is None or Archive._version_key(obs) > Archive._version_key(old)
                    ):
                        available[obs.identity] = obs
                sample = Archive.candidates(list(available.values()), self.settings.max_candidates)
                return [entry for obs in sample if (entry := self._read(db, field, obs, since))]
        except (OSError, sqlite3.Error):
            logger.warning("Could not open cached field", exc_info=True)
            return []

    def reconcile(self, query, observations, complete, *, as_of=None):
        """Forget superseded revisions, and treat disappearance as conclusive only in a complete lookup."""
        if not self.path.is_file():
            return
        field = self._field(query)
        catalog = {obs.identity: obs for obs in observations}
        try:
            with self._open() as db:
                cutoff = time.time() if as_of is None else as_of
                rows = db.execute("""
                    SELECT identity,uri,mjd,detector,release FROM exposure
                    WHERE field=? AND stored<=? AND mjd BETWEEN ? AND ?
                """, (field, cutoff, *self._dates(query))).fetchall()
                for row in rows:
                    old = Observation(**dict(row))
                    found = catalog.get(old.identity)
                    if found and found.uri == old.uri:
                        continue
                    if complete or (found and Archive._version_key(found) > Archive._version_key(old)):
                        db.execute(
                            "DELETE FROM exposure WHERE field=? AND identity=? AND uri=? AND stored<=?",
                            (field, old.identity, old.uri, cutoff),
                        )
        except (OSError, sqlite3.Error):
            logger.warning("Could not refresh cached field", exc_info=True)
