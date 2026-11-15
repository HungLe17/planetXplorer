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

Use **one Uvicorn worker and one service replica**. Job state is in memory. Python processing runs in a bounded thread pool so polling and health checks remain available. The backend accepts up to three outstanding jobs and processes two at a time. All jobs share two IRSA cutout slots by default. A temporary cutout failure gets up to four total attempts within the job's download deadline. HTTP 429 and 503 pause new cutout requests across jobs. The client honors IRSA's `Retry-After` and uses exponential backoff with jitter. Metadata queries have their own allowance. Restarting the service loses job IDs. Submit the query again to continue. Prepared sequences survive restarts. [Archive transport](app/archive.py) · [Job limits](app/config.py)

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

The explorer's **Surveys** tab sends separate `POST /api/surveys/neowise`,
`/api/surveys/euclid`, and `/api/surveys/desi` requests with `ra_deg` and
`dec_deg`. These show field context across all dates. The blink sequence and
its date filters use SPHEREx alone.

NEOWISE returns four-arcminute FITS links and PNG previews for the newest
quality-10 W1/W2 pair. Euclid returns DR1/Q1 calibrated VIS and NIR exposure
counts, dates and links to matching product records. Individual detector frames
are large, so the API requests exposure metadata only. DESI returns observed BGS,
LRG and ELG clustering-catalog galaxies inside a 2.5-arcminute radius.

From `BE`, run `python scripts/prepare_desi.py` once to install the six
northern/southern DR1 v1.5 catalog indices. Preparation streams about 1.13 GB
and removes each temporary FITS after indexing. Set `PLANETX_DESI_DIR` on both
the preparation command and service to use persistent storage across deploys.
The finished indexes use about 323 MB of backend disk space. A missing index returns
HTTP 503 with code `desi_index_missing` and the Surveys panel displays the setup
command. Once all six are installed, reopen Surveys. A successful search with no
matching catalog galaxy returns HTTP 200 and an empty list. [Catalog installer and search](app/desi.py)

