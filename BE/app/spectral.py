"""Read the visualization wavelength WCS from cutouts or bounded FITS byte ranges."""

import io
import re

from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.time import Time
from astropy.wcs import WCS
import astropy.units as u
import numpy as np


def spectral_wcs(header, hdus):
    header = header.copy()
    for key in list(header):
        if re.fullmatch(r"(A|B|AP|BP)_(ORDER|DMAX|\d+_\d+)", key):
            del header[key]
    result = WCS(header, fobj=hdus, key="W")
    result.sip = None
    return result


def image_header(prefix):
    for offset in range(2880, len(prefix), 2880):
        if prefix[offset:offset+8] == b"XTENSION":
            image = fits.Header.fromfile(io.BytesIO(prefix[offset:]))
            if image.get("EXTNAME", "").strip() == "IMAGE":
                break
    else:
        raise ValueError("IMAGE header unavailable in prefix")
    if not any(prefix[i:i+8] == b"END     " for i in range(offset, len(prefix), 80)):
        raise ValueError("Incomplete IMAGE header")
    return image


def exposure_midpoint(header) -> str | None:
    """Use the FITS time system and its exposure midpoint or measured bounds."""
    scale = str(header.get("TIMESYS", "UTC")).strip().lower()
    if scale not in {"utc", "tt", "tai", "tdb"}:
        return None

    def instant(suffix):
        for key, format in (("MJD-" + suffix, "mjd"), ("DATE-" + suffix, "isot")):
            if key in header:
                try:
                    t = Time(header[key], format=format, scale=scale)
                    if np.isfinite(t.jd):
                        return t
                except (TypeError, ValueError):
                    continue
        return None

    middle = instant("AVG")
    if middle is None:
        start, end = instant("BEG"), instant("END")
        if start is None or end is None or end < start:
            return None
        middle = start + (end - start) * 0.5
    return middle.utc.isot + "Z"


def spectral_header_index(prefix, tail, query):
    """IRSA's uncompressed full MEFs end with a small, self-contained WCS-WAVE HDU."""
    primary = fits.Header.fromfile(io.BytesIO(prefix))
    image = image_header(prefix)
    for offset in range(0, len(tail), 2880):
        if tail[offset:offset+8] != b"XTENSION":
            continue
        table_head = fits.Header.fromfile(io.BytesIO(tail[offset:]))
        if table_head.get("EXTNAME", "").strip() == "WCS-WAVE":
            table = fits.BinTableHDU.fromstring(tail[offset:])
            break
    else:
        raise ValueError("No trailing wavelength table")
    coordinate = SkyCoord(query.ra_deg*u.deg, query.dec_deg*u.deg)
    x, y = WCS(image).celestial.world_to_pixel(coordinate)
    if not (-0.5 <= x < image["NAXIS1"]-0.5 and -0.5 <= y < image["NAXIS2"]-0.5):
        raise ValueError("Center outside indexed exposure")
    with fits.HDUList([fits.PrimaryHDU(), table]) as hdus:
        wave, band = spectral_wcs(image, hdus).pixel_to_world(x, y)
    wave, band = float(wave.to_value(u.um)), float(band.to_value(u.um))
    if not np.isfinite(wave) or not np.isfinite(band) or band <= 0:
        raise ValueError("Invalid spectral lookup")
    return {"wavelength_um": wave, "bandwidth_um": band,
            "processing_version": str(primary.get("VERSION", "unknown"))}
