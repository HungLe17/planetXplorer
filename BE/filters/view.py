"""Open the latest pull offline, or render it to the cache with --save."""
import csv
import json
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from astropy.io import fits
from astropy.time import Time
from astropy.visualization import simple_norm

cache = Path(__file__).resolve().parent / "cache"
manifest = cache / "products.json"
if not manifest.exists():
    sys.exit("Run pull.py first.")
products = json.loads(manifest.read_text())
images = [(survey, name) for survey, files in products.items()
          if isinstance(files, list) for name in files]
desi = products["desi"]
galaxies = []
notes = [f"{name}: request failed ({result['error']})" for name, result in products.items()
         if isinstance(result, dict) and "error" in result]
if products["euclid"] == []:
    notes.append("Euclid DR1 + Q1 · No matching LE2 VIS or NIR frame")
if "file" in desi:
    with (cache / desi["file"]).open() as stream:
        galaxies = list(csv.DictReader(stream))
    if not galaxies:
        notes.append(f"DESI DR1 LSS · 0 galaxies in field · nearest main-survey tile center {desi['nearest_tile_deg']:.1f}°")

count = max(1, len(images) + bool(galaxies))
fig, axes = plt.subplots(1, count, figsize=(3.8 * count, 4.8), squeeze=False)
for ax in axes.flat:
    ax.set_axis_off()
for ax, (survey, name) in zip(axes.flat, images):
    with fits.open(cache / name) as hdus:
        hdu = next(h for h in hdus if h.is_image and h.header.get("NAXIS") == 2)
        image = hdu.data
        hdr = hdu.header
        date = hdr.get("DATE-OBS") or hdr.get("DATE_OBS", "")
        if not date and "MJD-OBS" in hdr:
            date = Time(hdr["MJD-OBS"], format="mjd").isot
        if survey == "neowise":
            title = f"NEOWISE Final · W{hdr['BAND']}"
        elif survey == "euclid":
            title = f"Euclid {name.split('-')[1].upper()} · {hdr['FILTER']}"
        else:
            title = "SPHEREx · Level 2"
        ax.imshow(image, origin="lower", cmap="gray",
                  norm=simple_norm(image[np.isfinite(image)], "asinh", percent=99.5))
        ax.set_title(f"{title}\n{date[:10]}")
if galaxies:
    from pull import position
    p = position(2025.5)
    ax = axes.flat[-1]
    ax.set_axis_on()
    for tracer in sorted({r["TRACER"] for r in galaxies}):
        subset = [r for r in galaxies if r["TRACER"] == tracer]
        ax.scatter([float(r["RA"]) for r in subset], [float(r["DEC"]) for r in subset], label=tracer)
    ax.scatter(p.ra.deg, p.dec.deg, marker="*", label="Barnard’s Star")
    ax.invert_xaxis()
    ax.set(xlabel="RA (deg)", ylabel="Dec (deg)", title="DESI DR1 LSS")
    ax.legend()
fig.suptitle("Barnard’s Star · 4 arcmin field")
fig.text(0.5, 0.025, "\n".join(notes), ha="center", fontsize=9)
fig.tight_layout(rect=(0, 0.10, 1, 0.94))
if "--save" in sys.argv:
    fig.savefig(cache / "barnards-star.png", dpi=150)
else:
    plt.show()
