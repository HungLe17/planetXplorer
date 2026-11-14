import hashlib
import logging
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

from .config import Settings
from .pipeline import PIPELINE_VERSION, Pipeline, atomic_json
from .schemas import Job, Manifest, Query

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
    return "partial" if failures or len(manifest.frames) == 1 else "complete"


class Jobs:
    def __init__(self, settings: Settings, pipeline: Pipeline):
        self.settings, self.pipeline = settings, pipeline
        self.root = settings.cache_dir / "jobs"
        self.root.mkdir(parents=True, exist_ok=True)
        self.executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="spherex")
        self.lock = threading.RLock()
        self.records: dict[str, Job] = {}
        self.cache: dict[str, str] = {}
        self.cancel_events: dict[str, threading.Event] = {}
        self.futures = {}

    def close(self):
        self.executor.shutdown(wait=True, cancel_futures=True)

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
            self.cancel_events.pop(key, None)
            self.futures.pop(key, None)
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

    def submit(self, query: Query) -> str:
        with self.lock:
            self.cleanup()
            key = hashlib.sha256(query.model_dump_json().encode()).hexdigest()
            cached = self.cache.get(key)
            if cached and self.records[cached].status in ("running", "queued"):
                return cached
            if cached and self.records[cached].manifest:
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
            size = 0
            for path in self.settings.cache_dir.rglob("*"):
                try:
                    if path.is_file():
                        size += path.stat().st_size
                except FileNotFoundError:
                    pass  # Another worker can finish/delete a temporary download during this scan.
            if size + self.settings.max_download_bytes > self.settings.max_cache_bytes:
                raise CapacityError(
                    "Temporary storage is full; retry after cached jobs expire"
                )
            job_id = uuid4().hex
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
            demo = self._demo(query, directory, job_id)
            if demo:
                self.records[job_id].manifest = demo
                self.records[job_id].status = result_status(demo)
                self.records[job_id].stage = "render"
                self.cache[key] = job_id
                return job_id
            self.cancel_events[job_id] = threading.Event()
            self.cache[key] = job_id
            self.futures[job_id] = self.executor.submit(
                self._run, job_id, query, directory, key
            )
            return job_id

    def _demo(self, query: Query, directory: Path, job_id: str) -> Manifest | None:
        for name in ("barnard", "epsilon", "wise", "rw", "rdraconis"):
            folder = self.settings.demo_dir / name
            source = folder / "manifest.json"
            if not source.is_file():
                continue
            try:
                manifest = Manifest.model_validate_json(
                    source.read_text(encoding="utf-8")
                )
                if (
                    manifest.query != query
                    or not manifest.frames
                    or manifest.processing.get("version") != PIPELINE_VERSION
                ):
                    continue
                allowed = {
                    f"frame-{i:04}.png" for i in range(self.settings.max_frames)
                } | {f"frame-{i:02}.png" for i in range(12)}
                if any(
                    f.id not in allowed or not (folder / f.id).is_file()
                    for f in manifest.frames
                ):
                    continue
                for frame in manifest.frames:
                    shutil.copyfile(folder / frame.id, directory / frame.id)
                    frame.url = f"/api/assets/{job_id}/{frame.id}"
                manifest.cached = True
                manifest.warnings.insert(
                    0,
                    "Prepared archive sequence; retrieved "
                    + manifest.retrieved_at
                    + ". Change the date range for a fresh live query.",
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
                self.cache = {k: v for k, v in self.cache.items() if v != job_id}
            return job.model_copy(deep=True) if job else None

    def load_more(self, job_id: str, ids: list[str], detector: str | None) -> str:
        with self.lock:
            self.cleanup()
            job = self.records.get(job_id)
            if job is None or job.manifest is None:
                raise KeyError("Unknown or expired field; search again")
            if job.status in ("running", "queued", "cancelling"):
                raise CapacityError("Wait for the current batch or cancel it first")
            if self.active_count() >= self.settings.max_jobs:
                raise CapacityError("The processing queue is full")
            records = {o.id: o for o in job.manifest.observations}
            if ids and any(i not in records for i in ids):
                raise ValueError("Observation is not part of this field")
            pending = ids or [
                o.id
                for o in records.values()
                if o.status == "pending" and (not detector or o.detector == detector)
            ]
            pending = [
                i for i in dict.fromkeys(pending) if records[i].status != "ready"
            ][: self.settings.batch_size]
            if not pending:
                raise ValueError("No unloaded observations match this selection")
            if len(job.manifest.frames) + len(pending) > self.settings.max_frames:
                raise CapacityError(
                    "This field has reached the loaded-image memory limit; narrow the date range"
                )
            job.status = "queued"
            job.stage = "queued"
            job.error = None
            self.cancel_events[job_id] = threading.Event()
            key = hashlib.sha256(
                job.manifest.query.model_dump_json().encode()
            ).hexdigest()
            self.cache[key] = job_id
            self.futures[job_id] = self.executor.submit(
                self._run, job_id, job.manifest.query, self.root / job_id, key, pending
            )
            return job_id

    def _run(
        self,
        job_id: str,
        query: Query,
        directory: Path,
        key: str,
        ids: list[str] | None = None,
    ):
        manager = self

        class Reporter:
            def __call__(self, stage):
                with manager.lock:
                    if manager.cancel_events[job_id].is_set():
                        raise JobCancelled("Search cancelled")
                    manager.records[job_id].stage = stage
                logger.info("job=%s stage=%s", job_id, stage)

            def publish(self, manifest):
                with manager.lock:
                    if manager.cancel_events[job_id].is_set():
                        raise JobCancelled("Search cancelled")
                    manager.records[job_id].manifest = manifest.model_copy(deep=True)

        report = Reporter()
        with self.lock:
            self.records[job_id].status = "running"
        try:
            result = (
                self.pipeline.load(
                    self.records[job_id].manifest.model_copy(deep=True),
                    ids,
                    directory,
                    job_id,
                    report,
                )
                if ids is not None
                else self.pipeline.run(query, directory, job_id, report)
            )
            with self.lock:
                if self.cancel_events[job_id].is_set():
                    raise JobCancelled("Search cancelled")
                job = self.records[job_id]
                job.manifest = result
                job.warnings = []
                job.status = result_status(result)
                self.cache[key] = job_id
        except JobCancelled:
            with self.lock:
                self.records[job_id].status = "cancelled"
                self.records[job_id].stage = "cancelled"
                if self.records[job_id].manifest:
                    for record in self.records[job_id].manifest.observations:
                        if record.status == "loading":
                            record.status = "pending"
        except Exception as exc:
            logger.exception("Job %s failed", job_id)
            with self.lock:
                self.records[job_id].status = "failed"
                self.records[job_id].error = (
                    str(exc)[:300]
                    if isinstance(exc, (ValueError, RuntimeError))
                    else "Observation processing failed; retry or use a different field."
                )
        finally:
            with self.lock:
                if (
                    self.records[job_id].status in ("failed", "cancelled")
                    and self.records[job_id].manifest
                ):
                    for record in self.records[job_id].manifest.observations:
                        if record.status == "loading":
                            record.status = "pending"
                if (
                    self.records[job_id].status in ("failed", "cancelled")
                    and self.cache.get(key) == job_id
                ):
                    self.cache.pop(key, None)
                self.records[job_id].expires_at = (
                    datetime.now(UTC) + timedelta(seconds=self.settings.ttl_seconds)
                ).isoformat()

    def get(self, job_id: str) -> Job | None:
        with self.lock:
            self.cleanup()
            job = self.records.get(job_id)
            return job.model_copy(deep=True) if job else None

    def asset(self, job_id: str, asset_id: str) -> Path | None:
        with self.lock:
            job = self.records.get(job_id)
            if not job or not job.manifest:
                return None
            allowed = {f.id for f in job.manifest.frames} | {"manifest.json"}
            if asset_id not in allowed:
                return None
            path = self.root / job_id / asset_id
            return path if path.is_file() else None
