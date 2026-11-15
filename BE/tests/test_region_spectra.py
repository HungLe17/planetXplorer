from pathlib import Path
import shutil

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.archive import Archive, ArchiveError, Observation
from app.config import Settings
from app.main import create_app
from app.pipeline import Pipeline, target_grid
from app.region_spectra import Aperture, RegionCatalog


FIELD = dict(ra_deg=133.795129, dec_deg=-7.245147, fov_arcsec=30, width=5, height=5)
FIXTURE = Path(__file__).parent / "fixtures" / "wise-d6.fits"


def test_north_up_aperture_pixel_grid_survives_ra_wrap_and_poles():
    region = RegionCatalog(Aperture(**{**FIELD, "ra_deg": 359.999, "dec_deg": 87.0}, box=(0, 0, 2, 1)))
    parent, _ = target_grid(region.field)
    assert region.shape == (2, 3)
    for x, y in [(0, 0), (2, 1)]:
        assert region.grid.pixel_to_world(x, y).separation(parent.pixel_to_world(x, y + 3)).arcsec < 1e-7
    def footprint(vertices):
        xy = np.asarray(vertices).T
        coords = region.grid.pixel_to_world(*xy)
        return "POLYGON ICRS " + " ".join(str(n) for n in np.column_stack((coords.ra.deg, coords.dec.deg)).flat)
    # The detector crosses two region edges although none of its corners are inside.
    assert region.intersects(footprint([(-3, .8), (4, .7), (4, .9), (-3, 1.0)]))
    assert not region.intersects(footprint([(2.4, 2.8), (4, 2.7), (4, 3), (2.4, 3)]))
    with pytest.raises(ArchiveError):
        region.intersects("")
    assert region.cutout.fov_arcsec >= 30


def test_exposure_bins_keep_signed_values_and_do_not_turn_saturated_nan_into_a_measurement():
    region = RegionCatalog(Aperture(**FIELD, box=(1, 1, 3, 2)))
    obs = Observation("example", "https://example.com", 60800.5, "D1", "DR1")
    data = np.array([[-5, np.nan, 1], [9, 50, 80]])
    wave = np.array([[1, 1.01, 1.02], [1.23, 1.5, np.nan]])
    states = np.array([[2, 3, 4], [1, 0, 2]])
    measurement, _ = region.reduce(obs, data, np.stack([wave, np.full(wave.shape, .1)]), states, {})
    assert measurement["pixels"] == 6 and measurement["covered"] == 5
    assert measurement["finite"] == 3
    assert measurement["bins"] == [
        {"wave": 1.01, "mean": -2, "finite": 2}, {"wave": 1.23, "mean": 9, "finite": 1},
    ]


def test_truncated_polygon_search_subdivides_time_without_a_fixed_page_cap(monkeypatch):
    a = Archive(Settings(metadata_limit=10))
    def collection(name, position, lo, hi, deadline, *, footprints=False):
        assert position.startswith("CIRCLE ") and footprints and lo is None and hi is None
        return [{"time_bounds_lower": date} for date in (60801., 60802., 60803.)], True
    try:
        monkeypatch.setattr(a, "_sia_collection", collection)
        rows, windows = a.region_page("CIRCLE 0 0 1", ("spherex_dr1", None, None), lambda row: True)
        assert not rows and windows == [("spherex_dr1", None, 60802.), ("spherex_dr1", 60802., None)]
    finally:
        a.close()


def test_region_endpoints_reconcile_releases_retry_partial_downloads_and_measure_real_fits(tmp_path):
    class FixtureArchive:
        fetches = []
        pages = []

        def region_page(self, position, window, intersects):
            assert position.startswith("CIRCLE ")
            name, lo, hi = window
            assert lo is None and hi is None
            self.pages.append(name)
            release = "DR1" if "dr1" in name else "QR3"
            row = Observation("2025W19_1B_0116_1D6", "https://example.com/" + release, 60800.7, "D6", release)
            later = Observation("later-D2", "https://example.com/later", 61000.5, "D2", "QR3")
            return ([row] if release == "DR1" else [row, later]), []

        def fetch(self, obs, query, path, deadline):
            self.fetches.append(obs)
            assert not query.start_utc and not query.end_utc and not query.detectors and not query.channels
            if obs.identity == "later-D2" and self.fetches.count(obs) == 1:
                raise ArchiveError("Temporary fixture failure")
            shutil.copyfile(FIXTURE, path)
            return obs.uri

    settings = Settings(cache_dir=tmp_path)
    archive = FixtureArchive()
    pipeline = Pipeline(settings, archive)
    with TestClient(create_app(settings, pipeline)) as client:
        assert client.post("/api/region-spectra", json={**FIELD, "box": [0, 0, 6, 2]}).status_code == 422
        opened = client.post("/api/region-spectra", json={**FIELD, "box": [1, 1, 3, 3]})
        assert opened.status_code == 201
        path = "/api/region-spectra/" + opened.json()["id"]
        while (page := client.post(path + "/catalog").json())["discovering"]:
            pass
        assert set(archive.pages) == {"spherex_dr1","spherex_dr1_deep","spherex_qr3","spherex_qr3_deep"}
        ids = [r["id"] for r in page["records"]]
        assert page["count"] == 2 and page["records"][0]["release"] == "DR1"
        assert len(page["visits"]) == 2
        batch = client.post(path + "/measure", json={"ids": ids}).json()
        assert batch["errors"] == {"later-D2": "Temporary fixture failure"}
        first = batch["measurements"][0]
        assert first["id"] == ids[0] and first["finite"] == 9 and first["pixels"] == 9
        assert all(4.9 < b["wave"] < 5.1 for b in first["bins"])
        assert sum(b["finite"] for b in first["bins"]) == 9
        retried = client.post(path + "/measure", json={"ids": ids}).json()
        assert not retried["errors"] and len(retried["measurements"]) == 2
        assert len(archive.fetches) == 3 and {o.release for o in archive.fetches if o.identity == ids[0]} == {"DR1"}
