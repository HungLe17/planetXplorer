"""Fetch calibrated survey products for the four-arcminute Barnard's Star field."""
import csv
import io
import json
import shutil
import sys
from collections import defaultdict
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryFile
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import astropy.units as u
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.nddata import Cutout2D
from astropy.table import Table
from astropy.time import Time
from astropy.wcs import WCS

CACHE = Path(__file__).resolve().parent / "cache"
IRSA = "https://irsa.ipac.caltech.edu"
ESA = "https://eas.esac.esa.int"
DESI = "https://data.desi.lbl.gov/public/dr1"
LSS = DESI + "/survey/catalogs/dr1/LSS/iron/LSScats/v1.5/"


def position(year):
    # SIMBAD J2000 coordinates and annual proper motion in degrees.
    years = year - 2000
    return SkyCoord(269.452077 - 0.0002234 * years, 4.693365 + 0.0028784 * years, unit="deg")


def fetch(url, **params):
    with urlopen(url + ("?" + urlencode(params) if params else ""), timeout=120) as response:
        return response.read()


def rows(data, key):
    reader = csv.DictReader(io.StringIO(data.decode("utf-8-sig")))
    if key not in (reader.fieldnames or []):
        raise ValueError(f"Missing archive column {key}: {data[:200]!r}")
    return list(reader)


def save(name, data):
    with NamedTemporaryFile(dir=CACHE, delete=False) as tmp:
        tmp.write(data)
    Path(tmp.name).replace(CACHE / name)


def irsa_image(name, url, coord):
    if not (CACHE / name).exists():
        data = fetch(url, center=f"{coord.ra.deg},{coord.dec.deg}", size="4arcmin", gzip="false")
        with fits.open(io.BytesIO(data)) as hdus:
            hdus.verify("exception")
        save(name, data)
    return name


def spherex():
    name = "spherex.fits"
    if not (CACHE / name).exists():
        p = position(2025.5)
        data = fetch(IRSA + "/SIA", FACILITY="SPHEREx", POS=f"CIRCLE {p.ra.deg} {p.dec.deg} 0.001",
                     MAXREC=100, RESPONSEFORMAT="CSV")
        row = next(r for r in rows(data, "access_url") if "/level2/" in r["access_url"])
        irsa_image(name, row["access_url"], position(Time(float(row["t_min"]), format="mjd").jyear))
    return [name]


def neowise():
    p = position(2024.25)
    service = "/wise/neowiser/p1bm_frm"
    data = fetch(IRSA + "/ibe/search" + service, POS=f"{p.ra.deg},{p.dec.deg}",
                 INTERSECT="CENTER", where="mjd_obs>60291 and qual_frame=10",
                 columns="scan_id,frame_num,band,mjd_obs")
    frames = defaultdict(set)
    for row in Table.read(data.decode().splitlines(), format="ascii.ipac"):
        frames[float(row["mjd_obs"]), str(row["scan_id"]), int(row["frame_num"])].add(int(row["band"]))
    mjd, scan, frame = max(key for key, bands in frames.items() if bands == {1, 2})
    base = f"{IRSA}/ibe/data{service}/{scan[-2:]}/{scan}/{frame:03d}/{scan}{frame:03d}"
    return [irsa_image(f"neowise-{scan}-{frame:03d}-w{b}.fits", f"{base}-w{b}-int-1b.fits",
                       position(Time(mjd, format="mjd").jyear)) for b in (1, 2)]


def euclid():
    images = {}
    for release in ("dr1", "q1"):
        query = (f"SELECT file_name,filter_name,start_time_mjd FROM {release}.calibrated_frame "
                 "WHERE 1=INTERSECTS(fov,CIRCLE('ICRS',269.446,4.764,0.06)) "
                 "AND product_type IN ('DpdVisCalibratedFrame','DpdVisCalibratedQuadFrame','DpdNirCalibratedFrame')")
        data = fetch(ESA + "/tap-server/tap/sync", REQUEST="doQuery", LANG="ADQL", FORMAT="csv", QUERY=query)
        for row in rows(data, "file_name"):
            band, source = row["filter_name"], row["file_name"]
            if band in images:
                continue
            name = f"euclid-{release}-{source}"
            if not (CACHE / name).exists():
                args = urlencode(dict(RELEASE=release, FILE_NAME=source, RETRIEVAL_TYPE="FILE")).encode()
                coord = position(Time(float(row["start_time_mjd"]), format="mjd").jyear)
                with TemporaryFile(dir=CACHE) as tmp:
                    with urlopen(Request(ESA + "/sas-dd/data", data=args), timeout=180) as response:
                        shutil.copyfileobj(response, tmp)
                    tmp.seek(0)
                    with fits.open(tmp) as hdus:
                        for hdu in hdus:
                            if not hdu.is_image or hdu.header.get("NAXIS") != 2:
                                continue
                            wcs = WCS(hdu.header).celestial
                            if not wcs.has_celestial or not wcs.footprint_contains(coord):
                                continue
                            cut = Cutout2D(hdu.data, coord, 4*u.arcmin, wcs=wcs)
                            header = hdu.header.copy()
                            header.update(cut.wcs.to_header(relax=True))
                            header["FILTER"] = band
                            header["MJD-OBS"] = float(row["start_time_mjd"])
                            out = io.BytesIO()
                            fits.PrimaryHDU(cut.data, header).writeto(out)
                            save(name, out.getvalue())
                            break
            if (CACHE / name).exists():
                images[band] = name
    return list(images.values())


def desi():
    # A 2-degree bound conservatively encloses every fiber in a DESI tile.
    tiles = rows(fetch(DESI + "/spectro/redux/iron/tiles-iron.csv"), "TILEID")
    tiles = [t for t in tiles if t["SURVEY"] == "main" and t["PROGRAM"] in ("bright", "dark")]
    centers = SkyCoord([float(t["TILERA"]) for t in tiles], [float(t["TILEDEC"]) for t in tiles], unit="deg")
    p = position(2025.5)
    nearest = float(min(p.separation(centers).deg))
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(("TARGETID", "RA", "DEC", "Z", "TRACER"))
    if nearest <= 2 + np.sqrt(2)/30:
        for tracer in ("BGS_ANY", "LRG", "ELG_LOPnotqso"):
            for cap in ("NGC", "SGC"):
                url = f"{LSS}{tracer}_{cap}_clustering.dat.fits"
                with TemporaryFile(dir=CACHE) as tmp:
                    with urlopen(url, timeout=180) as response:
                        shutil.copyfileobj(response, tmp)
                    tmp.seek(0)
                    with fits.open(tmp) as hdus:
                        table = hdus[1].data
                        mask = ((abs(table["RA"] - p.ra.deg)*np.cos(p.dec.radian) <= 1/30)
                                & (abs(table["DEC"] - p.dec.deg) <= 1/30))
                        for r in table[mask]:
                            writer.writerow((r["TARGETID"], r["RA"], r["DEC"], r["Z"], tracer))
    save("desi-dr1-lss.csv", out.getvalue().encode())
    return {"file": "desi-dr1-lss.csv", "nearest_tile_deg": nearest, "source": LSS}


if __name__ == "__main__":
    CACHE.mkdir(exist_ok=True)
    results = {}
    for survey in (spherex, neowise, euclid, desi):
        try:
            results[survey.__name__] = survey()
        except Exception as error:
            results[survey.__name__] = {"error": str(error) or type(error).__name__}
        print(survey.__name__, results[survey.__name__], flush=True)
    save("products.json", json.dumps(results, indent=2).encode())
    sys.exit(any("error" in result for result in results.values()))
