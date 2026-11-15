"""Catalog identity, exposure timing and subpixel positions on archival images."""

import asyncio
import json
from datetime import datetime
from types import SimpleNamespace

import astropy.units as u
import httpx
import numpy as np
import pytest
from astropy.coordinates import SkyCoord
from astropy.time import Time
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import known_catalog as catalog
from app.config import ROOT, Settings
from app.main import create_app
from app.moving_objects import HORIZONS, SPHEREX, MovingField, MovingObjects, field_results
from app.pipeline import target_grid
from app.schemas import Query
from app.spectral import exposure_midpoint


def test_unique_aliases_preserve_motion_and_ambiguous_sources_stay_separate():
    label = "Gaia DR3 4472832130942575872"
    star = catalog.source("Gaia DR3", 1, label, "Gaia source", "gaia", 269.45, 4.74, 2016, -802, 10362)
    named = catalog.source("SIMBAD", 2, "Barnard's star", "BY Dra Variable", "simbad",
                           269.45, 4.69, 2000, -802, 10362, [label])
    infrared = catalog.source("CatWISE2020", 3, "CWISE J1", "Infrared source", "wise",
                              269.45, 4.74, 2015.405, None, None)
    groups = {"Gaia DR3": [star], "SIMBAD": [named], "CatWISE2020": [infrared]}
    combined = catalog.merge_identifications(groups)
    assert len(combined) == 2
    merged = next(o for o in combined if o["id"] == star["id"])
    assert (merged["name"], merged["type"], merged["epoch_jyear"]) == ("Barnard's star", "BY Dra Variable", 2016)
    assert merged["sources"] == ["Gaia DR3", "SIMBAD"]
    # A second claimant prevents either SIMBAD identity from adopting the Gaia data.
    groups["SIMBAD"].append(dict(named, id="SIMBAD:other"))
    assert len(catalog.merge_identifications(groups)) == 4
    assert catalog.can_reach_field(star, 269.45, 4.768, 22, (2025, 2027))
    assert not catalog.can_reach_field(infrared, 269.45, 4.768, 22, (2025, 2027))


def test_catalog_api_cache_and_partial_service_status(tmp_path, monkeypatch):
    calls = []
    def gaia(client, ra, dec, radius):
        calls.append(radius)
        return [], False

    def unavailable(*args):
        raise httpx.ReadTimeout("SIMBAD timeout")

    monkeypatch.setattr(catalog, "gaia", gaia)
    monkeypatch.setattr(catalog, "simbad", unavailable)
    monkeypatch.setattr(catalog, "catwise", lambda *args: ([], True))
    monkeypatch.setattr(catalog, "catalog_cache", catalog.CatalogCache())
    body = dict(ra_deg=359.99, dec_deg=89.5, fov_arcsec=30,
                start_utc="2025-01-30T01:00:00Z", end_utc="2025-05-01T02:00:00Z")
    with TestClient(create_app(Settings(cache_dir=tmp_path))) as client:
        first = client.post("/api/known-objects/catalog", json=body).json()
        second = client.post("/api/known-objects/catalog", json=body).json()
        assert not first["cached"] and second["cached"] and first["fetched_at"] == second["fetched_at"]
        assert "SIMBAD unavailable" in " ".join(first["warnings"])
        assert "coverage is incomplete" in " ".join(first["warnings"])
        assert len(calls) == 1 and calls[0] > 120
        assert client.post("/api/known-objects/catalog", json=dict(body, end_utc="2001-01-01T00:00:00Z")).status_code == 422


def test_barnard_catalog_position_tracks_both_prepared_images():
    path = ROOT / "demos" / "barnard"
    manifest = json.loads((path / "manifest.json").read_text())
    grid, (height, width) = target_grid(Query(**manifest["query"]))
    # Gaia DR3 4472832130942575872, matched by SIMBAD identifier.
    star = SkyCoord(ra=269.44850252543836*u.deg, dec=4.739420051112412*u.deg,
                    pm_ra_cosdec=-801.5509783684709*u.mas/u.yr, pm_dec=10362.394206546573*u.mas/u.yr,
                    distance=1.83*u.pc, obstime=Time(2016, format="jyear"))
    ys = []
    for frame in manifest["frames"]:
        epoch = Time(datetime.fromisoformat(frame["observed_at"]))
        x, y = grid.world_to_pixel(star.apply_space_motion(new_obstime=epoch))
        y = height - 1 - y
        ys.append(y)
        values = np.fromfile(path / frame["quality"], dtype="<f4", count=height*width).reshape(height, width)
        left, top = int(round(float(x))) - 2, int(round(float(y))) - 2
        row, col = np.unravel_index(np.nanargmax(values[top:top+5, left:left+5]), (5, 5))
        assert np.hypot(x - left - col, y - top - row) < 0.7
    assert abs(ys[1] - ys[0]) > 0.9


def test_exposure_midpoint_requires_mean_or_verified_bounds():
    assert exposure_midpoint({"DATE-AVG": "2025-08-04T11:05:01.098"}) == "2025-08-04T11:05:01.098Z"
    assert exposure_midpoint({"DATE-BEG": "2025-08-04T11:04:00", "DATE-END": "2025-08-04T11:06:00"}) == "2025-08-04T11:05:00.000Z"
    assert exposure_midpoint({"DATE-BEG": "2025-08-04T11:04:00"}) is None
    assert exposure_midpoint({"DATE-AVG": "2025-08-04T11:05:01.098", "TIMESYS": "unverified"}) is None


