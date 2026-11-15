# planetXplorer frontend

Next.js, React and TypeScript power the Canvas image viewer. Use Node 24 for the direct TypeScript imaging tests. Run `npm ci`, copy `.env.example` to `.env.local`, then `npm run dev`. Open http://127.0.0.1:3000.

The interface uses plain CSS, a local set of Lucide icons and five IBM Plex WOFF2 files. These cover Latin labels, numeric readouts and the Greek μ in wavelength units. Other scripts use the browser's fallback fonts. The font files and their OFL licenses are in `src/app/fonts`. Tailwind, the full font and icon packages, and Prettier are no longer install dependencies.

Set `NEXT_PUBLIC_API_BASE_URL` to the FastAPI base URL, including `https://` for deployment and without `/api` or `/docs`. Backend CORS must allow the frontend origin. Public environment changes require a frontend rebuild/redeploy. The frontend contains no bundled observations or generated scientific imagery.

## Playback and navigation

- **Visits** shows one timestep per comparable observing cycle. An exposure PNG can appear immediately while its calibration is loading. Playback requires matching wavelength responses across dates. **Time sampling** prioritizes one representative per selected wavelength per cycle, or accepts a minimum separation in days. Expand a cycle in **Observations** to inspect its detector and wavelength groups and change the timeline checkboxes. [Playback selection](src/lib/imaging.ts) · [Archive sampling](../BE/app/sampling.py)
- **Browse** and the catalog allow direct inspection of individual exposures. **Matched** filters exposures by the selected backend-validated wavelength/calibration sequence. A selected exposure first shows its PNG, then calibrated brightness when the brightness or quality payload arrives.
- Play, stepping, the slider, Space and the arrow keys all move between observing cycles. Starting from a raw exposure moves to the adjacent cycle. Playback requires at least two usable cycles. Images in legacy bundles without assigned cycles remain individually selectable from Observations. [Timeline](src/lib/imaging.ts) · [Playback controls](src/components/explorer.tsx)
- Select (V) inspects a pixel or dragged rectangle; Pan (H) moves the image with a left drag. Right-drag also pans with either tool. Scroll or pinch to zoom around the pointer or two-finger midpoint. Double-click or double-tap toggles between a closer view and Fit. The workspace toolbar opens field settings, saved locations, observations, and details. Canvas only hides the panels and Escape restores them.
- **Fit** resets magnification and pan. **1:1** displays one image pixel per CSS pixel. Plus/minus zoom, `F` or `0` fits, and `1` selects native scale while the canvas is focused. Fullscreen is available when the browser supports it.
- The canvas retains nearest-neighbor display at magnification. Zoom/inversion do not change scientific measurements. A bounded cache keeps at most 12 image elements and prefetches neighboring frames, so a slow or failed distant image does not block the whole player. Failed images can be retried or stepped past.

## Calibrated imaging and saved work

**Coordinates** shows ICRS right ascension and declination on the live image. Point to a pixel or select a region to read its position. **Color scale** shows each displayed map’s palette, stretch, intensity limits and units. The same controls govern the corresponding PNG and GIF annotations. [Viewer](src/components/sky-viewer.tsx)

Fresh archive searches also serve measured pixel values and, where available, per-pixel quality metadata. Each Spectrum row combines signed detectors or channels, with independent difference settings, stretch, limits and color stops. The canvas adds the rows. Details loads per-pixel wavelengths for the displayed spectrum and plots the field and selection as thin lines on shared axes starting at zero intensity. Selecting a different pixel or rectangle preserves the whole-field line and axis limits. Negative readings remain available in the signed measurements. [Spectrum graphs](src/components/spectrum.tsx) · [Asset loading](src/lib/use-images.ts)

The Surveys tab independently queries NEOWISE, Euclid and DESI for the field. Device persistence is opt-in. Use the workspace controls to browse locations and save positions, custom questions, answers and notes, import or export versioned JSON, and check recorded source observations against the archive. A share link can include display settings and the selected exposure.

## Managing observations

Observations shows one collapsed row per assigned cycle, with dates, detectors, validation status, and loaded and failed exposure counts. View cycle selects its composite in the timeline. Expand the row to inspect, load, or retry individual detector exposures. Additional exposures collects supplemental windows for raw inspection. Older manifests without cycle membership show their individual records.

Filter by detector or status and search exposure IDs, dates, or releases. A matching cycle keeps its full coverage and counts visible, and its expanded table shows the matching exposures. Load next, Load all, and bulk retry apply to matching exposures. Stop cancels further loading while keeping available images. CSV export retains one row per matching exposure with its provenance and available spectral metadata.

Expand observations for a larger table. On phones, this switches to the records view; Restore image view returns to the canvas. Tapping View on a record returns to the image. The Field button shows/hides query settings on phones, and the records dock starts collapsed to leave space for the viewport. Details close when the layout moves from desktop to a narrow screen.

