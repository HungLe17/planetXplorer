from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
import shutil
import io
import time
from threading import Event

import numpy as np
import pytest

from app.archive import Archive, Observation
from app.config import Settings
from app.pipeline import Pipeline, decode
from app.schemas import Frame, Manifest, ObservationRecord, Query
from app.visits import field_visits


def test_visit_validation_distinguishes_pending_overlap_and_missing():
    records, frames = [], []
    start = datetime(2025, 8, 15, tzinfo=UTC)
    for i in range(6):
        date = (start + timedelta(days=i)).isoformat()
        detector = f"D{i + 1}"
        common = dict(detector=detector, observed_at=date, source_url="test.fits", release="DR1")
        records.append(ObservationRecord(id=detector, **common))
        frames.append(Frame(id=detector, observation_id=detector, url="test.png", wavelength_um=1.,
                            bandwidth_um=.03, processing_version="7.0", exposure_flags={"SPS_EPA": 0},
                            **common))
    m = Manifest(retrieved_at=start.isoformat(), query=Query(ra_deg=1, dec_deg=1),
                 observations=records, discovery_complete=True)
    visit, = field_visits(m, frames[:1])
    assert visit.status == "pending" and not visit.issues
    visit, = field_visits(m, frames)
    assert visit.status == "complete" and all(f.visit_id == visit.id for f in frames)
    m.observations.append(records[0].model_copy(update={"id": "duplicate"}))
    frames.append(frames[0].model_copy(update={"observation_id": "duplicate", "wavelength_um": 1.01}))
    visit, = field_visits(m, frames)
    assert visit.status == "invalid" and any("duplicate" in issue and "D1" in issue for issue in visit.issues)
    frames[-1].wavelength_um = 1.1
    assert field_visits(m, frames)[0].status == "complete"
    m.observations = m.observations[:5]
    assert any("D6" in issue for issue in field_visits(m, frames)[0].issues)
    m.discovery_complete = False
    assert field_visits(m, frames)[0].status == "pending"
    for frame in frames:
        frame.exposure_flags.clear()
    assert field_visits(m, frames)[0].status == "pending"  # Prepared previews can lack pointing metadata.
    m.observations = [record.model_copy(update={
        "observed_at": (start + timedelta(days=i * 8)).isoformat(),
    }) for i, record in enumerate(records[:5])]
    bridged, = field_visits(m, [])
    assert bridged.status == "invalid" and any("28 days" in issue for issue in bridged.issues)


def test_barnard_catalog_cycles_keep_sparse_detector_pairs_and_transfer_failures_separate():
    # Replay detector counts and first/last times of the seven windows of the
    # captured 30-arcsec center catalog, without copying 358 archive rows into tests.
    windows = [
        ("2025-08-15T20:45:11Z", "2025-09-05T02:34:22Z", (19, 18, 18, 18, 18, 17)),
        ("2025-09-30T14:02:53Z", "2025-10-01T06:22:54Z", (5, 0, 0, 5, 0, 0)),
        ("2026-03-11T02:11:37Z", "2026-03-25T21:27:44Z", (18, 18, 19, 18, 19, 19)),
        ("2026-04-10T00:43:17Z", "2026-04-10T00:43:17Z", (0, 0, 1, 0, 0, 1)),
        ("2026-05-04T03:11:42Z", "2026-05-05T01:59:28Z", (0, 0, 4, 0, 0, 4)),
        ("2026-08-16T15:08:22Z", "2026-09-02T06:10:07Z", (18, 24, 17, 18, 23, 17)),
        ("2026-09-22T15:04:21Z", "2026-09-22T15:04:21Z", (0, 1, 0, 0, 1, 0)),
    ]
    records = []
    for first, last, counts in windows:
        start, end = datetime.fromisoformat(first), datetime.fromisoformat(last)
        for det, count in enumerate(counts, 1):
            for i in range(count):
                stamp = start + (end - start) * i / max(count - 1, 1)
                records.append(ObservationRecord(
                    id=f"{first}-D{det}-{i}", detector=f"D{det}", observed_at=stamp.isoformat(),
                    release="DR1", source_url="test.fits",
                ))
    failed = records[0]
    failed.status, failed.reason = "failed", "IRSA cutout download returned HTTP 503."
    m = Manifest(retrieved_at=windows[-1][0], query=Query(ra_deg=269.446, dec_deg=4.768),
                 discovery_complete=True, observations=records)
    visits = field_visits(m, [])
    assert [len(v.observation_ids) for v in visits if v.kind == "cycle"] == [108, 111, 117]
    assert [len(v.observation_ids) for v in visits if v.kind == "supplemental"] == [10, 2, 8, 2]
    assert all(v.status == "pending" and not v.issues for v in visits)
    membership = {identity: v.id for v in visits for identity in v.observation_ids}
    assert len(membership) == len(records) == 358
    assert all(membership[r.id] == r.visit_id for r in records)
    assert failed.status == "failed" and "HTTP 503" in failed.reason


