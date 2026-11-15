"""Dataset setup for maintainers
Add a release path to RELEASES with its priority and SIA collection IDs for
wide and deep Level 2 spectral images. Higher priority supersedes a duplicate.
Retire a release by removing its entry. Restart the backend after changing it.
For a compatible IRSA mirror set ORIGIN and ASSET_PREFIX. For bearer auth set
TOKEN_ENV to the name of a server-side environment variable holding the key.
The reader expects IRSA SIA2/TAP metadata and spectral image FITS products.
https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/
"""

import csv
import io
import os
import random
import re
import ssl
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlencode, urljoin, urlsplit
import xml.etree.ElementTree as ET

import httpx
import truststore
from astropy.time import Time
from astropy.io.votable import parse_single_table

from .config import Settings
from .schemas import ObservationRecord, Query
from .spectral import spectral_header_index


ORIGIN = "https://irsa.ipac.caltech.edu"
ASSET_PREFIX = "/ibe/data/spherex/"
TOKEN_ENV = None
RELEASES = {
    "dr1": (2, ("spherex_dr1", "spherex_dr1_deep")),
    "qr3": (1, ("spherex_qr3", "spherex_qr3_deep")),
}
COLLECTION_TABLE = "/include/SIA2_collection_info.tsv"
METADATA_PAGES = 8
DETECTORS = tuple(f"D{i}" for i in range(1, 7))
CUTOUT_ATTEMPTS = 4


class ArchiveError(RuntimeError):
    pass


def archive_failure(exc: httpx.HTTPError, operation: str) -> str:
    if isinstance(exc, httpx.TimeoutException):
        return f"IRSA {operation} timed out. Retry later or use a narrower date range."
    if isinstance(exc, httpx.HTTPStatusError):
        message = f"IRSA {operation} returned HTTP {exc.response.status_code}."
        return message + " Retry later." if retryable(exc) else message
    return f"Cannot connect to IRSA for {operation}. Check the backend's internet access and proxy settings."


def retryable(exc: httpx.HTTPError) -> bool:
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in (408, 429, 500, 502, 503, 504)
    return isinstance(exc, (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError))


def retry_after_seconds(response: httpx.Response) -> float:
    value = response.headers.get("Retry-After", "").strip()
    if value.isascii() and value.isdigit():
        return float(value)
    if value:
        try:
            date = parsedate_to_datetime(value)
            if date.tzinfo is not None:
                return max(0.0, date.timestamp() - time.time())
        except (ValueError, TypeError, OverflowError, OSError):
            pass
    return 0.0


@dataclass(frozen=True)
class Observation:
    identity: str
    uri: str
    mjd: float
    detector: str
    release: str

    def record(self):
        return ObservationRecord(id=self.identity, source_url=self.uri, detector=self.detector,
                                 release=self.release, observed_at=Time(self.mjd, format="mjd").to_datetime(UTC).isoformat())


Timing = Callable[[str, float, str | None, str], None]


def response_chunks(response: httpx.Response, started: float, timing: Timing | None,
                    stage: str, observation_id: str | None = None) -> Iterator[bytes]:
    """Record the first nonempty HTTP body chunk before application buffering."""
    for chunk in response.iter_bytes():
        if not chunk:
            continue
        if timing:
            timing(stage, time.monotonic() - started, observation_id, "ok")
            timing = None
        yield chunk


def record_retry(timing, stage, started, exc, observation_id=None):
    if timing:
        cause = (f"HTTP {exc.response.status_code}"
                 if isinstance(exc, httpx.HTTPStatusError) else type(exc).__name__)
        timing(stage, time.monotonic() - started, observation_id, cause)


def checked_url(url: str) -> str:
    p = urlsplit(url)
    if (
        p.scheme != "https"
        or p.hostname != urlsplit(ORIGIN).hostname
        or p.port not in (None, 443)
        or p.username
        or p.password
        or not p.path.startswith(ASSET_PREFIX)
        or ".." in p.path
        or "%" in p.path
    ):
        raise ArchiveError("Archive returned an unsupported asset address")
    return url


