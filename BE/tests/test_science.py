from dataclasses import replace
from pathlib import Path
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS
from PIL import Image
from app.archive import Observation
from app.pipeline import (
    Cutout,
    align,
    choose_group,
    compatible,
    decode,
    render_pngs,
    target_grid,
)
from app.schemas import Query

QUERY = Query(ra_deg=133.795129, dec_deg=-7.245147)
SOURCE = "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/test.fits"
OBS = Observation("2025W19_1B_0116_1D6", SOURCE, 60800.700028, "D6", "DR1")
FIXTURE = Path(__file__).parent / "fixtures" / "wise-d6.fits"


def test_real_cutout_decodes_and_preserves_source_flagged_pixels():
    c = decode(FIXTURE, OBS, QUERY, SOURCE)
    assert c.data.shape == (49, 49)
    assert 4.96 < c.wavelengths[0] < 4.98
    assert 0.03 < c.bandwidths[0] < 0.04
    with fits.open(FIXTURE) as h:
        source = h["FLAGS"].data == (1 << 21)
        damaged = (
            h["FLAGS"].data.astype(np.uint64) & np.uint64(0xFFFFFFFFFFDFFFFF)
        ) != 0
    assert np.count_nonzero(source) > 100
    assert np.any(c.valid[source])
    assert not np.any(c.valid[damaged])
    grid, shape = target_grid(QUERY)
    output = align(c, grid, shape)
    assert output.shape == (49, 49)
    assert np.count_nonzero(np.isfinite(output)) > 100


def test_compatibility_is_pairwise_and_rejects_different_calibration():
    c = decode(FIXTURE, OBS, QUERY, SOURCE)
    a = replace(c, wavelengths=np.ones(5), bandwidths=np.full(5, 0.1))
    b = replace(
        a,
        wavelengths=np.full(5, 1.04),
        observation=replace(OBS, identity="b", mjd=60802),
    )
    d = replace(
        a,
        wavelengths=np.full(5, 1.08),
        observation=replace(OBS, identity="c", mjd=60801),
    )
    group = choose_group([d, a, b], 0.5)
    assert len(group) == 2
    assert all(compatible(x, y, 0.5) for x in group for y in group)
    assert [x.observation.mjd for x in group] == sorted(
        x.observation.mjd for x in group
    )
    assert not compatible(a, replace(a, version="different"), 0.5)
    assert not compatible(a, replace(a, observation=replace(OBS, detector="D2")), 0.5)


def test_stationary_source_stays_aligned_and_invalid_support_stays_masked():
    grid, shape = target_grid(QUERY)
    yy, xx = np.indices(shape)
    data = np.exp(-((xx - 24) ** 2 + (yy - 24) ** 2) / 8)
    c = Cutout(
        OBS,
        data,
        np.ones(shape, dtype=bool),
        grid,
        np.ones(5),
        np.ones(5) * 0.03,
        "v1",
        SOURCE,
    )
    other_wcs = WCS(grid.to_header())
    other_wcs.wcs.crpix += [3, -2]
    shifted = Cutout(
        OBS,
        np.exp(-((xx - 27) ** 2 + (yy - 22) ** 2) / 8),
        np.ones(shape, dtype=bool),
        other_wcs,
        np.ones(5),
        np.ones(5) * 0.03,
        "v1",
        SOURCE,
    )
    for image in (align(c, grid, shape), align(shifted, grid, shape)):
        assert np.unravel_index(np.nanargmax(image), shape) == (24, 24)
    c.valid[24, 24] = False
    assert np.isnan(align(c, grid, shape)[24, 24])
    west = grid.pixel_to_world_values(23, 24)[0]
    east = grid.pixel_to_world_values(25, 24)[0]
    assert west > east  # RA increases to the left


def test_shared_stretch_preserves_relative_brightness_and_north_orientation(tmp_path):
    a = np.arange(100, dtype=float).reshape(10, 10)
    b = a * 2
    a[0, 0] = np.nan
    paths = [tmp_path / "a.png", tmp_path / "b.png"]
    stretch = render_pngs([a, b], paths)
    x, y = [np.asarray(Image.open(p)) for p in paths]
    assert stretch["vmax"] > 100
    assert x[-1, 0, 3] == 0
    assert y[5, 5, 0] > x[5, 5, 0]
    assert x[0, 5, 0] > x[-1, 5, 0]


