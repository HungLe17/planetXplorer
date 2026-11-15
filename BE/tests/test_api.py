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


def test_live_refresh_revalidates_and_reuses_only_unchanged_products(tmp_path):
    import shutil
    from dataclasses import replace
    from app.archive import Observation
    from app.pipeline import Pipeline

    first = Observation("visitD6","https://irsa.ipac.caltech.edu/first",60800,"D6","DR1")

    class RecordingArchive:
        rows = [first]
        downloads = 0

        def search(self, query, deadline):
            assert query.live
            return self.rows, []

        def fetch(self, obs, query, path, deadline):
            self.downloads += 1
            shutil.copyfile(Path(__file__).parent/"fixtures"/"wise-d6.fits", path)
            return obs.uri

    from pathlib import Path
    settings_ = settings(tmp_path)
    archive = RecordingArchive()
    with TestClient(create_app(settings_, Pipeline(settings_,archive))) as client:
        q = {"ra_deg":133.795129,"dec_deg":-7.245147,"live":True}
        def search():
            return finished(client,client.post("/api/jobs",json=q).json()["job_id"])["manifest"]
        original = search()
        assert len(original["frames"]) == 1 and archive.downloads == 1
        identical = search()
        assert identical["cached"] and archive.downloads == 1
        frame = identical["frames"][0]
        pixels = client.get(frame["url"].rsplit("/",1)[0]+"/"+frame["pixels"])
        assert pixels.status_code == 200 and len(pixels.content) == 49*49*4
        replacement = replace(first,uri=first.uri+"-reprocessed")
        archive.rows = [replacement,replace(first,identity="repeatD6",mjd=60801,uri=first.uri+"-new")]
        snapshot = client.post("/api/archive/snapshot",json=q).json()
        assert snapshot["complete"] and archive.downloads == 1
        current = search()
        assert not current["cached"] and archive.downloads == 3
        assert [f["observation_id"] for f in current["frames"]] == ["visitD6","repeatD6"]
        assert current["processing"]["archive_products"] == snapshot["products"]


def test_restart_shows_partial_job_cache_while_refresh_checks_archive(tmp_path):
    import shutil
    from pathlib import Path

    from app.archive import ArchiveError, Observation
    from app.pipeline import Pipeline

    visits = [Observation(name, "https://irsa.ipac.caltech.edu/" + name, mjd, "D6", "DR1")
              for name, mjd in (("usable", 60800), ("missing", 60801))]
    resume_catalog = threading.Event()

    class ArchiveWithFailure:
        def __init__(self, refresh):
            self.refresh = refresh
            self.downloads = []

        def search(self, query, deadline):
            if self.refresh:
                assert resume_catalog.wait(8), "Cache hit waited for archive metadata"
            return visits, ["Partial metadata: one collection unavailable."]

        def fetch(self, obs, query, path, deadline):
            self.downloads.append(obs.identity)
            if not self.refresh and obs.identity == "missing":
                raise ArchiveError("Transient archive error")
            shutil.copyfile(Path(__file__).parent / "fixtures" / "wise-d6.fits", path)
            return obs.uri

    config = settings(tmp_path)
    query = {"ra_deg": 133.795129, "dec_deg": -7.245147, "live": True}
    first = ArchiveWithFailure(False)
    with TestClient(create_app(config, Pipeline(config, first))) as client:
        result = finished(client, client.post("/api/jobs", json=query).json()["job_id"])
        assert result["status"] == "partial"
        assert sorted(first.downloads) == ["missing", "usable"]

    second = ArchiveWithFailure(True)
    with TestClient(create_app(config, Pipeline(config, second))) as client:
        job_id = client.post("/api/jobs", json=query).json()["job_id"]
        try:
            deadline = time.monotonic() + 7
            while time.monotonic() < deadline:
                job = client.get(f"/api/jobs/{job_id}").json()
                if job.get("manifest") and job["manifest"]["frames"]:
                    break
                time.sleep(.01)
            assert job["status"] == "running"
            frame, = job["manifest"]["frames"]
            assert frame["observation_id"] == "usable"
            assert client.get(frame["url"]).content.startswith(b"\x89PNG")
            assert len(client.get(f"/api/assets/{job_id}/{frame['pixels']}").content) == 49 * 49 * 4
            assert not second.downloads
        finally:
            resume_catalog.set()
        final = finished(client, job_id)["manifest"]
        assert [f["observation_id"] for f in final["frames"]] == ["usable", "missing"]
        assert second.downloads == ["missing"]


