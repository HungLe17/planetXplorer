# Planet X backend

FastAPI service for the existing frontend. It retrieves **real SPHEREx cutouts from IRSA**, checks spectral compatibility, aligns them to one sky grid, and serves chronological PNG frames with provenance. No database, accounts, or invented observations.

## Run locally

Tested with Python 3.13 on Windows. From `proj/BE`:

```powershell
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.lock.txt
.venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1
```

On macOS/Linux use `.venv/bin/python`. Open http://127.0.0.1:8000/docs for OpenAPI and interactive requests. The frontend defaults to this backend origin; start its dev server on port 3000. CORS permits `http://127.0.0.1:3000` and `http://localhost:3000`. Change `PLANETX_CORS_ORIGINS` (comma-separated) for another frontend origin. TLS verifies against the operating system trust store, including managed Windows certificates.

Use **one Uvicorn worker and one service replica**: job state is in memory. Python processing runs in a bounded thread pool so polling and health checks remain available. Three outstanding jobs maximum; two processing jobs at a time, with up to four concurrent cutout downloads per job. Restarting the service loses job IDs; submit the query again. Prepared genuine sequences survive restarts.

## Deploy on Render

Create a **Web Service**, connect this Git repository, and choose the branch containing the backend. Use the native **Python 3** runtime.

### Service settings

| Render setting | Value |
|---|---|
| Root Directory | `BE` |
| Build Command | `python -m pip install -r requirements.lock.txt` |
| Start Command | `python -m uvicorn app.main:app --host 0.0.0.0 --port $PORT --workers 1` |
| Health Check Path | `/api/health` |
| Instances | `1` |

These paths assume the repository root contains `BE/` and `FE/`, as this checkout does. If your remote repository includes the enclosing `proj/` directory, use `proj/BE` instead. If the repository contains only the backend files, leave Root Directory blank. Build and start commands run inside the selected root directory.

Copy these commands into Render's corresponding fields; Render runs them in a Linux shell. Do not use the Windows `.venv/Scripts/python` path there. Bind to `0.0.0.0` and use Render's `$PORT`; do not bind to `127.0.0.1`, hardcode port 8000, or add `--reload` to the deployed service.

### Environment variables

Add these in the backend service's **Environment** settings before deploying:

```dotenv
PYTHON_VERSION=3.13.11
PLANETX_CORS_ORIGINS=https://your-frontend.example.com,http://localhost:3000,http://127.0.0.1:3000
PLANETX_CACHE_DIR=/tmp/planetx-cache
```

Replace `https://your-frontend.example.com` with the actual frontend origin. Origins include the scheme and hostname, with a port if applicable; omit paths and trailing slashes. Multiple allowed origins are comma-separated. You can remove the localhost entries when local development no longer needs access.

`PYTHON_VERSION` pins the Python version used by the existing local environment instead of relying on Render's default. `PLANETX_CACHE_DIR` puts disposable downloads and rendered frames in a writable temporary directory. No database, archive API key, or secret is required by this backend. Settings are read from process environment variables; uploading a `.env` file does not configure the service automatically.

Keep **one worker and one instance**. Jobs and the exact-query cache are stored in memory: multiple workers or replicas can send polling requests to a process that does not know the job ID, producing intermittent 404s. Do not use a generic Gunicorn command with multiple workers.

Push the backend source, `presets.json`, both requirements files, and `demos/` if you want the prepared reference sequences available. Do not upload `.venv/` or `.cache/`. The build command installs the pinned dependencies; `requirements.txt` contains the broader version ranges for intentional dependency updates.

### Connect the frontend

After deployment, Render provides a URL such as `https://your-backend.onrender.com`. Set this variable in the **frontend's** deployment environment, then rebuild/redeploy the frontend:

```dotenv
NEXT_PUBLIC_API_BASE_URL=https://your-backend.onrender.com
```

Use the backend base URL, without `/api` or `/docs`. The frontend appends the API paths itself. For a locally running frontend, put the same value in `FE/.env.local` and restart `npm run dev`. Ensure that frontend origin is also present in the backend's `PLANETX_CORS_ORIGINS`; changing CORS settings requires a backend restart/redeploy.

