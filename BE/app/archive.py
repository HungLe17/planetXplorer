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
import re
import ssl
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from math import isfinite
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlencode, urljoin, urlsplit
import xml.etree.ElementTree as ET

import httpx
import truststore
from astropy.time import Time
from astropy.io.votable import parse_single_table

from .config import Settings
from .schemas import Query


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


class ArchiveError(RuntimeError):
    pass


def archive_failure(exc: httpx.HTTPError, operation: str) -> str:
    if isinstance(exc, httpx.TimeoutException):
        return f"IRSA {operation} timed out. Retry later or use a narrower date range."
    if isinstance(exc, httpx.HTTPStatusError):
        return (
            f"IRSA {operation} returned HTTP {exc.response.status_code}. Retry later."
        )
    return f"Cannot connect to IRSA for {operation}. Check the backend's internet access and proxy settings."


def retryable(exc: httpx.HTTPError) -> bool:
    return (
        not isinstance(exc, httpx.HTTPStatusError)
        or exc.response.status_code == 429
        or exc.response.status_code >= 500
    )


@dataclass(frozen=True)
class Observation:
    identity: str
    uri: str
    mjd: float
    detector: str
    release: str


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
        self.discovery_until = 0.0
        self.discovery_note = ""
        token = os.getenv(TOKEN_ENV) if TOKEN_ENV else None
        self.client = httpx.Client(
            headers={"Authorization": f"Bearer {token}"} if token else None,
            verify=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT),
            timeout=httpx.Timeout(settings.request_seconds, connect=5),
            follow_redirects=False,
        )

    def close(self):
        self.client.close()

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

        def offer(batch):
            nonlocal announced
            if announced:
                return
            candidates = self._select_rows(batch)
            if candidates:
                # A collection's latest visit is likely to survive date/detector sampling.
                candidate = candidates[-1]
                announced = True
                if timing:
                    timing("first_candidate", time.monotonic() - started, candidate.identity, "ok")
                if on_candidate:
                    on_candidate(candidate)

        # Collection discovery is informational. Let it run alongside the actual field search.
        with ThreadPoolExecutor(max_workers=1) as pool:
            discovery = pool.submit(self.discovery) if query.live else None
            rows, notes = self._search_field(
                query, deadline, offer if on_candidate or timing else None, timing
            )
            if discovery and (note := discovery.result()):
                notes.insert(1, note)
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

    def _search_sia(
        self, query: Query, deadline: float, offer=None, timing: Timing | None = None,
    ) -> tuple[list[Observation], list[str]]:
        # Official collections and on-premises access_url contract:
        # https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/
        def collection(name):
            params = {
                "COLLECTION": name,
                "POS": f"CIRCLE {query.ra_deg} {query.dec_deg} 0",
                "MAXREC": self.settings.metadata_limit + 1,
            }
            if query.start_utc or query.end_utc:
                lo = Time(query.start_utc).mjd if query.start_utc else "-Inf"
                hi = Time(query.end_utc).mjd if query.end_utc else "+Inf"
                params["TIME"] = f"{lo} {hi}"
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
                        if total > 2_000_000:
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
                    if query.start_utc and mjd < Time(query.start_utc).mjd:
                        continue
                    if query.end_utc and mjd > Time(query.end_utc).mjd:
                        continue
                    result.append(
                        {
                            "uri": uri,
                            "time_bounds_lower": str(mjd),
                            "energy_bandpassname": "SPHEREx-" + detector[1],
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

    def _search_tap(
        self, query: Query, deadline: float, offer=None, timing: Timing | None = None,
    ) -> tuple[list[Observation], list[str]]:
        detector_names = ",".join(f"'SPHEREx-{d}'" for d in DETECTORS)
        root = ASSET_PREFIX.lstrip("/")
        releases = " OR ".join(f"a.uri LIKE '%{root}{release}/level2/%'" for release in RELEASES)
        filters = [
            f"1=CONTAINS(POINT('ICRS',{query.ra_deg:.10f},{query.dec_deg:.10f}),p.poly)",
            f"p.energy_bandpassname IN ({detector_names})",
            f"({releases})",
        ]
        if query.start_utc:
            filters.append(f"p.time_bounds_lower >= {Time(query.start_utc).mjd:.10f}")
        if query.end_utc:
            filters.append(f"p.time_bounds_lower <= {Time(query.end_utc).mjd:.10f}")
        deadline = min(deadline, time.monotonic() + self.settings.metadata_seconds)
        limit = self.settings.metadata_limit
        prefix = (
            f"SELECT TOP {limit + 1} a.uri,p.time_bounds_lower,p.energy_bandpassname "
            "FROM spherex.artifact a JOIN spherex.plane p ON a.planeid=p.planeid WHERE "
            + " AND ".join(filters)
        )
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
            last = batch[limit - 1]
            stamp = float(last["time_bounds_lower"])
            safe_uri = last["uri"].replace("'", "''")
            next_cursor = (f" AND (p.time_bounds_lower < {stamp!r} OR "
                           f"(p.time_bounds_lower = {stamp!r} AND a.uri < '{safe_uri}'))")
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
                        if total > 2_000_000:
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
            if not isfinite(obs.mjd):
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

    def fetch(self, obs: Observation, query: Query, path: Path, deadline: float, *,
              timing: Timing | None = None):
        url = (
            checked_url(obs.uri)
            + "?"
            + urlencode({"center": f"{query.ra_deg},{query.dec_deg}d", "size": query.fov_arcsec / 3600})
        )
        for attempt in range(2):
            started = time.monotonic()
            try:
                current = url
                for _ in range(4):
                    checked_url(current)
                    with self.client.stream(
                        "GET",
                        current,
                        timeout=max(
                            0.1,
                            min(
                                self.settings.request_seconds,
                                deadline - time.monotonic(),
                            ),
                        ),
                    ) as r:
                        if r.is_redirect:
                            current = urljoin(current, r.headers["location"])
                            continue
                        r.raise_for_status()
                        total = 0
                        with path.open("wb") as f:
                            for chunk in response_chunks(r, started, timing, "cutout_first_byte", obs.identity):
                                if time.monotonic() > deadline:
                                    raise ArchiveError("Processing deadline reached")
                                total += len(chunk)
                                if total > self.settings.max_download_bytes:
                                    raise ArchiveError(
                                        "Archive cutout exceeded the download limit"
                                    )
                                f.write(chunk)
                        return url
                raise ArchiveError("Archive returned too many redirects")
            except ArchiveError:
                path.unlink(missing_ok=True)
                raise
            except httpx.HTTPError as exc:
                path.unlink(missing_ok=True)
                if attempt or not retryable(exc) or time.monotonic() >= deadline:
                    raise ArchiveError(archive_failure(exc, "cutout download")) from exc
                record_retry(timing, "cutout_retry", started, exc, obs.identity)
                time.sleep(min(0.5, max(0, deadline - time.monotonic())))
        raise ArchiveError("Cutout download failed")