Run `python scripts/check_motion.py wise` (or `barnard`) for a metadata-only
footprint check on the two candidate dates in the prepared sequence. Add
`--fetch` to check the two small cutouts on one sky grid. The check reports
predicted shift, isolated target centroids and registration scatter from common
field sources. A candidate still requires visual review. It uses the WISE
[dated HST position and proper motion/parallax fit](https://www.aanda.org/articles/aa/pdf/2016/08/aa28662-16.pdf)
or the Barnard proper-motion preset.

| Endpoint | Contract |
|---|---|
| `POST /api/jobs` | `{ra_deg, dec_deg, start_utc?, end_utc?, fov_arcsec?, live?, detectors?, channels?}` → HTTP 202 `{job_id}`. Set `live: true` to check the archive. Dates must include timezone and be ordered. `detectors` is an optional array of D1–D6 labels. `channels` maps detector labels to arrays of calibrated labels from this field. |
| `GET /api/jobs/{job_id}` | Returns status, timings, discovered observations, field visits, matched sequences and discovery completeness. Visits list their member exposure IDs, validation status and conflicts. Continue polling through completion to receive final stretches and warnings. Other catalog records can remain available to load. |
| `GET /api/jobs/{job_id}/channels/{detector}?cursor=0` | Returns known target-local channel labels and checks one page of unresolved records using archive header and wavelength-table ranges. Use the returned continuation cursor to check another page. |
| `POST /api/archive/channels/{detector}?cursor=0` | Accepts the proposed field coordinates and dates before a search. Returns the same paginated channel choices using only catalog metadata and bounded FITS ranges. |
| `POST /api/jobs/{job_id}/load` | HTTP 202. Queue the next eligible batch or send up to eight observation IDs. The optional `detector` filters catalog records and `channels` limits cutout loading by calibrated channel. Explicit IDs can retry failed records. |
| `POST /api/jobs/{job_id}/priority/{obs_id}` | Promotes a requested exposure for the next free transfer slot. A duplicate click reuses the existing request. The original search selection applies to every transfer. |
| `POST /api/jobs/{job_id}/cancel` | Cancel queued work or request cancellation of a running search. |
| `GET /api/assets/{job_id}/{asset_id}` | A frame's `url` gives its PNG, `pixels` gives its strictly masked quantitative array, `quality` gives nearest-neighbor archive brightness, flags and status, and `spectral` gives per-pixel wavelength and bandwidth. Legacy prepared frames may have only a PNG. |
| `GET /api/presets` | Five target coordinates, coordinate provenance/epoch, and prepared-sequence availability. |
| `GET /api/health` | Local service/queue state. It does not claim IRSA is reachable. |

Discovery returns catalog metadata for all six detectors so the viewer can group cycles. The search form's detector and optional spectrum selections bound the initial batch, background loading, and explicit requests. Each catalog record's `selection` is `matched`, `excluded`, `unknown`, or `unavailable`. An unknown spectrum requires a coordinate- and product-specific wavelength check before any full transfer. If the check fails, the exposure stays pending and can be retried. A confirmed exposure may start while remaining collections are searched. When discovery finishes, the full catalog is published immediately and any preferred revision is checked against the same selection. The initial image allowance is 24 exposures by default. If the first candidates yield no usable image, the job checks additional candidates in bounded batches until it finds a match, exhausts the catalog or reaches its deadline or image allowance. Ineligible metadata results consume no full-image slots. Later batches retain earlier frames up to 512 per field. [Selection and publication](app/pipeline.py) · [Archive metadata](app/archive.py)

Live searches default to a 300-arcsecond field. Each frame keeps its observation ID as earlier dates are inserted into the timeline. Read `timings` for elapsed wall time and operation durations in milliseconds. Cutout downloads overlap. After completion, `/api/assets/{job_id}/timings.json` remains available for the lifetime of the job.

The service accepts RA in `[0,360)`, Dec in `[-90,90]`, and fields from 30 to 1800 arcseconds. The default cutout limit is 64 MB, with 1 GB of disposable cache. Busy or full storage returns HTTP 429 with Retry-After. Unknown or expired jobs and assets return 404, and invalid requests return 422. Job files expire after two hours. See `app/config.py` for limits and `PLANETX_CACHE_DIR` for the cache location.

On a repeat live search, the backend can publish individually cached exposures before IRSA responds. The cache is scoped to coordinates, field of view, archive configuration, processing version and quality mask. The requested dates filter which cached exposures are shown. A running manifest with `processing.refreshing_cache` means its frames are available while their current archive revisions are being checked. A final manifest with `processing.cache_fallback` means the archive check failed and saved observations are being returned. A full catalog response can withdraw an observation or replace its revision. Match by `observation_id` and read the current asset URLs on each update.

Cold searches with explicit detector demand wait for catalog metadata before choosing cutouts. On an unrestricted cold search, one provisional cutout can download while the catalog queries continue. Use `first_candidate`, `cutout_first_byte`, `metadata_search`, `first_frame` and `total` to trace that overlap. A first-byte event measures the first nonempty response-body chunk delivered to the client. Retry events include their failure reason. Browser Performance entries named `planetx:<job-id>:first-canvas-draw` measure the separate wait until the viewer draws the image.

Searches deduplicate identical queued/running queries. Metadata has a 30-second budget shared between TAP and SIA, with 15-second network timeouts, and live processing has a 120-second budget including time reserved for rendering partial results. The frontend polls for progress and allows cancellation via `POST /api/jobs/{job_id}/cancel`. Cancellation stops queued work; active network requests finish within their timeout. Restart the backend after code changes (or use Uvicorn `--reload` during development).

The frontend contract is preserved: `manifest.frames` includes image URL, acquisition time, detector, wavelength/bandwidth, release, source URL, observation ID, and warnings. The manifest also records query, WCS, processing version, display stretch, mask fractions, and omitted exposures.

## Scientific limits

- Uses the official SIA image search across DR1/QR3 wide and deep collections, with a bounded TAP fallback, followed by the archive cutout service. DR1 is preferred for duplicate exposures; QR3 is also supported; QR2 is excluded. D1–D6 are discoverable. Browse can show unmatched observations, and Matched restricts playback to validated sequence members. The metadata cap may omit later visits; use date filters when needed.
- Compatibility requires the same detector and processing version, and pairwise wavelength separation ≤ half the narrower bandwidth at the target plus four interior samples scaled to the requested field. This is a conservative display selection policy, **not validated full-field spectrophotometry**.
- Visits group exposures at the field position across detector pairs. A window with one physical pair is supplemental and remains available in Browse. Windows covering at least two pairs are candidate cycles. Missing D1–D6 coverage in complete discovery away from date boundaries, conflicting local wavelengths, and incompatible survey orientations invalidate a cycle. Unloaded or failed exposures leave validation provisional. Expand a cycle in Observations to inspect its individual exposures and retry failed downloads. [Visit validation](app/visits.py)
- The `pixels` array retains measurements with finite brightness, positive finite variance and either zero flags or SOURCE alone. Fresh maps, inspector values and spectra use the archive brightness supplied with `quality`. Finite negative brightness remains signed in Details and blank on the image. Each flag word remains available even when the reading is rendered. The display can mark an OVERFLOW NaN at maximum intensity while its archived brightness remains NaN. [Display and scientific processing rules](../../Proj%20logging/assumtions.md)
- For N sky pixels, the optional `quality` file contains N little-endian float32 archive brightnesses, N little-endian uint32 flags and N uint8 statuses. The optional `spectral` file contains two little-endian float32 planes of length N for wavelength and bandwidth in µm. These arrays share north-up row order and the same nearest detector sample. The low seven status bits encode the original quality classification and bit 7 marks unavailable uncertainty. [Asset encoding](app/pixel_quality.py) · [Per-pixel calibration](app/pipeline.py)
- Reprojection uses a north-up/east-left ICRS TAN grid near 6.14 arcseconds per pixel. The default width produces a 49×49 grid. Progressive previews may have individual stretches. Use the published stretch and sequence metadata for comparisons. PNGs are display products. No PSF matching, background fitting, ZODI subtraction or discovery classification is performed.
- The reference targets are approximate field centers. Four use SIMBAD/Sesame reference coordinates and linear proper motion to J2026.0; WISE 0855 retains the challenge-supplied position with unspecified epoch. Positions are for field retrieval, not precise epoch astrometry. Detection of any named target is not guaranteed.

## Genuine cached demonstrations and validation

### Known objects in a SPHEREx field

The viewer requests catalog metadata when the overlay opens. The search cone encloses the pixel-rounded square and includes a motion allowance of 12 arcseconds per year from each catalog's epoch. Each service can contribute up to 1,500 candidates. A partial response identifies the service that failed or reached its limit. Complete field results expire after an hour, partial results after a minute. Exact, unambiguous release-specific aliases from SIMBAD join named objects to catalog records. Nearby objects without an identification stay separate. [Catalog implementation](app/known_catalog.py)

Stars with both components of proper motion use a linear tangent velocity at the catalog epoch. Gaia's RA component includes the cosine of declination. CatWISE motion fits use MJD 57170 and arcseconds per year. A record lacking a usable motion retains its catalog position and epoch. These coordinates omit parallax and perspective acceleration. The markers share the displayed image's tangent-plane projection and north-up orientation. [Gaia DR3 astrometry](https://gea.esac.esa.int/archive/documentation/GDR3/Gaia_archive/chap_datamodel/sec_dm_main_source_catalogue/ssec_dm_gaia_source.html) · [CatWISE column definitions](https://irsa.ipac.caltech.edu/data/WISE/CatWISE/gator_docs/catwise_colDescriptions.html) · [Marker projection](../FE/src/lib/known-objects.ts)

Moving objects require the FITS exposure midpoint, or the mean of its start and end times. Legacy frames can retrieve this from a bounded archive header read. JPL Horizons supplies the spacecraft's geocentric ICRF position and velocity for that instant. SB Identification uses this observer and its second-pass numerical orbit calculation. Center and epoch keys keep different exposures' results independent. Successful ephemerides expire after 24 hours. When spacecraft coverage or the midpoint is unavailable, the viewer reports the lookup failure. [SPHEREx Explanatory Supplement](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/SPHEREx_Expsupp.pdf) · [JPL identification API](https://ssd-api.jpl.nasa.gov/doc/sb_ident.html) · [Moving-object service](app/moving_objects.py)

Live checks on 15 November 2026 returned Barnard's star as Gaia DR3 4472832130942575872 and SIMBAD type BY Dra Variable. Its estimated position was 0.61 and 0.36 displayed pixels from the local brightness peak in the 21 August 2025 and 19 March 2026 D6 demo images. For Vesta, IRSA MOST's August 2025 example returned RA 222.866022°, Dec −11.907528° for exposure `2025W32_1A_0105_1D6`. At its FITS midpoint of 4 August 2025 11:05:01.098 UTC, the JPL field lookup returned RA 222.866208°, Dec −11.907556°, a separation of 0.66 arcseconds, or 0.11 display pixel. The offline regression rechecks both star images and the recorded JPL coordinate against these references. [Prepared Barnard frames](demos/barnard/manifest.json) · [IRSA's Vesta query](https://github.com/Caltech-IPAC/irsa-tutorials/blob/main/tutorials/techniques-and-tools/MOST_queries.md#5-spherex) · [Regression tests](tests/test_known_objects.py)

### Sampling across cycles

For a live band search, `processing.sampling_tracks` lists one set of observation IDs for each calibrated wavelength group. `sampling_order` contains the same IDs flattened. Each group shares a detector and processing version. Every pair of center wavelengths lies within the configured fraction of the narrower bandwidth. Groups rank by distinct sampled cycles, then by their time span. The queue finishes each group before starting another, including after a failed transfer. Any pending exposure that the user clicks can take the next slot. [Scheduling](app/sampling.py) · [Progressive downloads](app/pipeline.py)

Within each group, the queue takes one exposure per eligible cycle, earliest and latest first. The optional positive `min_separation_days` limits automatic representatives using actual exposure times. Extra repeats, supplemental observations and unclassified exposures are available in `background_tracks`. A band lacking a usable cycle can supply one raw starting image per selected spectrum. Before final discovery, only a search already restricted to one calibrated channel can start a selected-band FITS preview. Broader searches use cached calibration or bounded wavelength header probes across candidate cycles under a shared six-second budget. The calibrated five-position sequence check establishes playback compatibility. [Cycle validation](app/visits.py) · [Scheduling tests](tests/test_sampling.py)

The legacy calibrated-channel endpoint can return measured labels as soon as a header finishes. Open pages share a four-worker maximum and return their pending count and cursor. Successful wavelength results are keyed by the exact product and coordinates. For another sky position, cached product calibration bytes are evaluated at the new coordinates. A fresh legacy menu catalog can supply an early single-channel preview while the search reconciles archive releases. Remaining `sampling_metadata_ids` can be submitted to the load endpoint with `metadata_only` to classify further tracks without transferring science images. Failed lookups remain available for explicit retry. [Catalog and menu](app/jobs.py) · [Bounded metadata reads](app/archive.py)

The Search picker lists 17 published geometric spectra for each detector without contacting IRSA. A value such as `D6-16` is verified by projecting the requested sky center to the original detector and looking up the nearest detector pixel in the official channel map. The leading FITS header supplies this mapping. Channels 0 and 18 are corners outside the selectable range. The nominal-channel wavelength ranges overlap, so the classification never uses the closest wavelength. A failed geometric lookup stays pending for retry. Within a nominal channel, download scheduling covers the available cycles before repeating a cycle. Quantitative sequences additionally require matching processing versions and spectra at all five field samples. Older saved calibrated wavelength labels retain their response-based matching. [Geometry and reference data](app/nominal_geometry.py) · [Selection](app/schemas.py) · [Archive reads](app/archive.py)

The twelve bundled demo frames carry nominal IDs verified using their original exact-release FITS headers. Existing cached science images can be enriched after a search or metadata-only load and reused without downloading their pixel data again. [Prepared fields](demos) · [Exposure cache](app/exposure_cache.py)

### Prepared fields

The viewer opens its startup preset with `POST /api/jobs?prepared_only=true`. If the prepared images are missing or unreadable, the backend returns a failed job without scheduling any FITS transfer. Pressing **Search observations** submits the detector and spectrum selection as a live job. The final transfer check uses the selected detector, calibrated spectrum and exact archive product. A server that ignores a wavelength metadata range cannot trigger a full image download through that lookup. [Job submission](app/jobs.py) · [Image download checks](app/pipeline.py) · [Metadata range tests](tests/test_field_visits.py)

`demos/<target>/` contains prepared archive PNGs and their source manifest where available. An exact matching coordinate query with no date filters can reuse that sequence and is explicitly labelled cached with its actual retrieval date. Other fields/filters use live retrieval. There is no silent substitution of a different field. The short-lived exact-query cache also expires after two hours; prepared demonstrations remain protected.

```powershell
.venv/Scripts/python scripts/prove_data.py --all --bundle
.venv/Scripts/python -m pytest -q
```

The proof script fetches each target, saves real-source reports under `.cache/validation/`, and optionally prepares demos. Reports state coverage/compatible frame results, not detections. Tests use a small recorded IRSA FITS fixture and synthetic test-only fields for coordinate, flag, calibration/wavelength, WCS, mask, stretch/orientation, API lifecycle, queue, expiry, and URL restriction checks. Unit tests do not depend on NASA availability. With both servers running, `node scripts/browser_smoke.cjs` verifies the real frontend/backend flow using the prepared Barnard sequence; it writes a screenshot and report under `.cache/integration/`.

## Selected region spectra

Right-click a selected rectangle in the viewer and choose **Open in new tab** to retrieve its spectral history. The tab searches all supported wide and deep SPHEREx collections for every detector and date. The selection uses the displayed field's 6.14″ ICRS TAN grid and inclusive pixel bounds. An enclosing SIA cone retrieves candidate exposures. The service intersects their published footprints with the selected rectangle and reconciles archive releases before requesting calibrated cutouts. Retrying within the same session reuses successful measurements. [IRSA image search](https://irsa.ipac.caltech.edu/ibe/sia.html) · [Region API](app/region_spectra.py)

Each exposure keeps its observation time, detector and release. Each region pixel samples archived brightness and wavelength at the same nearest detector pixel. Finite signed brightness contributes regardless of its flags. Missing pixels and NaNs contribute no brightness. Within an exposure, bins begin at the lowest sampled wavelength and use the narrowest positive finite bandwidth among contributing pixels. If no bandwidth is available, samples group by exact wavelength. The graph and table report arithmetic mean wavelength and surface brightness per populated bin, with the finite pixel count. The graph connects measurements only in verified cycles. Conflicting and supplemental observations remain individually inspectable. [Sampling and reduction](app/region_spectra.py) · [Visit validation](app/visits.py)

## Sources and credit

[IRSA cutout tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-cutouts/), [data products](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/), [flag definitions](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html), [SPHEREx archive and acknowledgement](https://irsa.ipac.caltech.edu/Missions/spherex.html).

This project makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), a joint project of the Jet Propulsion Laboratory and the California Institute of Technology funded by NASA. Data are distributed through Caltech/IPAC IRSA. Retain these credits and source manifests when sharing prepared images.
