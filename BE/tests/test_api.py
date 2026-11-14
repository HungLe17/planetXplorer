from datetime import UTC, datetime, timedelta
import threading
import time
from fastapi.testclient import TestClient
from PIL import Image
import pytest
from app.config import Settings
from app.main import create_app
from app.pipeline import PIPELINE_VERSION, atomic_json
from app.schemas import Frame, Manifest, Query


class StubPipeline:
    def run(self, query, directory, job_id, report):
        report("render")
        Image.new("RGBA", (4, 4), (255, 255, 255, 255)).save(directory / "frame-00.png")
        result = Manifest(
            frames=[
                Frame(
                    id="frame-00.png",
                    url=f"/api/assets/{job_id}/frame-00.png",
                    observation_id="fixture",
                    observed_at="2026-01-01T00:00:00Z",
                    detector="D2",
                    wavelength_um=1.3,
                    bandwidth_um=0.03,
                    release="DR1",
                    source_url="https://irsa.ipac.caltech.edu/ibe/data/spherex/fixture.fits",
                )
            ],
            retrieved_at=datetime.now(UTC).isoformat(),
            query=query,
            processing={"version": PIPELINE_VERSION},
        )
        atomic_json(directory / "manifest.json", result.model_dump(mode="json"))
        return result


def settings(tmp_path, **kwargs):
    return Settings(cache_dir=tmp_path / "cache", demo_dir=tmp_path / "demos", **kwargs)


def finished(client, job_id):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        result = client.get("/api/jobs/" + job_id).json()
        if result["status"] in ["complete", "partial", "failed"]:
            return result
        time.sleep(0.01)
    pytest.fail("Background job did not finish")


def test_job_assets_cache_and_contract(tmp_path):
    with TestClient(create_app(settings(tmp_path), StubPipeline())) as client:
        r = client.post("/api/jobs", json={"ra_deg": 1, "dec_deg": 2})
        assert r.status_code == 202 and r.headers["x-request-id"]
        job_id = r.json()["job_id"]
        result = finished(client, job_id)
        assert result["status"] == "partial"
        frame = result["manifest"]["frames"][0]
        asset = client.get(frame["url"])
        assert asset.status_code == 200 and asset.headers["content-type"] == "image/png"
        assert asset.content.startswith(b"\x89PNG")
        assert client.get("/api/assets/" + job_id + "/raw-0.fits").status_code == 404
        assert client.get("/api/jobs/not-a-job").status_code == 404
        assert (
            client.get("/api/assets/" + job_id + "/%2e%2e%2fmain.py").status_code == 404
        )
        assert (
            client.post("/api/jobs", json={"ra_deg": 1, "dec_deg": 2}).json()["job_id"]
            == job_id
        )
        assert client.get("/api/jobs/" + job_id).json()["manifest"]["cached"]
        assert client.get("/api/assets/" + job_id + "/manifest.json").json()["cached"]
        assert len(client.get("/api/presets").json()["presets"]) == 5
        schema = client.get("/openapi.json").json()
        assert all(
            endpoint in schema["paths"]
            for endpoint in [
                "/api/jobs",
                "/api/jobs/{job_id}",
                "/api/assets/{job_id}/{asset_id}",
                "/api/presets",
                "/api/health",
            ]
        )


def test_capacity_does_not_block_health_or_polling(tmp_path):
    release = threading.Event()

    class Slow(StubPipeline):
        def run(self, *args):
            release.wait(5)
            return super().run(*args)

    with TestClient(create_app(settings(tmp_path, max_jobs=1), Slow())) as client:
        try:
            r = client.post("/api/jobs", json={"ra_deg": 1, "dec_deg": 2})
            second = client.post("/api/jobs", json={"ra_deg": 3, "dec_deg": 2})
            assert second.status_code == 429 and second.headers["retry-after"] == "10"
            assert client.get("/api/health").json()["active_jobs"] == 1
            assert client.get("/api/jobs/" + r.json()["job_id"]).status_code == 200
        finally:
            release.set()