def test_date_bounds_keep_missing_coverage_provisional_but_do_not_hide_spectral_conflicts():
    start = datetime(2026, 3, 12, tzinfo=UTC)
    rows = [ObservationRecord(id=d, detector=d, observed_at=start.isoformat(),
                              release="DR1", source_url="test.fits") for d in ("D1", "D2", "D4")]
    q = Query(ra_deg=269.446, dec_deg=4.768, start_utc=start - timedelta(days=1))
    m = Manifest(retrieved_at=start.isoformat(), query=q, observations=rows, discovery_complete=True)
    visit, = field_visits(m, [])
    assert visit.kind == "cycle" and visit.status == "pending"
    assert any("Date limits" in issue for issue in visit.issues)
    rows[0].wavelength_um, rows[0].bandwidth_um = 1.0, 0.03
    m.observations.append(rows[0].model_copy(update={"id": "conflict"}))
    visit, = field_visits(m, [])
    assert visit.status == "invalid" and any("overlapping" in issue for issue in visit.issues)


def test_filtered_search_checks_metadata_first_and_followups_cannot_expand_it(tmp_path):
    fixture = Path(__file__).parent / "fixtures" / "wise-d6.fits"
    base = Observation("a", "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/test.fits",
                       60800.7, "D6", "DR1")
    matches = replace(base, identity="matched")
    misses = replace(base, identity="miss", mjd=base.mjd + .1)
    ignored = replace(base, identity="other", detector="D1")
    unknown = replace(base, identity="unknown", mjd=base.mjd + .2)
    q = Query(ra_deg=133.795129, dec_deg=-7.245147, live=True, detectors=["D6"])
    c = decode(fixture, base, q, base.uri)
    label = f"D6 {c.wavelengths[0]:.6f} µm ({c.version})"
    q.channels = {"D6": [label]}
    read, fetched = [], []
    published = Event()

    def observe(manifest):
        if len(manifest.observations) == 4:
            published.set()

    class RecordedArchive(Archive):
        def __init__(self):
            pass

        def search(self, query, deadline, *, on_candidate, timing):
            return [matches, misses, ignored, unknown], []

        def cached_spectral(self, uri, query):
            return None

        def probe_spectral(self, obs, query, deadline):
            assert published.wait(3), "Discovery must publish the catalog before unindexed cutouts are checked"
            read.append(obs.identity)
            if obs.identity == "unknown" and read.count("unknown") == 1:
                return None
            return {"wavelength_um": c.wavelengths[0] if obs.identity in ("matched", "unknown") else 4.5,
                    "bandwidth_um": c.bandwidths[0], "processing_version": c.version}

        def fetch(self, obs, query, path, deadline, **kwargs):
            fetched.append(obs.identity)
            shutil.copyfile(fixture, path)
            return obs.uri

    pipeline = Pipeline(Settings(cache_dir=tmp_path / "cache"), RecordedArchive())
    m = pipeline.run(q, tmp_path, "test", lambda _: None, publish=observe)
    assert sorted(read) == ["matched", "miss", "unknown"] and fetched == ["matched"]
    assert len(m.observations) == 4
    frame, = m.frames
    assert np.fromfile(tmp_path / frame.spectral, "<f4").size == 2 * np.prod(m.processing["output_shape"])
    cached = pipeline.exposure_cache.get(q, matches)
    assert np.isfinite(cached.quality.spectral).any()
    miss, = [r for r in m.observations if r.id == "miss"]
    assert miss.status == "pending" and miss.selection == "excluded" and miss.channel.startswith("D6 4.500000")
    unresolved, = [r for r in m.observations if r.id == "unknown"]
    assert unresolved.status == "pending" and unresolved.selection == "unavailable" and "Retry" in unresolved.reason
    m = pipeline.load(m, ["miss"], tmp_path, "test", lambda _: None, channels=q.channels)
    assert fetched == ["matched"]
    m = pipeline.load(m, ["other", "miss"], tmp_path, "test", lambda _: None)
    assert fetched == ["matched"]
    m = pipeline.load(m, ["unknown"], tmp_path, "test", lambda _: None)
    assert fetched == ["matched", "unknown"]
    assert next(r for r in m.observations if r.id == "unknown").status == "ready"


