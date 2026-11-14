# planetXplorer backend

FastAPI service for the existing frontend. It retrieves **real SPHEREx cutouts from IRSA**, checks spectral compatibility, aligns them to one sky grid, and serves chronological PNG frames with provenance. No database, accounts, or invented observations.

## Run locally

Tested with Python 3.13 on Windows. From `proj/BE`:

```powershell
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.lock.txt
.venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

On macOS/Linux use `.venv/bin/python`. Open http://127.0.0.1:8000/docs for OpenAPI and interactive requests. The frontend defaults to this backend origin; start its dev server on port 3000. CORS permits `http://127.0.0.1:3000` and `http://localhost:3000`. Change `PLANETX_CORS_ORIGINS` (comma-separated) for another frontend origin. TLS verifies against the operating system trust store, including managed Windows certificates.

Use **one Uvicorn worker and one service replica**: job state is in memory. Python processing runs in a dedicated worker thread so polling and health checks remain available. Three outstanding jobs maximum; one processing job at a time. Restarting the service loses job IDs; submit the query again. Prepared genuine sequences survive restarts.

## API

| Endpoint | Contract |
|---|---|
| `POST /api/jobs` | `{ra_deg, dec_deg, start_utc?, end_utc?}` → HTTP 202 `{job_id}`. Dates must include timezone and be ordered. |
| `GET /api/jobs/{job_id}` | `queued`, `running`, `complete`, `partial`, or `failed`; stage, error/warnings, final manifest, and expiry. |
| `GET /api/assets/{job_id}/{asset_id}` | Allowlisted generated PNG or `manifest.json`; no arbitrary paths or URL proxying. |
| `GET /api/presets` | Five target coordinates, coordinate provenance/epoch, and prepared-sequence availability. |
| `GET /api/health` | Local service/queue state. It does not claim IRSA is reachable. |

Limits: RA `[0,360)`, Dec `[-90,90]`, fixed 5-arcminute field, at most 100 metadata rows, 24 sampled candidate exposures, 12 output frames, 64 MB per cutout, 1 GB disposable cache, and a 10-minute processing deadline. Individual network operations use bounded timeouts and one retry for transient errors. Processing time is archive-dependent. Busy/full storage returns 429 with Retry-After; unknown/expired jobs and assets return 404; invalid requests return 422. Cache/job files expire after two hours. Settings are in `app/config.py`; cache location can be set with `PLANETX_CACHE_DIR`.

The frontend contract is preserved: `manifest.frames` includes image URL, acquisition time, detector, wavelength/bandwidth, release, source URL, observation ID, and warnings. The manifest also records query, WCS, processing version, fixed display stretch, mask fractions, and omitted exposures.

## Scientific limits

- Uses the official TAP artifact/plane query and archive cutout service. DR1 is preferred for duplicate exposures; QR3 is also supported; QR2 is excluded. D2/D6 are inspected automatically, and the best compatible group is selected. The metadata cap may omit later visits; use date filters when needed.
- Compatibility requires the same detector and processing version, and pairwise wavelength separation ≤ half the narrower bandwidth at the target plus four samples within the central 3 arcminutes. This is a conservative display selection policy, **not validated full-field spectrophotometry**.
- SOURCE (bit 21) identifies known objects and is retained. All other flags, nonfinite pixels, and nonpositive variances are masked. This deliberately conservative policy can mask saturated star cores and other useful pixels. Masks remain transparent; they are never filled with generated detail.
- Reprojection uses a north-up/east-left ICRS TAN grid near native 6.14 arcsec/pixel (49×49 pixels for this field). All frames use the same asinh scale. PNGs are display products, not photometric data. No PSF matching, background fitting, ZODI subtraction, flux measurement, or discovery classification is performed.
- The reference targets are approximate field centers. Four use SIMBAD/Sesame reference coordinates and linear proper motion to J2026.0; WISE 0855 retains the challenge-supplied position with unspecified epoch. Positions are for field retrieval, not precise epoch astrometry. Detection of any named target is not guaranteed.

## Genuine cached demonstrations and validation

`demos/<target>/` contains prepared archive PNGs and their source manifest where available. An exact matching coordinate query with no date filters can reuse that sequence and is explicitly labelled cached with its actual retrieval date. Other fields/filters use live retrieval. There is no silent substitution of a different field. The short-lived exact-query cache also expires after two hours; prepared demonstrations remain protected.

```powershell
.venv/Scripts/python scripts/prove_data.py --all --bundle
.venv/Scripts/python -m pytest -q
```

The proof script fetches each target, saves real-source reports under `.cache/validation/`, and optionally prepares demos. Reports state coverage/compatible frame results, not detections. Tests use a small recorded IRSA FITS fixture and synthetic test-only fields for coordinate, flag, calibration/wavelength, WCS, mask, stretch/orientation, API lifecycle, queue, expiry, and URL restriction checks. Unit tests do not depend on NASA availability. With both servers running, `node scripts/browser_smoke.cjs` verifies the real frontend/backend flow using the prepared Barnard sequence; it writes a screenshot and report under `.cache/integration/`.

## Sources and credit

[IRSA cutout tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-cutouts/), [data products](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/), [flag definitions](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html), [SPHEREx archive and acknowledgement](https://irsa.ipac.caltech.edu/Missions/spherex.html).

This project makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), a joint project of the Jet Propulsion Laboratory and the California Institute of Technology funded by NASA. Data are distributed through Caltech/IPAC IRSA. Retain these credits and source manifests when sharing prepared images.

