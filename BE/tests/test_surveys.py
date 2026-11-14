import io

import httpx
import numpy as np
from astropy.io import fits
from astropy.table import Table
from PIL import Image
import base64

from app import desi, surveys


def test_desi_wraps_ra_and_preserves_large_ids(tmp_path):
    rows = np.array([(0, 359.99, 39633162325724409, 0.34685), (0, 1, 22, 0.5)], dtype=desi.FIELDS)
    for name in desi.CATALOGS:
        np.save(tmp_path / name, rows if name == "BGS_ANY_NGC" else rows[:0])
    result = desi.galaxies(tmp_path, 0, 0)
    assert len(result) == 1
    assert result[0]["id"] == "39633162325724409"
    assert result[0]["tracers"] == ["BGS_ANY"]


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
