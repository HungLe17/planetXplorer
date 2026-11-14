## 1. Scope and architecture

One explorer page: coordinate search, five target presets, image viewer, timeline, and source inspector. Support arbitrary RA/Dec through live IRSA retrieval; bundle genuine processed demo sequences for reliable presentations. Label cached results with retrieval date and source observations. Never silently substitute a preset for a requested field.

```text
Next.js browser → FastAPI jobs → IRSA TAP + archive cutouts
                       ↓
              FITS processing → PNGs + JSON manifest
```

Build one vertical slice before polishing. Freeze FOV at 5 arcminutes initially; cap sequences at 12 frames and previews at 512×512. These are project limits, subject to the first data proof. No user accounts or persistent user state.

## 2. Frontend: `proj/FE`

Use Next.js App Router, TypeScript, Tailwind, native fetch, and Canvas 2D. One client explorer component owns React state; no global-state library, query framework, or WebGL.

- `SearchForm`: decimal-degree RA/Dec, optional date range, preset selection, explicit submit. Validate RA [0,360), Dec [-90,90], finite numbers, and ordered dates. Presets store verified coordinates and coordinate epochs.
- `SkyViewer`: aligned PNG with shared pan/zoom, play/pause, stepping, scrubber, and speed. Preload the bounded sequence before playback; update frame and metadata together. Disable playback below two frames.
- `FrameDetails`: observation time, wavelength/bandwidth at target, quality warnings, release, and archive link.
- `lib/api.ts`: submit/poll, typed responses, errors. Ignore stale responses using a search-generation counter; abort obsolete browser requests. Poll every two seconds; stop at completion or unmount.
- `lib/view-url.ts`: share committed coordinates and dates through URL parameters; reload repeats the query. Never share temporary job IDs.

Use one server-generated asinh stretch per sequence; omit interactive contrast rerendering. Show loading stage, no coverage, insufficient comparable frames, partial failure, and archive outage. Offer cached presets explicitly during outages. Support keyboard stepping and responsive layout; no autoplay.

### Visual specification

Use Notion's structural clarity and Carbon's productive typography as references: a precise research workspace with quiet navigation, compact rows, and a dominant real sky image. Adopt neither branding nor a new UI dependency. Keep the existing single-page workflow.

**Tokens:** page `#FFFFFF`; sidebar `#F5F5F4`; hover/selected row `#EAEAE7`; primary text `#202124`; secondary text `#565B63`; dividers `#D8DBDF`; control borders `#858B94`; sky surround `#101216`. Reserve blue `#175CD3` for primary actions, links, and keyboard focus; action hover `#124AA8`, with white button text. Selection uses neutral fill and a 2px dark leading rule; status always has explanatory text.

Use locally bundled IBM Plex Sans with system sans-serif fallback; IBM Plex Mono only for coordinates, timestamps, and identifiers. Body/control text: 14px/20px, weight 400; labels: 12px/16px, weight 500; section titles: 16px/24px, weight 600; page title: 20px/28px, weight 600. Use sentence case, normal letter spacing, and tabular numerals for changing values. Spacing scale: 4/8/12/16/24/32px. Panels and viewer: 2px radius; inputs/buttons: 4px. Use 1px separators and no panel shadows. Controls: 36px desktop height, 44px on touch layouts; icons: 16px with accessible names. Focus: 2px blue outline with 2px offset. Keep labels visible; placeholders are examples only.

**Layout:** at ≥1024px, use a 224px sidebar for identity and five target rows; the main workspace has 24px padding, a compact coordinate/date search row, then the viewer and a 280px metadata column. Below the viewer, place playback controls, timeline, and actual observation time together. Let the sky region take remaining width, preserving image aspect ratio and scientific orientation. Metadata uses aligned label/value rows with units and wrapping source identifiers. At 768–1023px, move metadata below the viewer. Below 768px, replace the sidebar with the existing preset selector; stack labeled search fields, viewer, playback/timeline, then metadata, using 16px gutters. Keep controls in document flow and prevent horizontal page scrolling.

**Avoid generic presentation:** no marketing hero, card-grid dashboard, decorative stars, gradients/glow/glass, pill badges, oversized typography, or ornamental monospace. Write concrete labels such as “Search observations”; show genuine dates, wavelengths, warnings, and provenance rather than invented metrics or promotional copy. Treat recurring visual clichés as qualitative critique, not AI detection or grounds for a font blacklist.