def evenly_spaced(rows: list, limit: int) -> list:
    if len(rows) <= limit:
        return rows
    return (
        [rows[round(i * (len(rows) - 1) / (limit - 1))] for i in range(limit)]
        if limit > 1
        else rows[:1]
    )


class Archive:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.discovery_lock = threading.Lock()
        self.discovery_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="collection-info")
        self.discovery_future = None
        self.discovery_until = 0.0
        self.discovery_note = ""
        self.spectral_lock = threading.Lock()
        self.spectral_index = OrderedDict()
        # One cutout allowance for this IRSA client, shared by all search jobs.
        self.cutout_slots = threading.BoundedSemaphore(min(2, settings.cutout_workers))
        self.cutout_lock = threading.Lock()
        self.cutout_resume_at = 0.0
        self.cutout_busy_status = 0
        token = os.getenv(TOKEN_ENV) if TOKEN_ENV else None
        self.client = httpx.Client(
            headers={"Authorization": f"Bearer {token}"} if token else None,
            verify=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT),
            timeout=httpx.Timeout(settings.request_seconds, connect=5),
            follow_redirects=False,
        )

    def close(self):
        self.discovery_pool.shutdown(wait=True, cancel_futures=True)
        self.client.close()

    def probe_spectral(self, obs: Observation, query: Query, deadline: float):
        return self.spectral_at(obs.uri, query, deadline)

    def cached_spectral(self, uri: str, query: Query):
        key = (uri, query.ra_deg, query.dec_deg)
        with self.spectral_lock:
            if key in self.spectral_index:
                self.spectral_index.move_to_end(key)
                return self.spectral_index[key]
        return None

    def spectral_at(self, uri: str, query: Query, deadline: float):
        """Inspect bounded calibration metadata, never a full-size science image."""
        if info := self.cached_spectral(uri, query):
            return info

        prefix_bytes, tail_bytes = 92160, 28800

        def read_range(byte_limit, *, tail=False):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ArchiveError("Spectral metadata deadline reached")
            spec = f"bytes=-{byte_limit}" if tail else f"bytes=0-{byte_limit - 1}"
            with self.client.stream("GET", checked_url(uri),
                                    headers={"Range": spec, "Accept-Encoding": "identity"},
                                    timeout=min(self.settings.request_seconds, remaining)) as response:
                content_range = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
                if response.status_code != 206 or not content_range or response.headers.get("Content-Encoding", "identity") != "identity":
                    raise ArchiveError("Spectral header byte ranges unavailable")
                start, end, total = map(int, content_range.groups())
                expected = total - byte_limit if tail else 0
                # Reject whole-file replies, including small files covered by the
                # two ranges together, before reading a single body chunk.
                if (total <= prefix_bytes + tail_bytes or start != expected
                        or end != expected + byte_limit - 1):
                    raise ArchiveError("Archive did not return the requested metadata range")
                length = response.headers.get("Content-Length")
                if length is not None and int(length) != byte_limit:
                    raise ArchiveError("Spectral metadata length disagrees with the requested range")
                data = bytearray()
                for chunk in response.iter_bytes(8192):
                    if len(data) + len(chunk) > byte_limit or time.monotonic() >= deadline:
                        raise ArchiveError("Spectral metadata read exceeded its limit")
                    data.extend(chunk)
                if len(data) != byte_limit:
                    raise ArchiveError("Incomplete spectral metadata range")
                return bytes(data)
        try:
            info = spectral_header_index(read_range(prefix_bytes), read_range(tail_bytes, tail=True), query)
        except (ArchiveError, httpx.HTTPError, ValueError, TypeError, IndexError, KeyError, OSError):
            return None
        with self.spectral_lock:
            self.spectral_index[(uri, query.ra_deg, query.dec_deg)] = info
            if len(self.spectral_index) > 2048:
                self.spectral_index.popitem(last=False)
        return info

    def discovery(self) -> str:
        with self.discovery_lock:
            if time.monotonic() >= self.discovery_until:
                try:
                    # Same catalog used by IRSA's SIA2 "Available datasets" table.
                    response = self.client.get(ORIGIN + COLLECTION_TABLE, timeout=6)
                    response.raise_for_status()
                    reader = csv.DictReader(io.StringIO(response.text), delimiter="\t")
                    if "SIA2 Collection" not in (reader.fieldnames or ()):
                        raise ValueError("Unexpected collection table")
                    known = {name for _, names in RELEASES.values() for name in names}
                    other = []
                    for row in reader:
                        name = row["SIA2 Collection"]
                        if name.lower().startswith("spherex") and name not in known:
                            other.append(f"{name} ({row.get('Description', 'unknown product')})")
                    self.discovery_note = (
                        "Other published SPHEREx collections: " + ", ".join(sorted(other))
                        if other else ""
                    )
                    self.discovery_until = time.monotonic() + 3600
                except (httpx.HTTPError, KeyError, ValueError):
                    self.discovery_note = "Collection discovery unavailable; using configured releases."
                    self.discovery_until = time.monotonic() + 60
            return self.discovery_note

    def search(
        self, query: Query, deadline: float, *,
        on_candidate: Callable[[Observation], None] | None = None, timing: Timing | None = None,
    ) -> tuple[list[Observation], list[str]]:
        started = time.monotonic()
        deadline = min(deadline, started + self.settings.metadata_seconds)
        announced = False
        offered = set()

        def offer(batch):
            nonlocal announced
            if announced and not query.channels:
                return
            candidates = []
            for obs in reversed(self._select_rows(batch)):
                if obs in offered or query.band_match(obs.detector) == "excluded":
                    continue
                info = self.cached_spectral(obs.uri, query) if obs.detector in query.channels else None
                match = query.band_match(obs.detector, info["wavelength_um"], info["bandwidth_um"],
                                         info["processing_version"]) if info else query.band_match(obs.detector)
                if match != "excluded":
                    candidates.append((match, obs))
            # Existing target-local calibration can establish an immediate match. Unknowns
            # are offered to the job for metadata probing, never directly for download.
            for _, candidate in sorted(candidates, key=lambda item: item[0] != "matched"):
                offered.add(candidate)
                if not announced and timing:
                    timing("first_candidate", time.monotonic() - started, candidate.identity, "ok")
                announced = True
                if on_candidate:
                    on_candidate(candidate)
                if not query.channels:
                    break

        # This advisory inventory describes other published collections. A slow
        # inventory response must never hold up an already reconciled sky catalog.
        if query.live and self.discovery_lock.acquire(blocking=False):
            try:
                if (time.monotonic() >= self.discovery_until
                        and (self.discovery_future is None or self.discovery_future.done())):
                    self.discovery_future = self.discovery_pool.submit(self.discovery)
            finally:
                self.discovery_lock.release()
        rows, notes = self._search_field(query, deadline, offer if on_candidate or timing else None, timing)
        if query.live and self.discovery_note:
            notes.insert(1, self.discovery_note)
        return rows, notes

    def _search_field(self, query, deadline, offer, timing):
        try:
            # SIA indexes the image collections directly; reserve half the budget
            # for TAP if the image-search service is temporarily unavailable.
            rows, notes = self._search_sia(
                query,
                min(deadline, time.monotonic() + self.settings.metadata_seconds / 2),
                offer, timing,
            )
            return rows, ["Metadata retrieved via IRSA SIA.", *notes]
        except ArchiveError as sia_error:
            if time.monotonic() >= deadline:
                raise
            try:
                rows, notes = self._search_tap(query, deadline, offer, timing)
                return rows, [
                    "Metadata retrieved via IRSA TAP after SIA was unavailable.",
                    *notes,
                ]
            except ArchiveError as tap_error:
                raise ArchiveError(
                    f"IRSA image search is unavailable. {tap_error}"
                ) from sia_error

    def _sia_collection(self, name, position, lo, hi, deadline, timing=None, *, footprints=False):
        params = {"COLLECTION": name, "POS": position, "MAXREC": self.settings.metadata_limit + 1}
        if lo is not None or hi is not None:
            params["TIME"] = f"{lo if lo is not None else '-Inf'} {hi if hi is not None else '+Inf'}"
        try:
            chunks, total = [], 0
            started = time.monotonic()
            with self.client.stream(
                "GET",
                ORIGIN + "/SIA",
                params=params,
                timeout=max(
                    0.1,
                    min(self.settings.request_seconds, deadline - time.monotonic()),
                ),
            ) as response:
                response.raise_for_status()
                for chunk in response_chunks(response, started, timing, "sia_first_byte"):
                    if time.monotonic() >= deadline:
                        raise ArchiveError("IRSA SIA metadata search timed out")
                    total += len(chunk)
                    if total > 32_000_000:
                        raise ArchiveError(
                            "IRSA SIA metadata exceeded the response limit"
                        )
                    chunks.append(chunk)
            payload = b"".join(chunks)
            overflow = False
            root = ET.fromstring(payload)
            for info in root.iter():
                if (
                    info.tag.rsplit("}", 1)[-1] == "INFO"
                    and info.attrib.get("name") == "QUERY_STATUS"
                ):
                    if info.attrib.get("value") == "ERROR":
                        raise ArchiveError("IRSA SIA returned a query error")
                    overflow |= info.attrib.get("value") == "OVERFLOW"
            table = parse_single_table(io.BytesIO(payload)).to_table(
                use_names_over_ids=True
            )
            if not {"access_url", "t_min"}.issubset(table.colnames):
                raise ArchiveError("IRSA SIA returned unexpected metadata columns")
            result = []
            for row in table:
                uri = str(row["access_url"])
                detector = re.search(r"level2_.+?(D[1-6])_spx", uri)
                if not detector:
                    continue
                mjd = float(row["t_min"])
                if lo is not None and mjd < lo:
                    continue
                if hi is not None and mjd > hi:
                    continue
                result.append(
                    {
                        "uri": uri,
                        "time_bounds_lower": str(mjd),
                        "energy_bandpassname": "SPHEREx-" + detector[1],
                        **({"footprint": str(row["s_region"])} if footprints and "s_region" in table.colnames else {}),
                    }
                )
            return result, overflow or len(table) >= self.settings.metadata_limit + 1
        except (
            httpx.HTTPError,
            ValueError,
            IndexError,
            TypeError,
            ET.ParseError,
        ) as exc:
            raise ArchiveError("IRSA SIA metadata service is unavailable") from exc

    def _search_sia(
        self, query: Query, deadline: float, offer=None, timing: Timing | None = None,
    ) -> tuple[list[Observation], list[str]]:
        position = f"CIRCLE {query.ra_deg} {query.dec_deg} 0"
        lo = float(Time(query.start_utc).mjd) if query.start_utc else None
        hi = float(Time(query.end_utc).mjd) if query.end_utc else None

        def collection(name):
            return self._sia_collection(name, position, lo, hi, deadline, timing)

        names = [n for _, collections in RELEASES.values() for n in collections]
        rows, failures = [], []
        capped = False
        # Do not mistake an unavailable collection for zero sky coverage.
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(collection, name): name for name in names}
            for future in as_completed(futures):
                try:
                    batch, truncated = future.result()
                except ArchiveError:
                    failures.append(futures[future])
                    continue
                rows.extend(batch)
                capped |= truncated
                if offer:
                    offer(batch)
        if failures and not rows:
            raise ArchiveError(
                "IRSA SIA metadata search was incomplete; coverage could not be established"
            )
        if capped or failures:
            # TAP supports ordered keyset pagination. Fall back to the available
            # SIA records if the supplemental service cannot complete the field.
            try:
                recent, notes = self._search_tap(query, deadline, offer, timing)
            except ArchiveError as exc:
                notes = [f"Partial metadata: {exc}"]
                recent = []
            rows.extend({"uri": obs.uri, "time_bounds_lower": obs.mjd,
                         "energy_bandpassname": obs.detector} for obs in recent)
        else:
            notes = []
        return self._select_rows(rows), notes

    def _tap_prefix(self, spatial_filter: str, query: Query):
        detector_names = ",".join(f"'SPHEREx-{d}'" for d in DETECTORS)
        root = ASSET_PREFIX.lstrip("/")
        releases = " OR ".join(f"a.uri LIKE '%{root}{release}/level2/%'" for release in RELEASES)
        filters = [
            spatial_filter,
            f"p.energy_bandpassname IN ({detector_names})",
            f"({releases})",
        ]
        if query.start_utc:
            filters.append(f"p.time_bounds_lower >= {Time(query.start_utc).mjd:.10f}")
        if query.end_utc:
            filters.append(f"p.time_bounds_lower <= {Time(query.end_utc).mjd:.10f}")
        return (
            f"SELECT TOP {self.settings.metadata_limit + 1} a.uri,p.time_bounds_lower,p.energy_bandpassname "
            "FROM spherex.artifact a JOIN spherex.plane p ON a.planeid=p.planeid WHERE "
            + " AND ".join(filters)
        )

    @staticmethod
    def _after_row(last):
        stamp = float(last["time_bounds_lower"])
        safe_uri = last["uri"].replace("'", "''")
        return (f" AND (p.time_bounds_lower < {stamp!r} OR "
                f"(p.time_bounds_lower = {stamp!r} AND a.uri < '{safe_uri}'))")

    def region_page(self, position, window, intersects):
        name, lo, hi = window
        rows, capped = self._sia_collection(
            name, position, lo, hi, time.monotonic() + self.settings.metadata_seconds, footprints=True,
        )
        if not capped:
            return self._select_rows(row for row in rows if intersects(row.get("footprint", ""))), []
        # Inclusive subwindows can share records. Release reconciliation removes duplicates.
        dates = sorted({float(row["time_bounds_lower"]) for row in rows
                        if (lo is None or float(row["time_bounds_lower"]) > lo)
                        and (hi is None or float(row["time_bounds_lower"]) < hi)})
        if not dates:
            raise ArchiveError(f"{name} exceeded the archive limit at one epoch. Coverage is incomplete.")
        mid = dates[len(dates) // 2]
        return [], [(name, lo, mid), (name, mid, hi)]

    def _search_tap(
        self, query: Query, deadline: float, offer=None, timing: Timing | None = None,
    ) -> tuple[list[Observation], list[str]]:
        prefix = self._tap_prefix(f"1=CONTAINS(POINT('ICRS',{query.ra_deg:.10f},{query.dec_deg:.10f}),p.poly)", query)
        deadline = min(deadline, time.monotonic() + self.settings.metadata_seconds)
        limit = self.settings.metadata_limit
        cursor = ""
        rows, notes = [], []
        for _ in range(METADATA_PAGES):
            if rows and time.monotonic() >= deadline:
                notes.append("Partial metadata: time budget reached during pagination.")
                break
            try:
                batch = self._tap_page(prefix + cursor + " ORDER BY p.time_bounds_lower DESC,a.uri DESC", deadline, timing)
            except ArchiveError as exc:
                if not rows:
                    raise
                notes.append(f"Partial metadata: {exc}")
                break
            rows.extend(batch[:limit])
            if offer:
                offer(batch[:limit])
            if len(batch) <= limit:
                break
            next_cursor = self._after_row(batch[limit - 1])
            if cursor == next_cursor:
                notes.append("Partial metadata: archive returned a repeated page.")
                break
            cursor = next_cursor
        else:
            notes.append(f"Partial metadata: newest {limit * METADATA_PAGES} records inspected; narrow dates to see earlier visits.")
        return self._select_rows(rows), notes

    def _tap_page(self, sql: str, deadline: float, timing: Timing | None = None) -> list[dict[str, str]]:
        text = None
        for attempt in range(2):
            started = time.monotonic()
            try:
                with self.client.stream(
                    "GET",
                    ORIGIN + "/TAP/sync",
                    params={
                        "REQUEST": "doQuery",
                        "LANG": "ADQL",
                        "QUERY": sql,
                        "FORMAT": "csv",
                    },
                    timeout=max(
                        0.1,
                        min(self.settings.request_seconds, deadline - time.monotonic()),
                    ),
                ) as response:
                    response.raise_for_status()
                    chunks, total = [], 0
                    for chunk in response_chunks(response, started, timing, "tap_first_byte"):
                        if time.monotonic() >= deadline:
                            raise ArchiveError(
                                "IRSA metadata search timed out. Try again later or narrow the date range."
                            )
                        total += len(chunk)
                        if total > 32_000_000:
                            raise ArchiveError(
                                "Archive metadata exceeded the response limit"
                            )
                        chunks.append(chunk)
                    text = b"".join(chunks).decode(response.encoding or "utf-8")
                break
            except httpx.HTTPError as exc:
                if attempt or not retryable(exc) or time.monotonic() >= deadline:
                    raise ArchiveError(archive_failure(exc, "metadata search")) from exc
                record_retry(timing, "tap_retry", started, exc)
                time.sleep(min(0.5, max(0, deadline - time.monotonic())))
        reader = csv.DictReader(io.StringIO(text or ""))
        if not {"uri", "time_bounds_lower", "energy_bandpassname"}.issubset(
            reader.fieldnames or []
        ):
            raise ArchiveError("IRSA returned an unexpected metadata format")
        return list(reader)

    def _select_rows(self, rows):
        unique = {}
        for row in rows:
            uri = checked_url(urljoin(ORIGIN + "/", row["uri"]))
            match = re.search(re.escape(ASSET_PREFIX) + r"([^/]+)/level2/", uri)
            if not match or match[1] not in RELEASES:
                continue
            identity = re.search(r"level2_(.+?D[1-6])_spx", uri)
            if not identity:
                continue
            obs = Observation(
                identity[1],
                uri,
                float(row["time_bounds_lower"]),
                row["energy_bandpassname"].replace("SPHEREx-", ""),
                match[1].upper(),
            )
            if obs.detector != identity[1][-2:]:
                continue
            if not 40000 < obs.mjd < 100000:
                raise ArchiveError("IRSA observation time has unexpected units")
            previous = unique.get(obs.identity)
            if previous is None or self._version_key(obs) > self._version_key(previous):
                unique[obs.identity] = obs
        return sorted(unique.values(), key=lambda o: (o.mjd, o.identity))

    @staticmethod
    def _version_key(obs):
        match = re.search(r"_spx_l2[a-z]*-v(\d+)-(\d+)-(\d+)", obs.uri)
        version = tuple(map(int, match.groups())) if match else ()
        return RELEASES[obs.release.lower()][0], version, obs.uri

    @staticmethod
    def candidates(observations: list[Observation], limit: int) -> list[Observation]:
        """Reserve downloads for each available detector and both ends of its timeline."""
        groups = {det: sorted((o for o in observations if o.detector == det),
                              key=lambda o: (o.mjd, o.identity)) for det in DETECTORS}
        quotas = {det: 0 for det in groups}
        for _ in range(min(limit, len(observations))):
            eligible = [det for det in groups if quotas[det] < len(groups[det])]
            det = min(eligible, key=lambda d: (quotas[d], -groups[d][-1].mjd))
            quotas[det] += 1
        selected = [obs for det, quota in quotas.items() if quota
                    for obs in (groups[det][-1:] if quota == 1 else evenly_spaced(groups[det], quota))]
        return sorted(selected, key=lambda o: (o.mjd, o.identity))

    def _await_cutout(self, not_before: float, deadline: float, on_wait: Callable[[], None] | None):
        while True:
            now = time.monotonic()
            with self.cutout_lock:
                resume = max(not_before, self.cutout_resume_at)
                busy = self.cutout_busy_status if self.cutout_resume_at > now else None
            if max(now, resume) >= deadline:
                if busy:
                    raise ArchiveError(f"IRSA cutout service is busy (HTTP {busy}). Retry later.")
                raise ArchiveError("Cutout download time limit reached. Retry later.")
            if resume <= now:
                return
            if on_wait:
                on_wait()
            time.sleep(min(resume - now, 1.0))

    def _download_cutout(self, url, path, deadline, started, timing, observation_id):
        current = url
        for _ in range(4):
            checked_url(current)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ArchiveError("Cutout download time limit reached. Retry later.")
            with self.client.stream("GET", current, timeout=min(self.settings.request_seconds, remaining)) as r:
                if r.is_redirect:
                    current = urljoin(current, r.headers["location"])
                    continue
                r.raise_for_status()
                total = 0
                with path.open("wb") as f:
                    for chunk in response_chunks(r, started, timing, "cutout_first_byte", observation_id):
                        if time.monotonic() >= deadline:
                            raise ArchiveError("Cutout download time limit reached. Retry later.")
                        total += len(chunk)
                        if total > self.settings.max_download_bytes:
                            raise ArchiveError("Archive cutout exceeded the download limit")
                        f.write(chunk)
                return
        raise ArchiveError("Archive returned too many redirects")

    def fetch(self, obs: Observation, query: Query, path: Path, deadline: float, *,
              timing: Timing | None = None, on_wait: Callable[[], None] | None = None):
        url = checked_url(obs.uri) + "?" + urlencode({
            "center": f"{query.ra_deg},{query.dec_deg}d", "size": query.fov_arcsec / 3600,
        })
        while not self.cutout_slots.acquire(timeout=min(1.0, max(0, deadline - time.monotonic()))):
            if time.monotonic() >= deadline:
                raise ArchiveError("Cutout download time limit reached while queued. Retry later.")
            if on_wait:
                on_wait()
        try:
            retry_at = 0.0
            for attempt in range(CUTOUT_ATTEMPTS):
                self._await_cutout(retry_at, deadline, on_wait)
                started = time.monotonic()
                try:
                    self._download_cutout(url, path, deadline, started, timing, obs.identity)
                    return url
                except httpx.HTTPError as exc:
                    path.unlink(missing_ok=True)
                    if not retryable(exc):
                        raise ArchiveError(archive_failure(exc, "cutout download")) from exc
                    delay = 2 ** attempt + random.uniform(0, 1)
                    if isinstance(exc, httpx.HTTPStatusError):
                        delay = max(delay, retry_after_seconds(exc.response))
                    retry_at = time.monotonic() + delay
                    if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in (429, 503):
                        with self.cutout_lock:
                            if retry_at > self.cutout_resume_at:
                                self.cutout_resume_at = retry_at
                                self.cutout_busy_status = exc.response.status_code
                    if attempt + 1 == CUTOUT_ATTEMPTS or retry_at >= deadline:
                        raise ArchiveError(archive_failure(exc, "cutout download")) from exc
                    record_retry(timing, "cutout_retry", started, exc, obs.identity)
        except (ArchiveError, OSError):
            path.unlink(missing_ok=True)
            raise
        finally:
            self.cutout_slots.release()
