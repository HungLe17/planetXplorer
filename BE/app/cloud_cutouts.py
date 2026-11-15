"""Bounded cutouts from the public IRSA SPHEREx AWS mirror.

Read headers and contiguous detector row strips, never a whole science product.
The resulting MEF retains the spectral lookup table and all alternate WCSes.
"""

import io
import math
import re
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from urllib.parse import urlsplit

import astropy.units as u
import httpx
import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.nddata.utils import overlap_slices
from astropy.wcs import WCS
from astropy.wcs.utils import proj_plane_pixel_scales


@lru_cache(maxsize=16)
def _metadata_cache(client, url):
    # Product paths include their processing version; bound retained headers to 16 MiB.
    return {"blocks": {}, "total": None, "lock": threading.Lock()}


def mirror_url(uri: str) -> str:
    parsed = urlsplit(uri)
    prefix = "/ibe/data/spherex/"
    if (parsed.scheme != "https" or parsed.netloc != "irsa.ipac.caltech.edu"
            or parsed.query or parsed.fragment or not parsed.path.startswith(prefix)
            or "%" in parsed.path or ".." in parsed.path):
        raise ValueError("Unsupported SPHEREx mirror source")
    key = parsed.path[len(prefix):]
    if not re.fullmatch(r"(?:dr1|qr3)/level2/[A-Za-z0-9_./-]+\.fits", key):
        raise ValueError("Unsupported SPHEREx cloud product")
    return "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/" + key


class RangeFile(io.RawIOBase):
    """Seekable HTTP file with strict ranges, a transfer budget and a deadline."""

    mode = "rb"
    block_size = 65536

    def __init__(self, client, url, deadline, budget, timeout=15, parent=None):
        self.client, self.name = client, url
        self.deadline, self.budget, self.timeout = deadline, budget, timeout
        self.position = 0
        self._metadata = parent._metadata if parent else _metadata_cache(client, url)
        self._transfer = parent._transfer if parent else {"bytes": 0, "lock": threading.Lock()}
        self._cache_headers = parent is None
        if parent:
            self.blocks, self.total = dict(parent.blocks), parent.total
        else:
            with self._metadata["lock"]:
                self.blocks = dict(self._metadata["blocks"])
                self.total = self._metadata["total"]
        if 0 not in self.blocks:
            self.blocks[0] = self._range(0, self.block_size)
            self._remember(0)

    @property
    def transferred(self):
        return self._transfer["bytes"]

    def _remember(self, block):
        if self._cache_headers:
            with self._metadata["lock"]:
                if len(self._metadata["blocks"]) < 16:
                    self._metadata["blocks"][block] = self.blocks[block]
                    self._metadata["total"] = self.total

    def _range(self, start, size):
        remaining = self.deadline - time.monotonic()
        with self._transfer["lock"]:
            if remaining <= 0 or self.transferred + size > self.budget:
                raise ValueError("Cloud cutout byte/time budget exceeded")
            self._transfer["bytes"] += size
        end = start + size - 1
        with self.client.stream("GET", self.name,
                headers={"Range": f"bytes={start}-{end}", "Accept-Encoding": "identity"},
                timeout=min(self.timeout, remaining)) as response:
            response.raise_for_status()
            match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
            if (response.status_code != 206 or not match
                    or response.headers.get("Content-Encoding", "identity") != "identity"):
                raise ValueError("Cloud server did not honor a bounded byte range")
            actual_start, actual_end, total = map(int, match.groups())
            if (actual_start != start or actual_end != end or total <= end
                    or (self.total is not None and total != self.total)):
                raise ValueError("Cloud range geometry changed")
            if int(response.headers.get("Content-Length", size)) != size:
                raise ValueError("Cloud range length mismatch")
            self.total = total
            data = bytearray()
            for chunk in response.iter_bytes(65536):
                if len(data) + len(chunk) > size or time.monotonic() >= self.deadline:
                    raise ValueError("Cloud range exceeded its bounds")
                data.extend(chunk)
            if len(data) != size:
                raise ValueError("Incomplete cloud range")
        return bytes(data)

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=0):
        position = offset if whence == 0 else self.position + offset if whence == 1 else self.total + offset
        if position < 0:
            raise ValueError("Negative cloud offset")
        self.position = position
        return position

    def read(self, size=-1):
        if size < 0:
            raise ValueError("Unbounded cloud reads are disabled")
        if time.monotonic() >= self.deadline:
            raise ValueError("Cloud cutout time budget exceeded")
        size = min(size, max(0, self.total - self.position))
        if not size:
            return b""
        if size > self.block_size:
            result = self._range(self.position, size)
            self.position += size
            return result
        parts = []
        while size:
            block = self.position // self.block_size * self.block_size
            if block not in self.blocks:
                self.blocks[block] = self._range(block, min(self.block_size, self.total - block))
                self._remember(block)
            offset = self.position - block
            part = self.blocks[block][offset:offset + size]
            parts.append(part)
            self.position += len(part)
            size -= len(part)
        return b"".join(parts)


