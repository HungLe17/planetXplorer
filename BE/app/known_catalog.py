"""Metadata-only catalog candidates for the SPHEREx sky grid."""

import csv
import math
import ssl
import time
from collections import Counter, OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import UTC, datetime
from threading import Lock
from urllib.parse import quote, urlencode

import httpx
import truststore
from astropy.table import Table
from astropy.time import Time
from fastapi import APIRouter, HTTPException

from .schemas import Query
from .surveys import read_small

GAIA = "https://gea.esac.esa.int/tap-server/tap/sync"
SIMBAD = "https://simbad.cfa.harvard.edu/simbad/sim-tap/sync"
GATOR = "https://irsa.ipac.caltech.edu/cgi-bin/Gator/nph-query"
WISE_EPOCH = 2000 + (57170 - 51544.5) / 365.25
MAX_ROWS = 1500
MOTION_MARGIN = 12  # arcsec/year, above Barnard's measured 10.4
router = APIRouter()


class CatalogField(Query):
    start_utc: datetime
    end_utc: datetime


def number(value):
    try:
        n = float(str(value))
        return n if math.isfinite(n) else None
    except ValueError:
        return None


def source(catalog, key, name, kind, url, ra, dec, epoch, pmra, pmdec, aliases=()):
    ra, dec = number(ra), number(dec)
    if ra is None or dec is None or not (0 <= ra < 360 and -90 <= dec <= 90):
        return None
    pmra, pmdec = number(pmra), number(pmdec)
    if pmra is None or pmdec is None:
        pmra = pmdec = None
    return dict(id=f"{catalog}:{key}", name=name, type=kind, ra_deg=ra, dec_deg=dec,
                epoch_jyear=number(epoch), pmra_masyr=pmra, pmdec_masyr=pmdec,
                source=catalog, aliases=list(aliases), sources=[catalog], source_url=url)


def tap(client, url, sql, expected):
    params = dict(REQUEST="doQuery", LANG="ADQL", FORMAT="csv", QUERY=sql)
    body = read_small(client, url, params, 8_000_000)
    rows = csv.DictReader(body.decode("utf-8-sig").splitlines())
    if not set(expected).issubset(rows.fieldnames or []):
        raise ValueError("Unexpected TAP response")
    return list(rows)


def cone(ra, dec, radius, ra_col, dec_col):
    return (f"1=CONTAINS(POINT('ICRS',{ra_col},{dec_col}),"
            f"CIRCLE('ICRS',{ra:.10f},{dec:.10f},{radius / 3600:.10f}))")


def gaia(client, ra, dec, radius):
    rows = tap(client, GAIA,
               f"SELECT TOP {MAX_ROWS+1} source_id,ra,dec,ref_epoch,pmra,pmdec "
               "FROM gaiadr3.gaia_source WHERE " + cone(ra, dec, radius, "ra", "dec")
               + " ORDER BY phot_g_mean_mag ASC", ["source_id", "ra", "dec", "ref_epoch", "pmra", "pmdec"])
    objects = []
    for r in rows[:MAX_ROWS]:
        label = "Gaia DR3 " + r["source_id"]
        link = "https://vizier.cfa.harvard.edu/viz-bin/VizieR-5?" + urlencode(
            {"-source": "I/355/gaiadr3", "Source": r["source_id"]})
        objects.append(source("Gaia DR3", r["source_id"], label, "Gaia source", link,
                              r["ra"], r["dec"], r["ref_epoch"], r["pmra"], r["pmdec"], [label]))
    return objects, len(rows) > MAX_ROWS


