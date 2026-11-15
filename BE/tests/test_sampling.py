from datetime import UTC, datetime, timedelta
from pathlib import Path
import shutil
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Condition, Event

import pytest

from app.archive import Archive, Observation
from app.config import Settings
from app.pipeline import Pipeline, decode
from app.sampling import sampling_plan
from app.schemas import Manifest, ObservationRecord, Query, Visit


EPOCH = datetime(2025, 5, 1, tzinfo=UTC)


def field(groups, *, channels=None, interval=None, supplemental=False):
    query = Query(ra_deg=10, dec_deg=2, detectors=["D1"], channels=channels or {}, min_separation_days=interval)
    manifest = Manifest(query=query, retrieved_at=EPOCH.isoformat())
    for day, waves in groups:
        date = (EPOCH + timedelta(days=day)).isoformat()
        ids = []
        for index, wave in enumerate(waves):
            key = f"{day}-{index}"
            record = ObservationRecord(id=key, visit_id=str(day), detector="D1", release="DR1",
                                       observed_at=date, source_url="fixture")
            record.set_spectral(dict(wavelength_um=wave, bandwidth_um=.024, processing_version="v"))
            record.selection = record.band_match(query)
            manifest.observations.append(record)
            ids.append(key)
        manifest.visits.append(Visit(id=str(day), start_utc=date, end_utc=date, observation_ids=ids,
                                     status="pending", kind="supplemental" if supplemental else "cycle"))
    return manifest


def test_coverage_counts_cycles_and_prioritizes_both_ends_before_repeats():
    groups = [(0, [.8]*9 + [.960]), (30, [.965]), (60, [.960]), (90, [.960])]
    tracks, background = sampling_plan(field(groups), .5)
    assert tracks == [["0-9", "90-0", "30-0", "60-0"], ["0-0"]]
    assert {key for group in background for key in group} == {f"0-{n}" for n in range(1, 9)}
    assert sampling_plan(field(groups, interval=60), .5)[0] == [["0-9", "90-0"], ["0-0"]]
    assert sampling_plan(field(groups[:3], interval=60), .5)[0] == [["0-9", "60-0"], ["0-0"]]
    assert len(sampling_plan(field(groups, supplemental=True), .5)[0]) == 1
    with pytest.raises(ValueError):
        field(groups, interval=-1)


def test_selected_subbands_each_get_representatives():
    groups = [(0, [.8, .96, 1.0]), (45, [.8, .96]), (190, [.8, .96, 1.0])]
    channels = {"D1": ["D1 0.80 µm (v)", "D1 0.96 µm (v)"]}
    assert sampling_plan(field(groups, channels=channels), .5) == ([
        ["0-0", "190-0", "45-0"], ["0-1", "190-1", "45-1"],
    ], [])


def test_nominal_selection_requires_geometry_and_keeps_distinct_centers_in_one_track():
    manifest = field([(0, [.96, .965]), (181, [.99, .965]), (365, [.97])],
                     channels={"D1": ["D1-06"]})
    query = manifest.query
    assert query.band_match("D1", .96, .03, "v") == "unknown"
    assert query.band_match("D1", .96, .03, "v", 7) == "excluded"
    assert query.band_match("D1", .96, .03, "v", 0) == "excluded"
    assert query.band_match("D1", .96, .03, "v", 18) == "excluded"
    assert query.band_match("D1", nominal_channel=6) == "matched"
    with pytest.raises(ValueError):
        field([], channels={"D1":["D2-06"]})
    for row in manifest.observations:
        row.nominal_channel = 6 if row.id.endswith("-0") else 7
        row.selection = row.band_match(query)
    tracks, background = sampling_plan(manifest, .5)
    assert tracks == [["0-0", "365-0", "181-0"]] and background == []


