import gzip
import hashlib
import json
from pathlib import Path

from astropy.io import fits
from astropy.wcs import WCS

from app.nominal_geometry import nominal_channel

DATA = Path(__file__).parents[1] / "app" / "data"


def test_channel_map_and_table_match_irsa_r7_calibration():
    raw = gzip.decompress((DATA / "channel-map-v2.u8.gz").read_bytes())
    assert hashlib.sha256(raw).hexdigest() == "29d44814de3894e1e93ee633a5e4f5fe2dff6264553196ae8eebb79cb0214c93"
    table = json.loads((DATA / "spherex-spectra.json").read_text())
    assert set(table) == {f"D{i}" for i in range(1, 7)}
    for rows in table.values():
        assert [row["channel"] for row in rows] == list(range(1, 18))
        assert all(row["min_um"] <= row["center_um"] <= row["max_um"] for row in rows)
    assert table["D6"][0] == {"channel": 1, "center_um": 4.435, "min_um": 4.4184, "max_um": 4.4524}


def test_full_and_cropped_detector_channel_and_edges():
    h = fits.Header({"NAXIS1": 2040, "NAXIS2": 2040})
    for detector in ("D1", "D4", "D6"):
        assert nominal_channel(detector, h, 0, 0) == 18
        assert nominal_channel(detector, h, 1019, 10) == 17
        assert nominal_channel(detector, h, 1019, 1019) == 9
        assert nominal_channel(detector, h, 1019, 2000) == 0
        assert nominal_channel(detector, h, 2039, 2039) == 1
    assert nominal_channel("D2", h, -0.51, 1) is None
    crop = fits.Header({"NAXIS1": 5, "NAXIS2": 5, "CRPIX1A": -1016, "CRPIX2A": -7})
    assert nominal_channel("D6", crop, 2, 2) == 17
    assert nominal_channel("D6", crop, 5, 2) is None
    del crop["CRPIX2A"]
    assert nominal_channel("D6", crop, 2, 2) is None


def test_wise_d6_real_cutout():
    h = fits.getheader(Path(__file__).parent / "fixtures" / "wise-d6.fits", "IMAGE")
    x, y = WCS(h).celestial.world_to_pixel_values(133.795129, -7.245147)
    original = (float(x), float(y))
    assert nominal_channel("D6", h, x, y) == 16
    assert (float(x), float(y)) == original