def shifted_header(header, x, y):
    header = header.copy()
    for key in list(header):
        match = re.fullmatch(r"CRPIX([12])([A-Z]?)", key)
        if match:
            header[key] -= x if match[1] == "1" else y
    # Preserve original detector coordinates, also when the full product has no A WCS.
    if "CRPIX1A" not in header:
        for axis, offset in ((1, x), (2, y)):
            header[f"CTYPE{axis}A"] = "LINEAR"
            header[f"CRPIX{axis}A"] = 1 - offset
            header[f"CRVAL{axis}A"] = 0
            header[f"CDELT{axis}A"] = 1
    for key in ("CHECKSUM", "DATASUM"):
        header.remove(key, ignore_missing=True)
    return header


def cloud_cutout(client, uri, query, path, deadline, budget, timeout=15):
    """Return transfer bytes after writing a normal small MEF for existing decode()."""
    with RangeFile(client, mirror_url(uri), deadline, budget, timeout) as remote:
        with fits.open(remote, memmap=False, lazy_load_hdus=True) as hdus:
            image = hdus["IMAGE"]
            if isinstance(image, fits.CompImageHDU) or image.header.get("NAXIS") != 2:
                raise ValueError("Cloud product must contain an uncompressed 2-D IMAGE")
            wcs = WCS(image.header).celestial
            coordinate = SkyCoord(query.ra_deg * u.deg, query.dec_deg * u.deg)
            x, y = map(float, wcs.world_to_pixel(coordinate))
            shape = (image.header["NAXIS2"], image.header["NAXIS1"])
            if not (-.5 <= x < shape[1] - .5 and -.5 <= y < shape[0] - .5):
                raise ValueError("Cloud exposure does not cover target")
            scales = proj_plane_pixel_scales(wcs)
            dimensions = tuple(math.ceil(query.fov_arcsec / (3600 * float(scale))) for scale in scales[::-1])
            if min(dimensions) < 2 or max(dimensions) > 512:
                raise ValueError("Cloud cutout dimensions exceed supported limits")
            slices, _ = overlap_slices(shape, dimensions, (y, x), mode="trim")
            sy, sx = slices
            primary = hdus[0].header.copy()
            for key in ("CHECKSUM", "DATASUM"):
                primary.remove(key, ignore_missing=True)
            output = [fits.PrimaryHDU(header=primary)]
            for name in ("IMAGE", "FLAGS", "VARIANCE"):
                hdu = hdus[name]
                if (hdu.header.get("NAXIS") != 2
                        or (hdu.header["NAXIS2"], hdu.header["NAXIS1"]) != shape):
                    raise ValueError("Cloud quality plane geometry is unsupported")
            table = hdus["WCS-WAVE"]
            if table.size > 65536:
                raise ValueError("Cloud spectral calibration exceeds its limit")
            spectral_table = table.copy()
            # Each worker has its own FITS cursor, shares cached headers and one byte budget.
            # Whole-width row strips keep the uncompressed planes to one request apiece.
            def read_plane(name):
                with RangeFile(client, remote.name, deadline, budget, timeout, parent=remote) as plane_file:
                    with fits.open(plane_file, memmap=False, lazy_load_hdus=True) as planes:
                        hdu = planes[name]
                        data = np.array(hdu.section[sy, :][:, sx], copy=True)
                        return fits.ImageHDU(data=data, header=shifted_header(hdu.header, sx.start, sy.start))

            with ThreadPoolExecutor(max_workers=3, thread_name_prefix="cloud-plane") as executor:
                output.extend(executor.map(read_plane, ("IMAGE", "FLAGS", "VARIANCE")))
            output.append(spectral_table)
            with fits.HDUList(output) as cutout:
                cutout.writeto(path, overwrite=True)
        return remote.transferred