@pytest.mark.parametrize("live", [True, False])
def test_image_traffic_for_subband_only_queries_across_initial_and_followup_loads(tmp_path, live):
    import httpx
    from astropy.io import fits

    fixture = Path(__file__).parent / "fixtures" / "wise-d6.fits"
    base = Observation("match", "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/match.fits",
                       60800.7, "D6", "DR1")
    field = dict(ra_deg=133.795129, dec_deg=-7.245147, live=live)
    calibration = decode(fixture, base, Query(**field), base.uri)
    channel = f"D6 {calibration.wavelengths[0]:.6f} µm ({calibration.version})"
    query = Query(**field, channels={"D6": [channel]})
    assert query.detectors == ["D6"]
    records = [replace(base, identity=name, uri=base.uri.replace("match.fits", name + ".fits"),
                       detector="D3" if name == "other-detector" else "D6")
               for name in ["match", "other-subband", "other-detector", "ignored", "wrong-range", "small"]]
    with fits.open(fixture) as hdus:
        primary = hdus[0].header.copy()
        def prefix():
            return (primary.tostring() + hdus["IMAGE"].header.tostring()).encode("ascii").ljust(92160)
        match = prefix()
        primary["VERSION"] = "other"
        nonmatch = prefix()
        table = io.BytesIO()
        fits.HDUList([fits.PrimaryHDU(), hdus["WCS-WAVE"].copy()]).writeto(table)
        tail = table.getvalue().rjust(28800, b" ")

    images, ranges = [], []
    class NoImageBody(httpx.SyncByteStream):
        def __iter__(self):
            raise AssertionError("A metadata request consumed a rejected science image body")

    def respond(request):
        name = Path(request.url.path).stem
        if "Range" not in request.headers:
            assert "size" in request.url.params and "center" in request.url.params
            images.append(name)
            return httpx.Response(200, content=fixture.read_bytes())
        assert request.url.query == b""
        spec = request.headers["Range"]
        ranges.append((name, spec))
        if name == "ignored":
            return httpx.Response(200, stream=NoImageBody())
        if name == "wrong-range":
            return httpx.Response(206, headers={"Content-Range": "bytes 0-199999/200000"}, stream=NoImageBody())
        if name == "small":
            return httpx.Response(206, headers={"Content-Range": "bytes 0-92159/100000"}, stream=NoImageBody())
        if spec == "bytes=0-92159":
            return httpx.Response(206, headers={"Content-Range": "bytes 0-92159/200000"},
                                  content=nonmatch if name == "other-subband" else match)
        assert spec == "bytes=-28800"
        return httpx.Response(206, headers={"Content-Range": "bytes 171200-199999/200000"}, content=tail)

    class FieldArchive(Archive):
        def search(self, query, deadline, **kwargs):
            return records, []

    settings = Settings(cache_dir=tmp_path / "cache", batch_size=8, max_candidates=8)
    archive = FieldArchive(settings)
    archive.client.close()
    archive.client = httpx.Client(transport=httpx.MockTransport(respond))
    pipeline = Pipeline(settings, archive)
    try:
        manifest = pipeline.run(query, tmp_path, "field", lambda _: None)
        assert {row.detector for row in manifest.observations} == {"D3", "D6"}
        assert {row.id for row in manifest.observations if row.selection == "unavailable"} == {
            "ignored", "wrong-range", "small",
        }
        assert images == ["match"]
        assert sorted(ranges) == sorted(
            [(name, "bytes=0-92159") for name in ("match", "other-subband", "ignored", "wrong-range", "small")]
            + [(name, "bytes=-28800") for name in ("match", "other-subband")]
        )
        pipeline.load(manifest, [r.id for r in manifest.observations], tmp_path, "field", lambda _: None)
        assert images == ["match"]
        assert all(name != "other-detector" for name, _ in ranges)
    finally:
        pipeline.transfers.close()
        archive.close()


