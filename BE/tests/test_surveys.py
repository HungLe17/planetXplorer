import io

import httpx
import numpy as np
from astropy.io import fits
from astropy.table import Table
from fastapi.testclient import TestClient
from PIL import Image
import base64

from app import desi, surveys
from app.config import Settings
from app.main import create_app


def test_desi_wraps_ra_and_preserves_large_ids(tmp_path):
    rows = np.array([(0, 359.99, 39633162325724409, 0.34685), (0, 1, 22, 0.5)], dtype=desi.FIELDS)
    for name in desi.CATALOGS:
        np.save(tmp_path / name, rows if name == "BGS_ANY_NGC" else rows[:0])
    result = desi.galaxies(tmp_path, 0, 0)
    assert len(result) == 1
    assert result[0]["id"] == "39633162325724409"
    assert result[0]["tracers"] == ["BGS_ANY"]


def test_desi_api_distinguishes_missing_index_and_empty_field(tmp_path):
    settings = Settings(cache_dir=tmp_path / "cache", desi_dir=tmp_path / "catalogs")
    settings.desi_dir.mkdir()
    host = {"ra_deg": 269.4462685026598, "dec_deg": 4.768204478798892}
    row = np.array([(host["dec_deg"], host["ra_deg"], 39633162325724409, 0.34685)], dtype=desi.FIELDS)
    for name in desi.CATALOGS[:-1]:
        np.save(settings.desi_dir / name, row if name == "BGS_ANY_NGC" else row[:0])
    with TestClient(create_app(settings, pipeline=object())) as client:
        response = client.post("/api/surveys/desi", json=host)
        assert response.status_code == 503 and response.json()["detail"]["code"] == "desi_index_missing"
        np.save(settings.desi_dir / desi.CATALOGS[-1], row[:0])
        response = client.post("/api/surveys/desi", json=host)
        assert response.status_code == 200
        assert [g["id"] for g in response.json()["galaxies"]] == ["39633162325724409"]
        empty = client.post("/api/surveys/desi", json={"ra_deg": 10, "dec_deg": 60})
        assert empty.status_code == 200 and empty.json()["galaxies"] == []


def test_prepare_desi_catalog_accepts_a_complete_stream_without_content_length(tmp_path):
    sample = np.array([(2., 359., 1, 0.4), (-1., 0., 2, 0.7)], dtype=desi.FIELDS)
    buffer = io.BytesIO()
    fits.BinTableHDU(sample).writeto(buffer)
    body = buffer.getvalue()

    def respond(req):
        assert str(req.url) == desi.LSS + "BGS_ANY_NGC_clustering.dat.fits"
        return httpx.Response(200, content=iter([body[:1000], body[1000:]]))

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        desi.prepare_catalog(tmp_path, "BGS_ANY_NGC", client)
    assert [p.name for p in tmp_path.iterdir()] == ["BGS_ANY_NGC.npy"]
    index = np.load(tmp_path / "BGS_ANY_NGC.npy", allow_pickle=False)
    np.testing.assert_array_equal(index, sample[::-1])


def test_neowise_uses_latest_complete_pair_and_transparent_missing_pixels():
    table = Table(rows=[("11aa", 1, 1, 60000), ("11aa", 1, 2, 60000), ("22bb", 2, 1, 60001)],
                  names=("scan_id", "frame_num", "band", "mjd_obs"))
    meta = io.StringIO()
    table.write(meta, format="ascii.ipac")
    cutout = io.BytesIO()
    fits.PrimaryHDU(np.array([[1, np.nan], [2, 3]])).writeto(cutout)

    def handler(request):
        if "/search/" in request.url.path:
            return httpx.Response(200, text=meta.getvalue())
        assert request.url.params["size"] == "4arcmin"
        return httpx.Response(200, content=cutout.getvalue())

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = surveys.neowise(client, 10, 20)
    assert result["observation_id"] == "11aa-001"
    assert [item["band"] for item in result["images"]] == ["W1", "W2"]
    png = base64.b64decode(result["images"][0]["preview"].split(",")[1])
    with Image.open(io.BytesIO(png)) as image:
        assert image.getpixel((1, 1))[1] == 0


def test_partial_euclid_lookup_preserves_available_release():
    def handler(request):
        if "dr1.calibrated_frame" in request.url.params["QUERY"]:
            return httpx.Response(200, text="filter_name,exposures,latest\nVIS,2,60000\n")
        return httpx.Response(503)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = surveys.euclid(client, 10, 20)
    assert result["unavailable"] == ["Q1"]
    assert result["bands"][0]["count"] == 2