def test_legacy_midpoint_only_reads_and_caches_the_fits_header():
    path = ROOT / "tests" / "fixtures" / "wise-d6.fits"
    frame = SimpleNamespace(midpoint_utc=None, observation_id="legacy", source_url=(
        "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/old.fits?center=2,4&size=0.01"))
    jobs = {"a"*32: SimpleNamespace(manifest=SimpleNamespace(frames=[frame]))}
    field = MovingField(job_id="a"*32, observation_id="legacy", ra_deg=2, dec_deg=4, fov_arcsec=30)
    calls = []
    def metadata(request):
        calls.append(request)
        assert not request.url.query and request.headers["Range"] == "bytes=0-92159"
        with path.open("rb") as stream:
            return httpx.Response(206, content=stream.read(92160),
                                  headers={"Content-Range": f"bytes 0-92159/{path.stat().st_size}"})

    async def run():
        service = MovingObjects(httpx.MockTransport(metadata))
        try:
            for _ in range(2):
                assert (await service.epoch(field, jobs)).isoformat() == "2025-05-05T16:49:00.018000+00:00"
            assert len(calls) == 1
        finally:
            await service.http.aclose()
    asyncio.run(run())


def test_spacecraft_state_before_jpl_lookup_and_cached_vesta():
    # MOST SPHEREx Vesta search, observation 2025W32_1A_0105_1D6.
    field = MovingField(ra_deg=222.866022, dec_deg=-11.907528, fov_arcsec=30,
                        midpoint_utc="2025-08-04T11:05:01.098Z")
    jd = Time(field.midpoint_utc).jd
    calls = []
    def archive(request):
        calls.append(request)
        if str(request.url).startswith(HORIZONS):
            assert request.url.params["COMMAND"] == SPHEREX
            assert request.url.params["CENTER"] == "500@399"
            return httpx.Response(200, json={"signature": {"version": "1.2"}, "result": (
                "Target body name: SPHEREx (-163182)\nCenter body name: Earth (399)\nReference frame: ICRF\n"
                f"Output units : KM-S\nOutput type : GEOMETRIC\nJDUT\n$$SOE\n{jd},date,1,2,3,4,5,6\n$$EOE")})
        params = request.url.params
        assert params["two-pass"] == "true" and params["xobs"] == "1.0,2.0,3.0,4.0,5.0,6.0"
        return httpx.Response(200, json={"signature": {"version": "1.1"}, "n_second_pass": 2,
            "observer": {"obs_date": f"2025-Aug-04 11:05:01 ({jd} UT)"},
            "fields_second": ["Object name", "Astrometric RA", "Astrometric Dec"],
            "data_second_pass": [["4 Vesta (A807 FA)", "14:51:27.89", "-11 54'27.2\""],
                                 ["Outside", "14:52:27.89", "-11 54'27.2\""]]})

    async def run():
        service = MovingObjects(httpx.MockTransport(archive))
        try:
            for _ in range(2):
                result = await service.lookup(field, None, lambda: asyncio.sleep(0, result=False))
                assert len(result["objects"]) == 1
                obj = result["objects"][0]
                assert obj["category"] == "Numbered minor planet"
                point = SkyCoord(obj["ra_deg"], obj["dec_deg"], unit="deg")
                assert point.separation(SkyCoord(field.ra_deg, field.dec_deg, unit="deg")).arcsec < 0.7
            assert len(calls) == 2
        finally:
            await service.http.aclose()
    asyncio.run(run())


def test_jpl_empty_field_and_epoch_mismatch():
    field = MovingField(ra_deg=15, dec_deg=10, fov_arcsec=30)
    payload = {"signature": {"version": "1.1"}, "warning": "no matching records",
               "observer": {"obs_date": "2025-Aug-21 15:27:40 (2460909.144213 UT)"}}
    assert field_results(payload, field, 2460909.144213) == []
    with pytest.raises(ValueError, match="different epoch"):
        field_results(payload, field, 2460909.154213)


def test_jpl_backoff_and_missing_midpoint():
    calls = []
    def throttled(request):
        calls.append(request)
        return httpx.Response(429, headers={"Retry-After": "65"})

    async def run():
        service = MovingObjects(httpx.MockTransport(throttled))
        field = MovingField(ra_deg=15, dec_deg=10, fov_arcsec=30)
        try:
            with pytest.raises(HTTPException) as missing:
                await service.lookup(field, None, lambda: asyncio.sleep(0, result=False))
            assert missing.value.status_code == 422 and not calls
            field.midpoint_utc = datetime.fromisoformat("2025-08-04T11:05:01+00:00")
            for _ in range(2):
                with pytest.raises(HTTPException) as retry:
                    await service.lookup(field, None, lambda: asyncio.sleep(0, result=False))
                assert int(retry.value.headers["Retry-After"]) >= 64
            assert len(calls) == 1
        finally:
            await service.http.aclose()
    asyncio.run(run())