def test_reconciled_product_never_inherits_provisional_calibration(tmp_path):
    fixture = Path(__file__).parent / "fixtures" / "wise-d6.fits"
    obs = Observation("sample", "https://irsa.ipac.caltech.edu/ibe/data/spherex/qr3/a.fits",
                      60800.7, "D6", "QR3")
    preferred = replace(obs, uri=obs.uri.replace("qr3", "dr1"), release="DR1")
    q = Query(ra_deg=133.795129, dec_deg=-7.245147, live=True, detectors=["D6"])
    c = decode(fixture, obs, q, obs.uri)
    q.channels = {"D6": [f"D6 {c.wavelengths[0]:.6f} µm ({c.version})"]}
    shown, downloads = Event(), []

    class Revisions(Archive):
        def __init__(self):
            pass

        def search(self, query, deadline, *, on_candidate, timing):
            on_candidate(obs)
            assert shown.wait(5), "First confirmed subband should render before the other collection finishes"
            return [preferred], []

        def cached_spectral(self, uri, query):
            return None

        def probe_spectral(self, candidate, query, deadline):
            return {"wavelength_um": c.wavelengths[0] if candidate == obs else 4.5,
                    "bandwidth_um": c.bandwidths[0], "processing_version": c.version}

        def fetch(self, candidate, query, path, deadline, **kwargs):
            downloads.append(candidate)
            shutil.copyfile(fixture, path)
            return candidate.uri

    def publish(manifest):
        if manifest.frames and Path(tmp_path / Path(manifest.frames[0].url).name).is_file():
            shown.set()

    pipeline = Pipeline(Settings(cache_dir=tmp_path/"cache"), Revisions())
    result = pipeline.run(q, tmp_path, "test", lambda _: None, publish=publish)
    assert downloads == [obs] and result.frames == []
    item, = result.observations
    assert item.source_url == preferred.uri and item.selection == "excluded" and item.wavelength_um == 4.5


