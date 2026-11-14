"""Local cone searches over the official DESI DR1 observed-galaxy LSS catalogs."""

import math
from pathlib import Path
from tempfile import NamedTemporaryFile

import httpx
import numpy as np
from astropy.io import fits

LSS = "https://data.desi.lbl.gov/public/dr1/survey/catalogs/dr1/LSS/iron/LSScats/v1.5/"
CATALOGS = tuple(
    f"{tracer}_{cap}"
    for tracer in ("BGS_ANY", "LRG", "ELG_LOPnotqso")
    for cap in ("NGC", "SGC")
)
FIELDS = np.dtype([("DEC", "<f8"), ("RA", "<f8"), ("TARGETID", "<i8"), ("Z", "<f8")])


def prepare_catalog(folder: Path, catalog: str, client: httpx.Client):
    """Build one declination-sorted index atomically, outside the request path."""
    folder.mkdir(parents=True, exist_ok=True)
    output = folder / f"{catalog}.npy"
    if output.exists():
        return
    url = LSS + catalog + "_clustering.dat.fits"
    with NamedTemporaryFile(dir=folder, suffix=".fits", delete=False) as raw:
        path = Path(raw.name)
    temp = None
    try:
        with path.open("wb") as stream, client.stream("GET", url) as response:
            response.raise_for_status()
            for part in response.iter_bytes(1024 * 1024):
                stream.write(part)
            if stream.tell() != int(response.headers["content-length"]):
                raise ValueError("Incomplete DESI catalog download")
        with fits.open(path, memmap=True) as hdus:
            rows = hdus[1].data
            with NamedTemporaryFile(dir=folder, suffix=".npy", delete=False) as result:
                temp = Path(result.name)
            index = np.lib.format.open_memmap(temp, mode="w+", dtype=FIELDS, shape=(len(rows),))
            for name in FIELDS.names:
                index[name] = rows[name]
            index.sort(order="DEC", kind="quicksort")
            del index, rows
        temp.replace(output)
    finally:
        path.unlink(missing_ok=True)
        if temp is not None:
            temp.unlink(missing_ok=True)


def galaxies(folder: Path, ra: float, dec: float) -> list[dict]:
    radius = 2.5 / 60
    limit = math.sin(math.radians(radius) / 2) ** 2
    matches = {}
    for catalog in CATALOGS:
        path = folder / f"{catalog}.npy"
        if not path.is_file():
            raise FileNotFoundError("DESI index is not installed. Run scripts/prepare_desi.py.")
        index = np.load(path, mmap_mode="r", allow_pickle=False)
        start = np.searchsorted(index["DEC"], dec - radius)
        end = np.searchsorted(index["DEC"], dec + radius, side="right")
        rows = index[start:end]
        distance = np.sin(np.radians(rows["DEC"] - dec) / 2) ** 2 + (
            math.cos(math.radians(dec)) * np.cos(np.radians(rows["DEC"]))
            * np.sin(np.radians(rows["RA"] - ra) / 2) ** 2
        )
        for i in np.flatnonzero(distance <= limit):
            row = rows[i]
            target = str(row["TARGETID"])
            if target not in matches:
                matches[target] = dict(
                    id=target, ra_deg=float(row["RA"]), dec_deg=float(row["DEC"]),
                    redshift=float(row["Z"]), tracers=[], distance=float(distance[i]),
                )
            matches[target]["tracers"].append(catalog.rsplit("_", 1)[0])
    ordered = sorted(matches.values(), key=lambda item: item["distance"])
    for item in ordered:
        del item["distance"]
    return ordered
