import asyncio
import json
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from .archive import Archive
from .config import ROOT, Settings
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
        if not request.app.state.jobs.get(job_id):
            raise HTTPException(404, "Unknown or expired job")
        path = request.app.state.jobs.asset(job_id, asset_id)
        if path is None:
            raise HTTPException(404, "Unknown asset")
        return FileResponse(
            path,
            media_type="application/json"
            if asset_id == "manifest.json"
            else "image/png",
            headers={
                "Cache-Control": "private, max-age=300",
                "X-Content-Type-Options": "nosniff",
            },
        )

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