@pytest.mark.parametrize("mode", ["no core match", "known core match", "whole detector"])
def test_search_finds_raw_matches_and_prefers_the_core_cycle(tmp_path, mode):
    fixture = Path(__file__).parent / "fixtures" / "wise-d6.fits"
    query = Query(ra_deg=133.795129, dec_deg=-7.245147, live=True, detectors=["D6"])
    rows = [Observation("core"+d, "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/"+d,
                        60800, d, "DR1") for d in ("D1", "D2", "D3", "D4", "D5", "D6")]
    rows.extend(replace(rows[-1], identity=f"core-extra{i}", uri=f"https://example.test/core{i}",
                        mjd=60800 + i/100) for i in (1, 2))
    extra = replace(rows[5], identity="supplemental", uri="https://example.test/extra", mjd=60980)
    conflict = replace(extra, identity="invalidD6", uri="https://example.test/invalid", mjd=61020)
    rows += [extra, conflict, replace(conflict, identity="invalidD1", uri="https://example.test/d1", detector="D1")]
    if mode == "whole detector":
        # Partial discovery leaves a candidate with D1-D5 and a supplemental D6.
        rows = [r for r in rows if r.identity == "supplemental" or r.identity in
                {"coreD1", "coreD2", "coreD3", "coreD4", "coreD5"}]
    decoded = decode(fixture, extra, query, extra.uri)
    if mode != "whole detector":
        query.channels = {"D6": [f"D6 {decoded.wavelengths[0]:.6f} µm ({decoded.version})"]}
    info = {"wavelength_um": decoded.wavelengths[0], "bandwidth_um": decoded.bandwidths[0],
            "processing_version": decoded.version, "nominal_channel": decoded.nominal_channel}
    sampled = []

    class Ranked(Archive):
        def __init__(self):
            pass

        def search(self, query, deadline, *, on_candidate, timing):
            return rows, ["Partial metadata: simulated date coverage"] if mode == "whole detector" else []

        def cached_spectral(self, uri, query):
            if uri in (extra.uri, conflict.uri) or (mode == "known core match" and uri == rows[5].uri):
                return info

        def probe_spectral(self, obs, query, deadline):
            assert mode == "no core match" and obs.identity.startswith("core")
            return dict(info, wavelength_um=info["wavelength_um"] + 1)

        def fetch(self, obs, query, path, deadline, **kwargs):
            sampled.append(obs.identity)
            shutil.copyfile(fixture, path)
            return obs.uri

    cfg = Settings(cache_dir=tmp_path/"cache", max_candidates=2, cutout_workers=1)
    result = Pipeline(cfg, Ranked()).run(query, tmp_path, "ranked", lambda _: None)
    assert len(result.frames) == len(sampled)
    if mode == "whole detector":
        assert sampled == ["supplemental"]
    elif mode == "known core match":
        assert sampled[0] == "coreD6"
    else:
        assert sampled == ["supplemental"]  # Only one confirmed raw fallback is needed.


def test_unindexed_nonmatches_leave_room_for_later_subband(tmp_path):
    fixture = Path(__file__).parent / "fixtures" / "wise-d6.fits"
    q = Query(ra_deg=133.795129, dec_deg=-7.245147, live=True, detectors=["D6"])
    rows = [Observation(str(i), f"https://example.test/{i}", 60800 + i/100, "D6", "DR1") for i in range(8)]
    calibrated = decode(fixture, rows[3], q, rows[3].uri)
    q.channels = {"D6": [f"D6 {calibrated.wavelengths[0]:.6f} µm ({calibrated.version})"]}
    requests, probes = [], []
    first_miss = Event()

    class Cold(Archive):
        def __init__(self):
            pass

        def search(self, query, deadline, *, on_candidate, timing):
            on_candidate(rows[0])
            assert first_miss.wait(3)
            return rows, []

        def cached_spectral(self, uri, query):
            return None

        def probe_spectral(self, obs, query, deadline):
            probes.append(obs.identity)
            if obs.identity == "0":
                first_miss.set()
                return None
            return {"wavelength_um": calibrated.wavelengths[0] if obs.identity == "3" else 4.5,
                    "bandwidth_um": calibrated.bandwidths[0], "processing_version": calibrated.version}

        def fetch(self, obs, query, path, deadline, **kwargs):
            requests.append(obs.identity)
            shutil.copyfile(fixture, path)
            return obs.uri

    cfg = Settings(cache_dir=tmp_path/"cache", max_candidates=2, batch_size=2)
    result = Pipeline(cfg, Cold()).run(q, tmp_path, "cold", lambda _: None)
    assert len(probes) > cfg.max_candidates
    assert requests == ["3"] and [f.observation_id for f in result.frames] == requests
    assert result.observations[0].selection == "unavailable"


