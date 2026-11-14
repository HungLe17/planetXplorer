"""IRSA TAP/MEF client. No user-supplied URLs or database dependencies."""

import csv
import io
import re
import ssl
import time
from dataclasses import dataclass
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


def checked_url(url: str) -> str:
    p = urlsplit(url)
    if (
        p.scheme != "https"
        or p.hostname != "irsa.ipac.caltech.edu"
        or p.port not in (None, 443)
        or p.username
        or p.password
        or not p.path.startswith("/ibe/data/spherex/")
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
        self.client = httpx.Client(
            verify=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT),
            timeout=httpx.Timeout(settings.request_seconds, connect=5),
            follow_redirects=False,
        )

    def close(self):
        self.client.close()

    def search(
        self, query: Query, deadline: float
    ) -> tuple[list[Observation], list[str]]:
        deadline = min(deadline, time.monotonic() + self.settings.metadata_seconds)
        try:
            # SIA indexes the image collections directly; reserve half the budget
            # for TAP if the image-search service is temporarily unavailable.
            rows, notes = self._search_sia(
                query,
                min(deadline, time.monotonic() + self.settings.metadata_seconds / 2),
            )
            return rows, ["Metadata retrieved via IRSA SIA.", *notes]
        except ArchiveError as sia_error:
            if time.monotonic() >= deadline:
                raise
            try:
                rows, notes = self._search_tap(query, deadline)
                return rows, [
                    "Metadata retrieved via IRSA TAP after SIA was unavailable.",
                    *notes,
                ]
            except ArchiveError as tap_error:
                raise ArchiveError(
                    f"IRSA image search is unavailable. {tap_error}"
                ) from sia_error

    def _search_sia(
        self, query: Query, deadline: float
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
                with self.client.stream(
                    "GET",
                    "https://irsa.ipac.caltech.edu/SIA",
                    params=params,
                    timeout=max(
                        0.1,
                        min(self.settings.request_seconds, deadline - time.monotonic()),
                    ),
                ) as response:
                    response.raise_for_status()
                    for chunk in response.iter_bytes():
                        if time.monotonic() >= deadline:
                            raise ArchiveError("IRSA SIA metadata search timed out")
                        total += len(chunk)
                        if total > 2_000_000:
                            raise ArchiveError(
                                "IRSA SIA metadata exceeded the response limit"
                            )
                        chunks.append(chunk)
                payload = b"".join(chunks)
                root = ET.fromstring(payload)
                for info in root.iter():
                    if (
                        info.tag.rsplit("}", 1)[-1] == "INFO"
                        and info.attrib.get("name") == "QUERY_STATUS"
                        and info.attrib.get("value") == "ERROR"
                    ):
                        raise ArchiveError("IRSA SIA returned a query error")
                table = parse_single_table(io.BytesIO(payload)).to_table(
                    use_names_over_ids=True
                )
                if not {"access_url", "t_min"}.issubset(table.colnames):
                    raise ArchiveError("IRSA SIA returned unexpected metadata columns")
                result = []
                for row in table:
                    uri = str(row["access_url"])
                    detector = re.search(r"level2_.+?(D[26])_spx", uri)
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
                return result
            except (
                httpx.HTTPError,
                ValueError,
                IndexError,
                TypeError,
                ET.ParseError,
            ) as exc:
                raise ArchiveError("IRSA SIA metadata service is unavailable") from exc

        names = ("spherex_dr1", "spherex_qr3", "spherex_dr1_deep", "spherex_qr3_deep")
        rows, failures = [], []
        # Do not mistake an unavailable collection for zero sky coverage.
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(collection, name): name for name in names}
            for future in as_completed(futures):
                try:
                    rows.extend(future.result())
                except ArchiveError:
                    failures.append(futures[future])
        if failures and not rows:
            raise ArchiveError(
                "IRSA SIA metadata search was incomplete; coverage could not be established"
            )
        rows.sort(key=lambda row: float(row["time_bounds_lower"]))
        selected, notes = self._select_rows(rows)
        notes.append(
            f"SIA queries are capped at {self.settings.metadata_limit + 1} records per collection; narrow the date range for additional observations."
        )
        if failures:
            notes.append(
                "Partial metadata: SIA collections unavailable: "
                + ", ".join(sorted(failures))
            )
        return selected, notes

    def _search_tap(
        self, query: Query, deadline: float
    ) -> tuple[list[Observation], list[str]]:
        filters = [
            f"1=CONTAINS(POINT('ICRS',{query.ra_deg:.10f},{query.dec_deg:.10f}),p.poly)",
            "p.energy_bandpassname IN ('SPHEREx-D2','SPHEREx-D6')",
        ]
        if query.start_utc:
            filters.append(f"p.time_bounds_lower >= {Time(query.start_utc).mjd:.10f}")
        if query.end_utc:
            filters.append(f"p.time_bounds_lower <= {Time(query.end_utc).mjd:.10f}")
        sql = (
            f"SELECT TOP {self.settings.metadata_limit + 1} a.uri,p.time_bounds_lower,p.energy_bandpassname FROM spherex.artifact a JOIN spherex.plane p ON a.planeid=p.planeid WHERE "
            + " AND ".join(filters)
            + " ORDER BY p.time_bounds_lower"
        )
        deadline = min(deadline, time.monotonic() + self.settings.metadata_seconds)
        text = None
        for attempt in range(2):
            try:
                with self.client.stream(
                    "GET",
                    "https://irsa.ipac.caltech.edu/TAP/sync",
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
                    for chunk in response.iter_bytes():
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
                time.sleep(min(0.5, max(0, deadline - time.monotonic())))
        reader = csv.DictReader(io.StringIO(text or ""))
        if not {"uri", "time_bounds_lower", "energy_bandpassname"}.issubset(
            reader.fieldnames or []
        ):
            raise ArchiveError("IRSA returned an unexpected metadata format")
        return self._select_rows(list(reader))

    def _select_rows(self, rows):
        notes = []
        if len(rows) > self.settings.metadata_limit:
            notes.append(
                f"Metadata limited to the earliest {self.settings.metadata_limit} matching exposures; narrow the date range to inspect later observations."
            )
        unique = {}
        for row in rows[: self.settings.metadata_limit]:
            uri = checked_url(urljoin("https://irsa.ipac.caltech.edu/", row["uri"]))
            match = re.search(r"/spherex/(dr1|qr3|qr2)/", uri)
            if not match or match[1] == "qr2":
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
            if not 40000 < obs.mjd < 100000:
                raise ArchiveError("IRSA observation time has unexpected units")
            previous = unique.get(obs.identity)
            if previous is None or (obs.release == "DR1", uri) > (
                previous.release == "DR1",
                previous.uri,
            ):
                unique[obs.identity] = obs
        # Reserve candidates for both detector ranges and cover the full returned time span.
        selected = []
        for detector in ("D2", "D6"):
            group = sorted(
                (o for o in unique.values() if o.detector == detector),
                key=lambda o: o.mjd,
            )
            selected.extend(evenly_spaced(group, self.settings.max_candidates // 2))
        if len(unique) > len(selected):
            notes.append(
                f"Inspecting {len(selected)} exposures sampled across available dates and detectors D2/D6."
            )
        return sorted(selected, key=lambda o: o.mjd), notes

    def fetch(self, obs: Observation, query: Query, path: Path, deadline: float):
        url = (
            checked_url(obs.uri)
            + "?"
            + urlencode({"center": f"{query.ra_deg},{query.dec_deg}d", "size": 5 / 60})
        )
        for attempt in range(2):
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
                            for chunk in r.iter_bytes(65536):
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
                time.sleep(min(0.5, max(0, deadline - time.monotonic())))
        raise ArchiveError("Cutout download failed")
