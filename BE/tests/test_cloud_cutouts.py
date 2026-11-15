import io
import re
import time
from pathlib import Path

import httpx
import numpy as np
import pytest
from astropy.io import fits
from astropy.wcs import WCS

from app.cloud_cutouts import RangeFile, cloud_cutout, mirror_url
from app.archive import Archive, Observation
from app.config import Settings
from app.pipeline import decode
from app.schemas import Query


URI = "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/test/product.fits"
QUERY = Query(ra_deg=133.795129, dec_deg=-7.245147, fov_arcsec=120)


def product_bytes(compressed_flags=False):
    fixture = Path(__file__).parent / "fixtures" / "wise-d6.fits"
    with fits.open(fixture, memmap=False) as original:
        hdus = [original[0].copy()]
        for name in ("IMAGE", "FLAGS", "VARIANCE"):
            header = original[name].header.copy()
            for key in list(header):
                if re.fullmatch(r"CRPIX[12][A-Z]?", key):
                    header[key] += 100
            data = np.pad(original[name].data, 100)
            image_type = fits.CompImageHDU if compressed_flags and name == "FLAGS" else fits.ImageHDU
            hdus.append(image_type(data=data, header=header))
        hdus.append(original["WCS-WAVE"].copy())
        out = io.BytesIO()
        fits.HDUList(hdus).writeto(out)
        return out.getvalue()


@pytest.mark.parametrize("compressed_flags", [False, True])
def test_cloud_rows_preserve_science_quality_and_spectral_wcs(tmp_path, compressed_flags):
    payload = product_bytes(compressed_flags)
    requests = []

    def serve(request):
        assert request.url.host == "nasa-irsa-spherex.s3.us-east-1.amazonaws.com"
        start, end = map(int, request.headers["Range"].removeprefix("bytes=").split("-"))
        requests.append((start, end))
        assert end < len(payload)
        return httpx.Response(206, headers={"Content-Range": f"bytes {start}-{end}/{len(payload)}"},
                              content=payload[start:end + 1])

    output = tmp_path / "cutout.fits"
    with httpx.Client(transport=httpx.MockTransport(serve)) as client:
        transferred = cloud_cutout(client, URI, QUERY, output, time.monotonic() + 20, 2_000_000)
    assert transferred < len(payload)
    assert all(end - start + 1 < len(payload) for start, end in requests)
    assert len(requests) < 20  # Row strips, rather than one request for every pixel row.
    observation = Observation("test", URI, 60800, "D6", "DR1")
    result = decode(output, observation, QUERY, URI)
    fixture = Path(__file__).parent / "fixtures" / "wise-d6.fits"
    reference = decode(fixture, observation, QUERY, URI)
    np.testing.assert_allclose(result.wavelengths[0], reference.wavelengths[0], rtol=1e-7)
    np.testing.assert_allclose(result.bandwidths[0], reference.bandwidths[0], rtol=1e-7)
    assert result.nominal_channel == reference.nominal_channel
    with fits.open(io.BytesIO(payload)) as full, fits.open(output) as cutout:
        for name in ("IMAGE", "FLAGS", "VARIANCE"):
            ra, dec = WCS(cutout[name].header).celestial.pixel_to_world_values(0, 0)
            x, y = WCS(full[name].header).celestial.world_to_pixel_values(ra, dec)
            sx, sy = round(float(x)), round(float(y))
            np.testing.assert_array_equal(cutout[name].data,
                full[name].data[sy:sy + cutout[name].data.shape[0], sx:sx + cutout[name].data.shape[1]])


@pytest.mark.parametrize("status,range_header", [(200, ""), (206, "bytes 1-65536/1000000"),
                                                   (206, "bytes 0-65535/65535")])
def test_rejects_whole_file_or_wrong_ranges(status, range_header):
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(
            status, headers={"Content-Range": range_header}, content=b"bad"))) as client:
        with pytest.raises(ValueError):
            RangeFile(client, mirror_url(URI), time.monotonic() + 10, 100000)


def test_budget_and_untrusted_mirrors_fail_before_network():
    calls = []
    with httpx.Client(transport=httpx.MockTransport(lambda request: calls.append(request))) as client:
        with pytest.raises(ValueError):
            RangeFile(client, mirror_url(URI), time.monotonic() + 10, 1)
    assert not calls
    for uri in (URI.replace("irsa.ipac.caltech.edu", "evil.test"), URI + "?token=secret",
                URI.replace("/dr1/", "/../"), URI.replace(".fits", ".fits.gz")):
        with pytest.raises(ValueError):
            mirror_url(uri)


def test_cached_headers_reduce_repeat_transfer_without_changing_cutout(tmp_path):
    payload = product_bytes(True)
    requests = []

    def serve(request):
        start, end = map(int, request.headers["Range"].removeprefix("bytes=").split("-"))
        requests.append((start, end))
        return httpx.Response(206, headers={"Content-Range": f"bytes {start}-{end}/{len(payload)}"},
                              content=payload[start:end + 1])

    with httpx.Client(transport=httpx.MockTransport(serve)) as client:
        first = tmp_path / "first.fits"
        second = tmp_path / "second.fits"
        cold = cloud_cutout(client, URI, QUERY, first, time.monotonic() + 20, 2_000_000)
        cold_requests = len(requests)
        requests.clear()
        warm = cloud_cutout(client, URI, QUERY, second, time.monotonic() + 20, 2_000_000)
        assert warm < cold
        assert len(requests) < cold_requests
        assert not any(start == 0 for start, _ in requests)
        assert first.read_bytes() == second.read_bytes()


def test_cloud_failure_retains_original_irsa_cutout_fallback(tmp_path, monkeypatch):
    def unavailable(*args, **kwargs):
        raise ValueError("Ranges unavailable")

    monkeypatch.setattr("app.archive.cloud_cutout", unavailable)
    archive = Archive(Settings())
    archive.client.close()
    requests = []

    def serve(request):
        requests.append(request)
        return httpx.Response(200, content=b"ordinary-irsa-cutout")

    archive.client = httpx.Client(transport=httpx.MockTransport(serve))
    path = tmp_path / "fallback.fits"
    events = []
    try:
        source = archive.fetch(Observation("test", URI, 60800, "D6", "DR1"), QUERY, path,
                               time.monotonic() + 10, timing=lambda *event: events.append(event))
        assert path.read_bytes() == b"ordinary-irsa-cutout"
        assert requests[0].url.host == "irsa.ipac.caltech.edu"
        assert requests[0].url.params["center"] == f"{QUERY.ra_deg},{QUERY.dec_deg}d"
        assert source.startswith(URI + "?")
        assert events[0][0] == "aws_fallback"
    finally:
        archive.close()