@pytest.mark.parametrize("ra,dec", [(360, 0), (-1, 0), (0, 91), (0, -91), ("NaN", 0)])
def test_invalid_coordinates(ra, dec):
    with pytest.raises(ValueError):
        Query(ra_deg=ra, dec_deg=dec)


def test_full_pipeline_with_recorded_fits_and_a_failed_exposure(tmp_path):
    import shutil
    import json
    from app.config import Settings
    from app.pipeline import Pipeline

    bad = replace(OBS, identity="bad")

    class RecordedArchive:
        def search(self, *_):
            return [bad, OBS], []

        def fetch(self, obs, query, path, deadline):
            if obs is bad:
                path.write_bytes(b"not a FITS file")
            else:
                shutil.copyfile(FIXTURE, path)
            return SOURCE

    stages = []
    result = Pipeline(Settings(), RecordedArchive()).run(
        QUERY, tmp_path, "test", stages.append
    )
    assert len(result.frames) == 1
    assert result.omissions[0]["observation_id"] == "bad"
    assert result.frames[0].source_url == SOURCE
    assert Image.open(tmp_path / result.frames[0].id).size == (49, 49)
    assert (
        json.loads((tmp_path / "manifest.json").read_text())["frames"][0]["id"]
        == "frame-00.png"
    )
    assert not list(tmp_path.glob("raw-*.fits"))
    assert stages[-2:] == ["align", "render"]


def test_rejects_quality_map_with_a_different_sky_grid(tmp_path):
    path = tmp_path / "mismatch.fits"
    with fits.open(FIXTURE) as h:
        h["FLAGS"].header["CRPIX1"] += 1
        h.writeto(path)
    with pytest.raises(ValueError, match="sky grid differs"):
        decode(path, OBS, QUERY, SOURCE)


def test_cutouts_download_concurrently_with_progress(tmp_path):
    import shutil
    import threading
    from app.config import Settings
    from app.pipeline import Pipeline

    barrier = threading.Barrier(2, timeout=3)

    class ParallelArchive:
        def search(self, *_):
            return [OBS, replace(OBS, identity="second", mjd=OBS.mjd + 1)], []

        def fetch(self, obs, query, path, deadline):
            barrier.wait()
            shutil.copyfile(FIXTURE, path)
            return SOURCE

    stages = []
    result = Pipeline(Settings(cutout_workers=2), ParallelArchive()).run(
        QUERY, tmp_path, "parallel", stages.append
    )
    assert len(result.frames) == 2
    assert "fetch:2/2" in stages
    assert not list(tmp_path.glob("raw-*.fits"))


def test_numeric_frames_match_masked_data_and_requested_fov(tmp_path):
    import shutil
    from app.config import Settings
    from app.pipeline import Pipeline

    query = QUERY.model_copy(update={"live": True, "fov_arcsec": 120})
    class LocalArchive:
        def search(self, *_):
            return [OBS], []
        def fetch(self, obs, query, path, deadline):
            shutil.copyfile(FIXTURE, path)
            return SOURCE

    m = Pipeline(Settings(cache_dir=tmp_path / "cache"), LocalArchive()).run(query,tmp_path,"live",lambda stage: None)
    grid, shape = target_grid(query)
    assert shape == (20,20)
    array = np.fromfile(tmp_path/m.frames[0].pixels,dtype="<f4").reshape(shape)
    expected = np.flipud(align(decode(FIXTURE,OBS,query,SOURCE),grid,shape))
    np.testing.assert_allclose(array,expected,rtol=1e-6,equal_nan=True)
    assert m.frames[0].exposure_flags["L2DQAFLG"] == "Pass"


