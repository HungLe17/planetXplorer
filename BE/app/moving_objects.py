"""Known small bodies at a SPHEREx exposure's mid-time, from the spacecraft."""

import asyncio
import csv
import math
import re
import ssl
import time
from collections import OrderedDict
from datetime import UTC, datetime
from urllib.parse import quote

import astropy.units as u
from astropy.coordinates import Angle, SkyCoord
from astropy.time import Time
from fastapi import APIRouter, HTTPException, Request
import httpx
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
import truststore

from .archive import ArchiveError, checked_url, retry_after_seconds
from .pipeline import target_grid
from .spectral import exposure_midpoint, image_header

HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"
SB_IDENT = "https://ssd-api.jpl.nasa.gov/sb_ident.api"
SPHEREX = "-163182"
USER_AGENT = "planetXplorer/1.0 (+https://github.com/HungLe17/planetXplorer/issues)"
router = APIRouter()


class MovingField(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    ra_deg: float = Field(ge=0, lt=360)
    dec_deg: float = Field(ge=-90, le=90)
    fov_arcsec: float = Field(ge=30, le=1800)
    midpoint_utc: AwareDatetime | None = None
    job_id: str | None = Field(default=None, pattern="^[a-f0-9]{32}$")
    observation_id: str | None = Field(default=None, max_length=180)


def spacecraft_vector(payload, jd):
    result = payload.get("result", "")
    if (payload.get("signature", {}).get("version") not in {"1.2", "1.3"}
            or payload.get("error") or "$$SOE" not in result or "$$EOE" not in result):
        raise ValueError("JPL has no verified SPHEREx spacecraft state at this epoch.")
    for pattern in (r"Target body name:.*SPHEREx.*\(-163182\)", r"Center body name:.*Earth \(399\)",
                    r"Reference frame\s*:\s*ICRF", r"Output units\s*:\s*KM-S",
                    r"Output type\s*:\s*GEOMETRIC", r"\bJDUT\b"):
        if not re.search(pattern, result, re.IGNORECASE):
            raise ValueError("Unexpected coordinate system or units in the JPL spacecraft state.")
    block = result.split("$$SOE", 1)[1].split("$$EOE", 1)[0].strip().splitlines()
    if len(block) != 1:
        raise ValueError("JPL did not return one spacecraft state.")
    row = next(csv.reader(block))
    values = [float(v) for v in row[2:8]]
    if len(values) != 6 or not all(map(math.isfinite, values)) or abs(float(row[0]) - jd) > 1e-7:
        raise ValueError("JPL did not return a finite state for the requested instant.")
    return ",".join(str(v) for v in values)


def field_parameters(q, jd, vector):
    # Circumscribe the projected (pixel-rounded) TAN square with a spherical
    # cap, accounting for longitude convergence. The final WCS test clips it.
    _, (size, _) = target_grid(q)
    radius = math.radians(size * 6.14 / 3600 / math.sqrt(2))
    dec = math.radians(q.dec_deg)
    ra_half = 180 if abs(dec) + radius >= math.pi / 2 else math.degrees(
        math.asin(math.sin(radius) / math.cos(dec))
    )
    center_ra = Angle(q.ra_deg, u.deg).to_string(unit=u.hourangle, sep="-", pad=True, precision=3)
    center_dec = Angle(abs(q.dec_deg), u.deg).to_string(sep="-", pad=True, precision=3)
    return {
        "xobs": vector, "obs-time": f"{jd:.9f}", "fov-ra-center": center_ra,
        "fov-dec-center": ("M" if q.dec_deg < 0 else "") + center_dec,
        "fov-ra-hwidth": f"{ra_half:.9f}", "fov-dec-hwidth": f"{math.degrees(radius):.9f}",
        "two-pass": "true", "suppress-first-pass": "true", "mag-required": "false", "req-elem": "false",
    }


def field_results(payload, q, jd):
    if payload.get("signature", {}).get("version") != "1.1":
        raise ValueError("Unexpected JPL field identification format.")
    observer_epoch = re.search(r"\(([\d.]+) UT\)", payload["observer"]["obs_date"])
    if not observer_epoch or abs(float(observer_epoch[1]) - jd) * 86400 > 1:
        raise ValueError("JPL field results belong to a different epoch.")
    # SB_IDENT omits the count and tables for an empty field.
    if "n_second_pass" not in payload and payload.get("warning") == "no matching records":
        return []
    count = int(payload["n_second_pass"])
    rows = payload.get("data_second_pass", [])
    if count != len(rows):
        raise ValueError("Incomplete second-pass field results from JPL.")
    if not rows:
        return []
    columns = payload["fields_second"]
    name_col = columns.index("Object name")
    ra_col = next(i for i, name in enumerate(columns) if name.startswith("Astrometric RA"))
    dec_col = next(i for i, name in enumerate(columns) if name.startswith("Astrometric Dec"))
    grid, (height, width) = target_grid(q)
    objects = []
    for row in rows:
        name = row[name_col]
        dec = row[dec_col].replace("'", " ").replace('"', "")
        point = SkyCoord(row[ra_col], dec, unit=(u.hourangle, u.deg), frame="icrs")
        x, y = grid.world_to_pixel(point)
        if -0.5 <= x < width - 0.5 and -0.5 <= y < height - 0.5:
            numbered = re.match(r"^(\d+)\s", name)
            designation = numbered[1] if numbered else name
            # JPL supplies a designation but no taxonomic column. A numbered
            # minor planet and an explicitly designated comet can be identified.
            category = "Solar System small body"
            if numbered:
                category = "Numbered minor planet"
            elif re.match(r"^(?:\d+[PD]|[CPDX])/", name, re.IGNORECASE):
                category = "Comet"
            objects.append({
                "id": "jpl:" + name, "name": name, "type": "moving", "category": category,
                "ra_deg": float(point.ra.deg), "dec_deg": float(point.dec.deg),
                "source_url": "https://ssd.jpl.nasa.gov/tools/sbdb_lookup.html#/?sstr=" + quote(designation, safe=""),
            })
    return objects


def remember(cache, key, value):
    cache[key] = value
    cache.move_to_end(key)
    if len(cache) > 256:
        cache.popitem(last=False)


class MovingObjects:
    def __init__(self, transport=None):
        self.http = httpx.AsyncClient(transport=transport, verify=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT),
                                      headers={"User-Agent": USER_AGENT}, timeout=httpx.Timeout(155, connect=10))
        self.lock = asyncio.Lock()
        self.queued = 0
        self.cooldown = 0.0
        self.results = OrderedDict()
        self.epochs = OrderedDict()
        self.states = OrderedDict()

    async def epoch(self, q, jobs):
        if q.midpoint_utc is not None:
            return q.midpoint_utc.astimezone(UTC)
        job = await asyncio.to_thread(jobs.get, q.job_id) if q.job_id and q.observation_id else None
        frame = next((f for f in job.manifest.frames if f.observation_id == q.observation_id), None
                     ) if job and job.manifest else None
        if not frame:
            raise HTTPException(422, "A registered exposure or its UTC midpoint is needed for moving objects.")
        if frame.midpoint_utc:
            return datetime.fromisoformat(frame.midpoint_utc)
        uri = checked_url(frame.source_url.split("?", 1)[0])
        if uri not in self.epochs:
            # Legacy products lack midpoint_utc. Read only the archived FITS header;
            # never infer an instant from the catalog's exposure start timestamp.
            async with self.http.stream("GET", uri, headers={"Range": "bytes=0-92159", "Accept-Encoding": "identity"},
                                        timeout=15) as r:
                if r.status_code != 206 or not r.headers.get("Content-Range", "").startswith("bytes 0-"):
                    raise ValueError("IRSA could not supply the archived exposure midpoint.")
                prefix = bytearray()
                async for chunk in r.aiter_bytes(8192):
                    if len(prefix) + len(chunk) > 92160:
                        raise ValueError("IRSA FITS header exceeds the metadata limit.")
                    prefix.extend(chunk)
            middle = exposure_midpoint(image_header(bytes(prefix)))
            if not middle:
                raise ValueError("The exposure has no verifiable midpoint.")
            remember(self.epochs, uri, datetime.fromisoformat(middle))
        return self.epochs[uri]

    async def lookup(self, q, jobs, disconnected):
        if self.queued >= 4:
            raise HTTPException(429, "Moving-object lookups are busy.", headers={"Retry-After": "15"})
        self.queued += 1
        try:
            async with self.lock:
                if await disconnected():
                    raise HTTPException(499, "Lookup cancelled.")
                epoch = await self.epoch(q, jobs)
                key = (q.ra_deg, q.dec_deg, q.fov_arcsec, epoch)
                now = time.monotonic()
                if key in self.results and now < self.results[key][0]:
                    return self.results[key][1]
                if now < self.cooldown:
                    raise HTTPException(503, "JPL is temporarily unavailable.", headers={
                        "Retry-After": str(math.ceil(self.cooldown - now))})
                jd = Time(epoch, scale="utc").jd
                if epoch not in self.states or now >= self.states[epoch][0]:
                    params = {"COMMAND": SPHEREX, "CENTER": "500@399", "EPHEM_TYPE": "VECTORS",
                              "TIME_TYPE": "UT", "TLIST": f"{jd:.9f}", "REF_PLANE": "FRAME", "REF_SYSTEM": "ICRF",
                              "OUT_UNITS": "KM-S", "VEC_CORR": "NONE", "VEC_TABLE": "2", "CSV_FORMAT": "YES",
                              "OBJ_DATA": "NO", "format": "json"}
                    r = await self.http.get(HORIZONS, params=params, timeout=35)
                    r.raise_for_status()
                    remember(self.states, epoch, (now + 86400, spacecraft_vector(r.json(), jd)))
                if await disconnected():
                    raise HTTPException(499, "Lookup cancelled.")
                r = await self.http.get(SB_IDENT, params=field_parameters(q, jd, self.states[epoch][1]))
                r.raise_for_status()
                objects = field_results(r.json(), q, jd)
                result = {"objects": objects, "warnings": [], "midpoint_utc": epoch.isoformat(),
                          "fetched_at": datetime.now(UTC).isoformat(), "source_url": "https://ssd-api.jpl.nasa.gov/doc/sb_ident.html"}
                remember(self.results, key, (now + 86400, result))
                return result
        except (httpx.HTTPError, ArchiveError, ValueError, KeyError, IndexError, TypeError, StopIteration, OSError) as exc:
            delay = 30
            if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in (429, 503):
                delay = max(delay, retry_after_seconds(exc.response))
            if isinstance(exc, httpx.HTTPError):
                self.cooldown = max(self.cooldown, time.monotonic() + delay)
            raise HTTPException(503, "Moving-object positions unavailable: " + str(exc)[:200],
                                headers={"Retry-After": str(math.ceil(delay))}) from exc
        finally:
            self.queued -= 1


@router.post("/api/known-objects/moving")
async def moving(q: MovingField, request: Request):
    return await request.app.state.moving_objects.lookup(q, request.app.state.jobs, request.is_disconnected)
