"""SPHEREx single-band display policy; quantitative arrays keep their own mask."""

from dataclasses import dataclass
from enum import IntEnum

import numpy as np
from reproject import reproject_interp


class PixelState(IntEnum):
    OUTSIDE = 0
    NORMAL = 1
    WARNING = 2
    OVERFLOW_MAX = 3
    INSPECT_ONLY = 4
    NO_DATA = 5


UNCERTAINTY_UNAVAILABLE = 0x80
SOURCE_BIT = 1 << 21
OVERFLOW_BIT = 1 << 1
NO_DATA_BITS = (1 << 6) | (1 << 9)  # NONFUNC, MISSING_DATA
# TRANSIENT, OVERFLOW, PERSIST, OUTLIER, CROSSTALK and optical/charge artifacts.
WARNING_BITS = sum(1 << b for b in (0, 1, 17, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29))
INSPECT_BITS = np.uint32(0xFFFFFFFF ^ (WARNING_BITS | SOURCE_BIT | NO_DATA_BITS))


@dataclass
class PixelQuality:
    values: np.ndarray
    flags: np.ndarray
    status: np.ndarray
    spectral: np.ndarray | None = None  # wavelength and bandwidth in µm at the same detector sample

    @classmethod
    def from_detector(cls, values, flags, variance):
        if flags.dtype.itemsize > 4 and np.any(flags.astype(np.uint64) > 0xFFFFFFFF):
            raise ValueError("Pixel flags exceed the 32-bit spectral image format")
        flags = flags.astype(np.uint32, copy=False)
        unavailable = ~np.isfinite(variance) | (variance <= 0)
        finite = np.isfinite(values)
        status = np.full(values.shape, PixelState.NO_DATA, dtype=np.uint8)
        status[finite] = PixelState.NORMAL
        status[finite & (unavailable | ((flags & WARNING_BITS) != 0))] = PixelState.WARNING
        status[finite & ((flags & INSPECT_BITS) != 0)] = PixelState.INSPECT_ONLY
        # Only an actual NaN in the original image can trigger a maximum marker.
        status[np.isnan(values) & ((flags & OVERFLOW_BIT) != 0)] = PixelState.OVERFLOW_MAX
        status[(flags & NO_DATA_BITS) != 0] = PixelState.NO_DATA
        status[unavailable] |= UNCERTAINTY_UNAVAILABLE
        return cls(values, flags, status)

    def align(self, source_wcs, grid, shape):
        # One nearest-neighbor lookup maps every plane to the identical detector sample.
        # Reprojecting a bitmask or a marker bilinearly could fabricate a flag combination.
        indices = np.arange(self.values.size, dtype=float).reshape(self.values.shape)
        mapped, footprint = reproject_interp(
            (indices, source_wcs), grid, shape_out=shape, order="nearest-neighbor"
        )
        inside = np.isfinite(mapped) & (footprint > 0)
        selected = mapped[inside].astype(np.intp)
        values = np.full(shape, np.nan, dtype="<f4")
        flags = np.zeros(shape, dtype="<u4")
        status = np.zeros(shape, dtype=np.uint8)
        values[inside] = self.values.flat[selected]
        flags[inside] = self.flags.flat[selected]
        status[inside] = self.status.flat[selected]
        spectral = None
        if self.spectral is not None:
            spectral = np.full((2, *shape), np.nan, dtype="<f4")
            for target, plane in zip(spectral, self.spectral, strict=True):
                target[inside] = plane.flat[selected]
        return PixelQuality(values, flags, status, spectral)

    @property
    def states(self):
        return self.status & 0x7F

    def display_values(self, science):
        return np.where((self.states != PixelState.OUTSIDE) & np.isfinite(self.values)
                        & (self.values >= 0), self.values, np.nan)

    def to_bytes(self):
        # Three contiguous, north-up planes in the same orientation as frame.pixels.
        return b"".join(np.flipud(plane).astype(dtype, copy=False).tobytes()
                        for plane, dtype in ((self.values, "<f4"), (self.flags, "<u4"),
                                             (self.status, "u1")))

    @classmethod
    def from_bytes(cls, data, shape):
        count = int(np.prod(shape))
        if len(data) != count * 9:
            raise ValueError("Invalid pixel quality asset length")
        planes = [np.flipud(np.frombuffer(data, dtype=dtype, count=count, offset=offset).reshape(shape))
                  for dtype, offset in (("<f4", 0), ("<u4", count * 4), ("u1", count * 8))]
        return cls(*planes)
