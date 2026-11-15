"""Ancillary field data. Each survey can be queried independently of a blink job."""

import base64
import csv
import io
import re
from collections import defaultdict
from urllib.parse import urlencode, urlsplit

import httpx
import numpy as np
from astropy.io import fits
from astropy.table import Table
from astropy.time import Time
from PIL import Image

IRSA = "https://irsa.ipac.caltech.edu/ibe"
WISE = "/wise/neowiser/p1bm_frm"
EUCLID = "https://eas.esac.esa.int/tap-server/tap/sync"


def read_small(client: httpx.Client, url: str, params: dict, limit: int) -> bytes:
    data = bytearray()
    with client.stream("GET", url, params=params) as response:
        response.raise_for_status()
        for part in response.iter_bytes(65536):
            if len(data) + len(part) > limit:
                raise ValueError("Archive response exceeded the field lookup size limit")
            data.extend(part)
    return bytes(data)


def preview(content: bytes) -> str:
    with fits.open(io.BytesIO(content), memmap=False) as hdus:
        hdu = hdus[0]
        if hdu.header.get("NAXIS") != 2 or max(hdu.shape) > 512:
            raise ValueError("Unexpected cutout dimensions")
        image = np.asarray(hdu.data, dtype=float)
    valid = np.isfinite(image)
    if not valid.any():
        raise ValueError("No valid pixels in cutout")
    low, high = np.percentile(image[valid], [1, 99.5])
    gray = np.zeros(image.shape, dtype=np.uint8)
    if high > low:
        values = np.clip((image[valid] - low) / (high - low), 0, 1)
        gray[valid] = np.round(255 * np.arcsinh(10 * values) / np.arcsinh(10))
    out = io.BytesIO()
    Image.fromarray(np.flipud(np.dstack((gray, (valid * 255).astype("uint8"))))).save(out, "PNG")
    return "data:image/png;base64," + base64.b64encode(out.getvalue()).decode("ascii")


def neowise(client: httpx.Client, ra: float, dec: float) -> dict:
    params = dict(POS=f"{ra},{dec}", INTERSECT="CENTER", where="qual_frame=10",
                  columns="scan_id,frame_num,band,mjd_obs")
    content = read_small(client, IRSA + "/search" + WISE, params, 4_000_000)
    rows = Table.read(content.decode().splitlines(), format="ascii.ipac")
    if not {"scan_id", "frame_num", "band", "mjd_obs"} <= set(rows.colnames):
        raise ValueError("Unexpected NEOWISE metadata")
    pairs = defaultdict(set)
    for row in rows:
        key = (float(row["mjd_obs"]), str(row["scan_id"]), int(row["frame_num"]))
        pairs[key].add(int(row["band"]))
    latest = max((key for key, bands in pairs.items() if bands == {1, 2}), default=None)
    if latest is None:
        return {"images": []}
    mjd, scan, frame = latest
    if not re.fullmatch(r"[A-Za-z0-9]+", scan) or not 0 <= frame <= 999:
        raise ValueError("Unexpected NEOWISE frame identifier")
    prefix = f"{IRSA}/data{WISE}/{scan[-2:]}/{scan}/{frame:03}/{scan}{frame:03}"
    images = []
    for band in (1, 2):
        url = f"{prefix}-w{band}-int-1b.fits"
        cutout = dict(center=f"{ra},{dec}", size="4arcmin", gzip="false")
        item = dict(band=f"W{band}", source_url=url + "?" + urlencode(cutout))
        try:
            item["preview"] = preview(read_small(client, url, cutout, 2_000_000))
        except (httpx.HTTPError, ValueError, OSError):
            item["warning"] = "Cutout preview unavailable"
        images.append(item)
    return dict(images=images, observed_at=Time(mjd, format="mjd").utc.isot + "Z",
                observation_id=f"{scan}-{frame:03}")


def euclid(client: httpx.Client, ra: float, dec: float) -> dict:
    groups, unavailable = [], []
    for release in ("dr1", "q1"):
        where = (
            f" FROM {release}.calibrated_frame WHERE "
            f"1=CONTAINS(POINT('ICRS',{ra},{dec}),fov) AND product_type IN "
            "('DpdVisCalibratedFrame','DpdVisCalibratedQuadFrame','DpdNirCalibratedFrame')"
        )
        params = dict(REQUEST="doQuery", LANG="ADQL", FORMAT="csv",
                      QUERY="SELECT filter_name, COUNT(*) AS exposures, MAX(start_time_mjd) AS latest"
                      + where + " GROUP BY filter_name")
        try:
            content = read_small(client, EUCLID, params, 250_000)
            rows = csv.DictReader(io.StringIO(content.decode("utf-8-sig")))
            if not {"filter_name", "exposures", "latest"} <= set(rows.fieldnames or []):
                raise ValueError("Unexpected Euclid metadata")
            release_groups = []
            for row in rows:
                band = row["filter_name"]
                if not re.fullmatch(r"[A-Za-z0-9_-]+", band):
                    raise ValueError("Unexpected filter")
                detail = dict(params, QUERY="SELECT TOP 50 observation_id,file_name,start_time_mjd"
                              + where + f" AND filter_name='{band}' ORDER BY start_time_mjd DESC")
                release_groups.append(dict(release=release.upper(), band=band, count=int(row["exposures"]),
                                           latest=Time(float(row["latest"]), format="mjd").utc.isot + "Z",
                                           source_url=EUCLID + "?" + urlencode(detail)))
            groups.extend(release_groups)
        except (httpx.HTTPError, ValueError, KeyError):
            unavailable.append(release.upper())
    if len(unavailable) == 2:
        raise ValueError("Euclid exposure service unavailable")
    return dict(bands=groups, unavailable=unavailable)


def euclid_images(client: httpx.Client, ra: float, dec: float) -> dict:
    """IRSA SIA2 MER science mosaics with bounded IBE cutouts.

    https://irsa.ipac.caltech.edu/ibe/sia.html
    https://irsa.ipac.caltech.edu/ibe/cutouts.html
    """
    content = read_small(client, "https://irsa.ipac.caltech.edu/SIA",
                         dict(COLLECTION="euclid_DpdMerBksMosaic",
                              POS=f"CIRCLE {ra} {dec} 0.000001", DPTYPE="image", MAXREC=24), 2_000_000)
    rows = Table.read(io.BytesIO(content), format="votable")
    if "access_url" not in rows.colnames:
        raise ValueError("Unexpected Euclid image metadata")
    images, bands = [], set()
    for row in rows:
        url = str(row["access_url"])
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.hostname != "irsa.ipac.caltech.edu" or not parsed.path.startswith("/ibe/data/euclid/"):
            continue
        match = re.search(r"(NIR-[YJH]|VIS)", parsed.path)
        band = match.group(1) if match else str(row["obs_id"]) if "obs_id" in rows.colnames else "MER"
        if band in bands:
            continue
        bands.add(band)
        params = dict(center=f"{ra},{dec}", size="30arcsec", gzip="false")
        item = dict(band=band, source_url=url + ("&" if parsed.query else "?") + urlencode(params),
                    product_url=url)
        if "t_min" in rows.colnames and not np.ma.is_masked(row["t_min"]):
            item["observed_at"] = Time(float(row["t_min"]), format="mjd").utc.isot + "Z"
        try:
            item["preview"] = preview(read_small(client, url, params, 4_000_000))
        except (httpx.HTTPError, ValueError, OSError):
            item["warning"] = "Cutout preview unavailable. The original FITS remains available."
        images.append(item)
        if len(images) == 4:
            break
    return dict(images=images, field_arcsec=30, product="MER background-subtracted mosaic")
