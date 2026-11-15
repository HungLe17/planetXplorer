import hashlib
import json
import logging
import re
import shutil
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from .archive import ASSET_PREFIX, ORIGIN, RELEASES
from .config import Settings
from .pipeline import PIPELINE_VERSION, Pipeline, atomic_json, update_counts
from .schemas import Job, JobTiming, Manifest, ObservationRecord, Query, channel_parameters
from .visits import field_visits
from .transfers import PriorityLoads

logger = logging.getLogger(__name__)


class JobCancelled(RuntimeError):
    pass


class CapacityError(RuntimeError):
    pass


def result_status(manifest: Manifest) -> str:
    failures = any(
        item.get("reason") != "Outside selected spectral group or frame limit"
        for item in manifest.omissions
    )
    partial = failures or len(manifest.frames) == 1 or manifest.processing.get("cache_fallback")
    return "partial" if partial else "complete"


def prepared_manifest(folder: Path) -> Manifest | None:
    try:
        manifest = Manifest.model_validate_json((folder / "manifest.json").read_text(encoding="utf-8"))
        if not manifest.frames or manifest.processing.get("version") not in {"1.0.0", "2.0.0", PIPELINE_VERSION}:
            return None
        for frame in manifest.frames:
            if not re.fullmatch(r"frame-(?:[0-9]{2,4}|[a-f0-9]{24})\.png", frame.id):
                return None
            stem = frame.id[:-4]
            if frame.pixels and frame.pixels != stem + ".bin":
                return None
            if frame.quality and (not frame.pixels or frame.quality != stem + "-quality.bin"
                                  or manifest.processing.get("version") not in {"2.0.0", PIPELINE_VERSION}):
                return None
            if frame.spectral and (not frame.pixels or frame.spectral != stem + "-spectral.bin"):
                return None
            if any(not (folder / name).is_file() for name in (frame.id, frame.pixels, frame.quality, frame.spectral) if name):
                return None
        return manifest
    except (ValueError, OSError):
        return None


def cache_key(query: Query):
    identity = (query.model_dump_json(), PIPELINE_VERSION, ORIGIN, ASSET_PREFIX, RELEASES)
    return hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()