def test_validation_cors_and_failure(tmp_path):
    class Broken:
        def run(self, *args):
            raise RuntimeError("IRSA unavailable")

    with TestClient(create_app(settings(tmp_path), Broken())) as client:
        for body in [
            {"ra_deg": 360, "dec_deg": 0},
            {"ra_deg": 1, "dec_deg": 2, "start_utc": "2026-01-01"},
            {
                "ra_deg": 1,
                "dec_deg": 2,
                "start_utc": "2026-02-01T00:00:00Z",
                "end_utc": "2026-01-01T00:00:00Z",
            },
            {"ra_deg": 1, "dec_deg": 2, "source_url": "http://evil"},
        ]:
            assert client.post("/api/jobs", json=body).status_code == 422
        response = client.options(
            "/api/jobs",
            headers={
                "Origin": "http://127.0.0.1:3000",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Content-Type",
            },
        )
        assert (
            response.headers["access-control-allow-origin"] == "http://127.0.0.1:3000"
        )
        job_id = client.post("/api/jobs", json={"ra_deg": 1, "dec_deg": 2}).json()[
            "job_id"
        ]
        assert finished(client, job_id)["error"] == "IRSA unavailable"


def test_expiry_and_restart_are_recoverable(tmp_path):
    app = create_app(settings(tmp_path), StubPipeline())
    with TestClient(app) as client:
        job_id = client.post("/api/jobs", json={"ra_deg": 1, "dec_deg": 2}).json()[
            "job_id"
        ]
        finished(client, job_id)
        app.state.jobs.records[job_id].expires_at = (
            datetime.now(UTC) - timedelta(seconds=1)
        ).isoformat()
        assert client.get("/api/jobs/" + job_id).status_code == 404
        assert not (tmp_path / "cache" / "jobs" / job_id).exists()
    with TestClient(create_app(settings(tmp_path), StubPipeline())) as client:
        assert client.get("/api/jobs/" + job_id).status_code == 404


def test_cached_demo_never_substitutes_another_query(tmp_path):
    config = settings(tmp_path)
    folder = config.demo_dir / "wise"
    folder.mkdir(parents=True)
    query = Query(ra_deg=1, dec_deg=2)
    StubPipeline().run(query, folder, "demo", lambda _: None)

    class NoNetwork:
        def run(self, *args):
            raise RuntimeError("Live query requested")

    with TestClient(create_app(config, NoNetwork())) as client:
        job_id = client.post("/api/jobs", json={"ra_deg": 1, "dec_deg": 2}).json()[
            "job_id"
        ]
        result = finished(client, job_id)
        assert result["manifest"]["cached"]
        assert client.get(result["manifest"]["frames"][0]["url"]).status_code == 200
        other = client.post("/api/jobs", json={"ra_deg": 1.001, "dec_deg": 2}).json()[
            "job_id"
        ]
        assert finished(client, other)["error"] == "Live query requested"


def test_duplicate_inflight_jobs_reuse_work_and_cancel(tmp_path):
    entered, release = threading.Event(), threading.Event()
    calls = []

    class Slow(StubPipeline):
        def run(self, query, directory, job_id, report):
            calls.append(query)
            entered.set()
            release.wait(5)
            report("fetch")
            return super().run(query, directory, job_id, report)

    with TestClient(create_app(settings(tmp_path, max_jobs=1), Slow())) as client:
        try:
            body = {"ra_deg": 330, "dec_deg": -50}
            job_id = client.post("/api/jobs", json=body).json()["job_id"]
            assert entered.wait(2)
            assert client.post("/api/jobs", json=body).json()["job_id"] == job_id
            assert len(calls) == 1
            assert (
                client.post(f"/api/jobs/{job_id}/cancel").json()["status"]
                == "cancelling"
            )
            assert client.get("/api/health").json()["active_jobs"] == 1
            release.set()
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                state = client.get(f"/api/jobs/{job_id}").json()["status"]
                if state == "cancelled":
                    break
                time.sleep(0.01)
            assert state == "cancelled"
            assert client.get("/api/health").json()["active_jobs"] == 0
            assert client.post("/api/jobs/not-an-id/cancel").status_code == 404
            retry = client.post("/api/jobs", json=body).json()["job_id"]
            assert retry != job_id
            assert finished(client, retry)["status"] == "partial"
        finally:
            release.set()