def test_presearch_channel_pages_use_only_field_metadata(tmp_path):
    from fastapi.testclient import TestClient
    from app.main import create_app

    class Catalog:
        def __init__(self):
            self.fields, self.lookups, self.known = [], [], {}

        def search(self, query, deadline):
            self.fields.append(query.ra_deg)
            return [Observation(str(i), f"https://test/{i}", 60800+i, detector, "DR1")
                    for i, detector in enumerate(["D6", "D6", "D1"])], []

        def cached_spectral(self, uri, query):
            return self.known.get((uri, query.ra_deg))

        def spectral_at(self, uri, query, deadline):
            self.lookups.append((uri, query.ra_deg))
            if query.ra_deg == 40 and uri.endswith("/0"):
                return None
            info = {"wavelength_um": 4.0 + int(uri[-1])/10 + query.ra_deg/1000,
                    "bandwidth_um": 0.02, "processing_version": "7"}
            self.known[uri, query.ra_deg] = info
            return info

        def fetch(self, *args, **kwargs):
            raise AssertionError("The pre-search channel selector requested a full image")

    archive = Catalog()
    cfg = Settings(cache_dir=tmp_path, batch_size=1)
    with TestClient(create_app(cfg, Pipeline(cfg, archive))) as client:
        body = {"ra_deg": 20, "dec_deg": 5}
        path = "/api/archive/channels/D6"
        first = client.post(path, json=body).json()
        assert first["channels"] == ["D6 4.020000 µm (7)"] and first["total"] == 2
        second = client.post(path, json=body, params={"cursor": first["next_cursor"]}).json()
        assert second["channels"] == ["D6 4.020000 µm (7)", "D6 4.120000 µm (7)"]
        assert second["next_cursor"] is None
        changed = client.post(path, json={**body, "ra_deg": 30}).json()
        assert changed["channels"] == ["D6 4.030000 µm (7)"]
        assert archive.fields == [20, 30]
        assert archive.lookups == [("https://test/0", 20), ("https://test/1",20), ("https://test/0",30)]
        incomplete = client.post(path, json={**body, "ra_deg": 40}).json()
        assert incomplete["unavailable"] == 1
        next_page = client.post(path, json={**body, "ra_deg": 40},
                                params={"cursor": incomplete["next_cursor"]}).json()
        assert next_page["unavailable"] == 0 and next_page["channels"] == ["D6 4.140000 µm (7)"]


def test_bounded_range_index_matches_cutout_wcs():
    from astropy.io import fits
    from app.spectral import spectral_header_index

    fixture = Path(__file__).parent / "fixtures" / "wise-d6.fits"
    obs = Observation("sample", "sample.fits", 60800.7, "D6", "DR1")
    q = Query(ra_deg=133.795129, dec_deg=-7.245147)
    decoded = decode(fixture, obs, q, obs.uri)
    with fits.open(fixture) as hdus:
        prefix = (hdus[0].header.tostring() + hdus["IMAGE"].header.tostring()).encode("ascii")
        table = io.BytesIO()
        fits.HDUList([fits.PrimaryHDU(), hdus["WCS-WAVE"].copy()]).writeto(table)
    index = spectral_header_index(prefix, table.getvalue(), q)
    assert index["processing_version"] == decoded.version
    np.testing.assert_allclose([index["wavelength_um"], index["bandwidth_um"]],
                               [decoded.wavelengths[0], decoded.bandwidths[0]])