def simbad(client, ra, dec, radius):
    rows = tap(client, SIMBAD, f"SELECT TOP {MAX_ROWS+1} b.oid,b.main_id,b.ra,b.dec,b.pmra,b.pmdec,"
               "t.description,x.ids FROM basic AS b LEFT OUTER JOIN ids AS x ON x.oidref=b.oid "
               "LEFT OUTER JOIN otypedef AS t ON t.otype=b.otype WHERE "
               + cone(ra, dec, radius, "b.ra", "b.dec") + " ORDER BY nbref DESC",
               ["oid", "main_id", "ra", "dec", "pmra", "pmdec", "description", "ids"])
    objects = []
    for r in rows[:MAX_ROWS]:
        name = r["main_id"]
        link = "https://simbad.cfa.harvard.edu/simbad/sim-id?Ident=" + quote(name)
        objects.append(source("SIMBAD", r["oid"], name.removeprefix("NAME "), r["description"] or "SIMBAD object",
                              link, r["ra"], r["dec"], 2000, r["pmra"], r["pmdec"], r["ids"].split("|")))
    return objects, len(rows) > MAX_ROWS


def catwise(client, ra, dec, radius):
    # Gator spatially indexes the stationary solution. Its mean observation epoch
    # can differ from the common motion-fit epoch anywhere in the 2010–2018 survey.
    params = dict(catalog="catwise_2020", spatial="cone", objstr=f"{ra:.10f} {dec:.10f}",
                  radius=radius + 6*MOTION_MARGIN, radunits="arcsec", outfmt=1, outrows=MAX_ROWS+1,
                  selcols="source_id,source_name,ra,dec,meanobsmjd,ra_pm,dec_pm,km,pmra,pmdec")
    body = read_small(client, GATOR, params, 3_000_000)
    rows = Table.read(body.decode().splitlines(), format="ascii.ipac")
    if not set(params["selcols"].split(",")).issubset(rows.colnames):
        raise ValueError("Unexpected CatWISE response")
    objects = []
    for r in rows[:MAX_ROWS]:
        raw_name = str(r["source_name"]).strip()
        label = "CWISE " + raw_name.removeprefix("WISEA ").removeprefix("CWISE ")
        x, y = number(r["ra_pm"]), number(r["dec_pm"])
        dx, dy = number(r["pmra"]), number(r["pmdec"])
        if str(r["km"]).strip() in ("1", "2", "3") and None not in (x, y, dx, dy):
            epoch, dx, dy = WISE_EPOCH, dx*1000, dy*1000
        else:
            x, y = r["ra"], r["dec"]
            mjd = number(r["meanobsmjd"])
            epoch = 2000 + (mjd - 51544.5)/365.25 if mjd is not None else None
            dx = dy = None
        link = GATOR + "?" + urlencode(dict(catalog="catwise_2020", spatial="cone",
                    objstr=f"{r['ra']} {r['dec']}", radius=2, radunits="arcsec"))
        objects.append(source("CatWISE2020", str(r["source_id"]), label, "Infrared source", link,
                              x, y, epoch, dx, dy, [label]))
    return objects, len(rows) > MAX_ROWS


def merge_identifications(groups):
    """Merge only unique, release-specific identifiers reported by SIMBAD."""
    def norm(alias):
        return " ".join(alias.upper().split())

    external = [o for cat in ("Gaia DR3", "CatWISE2020") for o in groups.get(cat, [])]
    named = groups.get("SIMBAD", [])
    count = Counter(norm(o["name"]) for o in external)
    by_alias = {norm(o["name"]): o for o in external if count[norm(o["name"])] == 1}
    associations = [[by_alias[key] for key in sorted({norm(a) for a in s["aliases"]}) if key in by_alias]
                    for s in named]
    claims = Counter(o["id"] for matches in associations for o in matches)
    result = {o["id"]: o for o in external}
    for s, matches in zip(named, associations, strict=True):
        catalogs = {o["source"] for o in matches}
        if len(catalogs) != len(matches) or any(claims[o["id"]] != 1 for o in matches):
            matches = []
        candidates = sorted([*matches, s], key=lambda o: (
            o["pmra_masyr"] is None, ("Gaia DR3", "CatWISE2020", "SIMBAD").index(o["source"])))
        best = candidates[0]
        for o in matches:
            result.pop(o["id"], None)
        result[best["id"]] = dict(best, name=s["name"], type=s["type"], source_url=s["source_url"],
                                  sources=[o["source"] for o in candidates],
                                  aliases=sorted({a for o in candidates for a in o["aliases"] if a}))
    return list(result.values())