**Visual QA, hours 24–36:** inspect 1440px and 390px layouts, 200% zoom, keyboard focus, long metadata, and existing loading/error/empty states. Check normal text contrast ≥4.5:1 and control/focus contrast ≥3:1; verify image/date synchronization and no decorative overlays obscuring data.

References: [Notion navigation](https://www.notion.com/help/navigate-with-the-sidebar), [Carbon typography](https://www.carbondesignsystem.com/building-blocks/foundations/typography/overview), [productive styles](https://www.carbondesignsystem.com/building-blocks/foundations/typography/style-strategies); qualitative critiques: [SCALR](https://scalr.sg/blog/20-signs-a-website-was-made-by-ai/), [InterfaceKit](https://blog.interfacekit.io/what-makes-a-website-look-ai-generated).

## 3. Backend: `proj/BE`

Use FastAPI/Pydantic, Astroquery TAP, HTTPX, Astropy, NumPy, reproject, and Pillow. Pin working dependencies after the data proof.

- `main.py`: routes, validation, executor lifespan, static output serving.
- `jobs.py`: bounded in-memory jobs and stage/status updates.
- `archive.py`: TAP query, product selection, archive cutout retrieval.
- `pipeline.py`: FITS inspection, masks, compatibility, alignment, rendering.
- `presets.json`: coordinates and cached manifest references.

Deploy one Uvicorn worker, one backend replica. Run the complete blocking pipeline in a dedicated single-worker thread executor; API polling remains asynchronous. Admit at most three outstanding jobs, returning 429 when full. Limit archive downloads to two concurrently; use approximately 120-second read timeouts, one transient retry, and a ten-minute whole-job deadline. Check deadline between stages and bound each network operation. No Redis, Celery, process pool, or cancellation protocol.

Store working files per UUID job directory. Publish results atomically, clean completed jobs after two hours, and protect bundled demos from cleanup. Restart loses jobs; the client can resubmit. Bound download bytes and FITS dimensions using measured fixture sizes before opening public access. Accept only server-resolved archive URLs and opaque asset IDs.

## 4. Minimal API and processing

- `POST /api/jobs`: `{ra_deg, dec_deg, start_utc?, end_utc?}` → 202 `{job_id}`.
- `GET /api/jobs/{id}`: `queued | running | complete | partial | failed`, stage, warnings, and final manifest. Unknown/restarted jobs return 404.
- `GET /api/assets/{job_id}/{asset_id}`: generated PNG or manifest through validated IDs.
- `GET /api/presets`: five targets, cached manifest availability, and test outcomes.
- `GET /api/health`: local readiness without querying IRSA.

Generate TypeScript types once from FastAPI OpenAPI after agreeing the contract; avoid a separate contract framework.

Pipeline:

1. Query overlapping footprints, deduplicate reprocessed exposures, sort by actual acquisition time, and cap metadata at 100 records. Report truncation. Inspect a bounded candidate set across dates; return at most 12 compatible frames.
2. Request archive-generated cutouts. HDUs can differ in shape and sky coverage: never slice all extensions with identical pixel indices. Preserve spatial/spectral WCS, PSF information, flags, units, and original FITS metadata.
3. Check target wavelength and bandwidth before grouping frames; detector identity alone is insufficient. Establish and record compatibility tolerances during data proof. Mask flagged/invalid pixels using documented flag semantics and each extension's own geometry.
4. Reproject science previews onto one north-up celestial grid near native sampling; use footprint masks and conservative invalid-pixel handling. Never interpolate bit flags. Apply one shared display scale, then publish time-ordered PNGs and manifest.

The manifest records query, source IDs/URLs, acquisition times, release/version, wavelength/bandwidth, units, grid, mask policy, stretch, processing version, omissions, and retrieval time. Previews support visual inspection, not calibrated photometry. Spatial wavelength variation and PSF changes can mimic variability; retain warnings. No claim that a candidate is Planet X.

## References

[Challenge](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/); [event copy](https://hackathlone.com/challenges/planet-x-and-spherex); [IRSA archive](https://irsa.ipac.caltech.edu/Missions/spherex.html); [official cutout constraints](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/cutouts.html); [retrieval tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-cutouts/). Challenge scope follows the prior event-copy check; official detail-page retrieval previously failed. Data-service constraints incorporate the independent official-source check supplied for this revision.