For the current deployment, the exact settings are:

- **Vercel frontend:** `NEXT_PUBLIC_API_BASE_URL=https://planetxplorer.onrender.com`
- **Render backend:** `PLANETX_CORS_ORIGINS=https://planet-x-plorer.vercel.app,http://localhost:3000,http://127.0.0.1:3000`

Include `https://` in the Vercel value. A bare hostname is interpreted as a relative browser URL by older frontend builds, sending requests to Vercel instead of Render. After editing a Vercel environment variable, redeploy the frontend so the new public value is compiled into its JavaScript.

### Check the deployment

Replace the example hostname, then check the health endpoint:

```bash
curl --fail --show-error https://your-backend.onrender.com/api/health
```

On Windows PowerShell:

```powershell
Invoke-RestMethod https://your-backend.onrender.com/api/health
```

Expect JSON containing `"status": "ok"`. Interactive API documentation is at `https://your-backend.onrender.com/docs`. The bare `/` URL has no route and returns 404; this does not mean the service is broken. Health confirms the app is running, not that IRSA is reachable. Use a frontend search to verify archive access, image downloads, and playback.

### Storage, cold starts, and troubleshooting

- Render's default filesystem is ephemeral. Restarts and redeploys discard generated files, and every process restart discards in-memory jobs. Search again after deployment instead of reusing an old job ID. Reference sequences committed under `demos/` are included in the deployment and can be loaded again.
- Free web services spin down after 15 minutes without inbound traffic, and waking them can take about a minute. This can exceed the frontend's 30-second API request timeout: open `/api/health`, wait for JSON, then retry the search. Cold-start time is separate from IRSA query/download time. See [Render's free-service limits](https://render.com/docs/free).
- `No module named app`: check Root Directory and use `app.main:app`, not `main:app`.
- No open port detected: use the exact start command above with `0.0.0.0` and `$PORT`.
- Dependency installation errors: confirm `PYTHON_VERSION=3.13.11`, check the first failing package in the build logs, and verify that `requirements.lock.txt` is included in the deployment.
- Browser CORS errors: add the actual frontend origin to `PLANETX_CORS_ORIGINS`, then restart/redeploy the backend. Configure `NEXT_PUBLIC_API_BASE_URL` on the frontend, not on the backend.
- Search timeouts or IRSA HTTP 503 responses: inspect Render's runtime logs. The service requires outbound HTTPS access to `irsa.ipac.caltech.edu`; a healthy `/api/health` response does not test that connection. Narrow the date range or retry when the archive recovers.
- A worker being killed or an out-of-memory restart: inspect memory usage during concurrent FITS downloads and reprojection. Keep the worker/instance count at one; increasing it also duplicates scientific processing memory and breaks the in-memory job model.

Render references: [FastAPI deployment](https://render.com/docs/deploy-fastapi), [Python version selection](https://render.com/docs/python-version), and [monorepo root directories](https://render.com/docs/monorepo-support).

## API

| Endpoint | Contract |
|---|---|
| `POST /api/jobs` | `{ra_deg, dec_deg, start_utc?, end_utc?}` → HTTP 202 `{job_id}`. Dates must include timezone and be ordered. |
| `GET /api/jobs/{job_id}` | Job state and an incrementally published manifest: catalog, loaded frames, wavelength sequences, counts, failures, and expiry. `complete` means the requested batch finished; unloaded catalog records can remain. |
| `POST /api/jobs/{job_id}/load` | `{observation_ids?: string[], detector?: "D1".."D6"}`; HTTP 202 queues up to eight unloaded records. Explicit IDs can retry failed records. Prior frames remain available. |
| `POST /api/jobs/{job_id}/cancel` | Cancel queued work or request cancellation of a running search. |
| `GET /api/assets/{job_id}/{asset_id}` | Allowlisted generated PNG or `manifest.json`; no arbitrary paths or URL proxying. |
| `GET /api/presets` | Five target coordinates, coordinate provenance/epoch, and prepared-sequence availability. |
| `GET /api/health` | Local service/queue state. It does not claim IRSA is reachable. |

The explorer discovers **all six detectors (D1-D6)** across DR1 and QR3 wide/deep collections, deduplicating superseded copies of the same exposure. It keeps the returned catalog instead of choosing 24 candidates or discarding all but the largest wavelength group. SIA has an explicit safety limit of 2,001 rows per collection; overflow or unavailable collections set `discovery_complete=false` and produce a warning. Narrow the date range when discovery is incomplete. TAP fallback also reports truncation. This is not a claim of unlimited or guaranteed archive completeness.

Images load in batches of up to eight. The first batch uses the detector with the most returned observations. Every successfully rendered image is retained, and partial manifests are published after each frame so the frontend can display an image before the batch finishes. The observation table exposes pending/loading/ready/failed records; load an individual record, load the next batch for a detector, or use **Load all** to continue through batches until no pending records match (or cancel). Failed records have explicit retry actions.

The frontend offers **Browse** for chronological inspection of all loaded images (with detector/wavelength labels and an unmatched-observation warning), and **Matched** for scientific blinking within a selected wavelength sequence. Browsing different bands is not evidence of brightness variability. Pairwise-compatible frames share the same detector/calibration and spectral response at five field samples. Other usable images form separate sequences rather than being discarded. Each sequence locks its display stretch when its first frame loads; adding frames does not silently renormalize the earlier images. Partial fields remain inspectable individually.

Limits: RA `[0,360)`, Dec `[-90,90]`, adjustable `fov_arcsec` from 30 to 1,800 (default 300), up to eight records per image batch with at most four active downloads, 512 loaded images per field, 64 MB per cutout, and a 1 GB disposable cache. Metadata has a 30-second budget and each image batch a 120-second processing budget. Individual network operations have bounded timeouts and transient retries. No database is required. These memory and network safeguards are separate from the number of matching observations shown in the catalog.

Identical active searches reuse the same job. Existing images remain accessible while a batch runs or after cancellation; queued downloads stop, and active network operations finish within their timeout. Busy/full storage returns 429, expired/unknown IDs return 404, and invalid requests return 422. Cache/job files expire after two hours. Settings are in `app/config.py`; cache location can be set with `PLANETX_CACHE_DIR`. Deploy both frontend and backend changes together; older deployments do not support `/load` or wavelength-sequence selection.


The frontend contract is preserved: `manifest.frames` includes image URL, acquisition time, detector, wavelength/bandwidth, release, source URL, observation ID, and warnings. The manifest also records query, WCS, processing version, fixed display stretch, mask fractions, and omitted exposures.

## Month-spaced initial selection

Pipeline version `2.2.0` adds query parameter `min_interval_days` (default `60`, allowed `0` to `3650`). Discovery retains the complete catalog. Within each detector, representative dates respect the requested minimum gap; when multiple dates fit, the final representative is moved to the latest available exposure without reducing that gap. The initial detector is chosen by representative count and date span. At most eight representatives are downloaded, spread across the full available span if there are more than a batch. This replaces loading the earliest adjacent exposures.

Each observation exposes `time_sample`. Processing metadata includes `initial_detector`, `initial_observation_ids`, and `min_interval_days`. The frontend starts with that detector and hides closely spaced records by default, while All exposures and the detector filter expose the rest. Checkboxes control timeline membership; Load checked requests only checked pending/failed IDs, with bounded batches. Explicit `/load` requests can still retrieve closely spaced exposures. Temporal sampling does not merge images or establish spectral compatibility.

Redeploy both applications and run a fresh search. Older prepared bundles are bypassed by the processing-version check. Zero spacing and shorter intervals remain available for rapid motion or variability work. The front end reports actual acquisition-date gaps and span independently of playback delay.

## Spectral samples

Pipeline version `2.1.0` adds `frame.spectral_sample` to each newly processed image. This contains native pixel indices and sky coordinates, wavelength/bandwidth, surface brightness (`value_mjy_sr`), uncertainty (`sigma_mjy_sr`), flags, method, and any rejection reason. Old prepared bundles are bypassed when their pipeline version differs; rebuild them with the proof script if needed. Redeploy both applications and submit a fresh search to obtain samples.

The extraction uses the nearest original IMAGE pixel to the requested coordinate, before display reprojection or stretch. Brightness is converted to MJy/sr; uncertainty is √VARIANCE after converting its squared brightness units. Quality-masked pixels, invalid variance/units, and invalid wavelength metadata produce a reason with null flux and uncertainty. Negative valid measurements are retained. SOURCE flags alone remain usable. The original sampled sky position is included because nearest pixel centres vary between observations.

The frontend plots these measurements with 1σ errors and bandwidth bars and exports provenance to CSV. This is a quick-look **surface-brightness spectrum**, including sky and zodiacal background, not extracted source flux. No background subtraction, aperture/ePSF correction, proper-motion tracking, or temporal averaging is applied. WCS-WAVE is intended for wavelength visualization; precision work needs the full CWAVE/CBAND calibration and source photometry. [IRSA product documentation](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/) describes those distinctions.

Counts are unique detector-image products, not objects or independent visits. One pointing can contribute multiple overlapping detector images. Image identities are deduplicated across collections/releases; footprint matches can still fail pixel-level validation. The frontend now distinguishes image count from unique pointing count.

## Scientific limits

- Uses the official SIA image search across DR1/QR3 wide and deep collections, with a bounded TAP fallback, followed by the archive cutout service. DR1 is preferred for duplicate exposures; QR3 is also supported; QR2 is excluded. All six detectors are discoverable and individually loadable. Archive result limits and collection failures are reported rather than silently interpreted as complete coverage.
- Compatibility requires the same detector and processing version, and pairwise wavelength separation ≤ half the narrower bandwidth at the target plus four interior samples scaled with the requested field of view. This is a conservative display selection policy, **not validated full-field spectrophotometry**.
- SOURCE (bit 21) identifies known objects and is retained. All other flags, nonfinite pixels, and nonpositive variances are masked. This deliberately conservative policy can mask saturated star cores and other useful pixels. Masks remain transparent; they are never filled with generated detail.
- Reprojection uses a north-up/east-left ICRS TAN grid near native 6.14 arcsec/pixel (49×49 pixels for this field). Each compatible sequence uses a fixed asinh scale. PNGs are display products, not photometric data. Native-pixel samples are extracted separately. No PSF matching, background fitting, ZODI subtraction, point-source flux extraction, or discovery classification is performed.
- The reference targets are approximate field centers. Four use SIMBAD/Sesame reference coordinates and linear proper motion to J2026.0; WISE 0855 retains the challenge-supplied position with unspecified epoch. Positions are for field retrieval, not precise epoch astrometry. Detection of any named target is not guaranteed.

## Genuine cached demonstrations and validation

`demos/<target>/` contains prepared archive PNGs and their source manifest where available. A prepared sequence is reused only when its processing version and complete query match. Older version-1 bundles are bypassed so they cannot hide the expanded catalog. An exact matching coordinate query with no date filters can reuse a current bundle and is explicitly labelled cached with its actual retrieval date. Other fields/filters use live retrieval. There is no silent substitution of a different field. The short-lived exact-query cache also expires after two hours; prepared demonstrations remain protected.

```powershell
.venv/Scripts/python scripts/prove_data.py --all --bundle
.venv/Scripts/python -m pytest -q
```

The proof script fetches each target, saves real-source reports under `.cache/validation/`, and optionally prepares demos. Reports state coverage/compatible frame results, not detections. Tests use a small recorded IRSA FITS fixture and synthetic test-only fields for coordinate, flag, calibration/wavelength, WCS, mask, stretch/orientation, API lifecycle, queue, expiry, and URL restriction checks. Unit tests do not depend on NASA availability. With both servers running, `node scripts/browser_smoke.cjs` verifies the real frontend/backend flow using the reference field; it writes a screenshot and report under `.cache/integration/`.

## Sources and credit

[IRSA cutout tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-cutouts/), [data products](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/), [flag definitions](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html), [SPHEREx archive and acknowledgement](https://irsa.ipac.caltech.edu/Missions/spherex.html).

This project makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), a joint project of the Jet Propulsion Laboratory and the California Institute of Technology funded by NASA. Data are distributed through Caltech/IPAC IRSA. Retain these credits and source manifests when sharing prepared images.