def test_live_publication_precedes_slow_cutout_and_keeps_sorted_assets(tmp_path):
    import shutil
    from threading import Event
    from app.config import Settings
    from app.pipeline import Pipeline

    later = replace(OBS, identity="later", mjd=OBS.mjd + 2, detector="D5")
    release_earlier = Event()
    snapshots = []
    timings = []

    class DelayedArchive:
        def search(self, *_):
            return [OBS, later], []

        def fetch(self, obs, query, path, deadline):
            if obs == OBS:
                assert release_earlier.wait(10), "First frame was blocked by the slow cutout"
            shutil.copyfile(FIXTURE, path)
            return SOURCE

    def publish(manifest):
        for frame in manifest.frames:
            assert Image.open(tmp_path / Path(frame.url).name).size == (49, 49)
            assert (tmp_path / frame.pixels).stat().st_size == 49 * 49 * 4
        snapshots.append(manifest)
        release_earlier.set()

    m = Pipeline(Settings(cache_dir=tmp_path / "cache"), DelayedArchive()).run(
        QUERY.model_copy(update={"live": True}), tmp_path, "progressive", lambda stage: None,
        publish=publish, timing=lambda *event: timings.append(event),
    )
    assert [[f.observation_id for f in s.frames] for s in snapshots] == [
        ["later"], [OBS.identity, "later"]
    ]
    first = snapshots[0].frames[0]
    assert m.frames[1].id == first.id and m.frames[1].pixels == first.pixels
    assert first.url.endswith("-preview.png") and m.frames[1].url.endswith(first.id)
    assert all((tmp_path / f.id).exists() for f in m.frames)
    assert "No wavelength channel has two usable exposures for a time comparison." in m.warnings
    assert not any("playback is unavailable" in warning for warning in m.warnings)
    for key in ("metadata_search", "cutout_download", "fits_decode", "align", "write_assets", "finalize"):
        assert any(stage == key and seconds >= 0 and status == "ok" for stage, seconds, _, status in timings)


def test_live_candidate_yields_image_before_catalog_and_is_replaced(tmp_path):
    import shutil
    from threading import Event
    from app.archive import Archive
    from app.config import Settings
    from app.pipeline import Pipeline

    published = Event()
    original = replace(OBS, release="QR3")
    revision = replace(OBS, uri=OBS.uri + "-revised")
    snapshots, downloads = [], []

    class SlowCatalog(Archive):
        def __init__(self):
            pass

        def search(self, query, deadline, *, on_candidate, timing):
            on_candidate(original)
            assert published.wait(5), "The early frame was blocked by the remaining lookup"
            return [revision], []

        def fetch(self, obs, query, path, deadline, **kwargs):
            downloads.append(obs)
            shutil.copyfile(FIXTURE, path)
            return obs.uri

    def publish(manifest):
        snapshots.append(manifest)
        if manifest.frames:
            frame = manifest.frames[0]
            assert (tmp_path / frame.pixels).stat().st_size > 0
            assert (tmp_path / Path(frame.url).name).is_file()
            published.set()

    result = Pipeline(Settings(cache_dir=tmp_path / "cache"), SlowCatalog()).run(
        QUERY.model_copy(update={"live": True}), tmp_path, "cold", lambda _: None, publish=publish,
    )
    assert downloads == [original, revision]
    initial, = snapshots[0].frames
    final, = result.frames
    assert initial.release == "QR3" and final.release == "DR1"
    assert initial.observation_id == final.observation_id
    assert initial.pixels != final.pixels
    assert (tmp_path / initial.pixels).is_file()


def test_partial_catalog_cannot_downgrade_preferred_cached_exposure(tmp_path):
    import shutil
    from app.config import Settings
    from app.pipeline import Pipeline

    old = replace(OBS, uri=OBS.uri + "-qr3", release="QR3")
    downloads = []

    class PartialCatalog:
        def search(self, *_):
            if downloads:
                return [old], ["Partial metadata: DR1 temporarily unavailable"]
            return [OBS], []

        def fetch(self, obs, query, path, deadline):
            downloads.append(obs)
            shutil.copyfile(FIXTURE, path)
            return obs.uri

    pipeline = Pipeline(Settings(cache_dir=tmp_path / "cache"), PartialCatalog())
    for name in ("cold", "repeat"):
        directory = tmp_path / name
        directory.mkdir()
        result = pipeline.run(QUERY.model_copy(update={"live": True}), directory, name, lambda _: None)
    assert downloads == [OBS]
    assert result.cached and not result.processing["archive_complete"]
    assert result.processing["archive_products"] == {OBS.identity: OBS.uri}
    assert [f.release for f in result.frames] == ["DR1"]
