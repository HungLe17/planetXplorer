import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace

import numpy as np

from app.archive import Observation
from app.config import Settings
from app.exposure_cache import ExposureCache
from app.schemas import Frame, Query


FIELD = Query(ra_deg=32, dec_deg=-12, live=True)
VISIT = Observation("visit", "https://irsa.ipac.caltech.edu/original", 60000, "D1", "DR1")


def store(cache, obs=VISIT, value=1.0):
    frame = Frame(id="old.png", url="/api/assets/old/old.png", observation_id=obs.identity,
                  observed_at="2023-02-25T00:00:00+00:00", detector=obs.detector,
                  wavelength_um=1, bandwidth_um=.1, release=obs.release, source_url=obs.uri)
    cache.store(FIELD, obs, frame, np.full((32, 32), value), np.ones(5), np.full(5, .1))


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