def can_reach_field(o, ra, dec, radius, years):
    """Conservative angular bound. The viewer clips each epoch to the actual WCS."""
    x, y, center_dec = map(math.radians, (o["ra_deg"] - ra, o["dec_deg"], dec))
    h = math.sin((y-center_dec)/2)**2 + math.cos(y)*math.cos(center_dec)*math.sin(x/2)**2
    separation = 3600 * math.degrees(2*math.asin(min(1, math.sqrt(max(0, h)))))
    motion = 0
    if o["pmra_masyr"] is not None and o["epoch_jyear"] is not None:
        motion = math.hypot(o["pmra_masyr"], o["pmdec_masyr"]) / 1000
        motion *= max(abs(t-o["epoch_jyear"]) for t in years)
    return separation <= radius + motion


def field_sources(ra, dec, fov, years):
    radius = math.ceil(fov / 6.14) * 6.14 / math.sqrt(2)
    services = [("Gaia DR3", gaia, 2016), ("SIMBAD", simbad, 2000), ("CatWISE2020", catwise, WISE_EPOCH)]
    groups, warnings = {}, []
    with httpx.Client(verify=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT),
                      timeout=httpx.Timeout(30, connect=8), follow_redirects=True) as client, ThreadPoolExecutor(3) as pool:
        jobs = [(name, pool.submit(fetch, client, ra, dec, radius + MOTION_MARGIN * max(abs(t-epoch) for t in years)))
                for name, fetch, epoch in services]
        for name, future in jobs:
            try:
                objects, truncated = future.result()
                groups[name] = [o for o in objects if o is not None]
                if truncated:
                    warnings.append(f"{name} reached the {MAX_ROWS}-row limit. Field coverage is incomplete.")
            except (httpx.HTTPError, OSError, ValueError, KeyError) as exc:
                warnings.append(f"{name} unavailable ({type(exc).__name__}).")
    if not groups:
        raise HTTPException(502, "The three object catalogs are unavailable. Retry the field lookup.")
    return dict(objects=[o for o in merge_identifications(groups) if can_reach_field(o, ra, dec, radius, years)],
                warnings=warnings, fetched_at=datetime.now(UTC).isoformat(), cached=False)


class CatalogCache:
    def __init__(self):
        self.lock = Lock()
        self.entries = OrderedDict()
        self.pending = {}

    def get(self, key):
        with self.lock:
            hit = self.entries.get(key)
            if hit and hit[0] > time.monotonic():
                self.entries.move_to_end(key)
                return dict(hit[1], cached=True)
            pending = self.pending.get(key)
            if pending is None:
                self.pending[key] = pending = Future()
                owner = True
            else:
                owner = False
        if not owner:
            return pending.result()
        try:
            result = field_sources(*key)
            with self.lock:
                self.entries[key] = (time.monotonic() + (60 if result["warnings"] else 3600), result)
                self.entries.move_to_end(key)
                if len(self.entries) > 16:
                    self.entries.popitem(last=False)
            pending.set_result(result)
            return result
        except Exception as exc:
            pending.set_exception(exc)
            raise
        finally:
            with self.lock:
                self.pending.pop(key, None)


catalog_cache = CatalogCache()


@router.post("/api/known-objects/catalog")
def catalog(field: CatalogField):
    years = (math.floor(Time(field.start_utc).jyear), math.ceil(Time(field.end_utc).jyear))
    return catalog_cache.get((field.ra_deg, field.dec_deg, field.fov_arcsec, years))
