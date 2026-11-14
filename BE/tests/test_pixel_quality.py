import numpy as np
import pytest
from astropy.wcs import WCS
from PIL import Image

from app.pipeline import render_pngs
from app.pixel_quality import UNCERTAINTY_UNAVAILABLE, PixelQuality, PixelState


def test_detector_flags_classify_each_bit_including_reserved_bits():
    flags = np.asarray([0, *(1 << bit for bit in range(32))], dtype=np.uint32)
    values = np.full(flags.shape, -1.0)
    quality = PixelQuality.from_detector(values, flags, np.ones_like(values))
    expected = np.full(flags.shape, PixelState.INSPECT_ONLY)
    expected[0] = expected[21 + 1] = PixelState.NORMAL
    for bit in (0, 1, 17, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29):
        expected[bit + 1] = PixelState.WARNING
    expected[6 + 1] = expected[9 + 1] = PixelState.NO_DATA
    np.testing.assert_array_equal(quality.status, expected)
    np.testing.assert_array_equal(quality.flags, flags)
    np.testing.assert_array_equal(quality.values, values)


def test_combined_flags_nonfinite_values_and_variance_precedence():
    overflow, source, bloom, sur_error = 1 << 1, 1 << 21, 1 << 26, 1 << 2
    flagged = overflow | source | bloom
    cases = [
        (np.nan, flagged | sur_error, np.nan, PixelState.OVERFLOW_MAX),
        (1722.82, flagged, 81.47, PixelState.WARNING),
        (np.nan, flagged | (1 << 6), np.nan, PixelState.NO_DATA),
        (np.nan, flagged | (1 << 9), np.nan, PixelState.NO_DATA),
        (23, bloom | sur_error, 1, PixelState.INSPECT_ONLY),
        (np.inf, overflow, 1, PixelState.NO_DATA),
        (np.nan, bloom, 1, PixelState.NO_DATA),
        (-1, source, 0, PixelState.WARNING),
        (0, source, -1, PixelState.WARNING),
        (1, 0, np.inf, PixelState.WARNING),
        (0, 0, 1, PixelState.NORMAL),
    ]
    values, flags, variances, states = map(np.asarray, zip(*cases))
    quality = PixelQuality.from_detector(values, flags, variances)
    np.testing.assert_array_equal(quality.states, states)
    np.testing.assert_array_equal(
        quality.status & UNCERTAINTY_UNAVAILABLE != 0, ~np.isfinite(variances) | (variances <= 0)
    )


def test_reprojection_keeps_neighboring_measurements_separate_from_overflow_and_gaps():
    grid = WCS(naxis=2)
    grid.wcs.ctype = ["RA---TAN", "DEC--TAN"]
    grid.wcs.crpix, grid.wcs.crval, grid.wcs.cdelt = [3, 3], [10, 0], [-.001, .001]
    shifted = grid.deepcopy()
    shifted.wcs.crpix += [1.25, 0.0]
    values = np.arange(25, dtype=float).reshape(5, 5)
    flags = np.zeros(values.shape, dtype=np.uint32)
    values[2, 2], flags[2, 2] = np.nan, 1 << 1
    flags[2, 3] = 1 << 26
    aligned = PixelQuality.from_detector(values, flags, np.ones_like(values)).align(grid, shifted, values.shape)
    assert np.all(aligned.states[:, 0] == PixelState.OUTSIDE)
    assert np.all(np.isnan(aligned.values[:, 0]))
    assert np.count_nonzero(aligned.states == PixelState.OVERFLOW_MAX) == 1
    assert aligned.states[2, 3] == PixelState.OVERFLOW_MAX
    assert aligned.states[2, 4] == PixelState.WARNING
    assert aligned.flags[2, 4] == 1 << 26
    assert aligned.values[2, 4] == 13


def test_png_renders_max_without_changing_scale_or_numeric_samples(tmp_path):
    values = np.array([[np.nan, 0., .5], [1., 2., np.nan]])
    flags = np.array([[2, 0, 1 << 26], [0, 1 << 2, (1 << 9) | 2]], dtype=np.uint32)
    q = PixelQuality.from_detector(values, flags, np.ones_like(values))
    science = np.where(flags == 0, values, np.nan)
    path = tmp_path / "test.png"
    bounds = render_pngs([science], [path], [q])
    rgba = np.asarray(Image.open(path))
    assert rgba[-1, 0].tolist() == [255, 255, 255, 255]
    assert 0 < rgba[-1, 2, 0] < 255 and rgba[-1, 2, 3] == 255
    assert rgba[0, 1, 3] == rgba[0, 2, 3] == 0
    assert bounds["vmax"] == pytest.approx(np.percentile([0, .5, 1.], 99.5))
    assert np.isnan(science[0, 0]) and np.isnan(q.values[0, 0])
