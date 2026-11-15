import time
import threading
from concurrent.futures import ThreadPoolExecutor
from email.utils import formatdate
from types import SimpleNamespace
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
        rows, notes = a._search_tap(
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
                assert a._search_tap(
                    Query(ra_deg=0, dec_deg=0), time.monotonic() + 30
                ) == (
                    [],
                    [],
                )
            else:
                with pytest.raises(ArchiveError):
                    a._search_tap(Query(ra_deg=0, dec_deg=0), time.monotonic() + 30)
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
            a._search_tap(Query(ra_deg=0, dec_deg=0), time.monotonic() + 30)
        assert len(seen) == 2
    finally:
        a.close()


def test_time_sampling_covers_both_ends():
    assert evenly_spaced(list(range(100)), 3) == [0, 50, 99]


def test_metadata_timeout_budget_and_error_are_explicit():
    budgets = []

    def handler(request):
        budgets.append(request.extensions["timeout"]["read"])
        raise httpx.ReadTimeout("IRSA stalled", request=request)

    a = archive_with(handler)
    try:
        started = time.monotonic()
        with pytest.raises(ArchiveError, match="metadata search timed out"):
            a._search_tap(Query(ra_deg=330, dec_deg=-50), started + 120)
        assert len(budgets) == 2 and max(budgets) <= 15
    finally:
        a.close()


def test_metadata_deadline_also_bounds_a_slow_stream():
    class Trickle(httpx.SyncByteStream):
        def __iter__(self):
            yield b"uri,time_bounds_lower,energy_bandpassname\n"
            time.sleep(0.03)
            yield b"\n"

    a = archive_with(lambda _: httpx.Response(200, stream=Trickle()))
    try:
        with pytest.raises(ArchiveError, match="metadata search timed out"):
            a._search_tap(Query(ra_deg=330, dec_deg=-50), time.monotonic() + 0.01)
    finally:
        a.close()


def test_sia_search_uses_documented_collections_and_columns():
    import io
    from astropy.table import Table

    def handler(request):
        if request.url.path == "/TAP/sync":
            pytest.fail("A successful SIA search must not wait on TAP")
        assert request.url.path == "/SIA"
        assert request.url.params["POS"] == "CIRCLE 330.0 -50.0 0"
        data = (
            []
            if request.url.params["COLLECTION"] != "spherex_dr1"
            else [("https://irsa.ipac.caltech.edu/" + uri(), 60801.5)]
        )
        table = Table(rows=data, names=["access_url", "t_min"], dtype=["U300", "f8"])
        output = io.BytesIO()
        table.write(output, format="votable")
        return httpx.Response(200, content=output.getvalue())

    a = archive_with(handler)
    try:
        rows, notes = a.search(Query(ra_deg=330, dec_deg=-50), time.monotonic() + 30)
        assert len(rows) == 1 and rows[0].detector == "D2" and rows[0].release == "DR1"
        assert "SIA" in notes[0]
    finally:
        a.close()


def test_sia_unavailable_falls_back_to_tap():
    candidates = []
    timings = []
    tap_calls = []

    def handler(request):
        if request.url.path == "/SIA":
            return httpx.Response(503)
        tap_calls.append(request)
        if len(tap_calls) == 1:
            return httpx.Response(503)
        return httpx.Response(
            200,
            text="uri,time_bounds_lower,energy_bandpassname\n"
            + f"{uri()},60801.5,SPHEREx-D2\n",
        )

    a = archive_with(handler)
    try:
        rows, notes = a.search(
            Query(ra_deg=330, dec_deg=-50), time.monotonic() + 30,
            on_candidate=candidates.append, timing=lambda *event: timings.append(event),
        )
        assert len(rows) == 1
        assert "TAP" in notes[0]
        assert candidates == rows
        assert [e[0] for e in timings] == ["tap_retry", "tap_first_byte", "first_candidate"]
    finally:
        a.close()


def test_tap_pages_equal_times_and_prefers_numeric_processing_version():
    header = "uri,time_bounds_lower,energy_bandpassname"
    newer = uri(identity="visitD2", version=10)
    older = uri(identity="visitD2", version=9)
    other = uri(identity="alsoD2", version=11)
    pages = [[(older, 60801.0), (newer, 60801.0)], [(newer, 60801.0), (other, 60800.0)], [(other, 60800.0)]]
    calls = []

    def handler(request):
        sql = request.url.params["QUERY"]
        calls.append(sql)
        page = pages[len(calls)-1]
        return httpx.Response(200, text="\n".join([header, *(f"{u},{t},SPHEREx-D2" for u,t in page)]))

    archive = archive_with(handler, Settings(metadata_limit=1))
    try:
        rows, notes = archive._search_tap(Query(ra_deg=0, dec_deg=0), time.monotonic() + 10)
    finally:
        archive.close()
    assert notes == []
    assert [o.identity for o in rows] == ["alsoD2", "visitD2"]
    assert rows[1].uri.endswith(newer)
    assert "ORDER BY p.time_bounds_lower DESC,a.uri DESC" in calls[0]
    assert f"a.uri < '{older}'" in calls[1]
    assert f"a.uri < '{newer}'" in calls[2]


def test_discovery_checks_once_and_reports_unconfigured_collection():
    calls = []

    def handler(req):
        calls.append(req)
        return httpx.Response(200, text="SIA2 Collection\tDescription\nspherex_dr1\timages\nspherex_dr1_cube\tcube\nspherex_dr4\timages\n")

    archive = archive_with(handler)
    try:
        first = archive.discovery()
        assert "spherex_dr4" in first and "spherex_dr1_cube" in first
        assert archive.discovery() == first
        assert len(calls) == 1
    finally:
        archive.close()


def test_candidate_arrives_before_slower_preferred_collection_and_discovery():
    import io
    from astropy.table import Table

    offered = threading.Event()
    catalog_finished = threading.Event()
    seen = []
    timings = []

    def handler(request):
        if request.url.path != "/SIA":
            assert catalog_finished.wait(5), "An informational collection list held up the catalog"
            return httpx.Response(200, text="SIA2 Collection\tDescription\n")
        collection = request.url.params["COLLECTION"]
        if collection == "spherex_dr1":
            assert offered.wait(5), "first collection was held behind the slower one"
        rows = []
        if collection in ("spherex_dr1", "spherex_qr3"):
            release = collection.removeprefix("spherex_")
            rows = [(uri(release, version=v), 60801.5) for v in (9, 10)]
        table = Table(rows=rows, names=["access_url", "t_min"], dtype=["U300", "f8"])
        output = io.BytesIO()
        table.write(output, format="votable")
        return httpx.Response(200, content=output.getvalue())

    def first_candidate(obs):
        seen.append(obs)
        offered.set()

    archive = archive_with(handler)
    try:
        result, _ = archive.search(Query(ra_deg=0, dec_deg=0, live=True), time.monotonic()+15,
                                   on_candidate=first_candidate, timing=lambda *event: timings.append(event))
    finally:
        catalog_finished.set()
        archive.close()
    assert len(seen) == len(result) == 1
    assert seen[0].identity == result[0].identity
    assert seen[0].uri.endswith(uri("qr3", version=10))
    assert result[0].uri.endswith(uri("dr1", version=10))
    assert [e[2] for e in timings if e[0] == "first_candidate"] == [seen[0].identity]
    assert sum(e[0] == "sia_first_byte" for e in timings) == 4


def test_cutout_retry_and_first_byte_measure_separate_attempts(tmp_path):
    calls = []
    timings = []

    class Body(httpx.SyncByteStream):
        def __iter__(self):
            yield b"small first chunk"
            assert timings[-1][0] == "cutout_first_byte"
            yield b"last chunk"

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(503)
        return httpx.Response(200, stream=Body())

    archive = archive_with(handler)
    obs = Observation("visitD2", "https://irsa.ipac.caltech.edu/" + uri(), 60800, "D2", "DR1")
    try:
        archive.fetch(obs, Query(ra_deg=0, dec_deg=0), tmp_path / "x.fits",
                      time.monotonic()+5, timing=lambda *event: timings.append(event))
    finally:
        archive.close()
    assert (tmp_path / "x.fits").read_bytes() == b"small first chunklast chunk"
    assert [(stage, identity, outcome) for stage, _, identity, outcome in timings] == [
        ("cutout_retry", obs.identity, "HTTP 503"), ("cutout_first_byte", obs.identity, "ok")
    ]


@pytest.fixture
def retry_clock(monkeypatch):
    seconds = [0.0]

    def advance(delay):
        assert delay > 0
        seconds[0] += delay

    clock = SimpleNamespace(monotonic=lambda: seconds[0], sleep=advance,
                            time=lambda: 1_800_000_000 + seconds[0])
    monkeypatch.setattr("app.archive.time", clock)
    monkeypatch.setattr("app.archive.random.uniform", lambda low, high: 0.0)
    return clock


def test_cutout_retries_share_server_cooldown_and_respect_deadline(tmp_path, retry_clock):
    sends = []

    def handler(request):
        sends.append(retry_clock.monotonic())
        if len(sends) == 1:
            return httpx.Response(503, headers={"Retry-After": "5"})
        if len(sends) == 2:
            return httpx.Response(429, headers={"Retry-After": formatdate(retry_clock.time() + 7, usegmt=True)})
        return httpx.Response(200, content=b"good")

    archive = archive_with(handler)
    obs = Observation("first", "https://irsa.ipac.caltech.edu/" + uri(), 60800, "D2", "DR1")
    other = Observation("other", "https://irsa.ipac.caltech.edu/" + uri(identity="other"), 60801, "D2", "DR1")
    query = Query(ra_deg=0, dec_deg=0)
    try:
        with pytest.raises(ArchiveError, match="503"):
            archive.fetch(obs, query, tmp_path / "first", 3)
        assert not (tmp_path / "first").exists()
        assert sends == [0] and retry_clock.monotonic() == 0
        archive.fetch(other, query, tmp_path / "other", 20)
        assert sends == [0, 5, 12]
        assert (tmp_path / "other").read_bytes() == b"good"
    finally:
        archive.close()


@pytest.mark.parametrize(("status", "times"), [(404, [0]), (501, [0]), (502, [0, 1, 3, 7])])
def test_cutout_http_attempt_bounds(tmp_path, retry_clock, status, times):
    sends = []

    def handler(req):
        sends.append(retry_clock.monotonic())
        return httpx.Response(status, headers={"Retry-After": "malformed"})

    archive = archive_with(handler)
    obs = Observation("test", "https://irsa.ipac.caltech.edu/" + uri(), 60800, "D2", "DR1")
    try:
        with pytest.raises(ArchiveError, match=str(status)):
            archive.fetch(obs, Query(ra_deg=0, dec_deg=0), tmp_path / "failed", 30)
        assert sends == times and not (tmp_path / "failed").exists()
    finally:
        archive.close()


def test_partial_cutout_is_removed_before_retry(tmp_path, retry_clock):
    sends = []
    path = tmp_path / "x.fits"

    class Interrupted(httpx.SyncByteStream):
        def __iter__(self):
            yield b"truncated"
            raise httpx.ReadError("connection dropped")

    def handler(req):
        sends.append(retry_clock.monotonic())
        assert not path.exists()
        return httpx.Response(200, stream=Interrupted()) if len(sends) == 1 else httpx.Response(200, content=b"whole")

    archive = archive_with(handler)
    obs = Observation("test", "https://irsa.ipac.caltech.edu/" + uri(), 60800, "D2", "DR1")
    try:
        archive.fetch(obs, Query(ra_deg=0, dec_deg=0), path, 30)
        assert sends == [0, 1] and path.read_bytes() == b"whole"
    finally:
        archive.close()


def test_cutout_backoff_allows_job_cancellation(tmp_path, retry_clock):
    sends = []

    def handler(req):
        sends.append(req)
        return httpx.Response(503, headers={"Retry-After": "30"})

    def check_cancelled():
        raise RuntimeError("Search cancelled")

    archive = archive_with(handler)
    obs = Observation("test", "https://irsa.ipac.caltech.edu/" + uri(), 60800, "D2", "DR1")
    try:
        with pytest.raises(RuntimeError, match="Search cancelled"):
            archive.fetch(obs, Query(ra_deg=0, dec_deg=0), tmp_path / "cancelled",
                          90, on_wait=check_cancelled)
        assert len(sends) == 1 and retry_clock.monotonic() == 0
        assert not (tmp_path / "cancelled").exists()
    finally:
        archive.close()


def test_two_cutout_slots_are_shared_without_blocking_metadata(tmp_path):
    inside = 0
    both_started = threading.Event()
    finish = threading.Event()
    lock = threading.Lock()

    def handler(req):
        nonlocal inside
        if req.url.path == "/TAP/sync":
            return httpx.Response(200, text="uri,time_bounds_lower,energy_bandpassname\n")
        with lock:
            inside += 1
            assert inside <= 2
            if inside == 2:
                both_started.set()
        try:
            assert finish.wait(5)
            return httpx.Response(200, content=b"ok")
        finally:
            with lock:
                inside -= 1

    archive = archive_with(handler)
    query = Query(ra_deg=0, dec_deg=0)
    deadline = time.monotonic() + 10
    try:
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(archive.fetch,
                                   Observation(str(i), "https://irsa.ipac.caltech.edu/" + uri(), 60800, "D2", "DR1"),
                                   query, tmp_path / str(i), deadline) for i in range(4)]
            try:
                assert both_started.wait(5)
                assert archive._search_tap(query, deadline) == ([], [])
            finally:
                finish.set()
            for f in futures:
                f.result()
    finally:
        archive.close()


def test_catalog_keeps_all_six_detectors_without_100_row_or_24_candidate_sampling():
    a = archive_with(lambda _: httpx.Response(500))
    try:
        rows = []
        for i in range(180):
            detector = f"D{i % 6 + 1}"
            identity = f"2025W19_1B_{i:04}_1{detector}"
            rows.append(
                {
                    "uri": uri(identity=identity),
                    "time_bounds_lower": str(60800 + i / 100),
                    "energy_bandpassname": "SPHEREx-" + detector,
                }
            )
        observations = a._select_rows(rows)
        assert len(observations) == 180
        assert {o.detector for o in observations} == {
            "D1",
            "D2",
            "D3",
            "D4",
            "D5",
            "D6",
        }
    finally:
        a.close()
