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
from .known_catalog import router as known_catalog_router
from .config import ROOT, Settings
from . import desi, surveys
from .jobs import CapacityError, Jobs, prepared_manifest
from .moving_objects import MovingObjects, router as moving_router
from .pipeline import Pipeline
from .region_spectra import region_router
from .schemas import Detector, Job, Query, Submitted, LoadRequest


def create_app(settings: Settings | None = None, pipeline=None):
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app):
        archive = Archive(settings) if pipeline is None else None
        manager = Jobs(settings, pipeline or Pipeline(settings, archive))
        app.state.jobs = manager
        app.state.archive = archive or getattr(pipeline, "archive", None)
        app.state.moving_objects = MovingObjects()
        try:
            yield
        finally:
            await asyncio.to_thread(manager.close)
            await app.state.moving_objects.http.aclose()
            if archive:
                archive.close()

    app = FastAPI(title="planetXplorer API", version="1.0.0", lifespan=lifespan)
    app.include_router(moving_router)
    app.include_router(known_catalog_router)
    app.include_router(region_router(settings))
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
    def submit(query: Query, request: Request, prepared_only: bool = False):
        try:
            return Submitted(job_id=request.app.state.jobs.submit(query, prepared_only=prepared_only))
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

    @app.post("/api/jobs/{job_id}/load", response_model=Submitted, status_code=202)
    def load_observations(job_id: str, body: LoadRequest, request: Request):
        if not valid_id(job_id):
            raise HTTPException(404, "Unknown field")
        try:
            return Submitted(
                job_id=request.app.state.jobs.load_more(
                    job_id, body.observation_ids, body.detector, body.channels, metadata_only=body.metadata_only
                )
            )
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except CapacityError as exc:
            raise HTTPException(429, str(exc), headers={"Retry-After": "10"}) from exc

    @app.post("/api/jobs/{job_id}/priority/{obs_id}", response_model=Submitted, status_code=202)
    def prioritize(job_id: str, obs_id: str, request: Request):
        if not valid_id(job_id):
            raise HTTPException(404, "Unknown field")
        try:
            return Submitted(job_id=request.app.state.jobs.prioritize(job_id, obs_id))
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except CapacityError as exc:
            raise HTTPException(429, str(exc), headers={"Retry-After": "2"}) from exc

    @app.get("/api/jobs/{job_id}/channels/{detector}")
    def channels(job_id: str, detector: Detector, request: Request, cursor: int = 0):
        if not valid_id(job_id):
            raise HTTPException(404, "Unknown field")
        if cursor < 0:
            raise HTTPException(422, "Invalid channel cursor")
        try:
            return request.app.state.jobs.channel_options(job_id, detector, cursor)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc
        except CapacityError as exc:
            raise HTTPException(429, str(exc), headers={"Retry-After": "2"}) from exc

    @app.post("/api/archive/channels/{detector}")
    def field_channels(query: Query, detector: Detector, request: Request, cursor: int = 0, progressive: bool = False):
        if cursor < 0:
            raise HTTPException(422, "Invalid channel cursor")
        if request.app.state.archive is None:
            raise HTTPException(503, "Archive metadata service unavailable")
        try:
            return request.app.state.jobs.field_channels(query, detector, cursor, progressive=progressive)
        except ArchiveError as exc:
            raise HTTPException(502, str(exc)) from exc
        except CapacityError as exc:
            raise HTTPException(429, str(exc), headers={"Retry-After": "2"}) from exc

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
                "Cache-Control": "private, no-cache" if asset_id.endswith(".json") else "private, max-age=300",
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
            bundle = prepared_manifest(settings.demo_dir / preset["id"])
            preset["cached_manifest_available"] = bool(bundle and bundle.query == Query(
                ra_deg=preset["ra_deg"], dec_deg=preset["dec_deg"]
            ))
            report = settings.cache_dir / "validation" / preset["id"] / "report.json"
            if not report.is_file():
                report = ROOT / "validation" / f"{preset['id']}.json"
            if report.is_file():
                preset["test_outcome"] = json.loads(report.read_text(encoding="utf-8"))[
                    "outcome"
                ]
        return {"presets": data}

    @app.post("/api/surveys/{survey}")
    async def survey_field(survey: Literal["neowise", "euclid", "euclid-images", "desi"], query: Query):
        # Context products span their full releases. Dates apply only to the blink sequence.
        def lookup():
            if survey == "desi":
                return {"galaxies": desi.galaxies(settings.desi_dir, query.ra_deg, query.dec_deg),
                        "source_url": desi.LSS}
            with httpx.Client(verify=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT),
                              timeout=httpx.Timeout(55, connect=8)) as client:
                fetch = {"neowise":surveys.neowise, "euclid":surveys.euclid,
                         "euclid-images":surveys.euclid_images}[survey]
                return fetch(client, query.ra_deg, query.dec_deg)
        try:
            return await asyncio.to_thread(lookup)
        except desi.MissingCatalog as exc:
            raise HTTPException(503, detail={
                "code": "desi_index_missing",
                "message": "The DESI DR1 galaxy index is not installed on this server.",
            }) from exc
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