FOV controls the requested angular cutout (30-1,800 arcseconds); zoom controls its screen magnification. Editing coordinates, dates, or FOV does not silently change the currently displayed field. Submit Search to apply edits. Shared links restore query coordinates, dates, and FOV.

## Inspect a field

**Known objects** opens a left-hand Aladin Lite atlas centered on the displayed SPHEREx field. The circles on the SPHEREx image use its own saved projection. Click a circle or choose an entry under **Object on image** to inspect its identification, coordinates, source, and epoch. A click on empty sky still inspects a pixel. On a composite, choose a contributing epoch for the stellar positions. Asteroids and comets can have a separate circle for each exposure midpoint. Changing cycles clears markers that belong to the previous view. [Viewer integration](src/components/explorer.tsx) · [Catalog panel](src/components/known-objects.tsx) · [Projection](src/lib/known-objects.ts)

Left-drag to select a region, then right-click inside it and choose **Open in new tab** for an all-date regional spectrum. The new tab requests D1–D6 independently of the original search filters. Right-drag continues to pan. [Viewer gestures](src/components/sky-viewer.tsx) · [Regional measurements](../BE/app/region_spectra.py)

## API contract

- `POST /api/jobs`: `{ra_deg, dec_deg, fov_arcsec?, start_utc?, end_utc?, live?, detectors?, channels?}` returns `{job_id}`.
- `GET /api/jobs/{id}` returns status, stage, errors/warnings, and the progressively published manifest. Status can be queued/running/complete/partial/failed/cancelling/cancelled. Batch completion does not imply every catalog record has been downloaded.
- `POST /api/jobs/{id}/load`: `{observation_ids?: string[], detector?: "D1".."D6", channels?}` queues up to eight records; explicit failed IDs can be retried.
- `GET /api/jobs/{id}/channels/{detector}?cursor=0` returns field-specific calibrated wavelengths for older clients. Search offers all 17 nominal channels per detector. Map Inputs keeps all six detector bands visible and lists only spectra verified in the current field's frames or catalog metadata; missing saved inputs remain removable without changing the saved configuration. Keep the shared JSON accessible at build time, including for deployments with `FE` as the project directory. [Channel reference](../BE/app/data/README.md)
- `POST /api/jobs/{id}/cancel` requests cancellation.
- The manifest includes observations, field visit validation, per-pixel wavelength assets, rendered frames, wavelength sequences with fixed within-sequence stretch, provenance, and discovery-completeness information. Up to 512 images can be loaded per field. Relative asset URLs resolve against the backend origin.
- `GET /api/presets` provides verified reference coordinates and prepared-sequence availability. An initial field is opened only from these backend-provided coordinates; explicit URL queries take precedence.

The backend supplies wavelength matching, quality information, aligned measured pixels and previews. The browser builds the selected composite and display from those assets.

## Verification

**Search → Bands** lists the 17 published nominal spectra for each detector from the bundled IRSA table. Selections survive a coordinate change. No archive call is needed to show or choose the spectra. After submission the service checks the target detector pixel against the official geometric channel map before requesting a selected image. Older saved wavelength/processing-version filters remain field-specific. [Search picker](src/components/search-bands.tsx) · [IRSA calibration provenance](../BE/app/data/README.md)

**Visits** displays a computed cycle map when its calibration and inputs are available. **Browse** inspects individual raw exposures. **Matched** groups exposures in a collapsible detector, nominal spectrum, and observing-date list. The measured wavelength is displayed on each date. **Subtract** compares calibrated cycle maps against a fixed reference epoch. The notification bell at the top right holds warnings and errors. [Matched picker](src/components/matched-picker.tsx) · [Image controls](src/components/image-controls.tsx)

To run the delayed-archive browser regression, set `PLANETX_TEST_PYTHON` to the absolute path of an interpreter with the backend requirements installed, then run `npx playwright test live-bands.spec.ts` from this directory. The test launches a temporary local backend, counts full cutout requests, holds two transfers while prioritizing another exposure, delays brightness and wavelength assets separately, and reports the first visible canvas paint. [Browser test](tests/live-bands.spec.ts) · [Archive fixture](../BE/tests/delayed_archive.py)

On 15 November 2026, three isolated cold searches against this fixture painted their first exposure PNG at 834, 766 and 960 ms after submission (median 834 ms). Each run made precisely six selected-spectrum cutout requests, including the clicked exposure in the next free slot. Opening Details started the per-pixel wavelength request after calibrated brightness was already visible. These timings describe the local production build and the delayed archive fixture. [Measured path and assertions](tests/live-bands.spec.ts)

```sh
npm run typecheck
node --test tests/image-processing.test.mjs
npx playwright install chromium
npm test
npm run build
```

If Chromium is missing, run `npx playwright install chromium` first. Tests cover validation, failures, ordering, cycle-only playback, individual exposure inspection, streaming additions, loop behavior, wheel/pan, real Chromium touch events for pinch/double-tap, native scale/fullscreen, image retry, filtered loading, CSV export, and mobile layouts. Test-only images/API fixtures are confined to tests; browser tests do not independently verify archive science or availability.