@pytest.mark.parametrize("cancel", [False, True])
def test_running_frame_and_timings_survive_late_download(tmp_path, cancel):
    import shutil
    from pathlib import Path
    from app.archive import Observation
    from app.pipeline import Pipeline

    release = threading.Event()

    class OutOfOrderArchive:
        def search(self, query, deadline):
            return [
                Observation(name, f"https://irsa.ipac.caltech.edu/{name}", mjd, "D6", "DR1")
                for name, mjd in [("older", 60800), ("newer", 60801)]
            ], []

        def fetch(self, obs, query, path, deadline):
            if obs.identity == "older":
                assert release.wait(8)
            shutil.copyfile(Path(__file__).parent / "fixtures" / "wise-d6.fits", path)
            return obs.uri

    config = settings(tmp_path)
    with TestClient(create_app(config, Pipeline(config, OutOfOrderArchive()))) as client:
        query = {"ra_deg": 133.795129, "dec_deg": -7.245147, "live": True}
        job_id = client.post("/api/jobs", json=query).json()["job_id"]
        endpoint = f"/api/jobs/{job_id}"
        assets = f"/api/assets/{job_id}/"
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                current = client.get(endpoint).json()
                if current.get("manifest", {}).get("frames"):
                    break
                time.sleep(.02)
            assert current["status"] == "running"
            frame, = current["manifest"]["frames"]
            assert frame["observation_id"] == "newer"
            preview = client.get(frame["url"]).content
            assert preview.startswith(b"\x89PNG")
            pixels = client.get(assets + frame["pixels"]).content
            assert len(pixels) == 49 * 49 * 4
            quality = client.get(assets + frame["quality"])
            assert quality.headers["content-type"] == "application/octet-stream"
            assert len(quality.content) == 49 * 49 * 9
            assert client.get(assets + "raw-0.fits").status_code == 404
            assert client.get(assets + "manifest.json").status_code == 404
            assert any(t["stage"] == "first_frame" for t in current["timings"])
            if cancel:
                assert client.post(endpoint + "/cancel").json()["status"] == "cancelling"
        finally:
            release.set()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            final = client.get(endpoint).json()
            if final["status"] not in ("running", "cancelling"):
                break
            time.sleep(.02)
        records = final["manifest"]["frames"]
        assert final["status"] == ("cancelled" if cancel else "complete")
        assert [f["observation_id"] for f in records] == (["newer"] if cancel else ["older", "newer"])
        assert frame["id"] == records[-1]["id"]
        assert client.get(frame["url"]).content == preview
        assert client.get(assets + frame["pixels"]).content == pixels
        assert client.get(assets + frame["quality"]).content == quality.content
        timings = client.get(assets + "timings.json").json()["timings"]
        assert timings == final["timings"]
        assert timings[-1]["stage"] == "total"
        assert [t["stage"] for t in timings].count("first_frame") == 1
        assert any(t["stage"] == "cutout_download" and t["observation_id"] == "newer" for t in timings)
        if cancel:
            assert final["manifest"]["processing"]["counts"]["loading"] == 0
            assert client.post(endpoint + "/load", json={"observation_ids": ["older"]}).status_code == 202
            resumed = finished(client, job_id)["manifest"]
            assert {f["observation_id"] for f in resumed["frames"]} == {"older", "newer"}
            assert client.get(frame["url"]).content == preview
            assert all(client.get(f["url"]).status_code == 200 for f in resumed["frames"])
            assert all(o["status"] == "ready" for o in resumed["observations"])


def test_catalog_preview_assets_and_incremental_load_endpoint(tmp_path):
    from pathlib import Path
    import shutil
    from app.archive import Observation
    from app.pipeline import Pipeline

    release = threading.Event()
    query = Query(ra_deg=133.795129, dec_deg=-7.245147)
    source = "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/test.fits"
    observations = [
        Observation(f"record-{i}", source, 60800.7 + i, "D6", "DR1") for i in range(3)
    ]

    class Recorded:
        def search(self, *_):
            return observations, []

        def fetch(self, obs, query, path, deadline):
            if obs.identity == "record-1":
                release.wait(4)
            shutil.copyfile(Path(__file__).parent / "fixtures" / "wise-d6.fits", path)
            return source

    config = settings(tmp_path, batch_size=2)
    with TestClient(create_app(config, Pipeline(config, Recorded()))) as client:
        try:
            job = client.post("/api/jobs", json=query.model_dump(mode="json")).json()[
                "job_id"
            ]
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                data = client.get(f"/api/jobs/{job}").json()
                if data.get("manifest", {}).get("frames"):
                    break
                time.sleep(0.01)
            assert data["status"] == "running"
            assert len(data["manifest"]["observations"]) == 3
            assert client.get(data["manifest"]["frames"][0]["url"]).status_code == 200
            release.set()
            assert len(finished(client, job)["manifest"]["frames"]) == 2
            assert (
                client.post(
                    f"/api/jobs/{job}/load", json={"observation_ids": ["unknown"]}
                ).status_code
                == 422
            )
            assert (
                client.post(
                    f"/api/jobs/{job}/load", json={"detector": "D6"}
                ).status_code
                == 202
            )
            result = finished(client, job)["manifest"]
            assert len(result["frames"]) == 3 and all(
                o["status"] == "ready" for o in result["observations"]
            )
        finally:
            release.set()