def test_quantitative_groups_and_visit_conflicts_respect_geometry():
    from app.pipeline import assign_sequence
    from app.schemas import Frame
    from app.visits import field_visits

    manifest = field([(0, [.96, .9601, 1.1])])
    manifest.discovery_complete = False
    for row, channel in zip(manifest.observations, (6,7,6), strict=True):
        row.nominal_channel = channel
    # The extra detector establishes a cycle candidate instead of an isolated pointing.
    manifest.observations.append(manifest.observations[0].model_copy(update={"id":"D2", "detector":"D2"}))
    visit, = field_visits(manifest, [])
    assert visit.issues == ["D1-06 has overlapping exposures 0-0 and 0-2."]

    frames, sequences = [], []
    for row in manifest.observations[:3]:
        f = Frame(id=row.id+".png", url="/", observation_id=row.id, observed_at=row.observed_at,
                  detector="D1", nominal_channel=row.nominal_channel, release="DR1", source_url="/", processing_version="v",
                  wavelength_um=row.wavelength_um, bandwidth_um=.024, match_wavelengths=[row.wavelength_um]*5,
                  match_bandwidths=[.024]*5)
        assign_sequence(f, frames, sequences, .5)
        frames.append(f)
    # The first and second have identical calibrated responses in different stripes.
    # The third shares the first stripe, but its actual calibrated response differs.
    assert len(sequences) == 3


def test_legacy_cached_image_is_enriched_without_downloading_its_pixels_again(tmp_path):
    import sqlite3

    fixture = Path(__file__).parent / "fixtures" / "wise-d6.fits"
    query = Query(live=True, ra_deg=133.795129, dec_deg=-7.245147, detectors=["D6"])
    obs = Observation("archived", "https://test/version-1/archived", 60800, "D6", "DR1")
    decoded = decode(fixture, obs, query, obs.uri)
    calibrated = dict(wavelength_um=decoded.wavelengths[0], bandwidth_um=decoded.bandwidths[0],
                      processing_version=decoded.version, nominal_channel=16)
    downloads, geometry = [], []

    class Legacy(Archive):
        def __init__(self):
            pass

        def search(self, *args, **kwargs):
            return [obs], []

        def cached_spectral(self, uri, q):
            return None

        def probe_spectral(self, observation, q, deadline):
            geometry.append(observation.identity)
            return {"nominal_channel":16} if q.channels else calibrated

        def fetch(self, observation, q, path, deadline, **kwargs):
            downloads.append(observation.identity)
            shutil.copyfile(fixture, path)
            return observation.uri

    cfg = Settings(cache_dir=tmp_path / "cache")
    pipeline = Pipeline(cfg, Legacy())
    try:
        first, second = tmp_path / "first", tmp_path / "second"
        first.mkdir()
        second.mkdir()
        pipeline.run(query, first, "old", lambda _: None)
        with sqlite3.connect(pipeline.exposure_cache.path) as db:
            db.execute("UPDATE exposure SET metadata=json_remove(metadata, '$.frame.nominal_channel')")
        query.channels = {"D6":["D6-16"]}
        result = pipeline.run(query, second, "new", lambda _: None)
        assert geometry == ["archived", "archived"] and downloads == ["archived"]
        assert result.frames[0].nominal_channel == result.observations[0].nominal_channel == 16
        assert pipeline.exposure_cache.get(query, obs).frame.nominal_channel == 16
    finally:
        pipeline.transfers.close()


def test_cold_unrestricted_detector_uses_bounded_calibration_to_find_a_common_wavelength(tmp_path):
    query = Query(live=True, ra_deg=133.795129, dec_deg=-7.245147, detectors=["D6"])
    fixture = Path(__file__).parent / "fixtures" / "wise-d6.fits"
    rows = [Observation(f"{cycle}-D{d}", f"https://irsa.ipac.caltech.edu/{cycle}-D{d}",
                        60800 + 90*cycle, f"D{d}", "DR1") for cycle in range(3) for d in range(1, 7)]
    for cycle in range(3):
        rows.append(Observation(f"{cycle}-extra", f"https://irsa.ipac.caltech.edu/{cycle}-extra",
                                60800 + 90*cycle + 1, "D6", "DR1"))
    calibr = decode(fixture, rows[5], query, rows[5].uri)
    probes, images = [], []

    class FieldArchive(Archive):
        def __init__(self):
            pass

        def search(self, *args, **kwargs):
            return rows, []

        def cached_spectral(self, uri, query):
            return None

        def probe_spectral(self, obs, query, deadline):
            probes.append(obs.identity)
            wave = calibr.wavelengths[0] if obs.identity.endswith("D6") else 3 + int(obs.identity[0]) / 4
            return dict(wavelength_um=wave, bandwidth_um=calibr.bandwidths[0], processing_version=calibr.version)

        def fetch(self, obs, query, path, deadline, **kwargs):
            images.append(obs.identity)
            shutil.copyfile(fixture, path)
            return obs.uri

    pipeline = Pipeline(Settings(cache_dir=tmp_path / "cache", cutout_workers=1), FieldArchive())
    try:
        result = pipeline.run(query, tmp_path, "test", lambda _: None)
        assert set(probes) == {r.identity for r in rows if r.detector == "D6"}
        assert images == ["0-D6", "2-D6", "1-D6", "0-extra", "1-extra", "2-extra"]
    finally:
        pipeline.transfers.close()


