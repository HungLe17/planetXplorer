import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import numpy as np

from app.archive import Observation
from app.config import Settings
from app.exposure_cache import ExposureCache
from app.pixel_quality import PixelQuality
from app.schemas import Frame, Query


FIELD = Query(ra_deg=32, dec_deg=-12, live=True)
VISIT = Observation("visit", "https://irsa.ipac.caltech.edu/original", 60000, "D1", "DR1")


def store(cache, obs=VISIT, value=1.0, quality=None):
    frame = Frame(id="old.png", url="/api/assets/old/old.png", observation_id=obs.identity,
                  observed_at="2023-02-25T00:00:00+00:00", detector=obs.detector,
                  wavelength_um=1, bandwidth_um=.1, release=obs.release, source_url=obs.uri,
                  quality="old-quality.bin" if quality is not None else None)
    cache.store(FIELD, obs, frame, np.full((32, 32), value), np.ones(5), np.full(5, .1), quality)


def test_restart_preserves_display_mask_archive_readings_and_original_orientation(tmp_path):
    settings = Settings(cache_dir=tmp_path)
    values = np.arange(32 * 32, dtype=float).reshape(32, 32)
    flags = np.zeros(values.shape, dtype=np.uint32)
    flags[2, 4], values[2, 4] = 2 | (1 << 26), np.nan
    flags[23, 29] = 1 << 31
    quality = PixelQuality.from_detector(values, flags, np.ones_like(values))
    store(ExposureCache(settings, "2", quality_mask=10), quality=quality)
    cache = ExposureCache(settings, "2", quality_mask=10)
    entry = cache.get(FIELD, VISIT)
    assert entry.quality.to_bytes() == quality.to_bytes()
    np.testing.assert_equal(entry.quality.values, values)
    np.testing.assert_equal(entry.quality.flags, flags)
    np.testing.assert_equal(entry.quality.status, quality.status)
    with sqlite3.connect(cache.path) as db:
        db.execute("UPDATE exposure SET pixels=substr(pixels,1,length(pixels)-1)")
    assert cache.get(FIELD, VISIT) is None


def test_restart_reuses_scientific_samples_only_for_matching_grid_version_and_dates(tmp_path):
    settings = Settings(cache_dir=tmp_path)
    store(ExposureCache(settings, "1", quality_mask=10))
    cache = ExposureCache(settings, "1", quality_mask=10)
    entry, = cache.load(FIELD)
    assert entry.observation == VISIT
    assert np.array_equal(entry.bandwidths, np.full(5, .1))
    assert np.array_equal(entry.array, np.ones((32, 32)))
    assert not cache.load(FIELD.model_copy(update={"fov_arcsec": 301}))
    assert not cache.load(Query(ra_deg=32, dec_deg=-12, start_utc="2023-02-26T00:00:00Z"))
    assert not ExposureCache(settings, "1", quality_mask=11).load(FIELD)
    assert not ExposureCache(settings, "2", quality_mask=10).load(FIELD)
    assert cache.get(FIELD, replace(VISIT, uri=VISIT.uri + "-updated")) is None


def test_partial_revalidation_and_concurrent_writes(tmp_path):
    cache = ExposureCache(Settings(cache_dir=tmp_path), "1", quality_mask=10)
    store(cache)
    newer = replace(VISIT, uri=VISIT.uri + "-updated")
    extra = replace(VISIT, identity="extra", uri=VISIT.uri + "-extra")
    store(cache, extra)
    started = time.time()
    with ThreadPoolExecutor(2) as pool:
        list(pool.map(lambda _: store(cache, newer, value=2), range(2)))
    cache.reconcile(FIELD, [newer], False, as_of=started)
    assert cache.get(FIELD, VISIT) is None
    assert cache.get(FIELD, extra)
    assert cache.get(FIELD, newer).array[0, 0] == 2
    cache.reconcile(FIELD, [replace(VISIT, release="QR3")], False)
    assert cache.get(FIELD, newer)
    cache.reconcile(FIELD, [], True, as_of=started)
    assert cache.get(FIELD, extra) is None
    assert cache.get(FIELD, newer)


def test_cache_evicts_to_disk_budget_and_expires_old_exposures(tmp_path):
    config = Settings(cache_dir=tmp_path, max_cache_bytes=256 * 1024, max_download_bytes=1024)
    cache = ExposureCache(config, "1", quality_mask=0)
    for i in range(10):
        store(cache, replace(VISIT, identity=str(i), uri=VISIT.uri + str(i)))
    assert cache.path.stat().st_size <= cache.limit
    assert 0 < len(cache.load(FIELD)) < 10
    with sqlite3.connect(cache.path) as db:
        db.execute("UPDATE exposure SET stored=0")
    assert not cache.load(FIELD)
    assert cache.prune() > 0