def test_clicked_catalog_exposure_gets_next_slot_once(tmp_path):
    import shutil
    from pathlib import Path
    from app.archive import Archive, Observation
    from app.pipeline import Pipeline, decode

    seen = []
    active = set()
    started = threading.Condition()
    release = {f"field-{i}": threading.Event() for i in range(7)}
    rows = [Observation(key, "https://irsa.ipac.caltech.edu/" + key, 60800 + i, "D6", "DR1")
            for i, key in enumerate(release)]
    rows.append(Observation("outside", "https://irsa.ipac.caltech.edu/outside", 60800, "D3", "DR1"))
    field = Query(ra_deg=133.795129, dec_deg=-7.245147, fov_arcsec=30, live=True)
    fixture = Path(__file__).parent / "fixtures" / "wise-d6.fits"
    sample = decode(fixture, rows[0], field, rows[0].uri)
    info = {"wavelength_um": float(sample.wavelengths[0]), "bandwidth_um": float(sample.bandwidths[0]),
            "processing_version": sample.version}
    label = f"D6 {sample.wavelengths[0]:.6f} µm ({sample.version})"
    probed = []
    probe_started = threading.Event()

    class DelayedArchive(Archive):
        def __init__(self):
            pass

        def search(self, *args, **kwargs):
            return rows, []

        def cached_spectral(self, uri, query):
            return None if uri.endswith("field-1") else info

        def probe_spectral(self, obs, query, deadline):
            probed.append(obs.identity)
            probe_started.set()
            return info

        def fetch(self, obs, query, path, deadline, **kwargs):
            with started:
                seen.append(obs.identity)
                active.add(obs.identity)
                started.notify_all()
                assert len(active) <= 2
            try:
                assert release[obs.identity].wait(15)
                shutil.copyfile(fixture, path)
                return obs.uri
            finally:
                with started:
                    active.remove(obs.identity)

    cfg = settings(tmp_path, max_candidates=4)
    with TestClient(create_app(cfg, Pipeline(cfg, DelayedArchive()))) as client:
        query = {**field.model_dump(mode="json"), "detectors": ["D6"], "channels": {"D6": [label]}}
        job = client.post("/api/jobs", json=query).json()["job_id"]
        endpoint = f"/api/jobs/{job}"
        try:
            with started:
                assert started.wait_for(lambda: len(seen) == 2, 5)
            catalog = client.get(endpoint).json()["manifest"]
            assert len(catalog["observations"]) == 8 and not catalog["frames"]
            clicked = "field-1"  # Both active slots are busy and its wavelength is still unknown.
            assert clicked not in seen
            assert client.post(f"{endpoint}/priority/outside").status_code == 422
            for _ in range(2):
                assert client.post(f"{endpoint}/priority/{clicked}").status_code == 202
            assert probe_started.wait(2) and probed == [clicked]
            release[seen[0]].set()
            with started:
                assert started.wait_for(lambda: len(seen) == 3, 5)
                assert seen[2] == clicked and seen[1] in active
        finally:
            for event in release.values():
                event.set()
        assert len(finished(client, job)["manifest"]["frames"]) == 5
        assert client.post(f"{endpoint}/priority/{clicked}").status_code == 202
        assert seen.count(clicked) == 1 and "outside" not in seen


def test_click_during_final_render_is_preserved(tmp_path, monkeypatch):
    import shutil
    from pathlib import Path
    from app.archive import Observation
    from app.pipeline import Pipeline, _FrameJob

    rendering, release = threading.Event(), threading.Event()
    original = _FrameJob.finalize

    def delayed_finalize(self):
        rendering.set()
        assert release.wait(10)
        return original(self)

    monkeypatch.setattr(_FrameJob, "finalize", delayed_finalize)
    seen = []

    class Archive:
        def search(self, *_):
            return [Observation(str(i), f"https://irsa.ipac.caltech.edu/{i}", 60800 + i, "D6", "DR1")
                    for i in range(3)], []

        def fetch(self, obs, query, path, deadline):
            seen.append(obs.identity)
            shutil.copyfile(Path(__file__).parent / "fixtures" / "wise-d6.fits", path)
            return obs.uri

    cfg = settings(tmp_path, max_candidates=2)
    with TestClient(create_app(cfg, Pipeline(cfg, Archive()))) as client:
        job = client.post("/api/jobs", json={"ra_deg": 133.795129, "dec_deg": -7.245147,
                                            "live": True, "fov_arcsec": 30}).json()["job_id"]
        try:
            assert rendering.wait(6)
            assert set(seen) == {"0", "2"}
            for _ in range(2):
                assert client.post(f"/api/jobs/{job}/priority/1").status_code == 202
        finally:
            release.set()
        assert len(finished(client, job)["manifest"]["frames"]) == 3
        assert seen.count("1") == 1