def test_early_raw_image_satisfies_the_supplemental_fallback(tmp_path):
    query = Query(live=True, ra_deg=133.795129, dec_deg=-7.245147, detectors=["D6"])
    fixture = Path(__file__).parent / "fixtures" / "wise-d6.fits"
    rows = [Observation(str(i), f"https://irsa.ipac.caltech.edu/{i}", 60800+i, "D6", "DR1") for i in range(3)]
    calibrated = decode(fixture, rows[0], query, rows[0].uri)
    info = dict(wavelength_um=calibrated.wavelengths[0], bandwidth_um=calibrated.bandwidths[0],
                processing_version=calibrated.version)
    query.channels = {"D6": [f"D6 {calibrated.wavelengths[0]:.6f} µm ({calibrated.version})"]}
    arrived = Event()
    images = []

    class FastPreview(Archive):
        def __init__(self):
            pass

        def search(self, query, deadline, *, on_candidate, **kwargs):
            on_candidate(rows[-1])
            assert arrived.wait(5)
            return rows, []

        def cached_spectral(self, uri, query):
            return info

        def fetch(self, obs, query, path, deadline, **kwargs):
            images.append(obs.identity)
            shutil.copyfile(fixture, path)
            return obs.uri

    pipeline = Pipeline(Settings(cache_dir=tmp_path / "cache"), FastPreview())
    try:
        result = pipeline.run(query, tmp_path, "test", lambda _: None,
                              publish=lambda manifest: arrived.set() if manifest.frames else None)
        assert images == ["2"]
        assert result.processing["sampling_order"] == ["2"]
    finally:
        pipeline.transfers.close()


def test_later_spectrum_waits_for_slow_and_failed_cycles(tmp_path):
    query = Query(live=True, ra_deg=133.795129, dec_deg=-7.245147, detectors=["D6"])
    fixture = Path(__file__).parent / "fixtures" / "wise-d6.fits"
    rows = [Observation(f"{cycle}-D{d}", f"https://irsa.ipac.caltech.edu/{cycle}-D{d}",
                        60800 + 180*cycle, f"D{d}", "DR1") for cycle in range(3) for d in range(1, 7)]
    for cycle in range(3):
        rows.append(Observation(f"{cycle}-B", f"https://irsa.ipac.caltech.edu/{cycle}-B",
                                60800 + 180*cycle + 1, "D6", "DR1"))
    decoded = decode(fixture, rows[5], query, rows[5].uri)
    gate, changed = Event(), Condition()
    started = []

    class TwoTracks(Archive):
        def __init__(self):
            pass

        def search(self, query, deadline, *, on_candidate, **kwargs):
            assert on_candidate is None  # An arbitrary first FITS could be the later wavelength.
            return rows, []

        def cached_spectral(self, uri, query):
            offset = .5 if uri.endswith("-B") else 0
            return dict(wavelength_um=decoded.wavelengths[0] + offset, bandwidth_um=decoded.bandwidths[0],
                        processing_version=decoded.version)

        def fetch(self, obs, query, path, deadline, **kwargs):
            with changed:
                started.append(obs.identity)
                changed.notify_all()
            if obs.identity == "0-D6":
                assert gate.wait(10)
            if obs.identity == "1-D6":
                raise ValueError("Unavailable first-track exposure")
            shutil.copyfile(fixture, path)
            return obs.uri

    pipeline = Pipeline(Settings(cache_dir=tmp_path / "cache", cutout_workers=2), TwoTracks())
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            run = pool.submit(pipeline.run, query, tmp_path, "test", lambda _: None)
            try:
                with changed:
                    assert changed.wait_for(lambda: len(started) == 3, 5)
                    assert set(started) == {"0-D6", "1-D6", "2-D6"}
                    assert not changed.wait_for(lambda: len(started) > 3, .25)
            finally:
                gate.set()
            result = run.result(timeout=15)
        assert set(started[3:]) == {"0-B", "1-B", "2-B"}
        assert result.omissions[0]["observation_id"] == "1-D6"
    finally:
        pipeline.transfers.close()