def test_channel_menu_probes_only_requested_detector_and_reuses_calibration(tmp_path):
    import httpx
    from astropy.io import fits
    from fastapi.testclient import TestClient
    from app.main import create_app
    from app.schemas import Job

    fixture = Path(__file__).parent / "fixtures" / "wise-d6.fits"
    with fits.open(fixture) as hdus:
        prefix = (hdus[0].header.tostring() + hdus["IMAGE"].header.tostring()).encode("ascii")
        table = io.BytesIO()
        fits.HDUList([fits.PrimaryHDU(), hdus["WCS-WAVE"].copy()]).writeto(table)
    requests = []
    def respond(req):
        path, spec = req.url.path, req.headers["Range"]
        requests.append((path.rsplit("/", 1)[-1], spec))
        assert req.method == "GET" and req.url.query == b""
        if path.endswith("/unsupported.fits"):
            class FullImage(httpx.SyncByteStream):
                def __iter__(self):
                    raise AssertionError("An ignored Range downloaded the full product")
            return httpx.Response(200, stream=FullImage())
        if spec == "bytes=0-92159":
            return httpx.Response(206, headers={"Content-Range": "bytes 0-92159/200000"},
                                  content=prefix.ljust(92160))
        assert spec == "bytes=-28800"
        return httpx.Response(206, headers={"Content-Range": "bytes 171200-199999/200000"},
                              content=table.getvalue().rjust(28800, b" "))

    cfg = Settings(cache_dir=tmp_path, batch_size=1)
    archive = Archive(cfg)
    archive.client.close()
    archive.client = httpx.Client(transport=httpx.MockTransport(respond))
    now = datetime.now(UTC)
    job_id = "a" * 32
    records = [ObservationRecord(
        id=name, observed_at=now.isoformat(), detector=det, release="dr1", channel=channel,
        source_url=f"https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/{name}.fits",
    ) for name, det, channel in [
        ("d1", "D1", None), ("known", "D6", "D6 4.000000 µm (7.0.5)"),
        ("first", "D6", None), ("second", "D6", None), ("unsupported", "D6", None),
    ]]
    q = Query(ra_deg=133.795129, dec_deg=-7.245147, live=True, detectors=["D1"])
    m = Manifest(query=q, retrieved_at=now.isoformat(), observations=records, discovery_complete=True)
    job = Job(job_id=job_id, status="complete", manifest=m, created_at=now.isoformat(),
              expires_at=(now + timedelta(hours=1)).isoformat())
    app = create_app(cfg, Pipeline(cfg, archive))
    try:
        with TestClient(app) as client:
            app.state.jobs.records[job_id] = job
            url = f"/api/jobs/{job_id}/channels/D6"
            first = client.get(url).json()
            assert first["total"] == 4 and len(first["channels"]) == 2
            assert first["channels"][0] == "D6 4.000000 µm (7.0.5)"
            assert requests == [("first.fits", "bytes=0-92159"), ("first.fits", "bytes=-28800")]
            second = client.get(url, params={"cursor": first["next_cursor"]}).json()
            assert second["channels"] == first["channels"] and second["unavailable"] == 0
            assert requests[-2:] == [("second.fits", "bytes=0-92159"), ("second.fits", "bytes=-28800")]
            final = client.get(url, params={"cursor": second["next_cursor"]}).json()
            assert final["channels"] == first["channels"] and final["unavailable"] == 1
            assert final["next_cursor"] is None and requests[-1] == ("unsupported.fits", "bytes=0-92159")
            assert len(requests) == 5 and not m.frames and not records[2].channel
            # The same versioned FITS can be reused at a different center, but
            # its wavelength must be evaluated again at that sky coordinate.
            shifted = q.model_copy(update={"dec_deg": q.dec_deg + .0003})
            recalibrated = archive.spectral_at(records[2].source_url, shifted, time.monotonic() + 2)
            expected = decode(fixture, Observation("first", records[2].source_url, 60800, "D6", "DR1"),
                              shifted, "fixture").wavelengths[0]
            assert recalibrated["wavelength_um"] == pytest.approx(expected, abs=1e-10)
            assert recalibrated["wavelength_um"] != archive.cached_spectral(records[2].source_url, q)["wavelength_um"]
            assert len(requests) == 5
            nominal = Query(ra_deg=q.ra_deg, dec_deg=q.dec_deg, detectors=["D6"], channels={"D6":["D6-16"]})
            product = Observation("geo", records[2].source_url.replace("first.fits", "geo.fits"), 60800, "D6", "DR1")
            assert archive.probe_spectral(product, nominal, time.monotonic()+2) == {"nominal_channel": 16}
            assert requests[5:] == [("geo.fits", "bytes=0-92159")]
            assert client.get(url.replace("D6", "D7")).status_code == 422
    finally:
        archive.close()
