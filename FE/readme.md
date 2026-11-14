# planetXplorer frontend

Next.js / React / TypeScript / Tailwind, local IBM Plex fonts, Canvas viewer. Node 20.9+ required. All implementation files live in this directory.

The interface uses a dark viewport-sized workspace: compact target navigation, a dominant resizable image region, on-demand date filters, and a collapsible inspector. Metadata opens as a floating panel on phones/tablets. The desktop page fits the screen; only long inspector contents scroll. Small/zoomed screens allow content scrolling when necessary to keep controls accessible.

Run `npm ci`, copy `.env.example` to `.env.local`, then `npm run dev`. Open http://127.0.0.1:3000. Set `NEXT_PUBLIC_API_BASE_URL` to the FastAPI origin (default http://127.0.0.1:8000); backend CORS must allow the frontend origin.

No backend or observation imagery is bundled. An unavailable service produces a clear error. WISE 0855 uses the challenge reference position; other presets await verified API coordinates.

## API contract

- `POST /api/jobs`: `{ra_deg, dec_deg, start_utc?, end_utc?}` → `{job_id}`.
- `GET /api/jobs/{id}`: `{status, stage?, error?, warnings?, manifest?}`. Status: queued/running/complete/partial/failed. Stage: query/fetch/validate/align/render.
- Manifest: `{frames, warnings?, retrieved_at?, cached?, grid?, stretch?}`. Frame: `{id, url, observation_id, observed_at, detector, wavelength_um?, bandwidth_um?, release?, source_url?, warnings?}`. ISO UTC dates, maximum 12 frames. Backend supplies one spatial grid and stretch per sequence. Relative image URLs resolve against the backend origin.
- `GET /api/presets`: `{presets:[{id, ra_deg, dec_deg, coordinate_epoch?}]}`. IDs: barnard, epsilon, wise, rw, rdraconis. Cached-image selection awaits the backend cached-manifest contract.

Types are provisional until FastAPI OpenAPI is available for generation. Browser preloads frames, sorts by acquisition time, updates image and metadata together, and restores shared queries from URLs. Scientific processing stays in the backend.

## Verification

`npm run build`; `npm run typecheck`; `npx playwright install chromium`; `npm test`.

Browser tests use test-only image/API fixtures for validation, service errors, ordering, stepping, URL restoration, and mobile overflow. They do not establish archive science or live connectivity. The app never substitutes generated observations.