def test_metadata_only_followup_classifies_unknown_without_a_fits(tmp_path):
    query = Query(live=True, ra_deg=10, dec_deg=2, detectors=["D1"])
    manifest = field([(0, [.8, 1.1]), (180, [.8, 1.1])])
    manifest.query = query
    for row in manifest.observations:
        row.channel = row.wavelength_um = row.bandwidth_um = None
    probes = []

    class Headers(Archive):
        def __init__(self):
            pass

        def probe_spectral(self, obs, query, deadline):
            probes.append(obs.identity)
            if obs.identity == "0-1":
                return None
            return dict(wavelength_um=.8, bandwidth_um=.02, processing_version="v")

        def fetch(self, *args, **kwargs):
            pytest.fail("metadata_only opened an image cutout")

    pipeline = Pipeline(Settings(cache_dir=tmp_path / "cache"), Headers())
    try:
        result = pipeline.load(manifest, ["0-0", "0-1", "180-0"], tmp_path, "test", lambda _: None, metadata_only=True)
        assert set(probes) == {"0-0", "0-1", "180-0"}
        assert result.frames == [] and result.processing["sampling_metadata_ids"] == ["180-1"]
        failed = next(r for r in result.observations if r.id == "0-1")
        assert failed.selection == "unavailable" and failed.status == "pending"
    finally:
        pipeline.transfers.close()


def test_progressive_channel_menu_returns_first_label_before_slow_headers(tmp_path):
    from fastapi.testclient import TestClient
    from app.main import create_app

    gate = Event()
    calls = []
    values = {}
    rows = [Observation(str(i), f"https://test/{i}", 60800+i, "D1", "DR1") for i in range(3)]

    class SlowHeaders:
        def search(self, query, deadline):
            return rows, []

        def cached_spectral(self, uri, query):
            return values.get((uri, query.ra_deg, query.dec_deg))

        def spectral_at(self, uri, query, deadline):
            calls.append(uri)
            if not uri.endswith("/0"):
                assert gate.wait(5)
            time.sleep(.04)
            info = dict(wavelength_um=.8 + .1 * int(uri[-1]), bandwidth_um=.03, processing_version="v")
            values[uri, query.ra_deg, query.dec_deg] = info
            return info

        def fetch(self, *args, **kwargs):
            pytest.fail("Opening the selector transferred a full FITS")

    cfg = Settings(cache_dir=tmp_path)
    with TestClient(create_app(cfg, Pipeline(cfg, SlowHeaders()))) as client:
        def read():
            return client.post("/api/archive/channels/D1?progressive=true", json={"ra_deg":10, "dec_deg":2}).json()

        try:
            start = time.monotonic()
            first = read()
            elapsed = time.monotonic() - start
            assert elapsed < 1 and first["channels"] == ["D1 0.800000 µm (v)"]
            assert first["pending"] == 2 and first["next_cursor"] == 0
            assert read()["channels"] == first["channels"]
        finally:
            gate.set()
        end = time.monotonic() + 2
        while (final := read())["pending"] and time.monotonic() < end:
            time.sleep(.01)
        assert final["next_cursor"] is None and len(final["channels"]) == 3
        assert sorted(calls) == [r.uri for r in rows]
        print(f"First matching menu wavelength in {elapsed * 1000:.0f} ms while two headers remained pending")


def test_two_detector_menus_share_one_partial_discovery(tmp_path):
    from app.jobs import Jobs

    entered, release = Event(), Event()
    calls = []

    class Partial:
        def search(self, query, deadline):
            calls.append(query.ra_deg)
            entered.set()
            assert release.wait(5)
            return [], ["Partial metadata: one collection is unavailable"]

    cfg = Settings(cache_dir=tmp_path)
    jobs = Jobs(cfg, Pipeline(cfg, Partial()))
    query = Query(ra_deg=1, dec_deg=2)
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(jobs.field_channels, query, "D1", 0, progressive=True)
            assert entered.wait(2)
            second = pool.submit(jobs.field_channels, query, "D6", 0, progressive=True)
            release.set()
            assert not first.result()["catalog_complete"] and not second.result()["catalog_complete"]
        assert not jobs.field_channels(query, "D2", 0)["catalog_complete"]
        assert calls == [1.]
    finally:
        release.set()
        jobs.close()