class Jobs:
    def __init__(self, settings: Settings, pipeline: Pipeline):
        self.settings, self.pipeline = settings, pipeline
        self.root = settings.cache_dir / "jobs"
        self.root.mkdir(parents=True, exist_ok=True)
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="spherex")
        self.lock = threading.RLock()
        self.channel_lookups = threading.BoundedSemaphore(2)
        self.channel_catalogs = OrderedDict()
        self.records: dict[str, Job] = {}
        self.published_assets: dict[str, set[str]] = {}
        self.started: dict[str, float] = {}
        self.cache: dict[str, str] = {}
        self.cancel_events: dict[str, threading.Event] = {}
        self.futures = {}
        self.priority_loads: dict[str, PriorityLoads] = {}
        self.closing = False

    def close(self):
        with self.lock:
            self.closing = True
        self.executor.shutdown(wait=True, cancel_futures=True)
        if isinstance(self.pipeline, Pipeline):
            self.pipeline.transfers.close()

    def cleanup(self):
        now = datetime.now(UTC)
        active = {
            k
            for k, v in self.records.items()
            if v.status in ("running", "queued", "cancelling")
        }
        expired = [
            k
            for k, v in self.records.items()
            if k not in active and datetime.fromisoformat(v.expires_at) < now
        ]
        for key in expired:
            self.records.pop(key, None)
            self.published_assets.pop(key, None)
            self.started.pop(key, None)
            self.cancel_events.pop(key, None)
            self.futures.pop(key, None)
            self.priority_loads.pop(key, None)
        for directory in self.root.iterdir():
            if not directory.is_dir() or directory.name in active:
                continue
            expired_directory = directory.name in expired or (
                directory.name not in self.records
                and now.timestamp() - directory.stat().st_mtime
                > self.settings.ttl_seconds
            )
            if (
                expired_directory
                and not directory.is_symlink()
                and directory.resolve().parent == self.root.resolve()
            ):
                shutil.rmtree(directory)
        self.cache = {k: v for k, v in self.cache.items() if v in self.records}

    def _check_storage(self):
        size = 0
        for path in self.settings.cache_dir.rglob("*"):
            try:
                if path.is_file():
                    size += path.stat().st_size
            except FileNotFoundError:
                pass  # Another worker can finish/delete a temporary download during this scan.
        excess = size + self.settings.max_download_bytes - self.settings.max_cache_bytes
        if excess > 0 and isinstance(self.pipeline, Pipeline):
            excess -= self.pipeline.exposure_cache.prune(excess)
        if excess > 0:
            raise CapacityError(
                "Temporary storage is full; retry after cached jobs expire"
            )

    def submit(self, query: Query) -> str:
        with self.lock:
            self.cleanup()
            key = cache_key(query)
            cached = self.cache.get(key)
            if cached and self.records[cached].status in ("running", "queued"):
                return cached
            if not query.live and cached and self.records[cached].status in ("complete", "partial"):
                self.records[cached].manifest.cached = True
                atomic_json(
                    self.root / cached / "manifest.json",
                    self.records[cached].manifest.model_dump(mode="json"),
                )
                return cached
            if (
                sum(
                    v.status in ("queued", "running", "cancelling")
                    for v in self.records.values()
                )
                >= self.settings.max_jobs
            ):
                raise CapacityError("The processing queue is full")
            self._check_storage()
            job_id = uuid4().hex
            self.started[job_id] = time.monotonic()
            now = datetime.now(UTC)
            self.records[job_id] = Job(
                job_id=job_id,
                created_at=now.isoformat(),
                expires_at=(
                    now + timedelta(seconds=self.settings.ttl_seconds)
                ).isoformat(),
            )
            directory = self.root / job_id
            directory.mkdir()
            demo = None if query.live else self._demo(query, directory, job_id)
            if demo:
                job = self.records[job_id]
                self._timing(job, "demo_load")
                self._publish(job, demo)
                job.status = result_status(demo)
                job.stage = "render"
                self._finish_timing(job)
                self.cache[key] = job_id
                return job_id
            self.cancel_events[job_id] = threading.Event()
            self.priority_loads[job_id] = PriorityLoads()
            self.cache[key] = job_id
            self.futures[job_id] = self.executor.submit(
                self._run, job_id, query, directory, key
            )
            return job_id

    def _demo(self, query: Query, directory: Path, job_id: str) -> Manifest | None:
        for name in ("barnard", "epsilon", "wise", "rw", "rdraconis"):
            folder = self.settings.demo_dir / name
            manifest = prepared_manifest(folder)
            if manifest is None or manifest.query != query:
                continue
            try:
                if not manifest.observations:
                    manifest.discovery_complete = False
                    manifest.observations = [
                        ObservationRecord(id=f.observation_id, detector=f.detector, release=f.release,
                                          observed_at=f.observed_at, source_url=f.source_url.split("?")[0],
                                          status="ready", frame_id=f.id)
                        for f in manifest.frames
                    ]
                    update_counts(manifest)
                for frame in manifest.frames:
                    if frame.pixels:
                        shutil.copyfile(folder / frame.pixels, directory / frame.pixels)
                    if frame.quality:
                        shutil.copyfile(folder / frame.quality, directory / frame.quality)
                    if frame.spectral:
                        shutil.copyfile(folder / frame.spectral, directory / frame.spectral)
                    shutil.copyfile(folder / frame.id, directory / frame.id)
                    frame.url = f"/api/assets/{job_id}/{frame.id}"
                manifest.visits = field_visits(manifest, manifest.frames)
                manifest.cached = True
                manifest.warnings.insert(
                    0,
                    "Prepared archive sequence; retrieved "
                    + manifest.retrieved_at
                    + ". Search this field again to check the archive.",
                )
                atomic_json(
                    directory / "manifest.json", manifest.model_dump(mode="json")
                )
                return manifest
            except (ValueError, OSError):
                logger.exception("Could not load prepared sequence %s", name)
        return None

    def active_count(self) -> int:
        with self.lock:
            return sum(
                v.status in ("queued", "running", "cancelling")
                for v in self.records.values()
            )

    def cancel(self, job_id: str) -> Job | None:
        with self.lock:
            job = self.records.get(job_id)
            if job and job.status in ("queued", "running", "cancelling"):
                self.cancel_events[job_id].set()
                job.status = (
                    "cancelled" if self.futures[job_id].cancel() else "cancelling"
                )
                job.stage = job.status
                if job.status == "cancelled":
                    self._finish_timing(job)
                self.cache = {k: v for k, v in self.cache.items() if v != job_id}
            return job.model_copy(deep=True) if job else None

    def load_more(self, job_id: str, ids: list[str], detector: str | None, channels=None) -> str:
        with self.lock:
            self.cleanup()
            job = self.records.get(job_id)
            if job is None or job.manifest is None:
                raise KeyError("Unknown or expired field; search again")
            if job.status in ("running", "queued", "cancelling") or self.active_count() >= self.settings.max_jobs:
                raise CapacityError("Wait for the current batch or retry when the queue has space")
            manifest = job.manifest
            records = {o.id: o for o in manifest.observations}
            if any(i not in records for i in ids):
                raise ValueError("Observation is not part of this field")
            remaining = self.settings.max_frames - len(manifest.frames)
            if remaining <= 0:
                raise CapacityError("This field reached the loaded-image limit; narrow the date range")
            requested = list(dict.fromkeys(ids)) if ids else [r.id for r in records.values() if r.status == "pending"]
            selected = [i for i in requested if records[i].status != "ready"
                        and records[i].selection != "excluded"
                        and (not manifest.query.live or manifest.query.detectors is None
                             or records[i].detector in manifest.query.detectors)
                        and (detector is None or records[i].detector == detector)]
            selected = selected[:min(self.settings.batch_size, remaining)]
            if not selected:
                raise ValueError("No unloaded observations match this selection")
            self._check_storage()
            job.status = job.stage = "queued"
            job.error = None
            self.cancel_events[job_id] = threading.Event()
            self.priority_loads[job_id] = PriorityLoads()
            key = cache_key(manifest.query)
            self.cache[key] = job_id
            self.futures[job_id] = self.executor.submit(
                self._run, job_id, manifest.query, self.root / job_id, key, selected, channels
            )
            return job_id

    def prioritize(self, job_id: str, obs_id: str) -> str:
        with self.lock:
            self.cleanup()
            job = self.records.get(job_id)
            if not job or not job.manifest:
                raise KeyError("Unknown field or the catalog has not arrived")
            record = next((r for r in job.manifest.observations if r.id == obs_id), None)
            if not record:
                raise ValueError("Observation is not part of this field")
            if record.selection == "excluded" or record.band_match(job.manifest.query) == "excluded":
                raise ValueError("Observation is outside the selected bands")
            if job.status == "cancelling":
                raise CapacityError("Search cancellation is in progress")
            if record.status == "ready":
                return job_id
            if job.status in ("running", "queued"):
                self.priority_loads[job_id].request(obs_id)
                return job_id
            self.load_more(job_id, [obs_id], None)
            self.priority_loads[job_id].request(obs_id)
            return job_id

    # Call under self.lock so polling always sees a consistent manifest and clock.
    def _timing(self, job, stage, duration=None, observation_id=None, outcome="ok"):
        elapsed = time.monotonic() - self.started[job.job_id]
        event = JobTiming(
            stage=stage,
            elapsed_ms=round(elapsed * 1000, 1),
            duration_ms=round((elapsed if duration is None else duration) * 1000, 1),
            observation_id=observation_id,
            outcome=outcome,
        )
        job.timings.append(event)
        logger.info("job=%s timing=%s", job.job_id, event.model_dump_json(exclude_none=True))

    def _publish(self, job, manifest):
        if manifest.frames and (not job.manifest or not job.manifest.frames):
            self._timing(job, "first_frame")
        job.manifest = manifest.model_copy(deep=True)
        # A browser can still be fetching a snapshot when a newer revision replaces it.
        assets = self.published_assets.setdefault(job.job_id, set())
        for frame in manifest.frames:
            assets.add(frame.url.rsplit("/", 1)[-1])
            if frame.pixels:
                assets.add(frame.pixels)
            if frame.quality:
                assets.add(frame.quality)
            if frame.spectral:
                assets.add(frame.spectral)

    def _finish_timing(self, job):
        self._timing(job, "total", outcome=job.status)
        try:
            atomic_json(
                self.root / job.job_id / "timings.json",
                job.model_dump(include={"job_id", "status", "timings"}, exclude_none=True),
            )
        except OSError:
            logger.exception("Could not persist timings for job %s", job.job_id)

    def _run(self, job_id: str, query: Query, directory: Path, key: str, ids=None, channels=None):
        job = self.records[job_id]
        cancelled = self.cancel_events[job_id]
        priority = self.priority_loads[job_id]

        def report(stage):
            with self.lock:
                if cancelled.is_set():
                    raise JobCancelled("Search cancelled")
                job.stage = stage
            logger.info("job=%s stage=%s", job_id, stage)

        def publish(manifest):
            with self.lock:
                if cancelled.is_set():
                    raise JobCancelled("Search cancelled")
                self._publish(job, manifest)

        def timing(stage, duration, observation_id=None, outcome="ok"):
            with self.lock:
                self._timing(job, stage, duration, observation_id, outcome)

        with self.lock:
            if not cancelled.is_set():
                job.status = "running"
            self._timing(job, "queue")
        result = None
        error = None
        try:
            if cancelled.is_set():
                raise JobCancelled("Search cancelled")
            if ids is not None:
                options = {"channels": channels} if channels else {}
                if isinstance(self.pipeline, Pipeline):
                    options["priority"] = priority
                result = self.pipeline.load(job.manifest, ids, directory, job_id, report,
                                            publish=publish, timing=timing, **options)
            elif isinstance(self.pipeline, Pipeline):
                result = self.pipeline.run(
                    query, directory, job_id, report, publish=publish, timing=timing, priority=priority
                )
            else:
                result = self.pipeline.run(query, directory, job_id, report)
        except JobCancelled:
            cancelled.set()
        except Exception as exc:
            logger.exception("Job %s failed", job_id)
            error = (
                str(exc)[:300] if isinstance(exc, (ValueError, RuntimeError))
                else "Observation processing failed; retry or use a different field."
            )
        with self.lock:
            if cancelled.is_set():
                job.status = job.stage = "cancelled"
            elif result is None:
                job.status = "failed"
                job.error = error
            else:
                self._publish(job, result)
                job.status = result_status(result)
                # A click can arrive after the dispatcher drained, during final
                # rendering. Keep it in this job before allowing the next poll.
                trailing = priority.take_waiting()
                if trailing:
                    records = {r.id: r for r in result.observations}
                    trailing = [i for i in trailing if i in records and records[i].status != "ready"
                                and records[i].selection != "excluded"]
                if trailing and not self.closing and len(result.frames) < self.settings.max_frames:
                    job.status = job.stage = "queued"
                    self.futures[job_id] = self.executor.submit(
                        self._run, job_id, query, directory, key, trailing
                    )
                    return
            if job.status in ("failed", "cancelled"):
                if job.manifest:
                    for record in job.manifest.observations:
                        if record.status == "loading":
                            record.status = "pending"
                    update_counts(job.manifest)
                    job.manifest.processing["revision"] = job.manifest.processing.get("revision", 0) + 1
                    atomic_json(directory / "manifest.json", job.manifest.model_dump(mode="json"))
                if self.cache.get(key) == job_id:
                    self.cache.pop(key)
            job.expires_at = (datetime.now(UTC) + timedelta(seconds=self.settings.ttl_seconds)).isoformat()
            self._finish_timing(job)

    def get(self, job_id: str) -> Job | None:
        with self.lock:
            self.cleanup()
            job = self.records.get(job_id)
            return job.model_copy(deep=True) if job else None

    def channel_options(self, job_id: str, detector: str, cursor: int):
        job = self.get(job_id)
        if not job:
            raise KeyError("Unknown or expired field")
        if not job.manifest:
            raise ValueError("The field catalog is still loading")
        if not self.channel_lookups.acquire(blocking=False):
            raise CapacityError("Wavelength lookups are busy. Retry shortly.")
        try:
            return self._detector_channels(job.manifest, detector, cursor)
        finally:
            self.channel_lookups.release()

    def field_channels(self, query: Query, detector: str, cursor: int):
        if not self.channel_lookups.acquire(blocking=False):
            raise CapacityError("Wavelength lookups are busy. Retry shortly.")
        try:
            key = (query.ra_deg, query.dec_deg, query.start_utc, query.end_utc)
            with self.lock:
                cached = self.channel_catalogs.get(key)
            if cached and cached[0] > time.monotonic():
                rows, complete = cached[1:]
            else:
                archive = self.pipeline.archive
                rows, notes = archive.search(query.model_copy(update={"live": True}),
                                             time.monotonic() + self.settings.metadata_seconds)
                complete = not any(n.startswith("Partial metadata:") for n in notes)
                if complete:
                    with self.lock:
                        self.channel_catalogs[key] = time.monotonic() + 120, rows, complete
                        self.channel_catalogs.move_to_end(key)
                        if len(self.channel_catalogs) > 8:
                            self.channel_catalogs.popitem(last=False)
            manifest = Manifest(query=query, retrieved_at=datetime.now(UTC).isoformat(),
                                discovery_complete=complete,
                                observations=[o.record() for o in rows if o.detector == detector])
            return self._detector_channels(manifest, detector, cursor)
        finally:
            self.channel_lookups.release()

    def _detector_channels(self, manifest: Manifest, detector: str, cursor: int):
        records = sorted((r for r in manifest.observations if r.detector == detector),
                         key=lambda r: r.id)
        frames = {f.observation_id: f.channel for f in manifest.frames if f.detector == detector}
        labels = {label for label in frames.values() if label}
        query = manifest.query
        cache = getattr(self.pipeline, "exposure_cache", None)
        cutouts = cache.field_index(query) if cache else {}
        archive = getattr(self.pipeline, "archive", None)
        unresolved = []
        for i, record in enumerate(records):
            label = record.channel or frames.get(record.id)
            if not label:
                info = cutouts.get((record.id, record.source_url))
                if not info and archive:
                    info = archive.cached_spectral(record.source_url, query)
                if info and info.get("wavelength_um") is not None:
                    label = f"{detector} {info['wavelength_um']:.6f} µm ({info['processing_version']})"
            if label:
                labels.add(label)
            else:
                unresolved.append((i, record))

        pending = [(i, record) for i, record in unresolved if i >= cursor]
        page = pending[:self.settings.batch_size]
        unavailable = 0
        deadline = time.monotonic() + min(self.settings.metadata_seconds, 30)
        if page:
            with ThreadPoolExecutor(max_workers=min(self.settings.cutout_workers, 4)) as pool:
                lookups = [pool.submit(archive.spectral_at, r.source_url, query, deadline)
                           for _, r in page] if archive else []
                for future in lookups:
                    if info := future.result():
                        labels.add(f"{detector} {info['wavelength_um']:.6f} µm ({info['processing_version']})")
                    else:
                        unavailable += 1
                if not archive:
                    unavailable += len(page)
        more = pending[len(page):]
        return {
            "channels": sorted(labels, key=lambda label: (channel_parameters(label) or ("", 0, label))),
            "unavailable": unavailable, "next_cursor": more[0][0] if more else None,
            "total": len(records), "catalog_complete": manifest.discovery_complete,
        }

    def asset(self, job_id: str, asset_id: str) -> Path | None:
        with self.lock:
            self.cleanup()
            job = self.records.get(job_id)
            if not job:
                return None
            allowed = self.published_assets.get(job_id, set()).copy()
            if job.status in ("complete", "partial", "cancelled", "failed"):
                allowed.add("timings.json")
            if job.manifest and job.status in ("complete", "partial", "cancelled", "failed"):
                allowed.add("manifest.json")
            if asset_id not in allowed:
                return None
            path = self.root / job_id / asset_id
            return path if path.is_file() else None
