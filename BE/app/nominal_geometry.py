"""SPHEREx nominal channel at the searched sky position in a Level 2 image."""

import gzip
import math
from functools import cache
from pathlib import Path

from astropy.io import fits


SIZE = 2040


@cache
def _channel_pixels() -> bytes:
    # Lossless uint8 CHANNEL_MAP in its original FITS [y, x] order. DETCOORD='sky'
    # and DETECTOR='ALL' apply to every Level 2 plane, including D4–D6.
    data = gzip.decompress((Path(__file__).with_name("data") / "channel-map-v2.u8.gz").read_bytes())
    if len(data) != SIZE * SIZE:
        raise ValueError("Invalid SPHEREx detector geometry.")
    return data


def nominal_channel(detector: str, image_header: fits.Header, x: float, y: float) -> int | None:
    """Return 0–18 at the nearest detector pixel, or None without a valid mapping.

    Both inputs are zero-based pixels in the unflipped FITS IMAGE extension.
    Channels 0 and 18 positively identify the corners outside nominal spectra.
    """
    if detector not in {"D1", "D2", "D3", "D4", "D5", "D6"}:
        return None
    h = image_header
    x, y = float(x), float(y)
    width, height = h.get("NAXIS1", 0), h.get("NAXIS2", 0)
    if not (-0.5 <= x < width - 0.5 and -0.5 <= y < height - 0.5):
        return None
    if "CRPIX1A" in h and "CRPIX2A" in h:
        # IRSA cutouts encode the original zero-based active detector pixel as
        # local FITS (one-based) pixel minus CRPIXiA. Never use display-grid pixels here.
        if any(h.get(f"CTYPE{i}A", "LINEAR") != "LINEAR" or h.get(f"CDELT{i}A", 1) != 1 for i in (1, 2)):
            return None
        for i in (1, 2):
            for j in (1, 2):
                identity = int(i == j)
                if any(h.get(f"{prefix}{i}_{j}A", identity) != identity for prefix in ("CD", "PC")):
                    return None
        x += 1 - h["CRPIX1A"] + h.get("CRVAL1A", 0)
        y += 1 - h["CRPIX2A"] + h.get("CRVAL2A", 0)
    elif (width, height) != (SIZE, SIZE) or "CRPIX1A" in h or "CRPIX2A" in h:
        return None
    if not (-0.5 <= x < SIZE - 0.5 and -0.5 <= y < SIZE - 0.5):
        return None
    return _channel_pixels()[math.floor(y + 0.5) * SIZE + math.floor(x + 0.5)]
