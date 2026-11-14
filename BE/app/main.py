import asyncio
import json
import ssl
import time
from typing import Literal
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
import httpx
import truststore

from .archive import Archive, ArchiveError
from .config import ROOT, Settings
from . import desi, surveys
from .jobs import CapacityError, Jobs
from .pipeline import Pipeline
from .schemas import Job, Query, Submitted


def create_app(settings: Settings | None = None, pipeline=None):
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app):
        archive = Archive(settings) if pipeline is None else None
        manager = Jobs(settings, pipeline or Pipeline(settings, archive))
        app.state.jobs = manager
        app.state.archive = archive or getattr(pipeline, "archive", None)
        try:
            yield
        finally:
            await asyncio.to_thread(manager.close)
            if archive:
                archive.close()

    app = FastAPI(title="planetXplorer API", version="1.0.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.origins),
        allow_methods=["GET", "POST"],
        allow_headers=["Content-Type", "Accept"],
        expose_headers=["X-Request-ID", "Retry-After"],
    )

    @app.middleware("http")
    async def request_id(request: Request, call_next):
        request.state.request_id = uuid4().hex
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        return response

    @app.post("/api/jobs", response_model=Submitted, status_code=202)
    def submit(query: Query, request: Request):
        try:
            return Submitted(job_id=request.app.state.jobs.submit(query))
        except CapacityError as exc:
            raise HTTPException(429, str(exc), headers={"Retry-After": "10"}) from exc

    @app.get("/api/jobs/{job_id}", response_model=Job, response_model_exclude_none=True)
    def job(job_id: str, request: Request):
        if not valid_id(job_id):
            raise HTTPException(404, "Unknown job")
        result = request.app.state.jobs.get(job_id)
        if result is None:
            raise HTTPException(404, "Unknown or expired job; submit the query again")
        return result

    @app.post(
        "/api/jobs/{job_id}/cancel",
        response_model=Job,
        response_model_exclude_none=True,
    )
    def cancel_job(job_id: str, request: Request):
        result = request.app.state.jobs.cancel(job_id) if valid_id(job_id) else None
        if result is None:
            raise HTTPException(404, "Unknown or expired job")
        return result

    @app.get("/api/assets/{job_id}/{asset_id}")
    def asset(job_id: str, asset_id: str, request: Request):
        if not valid_id(job_id):
            raise HTTPException(404, "Unknown asset")
        path = request.app.state.jobs.asset(job_id, asset_id)
        if path is None:
            raise HTTPException(404, "Unknown asset")
        return FileResponse(
            path,
            media_type="application/json"
            if asset_id.endswith(".json")
            else "application/octet-stream" if asset_id.endswith(".bin") else "image/png",
            headers={
                "Cache-Control": "private, max-age=300",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.post("/api/archive/snapshot")
    def snapshot(query: Query, request: Request):
        archive = request.app.state.archive
        if archive is None:
            raise HTTPException(503, "Archive metadata service unavailable")
        try:
            observations, warnings = archive.search(
                query.model_copy(update={"live": True}),
                time.monotonic() + settings.metadata_seconds,
            )
        except ArchiveError as exc:
            raise HTTPException(502, str(exc)) from exc
        return {
            "products": {obs.identity: obs.uri for obs in observations},
            "warnings": warnings,
            "complete": not any(w.startswith("Partial metadata:") for w in warnings),
        }

    @app.get("/api/presets")
    def presets():
        data = json.loads((ROOT / "presets.json").read_text(encoding="utf-8"))
        for preset in data:
            preset["cached_manifest_available"] = (
                settings.demo_dir / preset["id"] / "manifest.json"
            ).is_file()
            report = settings.cache_dir / "validation" / preset["id"] / "report.json"
            if not report.is_file():
                report = ROOT / "validation" / f"{preset['id']}.json"
            if report.is_file():
                preset["test_outcome"] = json.loads(report.read_text(encoding="utf-8"))[
                    "outcome"
                ]
        return {"presets": data}

    @app.post("/api/surveys/{survey}")
    async def survey_field(survey: Literal["neowise", "euclid", "desi"], query: Query):
        # Context products span their full releases. Dates apply only to the blink sequence.
        def lookup():
            if survey == "desi":
                return {"galaxies": desi.galaxies(settings.desi_dir, query.ra_deg, query.dec_deg),
                        "source_url": desi.LSS}
            with httpx.Client(verify=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT),
                              timeout=httpx.Timeout(55, connect=8)) as client:
                fetch = surveys.neowise if survey == "neowise" else surveys.euclid
                return fetch(client, query.ra_deg, query.dec_deg)
        try:
            return await asyncio.to_thread(lookup)
        except FileNotFoundError as exc:
            raise HTTPException(503, "DESI catalog index is unavailable") from exc
        except (ValueError, OSError, httpx.HTTPError) as exc:
            raise HTTPException(502, f"{survey.upper()} lookup unavailable") from exc

    @app.get("/api/health")
    def health(request: Request):
        manager = request.app.state.jobs
        return {
            "status": "ok",
            "service": "planetxplorer",
            "active_jobs": manager.active_count(),
            "max_jobs": settings.max_jobs,
            "archive_connectivity": "not_checked",
        }

    return app


def valid_id(value):
    return len(value) == 32 and all(c in "0123456789abcdef" for c in value)


app = create_app()
