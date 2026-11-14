import time
from urllib.parse import parse_qs, urlsplit
import httpx
import pytest
from app.archive import Archive, ArchiveError, Observation, checked_url, evenly_spaced
from app.config import Settings
from app.schemas import Query


def archive_with(handler, settings=None):
    archive = Archive(settings or Settings())
    archive.client.close()
    archive.client = httpx.Client(
        transport=httpx.MockTransport(handler), follow_redirects=False
    )
    return archive


def uri(release="dr1", identity="2025W19_1B_0116_1D2", version=27):
    return f"ibe/data/spherex/{release}/level2/2025W19_1B/l2b-v{version}-2026-197/2/level2_{identity}_spx_l2b-v{version}-2026-197.fits"


def test_query_utc_bounds_deduplicates_and_prefers_dr1():
    def handler(request):
        sql = request.url.params["QUERY"]
        assert "60801.0000000000" in sql and "60802.0000000000" in sql
        return httpx.Response(
            200,
            text="uri,time_bounds_lower,energy_bandpassname\n"
            + f"{uri('qr3')},60801.5,SPHEREx-D2\n{uri()},60801.5,SPHEREx-D2\n",
        )

    a = archive_with(handler)
    try:
        rows, notes = a.search(
            Query(
                ra_deg=133,
                dec_deg=-7,
                start_utc="2025-05-06T00:00:00Z",
                end_utc="2025-05-07T00:00:00Z",
            ),
            time.monotonic() + 30,
        )
        assert len(rows) == 1 and rows[0].release == "DR1"
    finally:
        a.close()


def test_empty_metadata_is_success_and_malformed_metadata_is_rejected():
    for text in [
        "uri,time_bounds_lower,energy_bandpassname\n",
        "<VOTABLE>error</VOTABLE>",
    ]:
        a = archive_with(lambda _: httpx.Response(200, text=text))
        try:
            if text.startswith("uri"):
                assert a.search(Query(ra_deg=0, dec_deg=0), time.monotonic() + 30) == (
                    [],
                    [],
                )
            else:
                with pytest.raises(ArchiveError):
                    a.search(Query(ra_deg=0, dec_deg=0), time.monotonic() + 30)
        finally:
            a.close()


@pytest.mark.parametrize(
    "url",
    [
        "http://irsa.ipac.caltech.edu/ibe/data/spherex/x.fits",
        "https://evil.test/ibe/data/spherex/x.fits",
        "https://irsa.ipac.caltech.edu/ibe/data/spherex/../secret",
        "https://user@irsa.ipac.caltech.edu/ibe/data/spherex/x.fits",
        "https://irsa.ipac.caltech.edu/ibe/data/spherex/%2e%2e/x.fits",
    ],
)
def test_untrusted_urls_rejected(url):
    with pytest.raises(ArchiveError):
        checked_url(url)


def test_cutout_redirect_does_not_escape_archive(tmp_path):
    seen = []

    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(302, headers={"Location": "https://evil.test/secret"})

    a = archive_with(handler)
    obs = Observation(
        "id", "https://irsa.ipac.caltech.edu/" + uri(), 60800, "D2", "DR1"
    )
    try:
        with pytest.raises(ArchiveError):
            a.fetch(
                obs,
                Query(ra_deg=0, dec_deg=0),
                tmp_path / "x.fits",
                time.monotonic() + 30,
            )
        assert len(seen) == 1
        params = parse_qs(urlsplit(seen[0]).query)
        assert params["center"] == ["0.0,0.0d"] and float(params["size"][0]) == 5 / 60
    finally:
        a.close()


def test_download_limit_and_http_failure_are_bounded(tmp_path):
    a = archive_with(
        lambda _: httpx.Response(200, content=b"123456"), Settings(max_download_bytes=4)
    )
    obs = Observation(
        "id", "https://irsa.ipac.caltech.edu/" + uri(), 60800, "D2", "DR1"
    )
    try:
        with pytest.raises(ArchiveError, match="download limit"):
            a.fetch(
                obs,
                Query(ra_deg=0, dec_deg=0),
                tmp_path / "x.fits",
                time.monotonic() + 30,
            )
    finally:
        a.close()
    seen = []

    def unavailable(request):
        seen.append(request)
        return httpx.Response(503)

    a = archive_with(unavailable)
    try:
        with pytest.raises(ArchiveError):
            a.search(Query(ra_deg=0, dec_deg=0), time.monotonic() + 30)
        assert len(seen) == 2
    finally:
        a.close()


def test_time_sampling_covers_both_ends():
    assert evenly_spaced(list(range(100)), 3) == [0, 50, 99]
