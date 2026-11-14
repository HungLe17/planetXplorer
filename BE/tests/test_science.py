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
            if obs.identity == bad.identity:
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
        == "frame-0000.png"
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


def test_distinct_wavelength_groups_are_preserved_and_later_batches_extend_them(
    tmp_path, monkeypatch
):
    import shutil
    import app.pipeline as pipeline_module
    from app.config import Settings
    from app.pipeline import Pipeline

    observations = [
        replace(OBS, identity=f"obs-{i}", mjd=OBS.mjd + i) for i in range(6)
    ]

    class Recorded:
        def search(self, *_):
            return observations, []

        def fetch(self, obs, query, path, deadline):
            shutil.copyfile(FIXTURE, path)
            return SOURCE

    original_decode = pipeline_module.decode

    def spectral_fixture(path, obs, query, source):
        c = original_decode(path, obs, query, source)
        wavelength = 1.0 if int(obs.identity[-1]) % 2 == 0 else 2.0
        return replace(
            c, wavelengths=np.full(5, wavelength), bandwidths=np.full(5, 0.1)
        )

    monkeypatch.setattr(pipeline_module, "decode", spectral_fixture)
    pipeline = Pipeline(Settings(batch_size=4), Recorded())
    result = pipeline.run(QUERY, tmp_path, "groups", lambda _: None)
    assert len(result.observations) == 6 and len(result.frames) == 4
    assert len(result.sequences) == 2
    locked = {g.id: dict(g.stretch) for g in result.sequences}
    old_frames = {f.id for f in result.frames}
    result = pipeline.load(
        result, ["obs-4", "obs-5"], tmp_path, "groups", lambda _: None
    )
    assert len(result.frames) == 6 and len(result.sequences) == 2
    assert old_frames.issubset({f.id for f in result.frames})
    assert all(g.stretch == locked[g.id] for g in result.sequences)
    assert all(len(g.frame_ids) == 3 for g in result.sequences)
    assert all(o.status == "ready" for o in result.observations)
