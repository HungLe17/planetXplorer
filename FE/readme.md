# Planet X frontend

Next.js / React / TypeScript / Tailwind, local IBM Plex fonts, and a Canvas image viewer. Run `npm ci`, copy `.env.example` to `.env.local`, then `npm run dev`. Open http://127.0.0.1:3000.

Set `NEXT_PUBLIC_API_BASE_URL` to the FastAPI base URL, including `https://` for deployment and without `/api` or `/docs`. Backend CORS must allow the frontend origin. Public environment changes require a frontend rebuild/redeploy. The frontend contains no bundled observations or generated scientific imagery.

## Playback and navigation

- **Browse** is the default: play loaded images in acquisition order, including observations in different wavelength groups. The viewer shows the current detector, wavelength, and UTC acquisition time. A visible warning identifies unmatched observations; this mode is for browsing and does not establish brightness variability.
- **Matched** restricts playback to the selected backend-validated wavelength/calibration sequence. Select a sequence with two or more loaded images to blink it. If only one matches, the UI explains that limitation and offers a direct return to browsing all loaded images.
- Play/pause, first/last, stepping, timeline scrubbing, playback interval, and loop toggle operate on the current mode. Space toggles playback and arrow keys step when focus is outside form controls. Images remain usable while more records load; new arrivals preserve the selected observation by URL rather than shifting its index.
- Drag one pointer to pan a magnified image. Scroll or pinch to zoom around the pointer or two-finger midpoint. Double-click or double-tap toggles between a closer view and Fit. The gestures affect the image, not the page.
- **Fit** resets magnification and pan. **1:1** displays one image pixel per CSS pixel. Plus/minus zoom, `F` or `0` fits, and `1` selects native scale while the canvas is focused. Fullscreen is available when the browser supports it.
- The canvas retains nearest-neighbor display at magnification. Zoom/inversion do not change scientific measurements. A bounded cache keeps at most 12 image elements and prefetches neighboring frames, so a slow or failed distant image does not block the whole player. Failed images can be retried or stepped past.

## Managing observations

The records dock shows the full returned catalog and distinct loaded/failed/not-loaded counts. Filter by detector or status and search observation IDs, dates, or releases. Load next, Load all, and bulk retry apply to the visible selection. Load all processes successive batches; Stop cancels further loading while keeping existing images available. Export saves the filtered catalog as CSV with provenance and available spectral metadata.

Expand observations for a larger table. On phones, this switches to the records view; Restore image view returns to the canvas. Tapping View on a record returns to the image. The Field button shows/hides query settings on phones, and the records dock starts collapsed to leave space for the viewport. Details close when the layout moves from desktop to a narrow screen.

FOV controls the requested angular cutout (30-1,800 arcseconds); zoom controls its screen magnification. Editing coordinates, dates, or FOV does not silently change the currently displayed field. Submit Search to apply edits. Shared links restore query coordinates, dates, and FOV.

## API contract

- `POST /api/jobs`: `{ra_deg, dec_deg, fov_arcsec?, start_utc?, end_utc?}` returns `{job_id}`.
- `GET /api/jobs/{id}` returns status, stage, errors/warnings, and the progressively published manifest. Status can be queued/running/complete/partial/failed/cancelling/cancelled. Batch completion does not imply every catalog record has been downloaded.
- `POST /api/jobs/{id}/load`: `{observation_ids?: string[], detector?: "D1".."D6"}` queues up to eight records; explicit failed IDs can be retried.
- `POST /api/jobs/{id}/cancel` requests cancellation.
- The manifest includes observations, rendered frames, wavelength sequences with fixed within-sequence stretch, provenance, and discovery-completeness information. Up to 512 images can be loaded per field. Relative asset URLs resolve against the backend origin.
- `GET /api/presets` provides verified reference coordinates and prepared-sequence availability. An initial field is opened only from these backend-provided coordinates; explicit URL queries take precedence.

Scientific rendering, matching, masking, and reprojection stay in FastAPI. The browser does not manufacture compatible sequences or image pixels.

## Verification

```sh
npm run typecheck
npm test
npm run build
```

If Chromium is missing, run `npx playwright install chromium` first. Tests cover validation, failures, ordering, browse/matched playback, streaming additions, loop behavior, wheel/pan, real Chromium touch events for pinch/double-tap, native scale/fullscreen, image retry, filtered loading, CSV export, and mobile layouts. Test-only images/API fixtures are confined to tests; browser tests do not independently verify archive science or availability.
