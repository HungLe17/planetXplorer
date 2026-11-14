# PLANET X — Implementable Frontend & Real-Data Integration Specification

**Audience:** Codex (implementation agent) and the Planet X development team  
**Version:** 2.0 — 14 November 2026  
**Primary UI reference:** User-provided screenshot of **WiseView / Backyard Worlds WISE image viewer**  
**Product:** Planet X — SPHEREx time-domain astronomical image explorer  
**Status:** Engineering requirements, not a finished design or evidence that data has been fetched

> **CODEX: THIS DOCUMENT IS THE IMPLEMENTATION BRIEF.** Read it alongside the existing repository and the NASA task description. Inspect the project before changing files. Implement the real working query → archive metadata → FITS cutout → scientific image → time-lapse pipeline, not just the visuals. The screenshot defines the useful control layout, not the obsolete typography/colors or the WISE data model. **Never invent image pixels, observations, timestamps, scientific values, or detections for the production interface.** Do not claim that a feature works until it genuinely works against FastAPI and the NASA archive.

---

## 0. Mission, non-negotiable scope, and definition of success

Build a **professional, browser-accessible, data-first astronomical workstation** to inspect how a specified patch of sky changes across **real NASA SPHEREx** observations. A visitor enters right ascension (RA) and declination (Dec), specifies field of view (FOV) and other query filters, retrieves matching observation records, views actual FITS-backed pixels, and blinks or plays aligned frames in time order. The result must remain scientifically interpretable.

**The MVP is successful only when:**

1. A user enters valid RA/Dec and FOV in the **visible left-side query panel**.
2. The FastAPI backend queries the live IRSA archive for authentic SPHEREx observations, using currently supported collections.
3. The app lists real observations and provenance, including which release and detector each came from.
4. The user loads an actual cutout of one observation and sees **the original scientific pixel measurements mapped to screen intensities**, not a stylized replacement image.
5. The user selects two or more scientifically comparable observations, requests a common registered grid where needed, and plays/steps through them with actual acquisition times.
6. Zoom, stretch, inversion, brightness bounds, and time controls visibly work and **do not change underlying scientific measurements**.
7. No data, missing coverage, missing backend capability, incompatible images, and archive failures display honest, actionable states.
8. Everything runs using **Next.js + FastAPI, with no database**.

**Scientific exclusions:** The 102-band SPHEREx all-sky cube is not itself a time series; detector images are not interchangeable broad-band photographs; an algorithmic residual is not automatically a new planet. The tool is named Planet X, but may not claim a new discovery without independent verification.

### Priority system

- **P0 — ship first:** genuine archive query/cutouts, visible WiseView-style query controls, authentic single-frame viewport, scientifically valid time viewer, metadata/provenance, URL sharing, accurate states, tests.
- **P1 — ship after P0:** comprehensive display controls, epoch grouping, split/difference/stack, quality mask visualizations, WCS cursor/pixel inspector, Gaia/WISE overlays, user annotations and exports.
- **P2 — add modularly:** spectra/light curves, 102-plane cube explorer, Euclid, candidate detection, ML integration, advanced compositing, custom pipelines.

Do not let P1 or P2 delay the real P0 scientific pipeline. Expose an unfinished control only if it is **clearly disabled with an explanation**, not superficially operational.

---

## 1. Architectural constraints (already decided by the team)

| Area | Required choice | Constraint |
|---|---|---|
| Web | **Next.js App Router + React + TypeScript** | No duplicate backend astronomy logic in Next.js |
| Styling | Tailwind CSS + shadcn/ui, Lucide as appropriate | Tight scientific UI, accessible, not dashboard marketing |
| State | Zustand | Shared query, viewer, timeline, inspector state |
| Requests | TanStack Query | Typed requests, cancellation, caching, retries with bounds |
| Image display | Canvas 2D, optional later WebGL | Honest pixel rendering, controllable scaling and LUT |
| Sky navigation | Aladin Lite (optional/integrated as a secondary navigation layer) | Do not replace actual FITS cutout viewport with a decorative star map |
| Backend | **Python FastAPI** | Owns archive access, FITS/WCS, science validation and processing |
| Astronomy packages | Astroquery/PyVO, Astropy, NumPy, SciPy, Reproject | Extend with Photutils only when needed |
| Data source | NASA IRSA SPHEREx, with adapters for other archives | No local authoritative astronomy catalog |
| Persistence | **No database** | No PostgreSQL, SQLite, MongoDB, Redis requirement, Firebase, Supabase, or auth system |
| Cache | Optional bounded, disposable local filesystem + browser memory | Must be reconstructable from provider data; TTL/versioning |
| Analysis | Feature-modular; optional classical methods and ONNX/WASM/WebGPU in future | Not required for P0, no fake inference results |

Deploy frontend and backend separately or via simple containers. One FastAPI instance is acceptable for the MVP; background operations may use bounded in-memory jobs and a single-process worker, with clear limitations and cancellation. Do **not** quietly add an external database or queue.

---

## 2. WiseView screenshot: exact control inventory and translation

The attached WiseView screenshot is the **primary layout and interaction reference**. It shows a left settings pane taking roughly one-fifth of screen width and a large black image region on the right. Controls on the left are dense, scrollable, plainly labeled, and persist during image inspection. The image is visibly low-resolution, grayscale, and pixelated; that is **a positive scientific property**, not a visual defect to hide.

**Do not copy the legacy visual style. Copy its functional density and immediate access to settings.**

| Screenshot control | Planet X requirement | Correct interpretation / conditional availability |
|---|---|---|
| `Settings`, `Links`, `Help`, `About` | P0 tabs/actions in upper-left section | Working help, archive citations, about; settings open by default |
| `Right ascension and declination` | P0 RA/Dec entry (combined field and/or distinct inputs) | Validate both; support decimal and sexagesimal coordinate formats |
| `Field of View (arcseconds)` | P0 numeric angular FOV | Arcsec entry by default; offer arcmin/degree units; FOV is **not** zoom |
| `Band[s]` (WISE `W2`) | P0 SPHEREx detector D1–D6 selection; P2 actual spectral plane selector | W1/W2 shown only inside separate WISE provider; never label SPHEREx D2 as W2 |
| `Apply defaults` | P0 reset-to-known-defaults | Explicit default values, no hidden query side effects |
| `Sliding window (0.50 yrs)` | P1 time-window/epoch binning | Group observations by time only when algorithm supports it; do not automatically coadd incompatible wavelengths |
| `Blink interval (500.00 ms)` | P0 playback interval slider/input | Real frame switching at requested interval, constrained by loaded frame readiness |
| `Zoom (9.0)` | P0 viewer magnification | Preserve zoom/pan across frames; independent of queried angular FOV |
| `Min - max pixel values: -50 - 500` | P0 two-value physical/display range controls | Display stretch bounds; preserve units and source data; support negatives |
| `Stretch Linearity (1.000)` | P0 stretch selector + shape parameter | Linear initially, plus asinh/log/sqrt where mathematically safe; clearly label transform |
| `Invert pixel values` | P0 grayscale inversion | Invert lookup-table only; never negate physical data |
| `Maximize dynamic range` | P1 computed percentile/auto bounds | Per-frame or shared bounds, explicitly labeled; default locked across blink |
| `Separate scan directions` | P1 survey-specific grouping if valid | Only if SPHEREx metadata supports scan direction and grouping yields a sound comparison |
| `Use only NEOWISE imagery` | Not applicable to SPHEREx; WISE-only P2 | Never place a fake NEOWISE checkbox in SPHEREx mode |
| `Skip middle epochs` | P1 timeline subset preset | Choose first/last or meaningful endpoints; clearly display removed epochs |
| `Skip duplicate windows` | P1 deduplicate time group results | Dedup by stable observation/product identities, not arbitrary image similarity |
| `Smooth by scan direction` | Optional processing mode with real algorithm | Disabled/omitted until implemented and documented; never default smoothing |
| `Border epoch 0` | P1 border/outline for reference epoch or registered footprint | Explicitly indicate what it outlines; avoid implying WISE epoch data exist |
| `Gaia DR3 overlay` | P1 WCS-correct Gaia overlay | Sources, positions, legend, catalog attribution, proper epoch handling |
| Main image + date range | P0 authentic image, actual timestamp/epoch annotation | No arbitrary epoch range, synthetic clouds, or invented overlay image |

Additional screenshot-specific behaviors: **left settings pane independently scrolls**; wide viewport retains black/neutral letterboxing; image can be enlarged beyond native resolution without artificially sharpening it; controls are compact but not cramped; long settings lists may use categories and collapsible subgroups.

### WiseView-inspired controls that MUST be visible above the left panel fold at desktop size

1. Coordinate query (RA/Dec).
2. Angular FOV and units.
3. Dataset/release + detector/band choice.
4. Search/Load and Reset Defaults.
5. Playback interval, zoom.
6. Display min/max and stretch/invert.

Do not hide these essentials behind a floating settings gear, command palette, popover, or separate page. Users need them immediately during active image inspection.

---

## 3. Visual layout — serious observatory software, not a startup landing page

### Desktop shell (target 1440×900 and 1920×1080)

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ PLANET X  | SPHEREx / IRSA | target RA/Dec | active product | archive state  | Help | Share │
├───────────────────────────────┬──────────────────────────────────────────────────────────────┤
│ LEFT SETTINGS / QUERY         │ VIEWPORT TOOLBAR: Image / Compare / Spectrum | WCS | 1:1 │
│ ~320–380px, resizable         ├──────────────────────────────────────────────────────────────┤
│                               │                                                              │
│ [Settings Links Help About]   │                                                              │
│ RA  [________________]        │                  REAL NASA SPHEREx FITS                         │
│ Dec [________________]        │                    SCIENCE PIXELS                              │
│ FOV [___] [arcsec ▾]          │                                                              │
│ Release [DR1+QR3 ▾]           │          native / registered mode and WCS overlay             │
│ Detector [D1 ... D6]          │                                                              │
│ [SEARCH / LOAD] [DEFAULTS]    │                                                              │
│                               │                                                              │
│ Time bin/window [______]      │                                                              │
│ Blink interval  [——●——]       │                                                              │
│ Zoom            [——●——]       ├──────────────────────────────────────────────────────────────┤
│ Pixel min [___] max [___]     │ TIME BAR:  ◀◀  ◀  ▶/❚❚  ▶  ▶▶  [speed] [loop] [A] [B]       │
│ Stretch [Linear ▾] [param]    │ markers: |  |    |   |   |       |   |    date/time readout │
│ [x] Invert                    ├──────────────────────────────────────────────┬───────────────┤
│ [ ] Auto dynamic range        │ OBSERVATIONS (real archive results table)    │ INSPECTOR     │
│ Layers, Flags, Processing...  │ time | detector | wavelength | id | flags    │ provenance    │
│                               │ selectable rows and filters                 │ pixel + WCS   │
└───────────────────────────────┴──────────────────────────────────────────────┴───────────────┘
```

**Key choices:**

- Left panel is **persistent, independently scrollable, resizable**, and immediately useful, as in WiseView. Default width ~340px; reasonable range ~290–440px.
- The **viewport is dominant**. It must not be squeezed by unrelated dashboard cards or an enormous inspector; lower results/inspector dock is resizable and collapsible.
- Top toolbar is shallow (~40–48px), not a giant branded hero.
- Center viewport has neutral black/dark background. If no data, show a concise, honest empty state, not a generated sky background.
- Timeline is always visible when observation results exist. Dock can expand to show fine-grained chronology.
- Observation list shows actual products with row selection and sort. Avoid scrolling the page as a whole; scroll individual panes.
- Right inspector may be a drawer or dock rather than permanently occupying 350px.
- Clear borders and thoughtful typography: system UI font for controls, tabular/monospaced numerals for coordinates, time, flux and pixel values. Nothing oversized, glossy, glow-heavy, or marketing-like.
- Consistent semantic colors (selected frame, comparison A/B, warning/error, masks). No luminous rainbow UI. Color maps appear in a scientific legend and are opt-in.
- Resizable splitters, keyboard focus outlines, accessible hit targets and real dropdown behavior. Use CSS grid/flex and ResizeObserver appropriately.

### Mobile / narrow screen

- On widths under ~900px, left controls open as a full-height **Settings/Query drawer**, but expose an always-visible button and compact coordinate/FOV status.
- Keep viewport visible by default. Timeline compresses to transport controls and a horizontal scrubber.
- Observation results and inspector become bottom sheets or tabs.
- No horizontally clipped controls or nested scrolling traps; preserve utility on tablet. Desktop is the primary scientific environment.

---

## 4. Left sidebar — detailed requirements and behavior

The sidebar is a **first-class scientific control surface**, not optional decoration. Implement subgroups in approximately this order.

### 4.1 Query / coordinate entry (P0)

**Controls:**

- Dataset provider: `SPHEREx (IRSA)` default. Future WISE/Euclid provider switching via adapter, not hardcoded into core.
- Archive collection selector: `Current (DR1 + QR3)` by default; allow individual DR1 / QR3 as supported; never invent collection names; backend discovers actual collection IDs. Show release/calibration warnings for deprecated products.
- Object-name resolver (optional if the service is available); RA/Dec remains fully usable without resolver.
- RA and Dec as **two explicit fields** plus optional compact joint-paste form `133.786245 -7.244372` like WiseView. Decimal degrees and sexagesimal entry are supported. Show parsed decimal values. Use ICRS by default.
- FOV input: number + `arcsec / arcmin / degrees`; default should be sensible for SPHEREx, configurable. Show physical size and warning when huge FOV could trigger slow downloads.
- FOV shape (P1): square/circle if underlying cutout/query supports selection; clearly distinguish query radius from cutout width.
- Date range (P1): start/end, `All available`, with known archive constraints.
- Detector control: `D1, D2, D3, D4, D5, D6`; default a single detector or a science-justified compatible group, not six arbitrarily combined arrays. Multi-select means **filter**, not automatic pixel addition.
- Data product control: `Spectral images / Single mosaic / Spectral cube` where actually exposed; cube is a different mode than animation.
- `Search observations` primary button, `Load selected frames` secondary action (or explicit query-and-load operation), `Cancel`, `Apply defaults`.
- Validation messages adjacent to fields: RA wraps or is validated per chosen convention; Dec in [-90,+90]; positive finite FOV; valid time interval; bounds on result count and cutout size.
- Search summary: sky center, FOV, number of observations, releases, actual time span, partial results, limit applied, queried at timestamp.

**Preset objects (P0):** Barnard's Star, Epsilon Indi B, WISE 0855−0714, RW Aurigae, and R Draconis. Use validated astronomical coordinates **with epoch/reference-frame details** or a real resolver. WISE 0855 is provided by the challenge at RA `08h55m10.831s`, Dec `−07°14′42.53″`; do not invent its observation motion/detection. Selecting a preset fills parameters; searching still uses the archive.

**Behavior:** Updating input fields must NOT silently claim to have loaded a new field. Query parameters are distinct from the currently committed observation result. Clicking Search validates, cancels/invalidates stale field requests, fetches new metadata and resets incompatible frame selection. A changed FOV triggers re-query/re-cutout as needed, not just CSS scaling.

### 4.2 Time window and playback controls (P0/P1)

- P0 `Blink interval`: range with numeric millisecond input, suggested selectable values 100/200/500/1000/2000 ms; UI reflects actual interval.
- P0 `Zoom`: slider plus numeric magnification, fit-to-viewport and native 1:1 pixel scale. Zoom affects rendering only.
- P1 `Sliding window`: choose a time-window size, unit days/months/years; epoch/coadd grouping needs a defined policy. Show number of observations per window and warn if mixed wavelengths or other incompatible calibration would make coaddition invalid.
- P1 `Skip duplicate windows`, `Skip middle epochs`, `Separate scan directions` (only if supported), all with clear checked states and immediate effect on visible *frame/epoch list*.
- P1 `Loop` and `Ping-pong` modes.

### 4.3 Pixel range and image appearance (P0/P1)

- P0 numeric `Min pixel value` and `Max pixel value` with optional dual-thumb slider. Use actual physical image values and document units when available. Do not assume every image has the WiseView example range `−50 to 500`.
- P0 `Stretch` menu: `Linear` default; optionally `Asinh`, `Log`, `Square root`. Math domain must be handled explicitly for zero/negative values and missing pixels; tooltips describe transforms.
- P0 `Stretch parameter` (linearity/softening) where relevant, numerical and bounded.
- P0 `Invert pixel values` (display LUT inversion only). For grayscale: positive intensity typically maps dark→light unless inverted; never modify FITS values.
- P1 `Auto / maximize dynamic range`: actual numeric percentile estimates or a documented robust rule; one-click fit. `Shared across frames` default ON for proper variability comparisons; `Per-frame auto` opt-in with visible warning that brightness comparisons can mislead.
- P1 `Color map`: `Grayscale` default, others identified as **false color** and accompanied by a legend.
- P1 `Interpolation`: `Nearest neighbor (native pixels)` default at zoom >1; `Bilinear` optional *display-only*; never call interpolation scientific superresolution.
- P1 `Display orientation`: north-up/east-left registered orientation if scientifically possible, or original detector orientation in native mode. State orientation explicitly.
- P1 reset just appearance settings without resetting query.

### 4.4 Dataset, quality, and processing (P1)

- Read-only current source: `SPHEREx / DR1` or `SPHEREx / QR3` as actually returned, with original file link.
- Toggle `Show quality-mask overlay` and `Exclude flagged pixels from processing` (policy/bitmask clearly specified).
- Select HDU / plane where relevant: `IMAGE`, `FLAGS`, `VARIANCE`, `ZODI`, and appropriate PSF metadata; note different HDUs aren't always ordinary 2D spatial images. `WCS-WAVE` is a table, not a fake color plane. For 102-plane mosaics provide plane navigation distinct from time animation.
- `Native detector pixels` vs `Registered comparison grid` mode (explanations visible).
- Processing provenance: mask policy, WCS reference, interpolation method, calibration compatibility, any stacking/background normalization.
- Archive refresh/status and source document links.

### 4.5 Overlay / optional extra controls (P1/P2)

- Gaia DR3 source overlay (where query supported) and source details.
- WISE and optional Euclid layers implemented through an actual provider, not a mislabeled SPHEREx detector.
- WCS grid, crosshair, observation footprint, catalog markers, image boundary, annotation markers.
- Layers panel with toggles, opacity and explicit metadata/credit per layer.
- Future `Candidate overlay / algorithm` hidden or disabled until real analysis exists.

### 4.6 Links, Help, About tabs (P0)

- **Links:** NASA IRSA SPHEREx mission, archive docs, official cutouts tutorial, original data product source, Gaia/WISE/Euclid links when used.
- **Help:** concise explanation of RA/Dec, FOV vs zoom, raw/native vs reprojected, band vs wavelength, blinking, interpolation and inversion, FITS physical values, quality flags; keyboard shortcuts.
- **About:** project purpose, user-facing science limitations, NASA data attribution, open-source repository link if defined, software version.

---

## 5. Observations panel — genuine metadata, no hardcoded dates

This is the scientifically essential feature missing from traditional one-image toy demos. Present the query results as a compact, sortable/selectable table beneath or beside the image.

**Columns:** checkbox/selection, observed date/time (UTC and optional MJD), observation/product ID, detector, relevant wavelength or wavelength span **at selected location when available**, release, pipeline version, coverage, flags summary, source link. Optional extra columns: file dimension, background/noise, exposure, scan direction, quality status.

**Functions:**

1. Ascending/descending chronology; stable tie-breaker by product ID.
2. Filter by detector, release, usable coverage, date, quality and processability.
3. Multi-select and `Select all compatible`; deselect; show selected count.
4. Pick reference image and comparison A/B frames explicitly.
5. Detect duplicate/superseded product versions without silently discarding unique observing epochs.
6. Open original source archive page or product URI.
7. Bounded paginated querying and incremental load (`Load more`) with status and partial result warnings.
8. Wavelength/calibration compatibility diagnostics before enabling blink/subtract/stack.
9. If only one valid image exists, show it and disable time-lapse with `Only one usable observation available`.

**Time grouping:** An epoch is a user-visible grouping of actual observations; not an invented image or arbitrary date bucket. Label grouped frames with their time range and number of inputs. If a frame is a stack, label it `Stack (N observations)`, never as a single-exposure image.

---

## 6. Central scientific image viewport (P0)

### 6.1 Absolute image authenticity rules

1. Display pixel intensity obtained from genuine SPHEREx `IMAGE` FITS HDU data, retrieved through IRSA and decoded in Python. Every frame has an observation/product ID and provenance. **Never use CSS-generated stars, canvas noise, procedural galaxies, image generation, stock photos, or random matrices** as production fallbacks.
2. **No synthetic or ML-upscaled scientific imagery**. Native resolution must be accessible with nearest-neighbor pixel magnification. Optional bilinear visual smoothing is purely cosmetic and labeled; interpolation cannot fabricate higher-resolution measurements.
3. FITS pixels are physical float samples; **the rendered grayscale image is a display mapping, not byte-for-byte raw FITS**. Document LUT/stretch/min/max/invert choices. Allow download/access to original FITS/cutout for scientific fidelity.
4. Missing pixels (`NaN`, invalid footprint) must not be rendered as stars or silently filled. Render with consistent transparent/hatched/neutral missing-data marker (distinct from black/white real pixels). Display flagged pixel count.
5. Keep the image aspect ratio, WCS geometry, orientation and correct square-pixel behavior. No CSS `object-fit: cover` cropping that hides the selected FOV.
6. Native mode displays original detector cutout pixels without spatial reprojection. Registered mode reprojects frames to a common sky WCS, clearly labeled `Reprojected/registered`; scientific data are not falsely described as raw after reprojection.
7. All frame swaps preserve the user's sky center, zoom, pan, and **locked global display range**, when coordinate registration allows.
8. Never infer physical motion from a jump caused by unregistered, different-orientation raw frames.

### 6.2 UI and interactions

- Main canvas on neutral black/dark background, centered and fit when loaded.
- Zoom with wheel/pinch/buttons; drag pan; reset view; fit to FOV; native 1 image pixel : 1 display pixel.
- Crosshair, exact pointer pixel indices, RA/Dec (via backend WCS metadata or a correctly implemented client projection), and measured pixel value in stated scientific units.
- Status ribbon for `Source / release / detector / product ID / UTC time / native or registered / dimensions / units`.
- Toggle north/east directions, angular ruler, WCS grid and observed coverage footprint, with genuine WCS transforms.
- Selection of image pixel or circular/rectangular ROI for later extraction; clearly distinguish measurement from quick-look inspection.
- Fullscreen viewport and optional split/wipe comparison mode.
- `Download original/cutout FITS` or genuine archive link. `Export rendered PNG` includes display settings in companion manifest when possible.
- When loading: unobtrusive progress overlay and optional previous image retained with `Loading new field…` label; never falsely label old pixels as the new query.
- When no data: **plain neutral empty viewport** with `No compatible SPHEREx image loaded`, reason and next suggested action. No starfield wallpaper.

### 6.3 Rendering choices and client/server responsibility

For P0, choose one actual, testable pipeline and implement end-to-end:

**Preferred scientific-pixel pipeline:** FastAPI produces a normalized frame manifest (metadata + width/height + units + min/max/quality + WCS) and a bounded binary array of source-derived **Float32** values. Frontend loads into `Float32Array` and maps scalar intensity through a documented grayscale LUT onto Canvas ImageData. If needed, masks/variance are separate typed arrays. This gives immediate min/max/stretch/invert without network rerender and permits a genuine pixel inspector. Limit cutout dimensions and memory allocation.

**Acceptable simpler MVP:** Backend produces a PNG from authentic FITS data with a clearly specified stretch and returns provenance + display parameters. Pixel inspection must request original values through a backend endpoint; updates to min/max/stretch regenerate or use corresponding float data. Never pretend an 8-bit PNG contains full scientific precision.

Backend supplies correct source matrix, orientation, metadata, flags, and optional registration. Frontend never performs astrophysical WCS reprojection, spectral calibration, flux arithmetic, or scientific resampling. Frontend only performs bounded **visual LUT/color/interpolation** transformations.

---

## 7. Timeline, blink, epoch grouping, and playback (P0)

Required always-available (once selected frames load):

- Timestamped linear scrubber with markers corresponding to **actual observation times**.
- `Play/Pause`, `First`, `Previous`, `Next`, `Last`, loop toggle, actual frame index and selected observation details.
- `Blink interval` slider and numeric milliseconds field (WiseView-style control on left; transport bar can mirror it).
- Speed label, e.g. `500 ms/frame`, not an invented frame rate derived from observation cadence.
- Show actual time deltas between frames; do not imply each screen interval equals the same elapsed astronomical time.
- Timestamp label must be from archive metadata, and a stack shows its time interval instead of a fictional singular timestamp.
- Maintain viewport center, orientation, FOV, zoom, and intensity scale when switching between registered frames.
- Prefetch next/previous frames; suspend or skip only under a visibly stated loading policy; do not flash placeholder images or silently reuse previous frame as a different date.
- Freeze/playback policy when user changes detector/band: require compatible selection or rebuild frame sequence and make the change obvious.
- Keyboard shortcuts documented in Help (e.g. Space play/pause, left/right step, `F` fit image, `I` invert, `G` coordinate grid; avoid typing-field conflicts).

**Two independent axes:** (a) observation **time** and (b) wavelength / detector / spectral plane. Do not accidentally animate across 102 spectral planes while labeling it as time-lapse.

**P1 epoch/binning:** Optional time window (e.g. sliding 0.5 years) and grouped coadds. The word `epoch` must refer to real source exposure membership; list members, grouping algorithm, and processing time range. Never sum unrelated D1–D6 pixel arrays just because they occur in the same epoch.

---

## 8. Image analysis and comparison workspaces (P1)

Add modes to a compact viewport toolbar; each operates on real selected observations:

| Mode | User interaction | Science requirements |
|---|---|---|
| `Single` | Examine one image | Native or registered, label state |
| `Blink` | Alternate selected frames | Same sky grid, compatible wavelengths/calibration or an explicit warning |
| `Side by side` | A and B in synchronized viewports | Shared WCS center/scale/cursor, each provenance displayed |
| `Wipe` | Drag boundary between A and B | Registered co-spatial images; mismatch warning |
| `Opacity blend` | A/B alpha slider | Matched geometry and meaningful intensity scales |
| `Difference A−B / B−A` | Choose order and A/B frames | Masking, background matching, comparable spectral response/PSF; show units/sign legend |
| `Stack/coadd` | Select >1 input and method | Compatible calibration, wavelength policy, uncertainty handling, masks, source list |
| `HDU inspector` | View science/variance/flags/zodi and metadata | Select only meaningful images, never mislabel PSF or table |

When incompatible, disable scientific operation and show a precise reason: e.g. `These exposures sample different wavelengths at this position; choose matching data or request an appropriate mosaic.` A wipe/blend may be allowed as a purely visual comparison **only if clearly marked non-photometric**.

Difference and stacking should run in FastAPI; return derived product manifest with all parent observation IDs, algorithm name, parameters, WCS and uncertainties/quality summary. Do not have React subtract 8-bit rendered PNGs and call it a science difference product.

---

## 9. Spectral and advanced science modules (P2 unless stated)

Create extension contracts, but do not fake content. Add a spectrum workspace only when real data/service is integrated.

- Separate `Time series` view from `Spectral cube` view. A SPHEREx 102-plane cube contains different **wavelengths**, not necessarily 102 observation dates.
- For a cube, display `Plane index 1–102`, physical wavelength (µm) from FITS metadata, and show correct `IMAGE`, `NHITS`, `FLAGS` plane series where present.
- Single-pixel cube drilling is **quick-look**, not equivalent to calibrated point-source spectrophotometry.
- Spectrum mode requires real extracted flux-density vs wavelength data with units, uncertainties, masks and provider/algorithm provenance. Use official IRSA spectrophotometry capability when suitable.
- Optional per-source light curve: flux vs actual observation time at a consistent band/wavelength with propagated errors. Target variable stars RW Aurigae / R Draconis are useful tests, but visibility and detection cannot be assumed.
- Provide CSV/PNG/FITS export if backed by genuine measurement outputs.
- Avoid term `thermal spectrum` unless fitted and labeled as a physically justified thermal model; the standard display is a **spectrum**.

---

## 10. Catalogs, external surveys, and overlays (P1/P2)

**P1:** WCS coordinate grid, Gaia DR3 source markers, optional WISE overlay and SPHEREx observation footprints. **P2:** Euclid available-coverage overlay, new catalog plugins, more advanced cross-matching.

- Each layer adapter exposes a provider ID, coverage, query schema, fetch function, pixel/catalog geometry, source attribution, and capability flags.
- Gaia objects should be plotted with appropriate coordinate epoch/proper-motion treatment when that accuracy matters; do not simply paste arbitrary markers onto the pixel canvas.
- WISE W1/W2 (and other bands) are separate **WISE** products, not SPHEREx D1/D2.
- Euclid is **coverage-limited**, not all-sky; show unavailable region honestly.
- Opacity controls change **display layer** only; each catalog marker is clickable for true returned metadata.
- Aladin Lite may provide navigation and catalog overlays but may not replace the authenticated scientific SPHEREx image with an unlabelled default survey background.
- Failure of Gaia/WISE/Euclid must not break SPHEREx image playback.

---

## 11. Quality flags, annotations, and future ML candidates

Keep exactly separate semantic classes:

1. **Archive quality flags**: bitmasks/metadata supplied by NASA; immutable; show decoded meanings and which pixels they cover.
2. **Derived processing flags**: misalignment, incomplete footprint, wavelength mismatch, high background, failed job, etc.; include calculation provenance.
3. **User annotations**: labels/markers/ROIs drawn by the viewer; editable and exportable locally; never represented as NASA flags.
4. **Automated candidates**: only if a real algorithm runs, marked `Unverified algorithmic candidate` with score, version, input IDs and evidence; not a confirmed discovery.

**No database storage.** Annotations can live in memory and optionally in browser local storage (if user opts in) and support JSON import/export; no server-side record system or account login.

**Future ML module:** Separate `Analyzer` interface and capability flags. ONNX Runtime Web with WASM as compatibility baseline; optional WebGPU if available. The model must not replace measured pixels, generate enhanced synthetic telescope imagery in the science viewport, or automatically hide low-scoring sources. CNNs, VAEs, contrastive learning, diffusion, JEPA, etc., are research ideas, **not implementation requirements**.

---

## 12. Archive integration and scientific processing — real data contract

### 12.1 Sources and current release policy

- Use NASA IRSA **SPHEREx DR1** and **QR3** as the primary current sources as of November 2026. DR1 reprocesses Surveys 1/2 and QR3 covers later observations; these supersede older QR2 for most new work.
- Use official **SIA2** for discoverable image metadata and documented **TAP** where a more complex query is required. Do not scrape pages.
- Use on-premises IRSA **cutout requests** for spatial subsets, preserving WCS and calibration HDUs. Treat cutout URL syntax as a service contract; properly append query parameters to URLs that may already have a query string.
- Discover archive collections/version metadata where possible. Don't hardcode raw archive file path patterns or assume new releases always have the same version.
- Spectral images have `IMAGE`, `FLAGS`, `VARIANCE`, `ZODI`, `PSF`, and `WCS-WAVE` HDUs. The current IRSA data products documentation notes that the PSF and spectral wavelength metadata need careful handling for cutouts.
- Store release ID and pipeline/calibration version in frame provenance; mask contaminated pixels or display flags according to documented bit definitions.
- DR1/QR3 compatibility is preferable to mixing QR2 with later reprocessings without explicit correction/warnings.
- Server must validate external archive hosts and construct requests itself; never accept arbitrary user-supplied remote FITS URLs (SSRF risk).

### 12.2 Required FastAPI processing flow

```text
Validated sky query
  → IRSA SIA2/TAP metadata search
  → normalized typed observation descriptors + real observation dates
  → user selects real product IDs
  → server maps IDs to trusted archive URLs from metadata
  → bounded remote cutout request + retry/timeout
  → validate FITS + HDUs + WCS + units + dimensions + masks
  → native science array and metadata
  → optional compatible common-grid reprojection / coadd / difference
  → array/PNG response + provenance manifest
  → Next.js Canvas renderer and time controls
```

Always preserve source provenance even when rendering a preview PNG. Reprojection, interpolation, stacking, rescaling and difference must all be recorded as processing metadata. Include explicit warning/status if a reference image has no overlap or the wavelength/PSF differs materially. Background and mask handling should be deterministic and tested.

### 12.3 Suggested versioned API endpoints (implement P0 first)

| Method | Route | Priority | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/health` | P0 | API availability and version |
| `GET` | `/api/v1/capabilities` | P0 | Actual enabled providers, algorithms, render modes, limits |
| `GET` | `/api/v1/providers` | P0 | Available collections/releases and discovery status |
| `GET` | `/api/v1/presets` | P0 | Named test targets with source/coordinate epoch |
| `GET` | `/api/v1/observations` | P0 | RA/Dec/FOV/date/detector/release query, cursor/limit |
| `GET` | `/api/v1/observations/{id}` | P0 | Full source metadata |
| `POST` | `/api/v1/render` | P0 | Request cutouts and/or registered frames from actual product IDs |
| `GET` | `/api/v1/jobs/{id}` | P0 if jobs used | Actual progress, errors and result pointers |
| `DELETE` | `/api/v1/jobs/{id}` | P1 | Cancel bounded job |
| `GET` | `/api/v1/frames/{id}/manifest` | P0 | Shape, dtype, WCS, units, provenance and processing flags |
| `GET` | `/api/v1/frames/{id}/data` | P0 or selected implementation | Original-derived Float32 matrix (binary), optionally masks |
| `GET` | `/api/v1/frames/{id}/preview.png` | P0 or selected implementation | Grayscale from real FITS values with documented display LUT |
| `GET` | `/api/v1/frames/{id}/fits` | P1 | Native/derived FITS or true archive/cutout URL |
| `POST` | `/api/v1/compare` | P1 | Coadd/difference jobs and provenance |
| `GET` | `/api/v1/catalogs/{provider}/sources` | P1 | WCS-registered external source metadata |
| `POST` | `/api/v1/spectra` | P2 | True spectrum extraction/catalog service |

**API schema (illustrative *structure* only, never populate UI with this as scientific data):**

```ts
export type ProductKind = 'spectral-image' | 'mosaic' | 'cube';
export type FrameGeometry = 'native-detector' | 'registered-wcs';
export type ReleaseCode = string;

export interface Observation {
  id: string;                         // real archive identifier
  source: 'spherex';
  collection: string;                 // discovered IRSA collection
  release: ReleaseCode;
  productKind: ProductKind;
  detector?: 'D1'|'D2'|'D3'|'D4'|'D5'|'D6';
  observedAtUtc?: string;             // only if supplied and valid
  observedStartUtc?: string;
  observedEndUtc?: string;
  wavelengthAtTargetUm?: number;
  wavelengthRangeUm?: [number, number];
  pipelineVersion?: string;
  sourceUrl?: string;                 // trustworthy, backend provided
  qualitySummary?: { maskedFraction?: number; warnings: string[] };
  coverage?: { intersects: boolean; footprintId?: string };
}

export interface FrameManifest {
  id: string;
  productIds: string[];
  geometry: FrameGeometry;
  width: number;
  height: number;
  dtype: 'float32-le';               // when serving binary arrays
  units: string;                      // FITS unit e.g. MJy/sr, if applicable
  observationTimeUtc?: string;
  observationRangeUtc?: [string,string];
  detector?: string;
  wavelengthSummary?: string;
  wcs: Record<string, unknown>;       // typed celestial WCS representation
  dataUrl?: string;                   // actual float samples, row-major
  previewUrl?: string;                // optional view only
  flagMaskUrl?: string;
  varianceUrl?: string;
  validPixelCount?: number;
  processing: {
    kind: 'native'|'reprojected'|'stack'|'difference';
    method: string;
    parameters: Record<string, unknown>;
    warnings: string[];
  };
  provenance: {
    provider: string;
    collection: string;
    sourceProductIds: string[];
    sourceUrls?: string[];
    retrievalTimestampUtc: string;
    processingVersion: string;
  };
}
```

**Binary float contract if selected:** response body is *exactly* a `width × height` array of little-endian IEEE-754 float32 values, row-major, with NaNs allowed, and `Content-Type: application/octet-stream`. The manifest supplies width, height, units, byte order, geometry, canonical WCS and file/data URLs. Validate `byteLength === width * height * 4`. Mask/variance binary streams have separately documented dtype/shape. Never deserialize Float32 bytes as RGB image pixels.

**Capabilities** must be truthful: missing analysis endpoints mean the UI hides/disables those tools. The frontend should not create fake observations from sample JSON to fill an empty grid.

---

## 13. State model, query parameters, and shareable links

### 13.1 Recommended Zustand slices

- `query`: draft RA/Dec, parsed ICRS values, FOV + unit, collection, detector filters, date filters.
- `results`: active committed query, observation IDs, pagination and selected products (TanStack Query holds server response cache).
- `viewer`: current frame ID, geometry native/registered, zoom, pan, display LUT, units, cursor and WCS readout.
- `timeline`: ordered real frame IDs, intervalMs, playing, loop, active index, selected A/B, temporal window policy.
- `layers`: grid, footprints, source catalogs, visible quality masks, legends.
- `workspace`: resizable pane sizes, dock layout and active mode.
- `annotations` (P1): in-memory/local exportable items separate from all archive flags.

Do not duplicate large scientific image arrays in multiple React states. Keep them in bounded image buffers/cache and dispose them on query change. Server responses belong in TanStack Query; Zustand stores lightweight interaction state.

### 13.2 URL query contract

Support a direct URL such as:

```text
/explore?ra=133.795129&dec=-7.245147&fov=176&fovUnit=arcsec&detector=D2&release=current&view=single&invert=1
```

This is an **example query definition**, not a claim that any particular image exists for those settings. Parse and validate on load; recover gracefully from invalid parameters. `Copy Link` serializes stable view state, not transient private URLs, temporary job IDs, or arbitrary archive access tokens. Keep query and URL updated without full page reload.

P2 read-only `/embed` can restore the same public query state with appropriate attribution.

---

## 14. Full UI behavior states, errors, accessibility and performance

**Required states:** initial no query, invalid coordinates, querying archive, partial paginated results, zero coverage, archive rate limit/unavailable, found results but no compatible time-series, rendering, partial frames loaded, ready, stale field after parameter edits, cancelling, processing error, expired transient job, catalog overlay failure, absent optional feature.

**Requirements:**

- Show specific messages (`IRSA returned no observations overlapping this field`) rather than generic `Something went wrong`.
- Never show a synthetic fallback or previous field without a clear stale-data warning.
- Cancel obsolete requests via `AbortController`; bound retries with exponential backoff for transient archive errors.
- Disable Play until at least two compatible, loaded frames exist; permit single-frame inspection otherwise.
- Disable difference and stacking when backend disallows the scientific comparison.
- Provide numeric feedback adjacent to slider controls; allow keyboard adjustment; accessible labels and focus states.
- Prevent accidental global shortcuts when typing in form controls.
- Handle hi-DPI displays without inventing detail; Canvas backing resolution/devicePixelRatio must not change the image science scale.
- Render large images in bounded buffers, avoid wasteful FITS downloads, prefetch adjacent frames only, deduplicate concurrent requests, free stale image buffers, and provide progress/cancel feedback.
- Do not rely solely on color to signal states; report units and textual warnings.
- Make very large cutout requests explicit, with server limits and clear UI guidance.
- Show clear archive acknowledgement/citation terms and original observation link.

---

## 15. Modular Next.js / FastAPI file architecture

Use the existing repository conventions if reasonable; otherwise organize approximately as follows. **Do not replace working code just to match this directory tree.**

```text
planetx/
  frontend/
    src/
      app/
        explore/page.tsx
        embed/page.tsx               # optional
        layout.tsx
      components/ui/                 # shadcn primitives
      components/shell/
        AppHeader.tsx
        WorkstationLayout.tsx
        ResizableDock.tsx
      features/query/
        QueryPanel.tsx
        CoordinateFields.tsx
        FieldOfViewInput.tsx
        DatasetSelector.tsx
        DetectorSelector.tsx
        TargetPresets.tsx
        querySchema.ts
      features/observations/
        ObservationTable.tsx
        ObservationFilters.tsx
        useObservations.ts
      features/viewer/
        ScientificCanvas.tsx
        useFramePixels.ts
        FrameManifestPanel.tsx
        WcsCursorInspector.tsx
        ColorStretchControls.tsx
        ImageToolbar.tsx
        canvasLut.ts
      features/timeline/
        TimeScrubber.tsx
        PlaybackControls.tsx
        EpochGroupingControls.tsx
      features/compare/
        CompareWorkspace.tsx
        CompareActions.tsx
      features/inspector/
        ProvenancePanel.tsx
        QualityFlagsPanel.tsx
        PixelDetails.tsx
      features/layers/
        LayerManager.tsx
        GaiaLayer.tsx
        WiseLayer.tsx
        AladinNavigator.tsx
      features/spectrum/            # optional, feature-gated
      features/candidates/          # optional, feature-gated
      features/annotations/         # optional, local JSON only
      lib/api/
        client.ts
        generated.ts                # OpenAPI-derived types if feasible
        errors.ts
      lib/astro/
        formatCoordinates.ts        # formatting only, not science reprojection
        formatUnits.ts
      store/
        queryStore.ts
        viewerStore.ts
        timelineStore.ts
      tests/
  backend/
    app/
      main.py
      api/v1/
        observations.py
        frames.py
        jobs.py
        capabilities.py
        comparisons.py              # P1
      core/
        models.py
        errors.py
        capabilities.py
      providers/
        base.py
        irsa_spherex.py
        gaia.py                    # optional
        wise.py                    # optional
        euclid.py                  # optional
      science/
        fits_reader.py
        cutouts.py
        wcs.py
        quality.py
        calibration.py
        registration.py
        rendering.py
        comparison.py              # P1
        spectra.py                 # P2
      services/
        observation_service.py
        frame_service.py
        job_service.py
      cache/
        transient.py
      tests/
  docs/
    API.md
    DATA_PROVENANCE.md
    SCIENCE_LIMITATIONS.md
    TEST_REPORT.md
```

### Explicit extension interfaces

- `ObservationProvider`: `search(query) -> ObservationPage`, `resolve_product(id) -> SourceProduct`, `fetch_cutout(...) -> FITS`; providers define available products/limits.
- `FrameProcessor`: `process(source, options) -> FrameProduct` with real data units, WCS, masks, provenance.
- `ComparisonAlgorithm`: `supports(frameSet) -> validation result`, `run(...) -> DerivedProduct`.
- `CatalogLayerProvider`: `search(field,time) -> catalog features`, `attribution`.
- `Analyzer` (future only): `requirements`, `analyze(real frames) -> unverified candidates`.
- `ViewerMode` (frontend): mount/unmount, supported geometry/data types, controls and legends.

Scientific source and domain models must not import Next.js UI. Optional provider failures cannot break the core SPHEREx path.

---

## 16. Implementation sequence for Codex — do not stop at a screenshot

**Phase 0: Repository inspection and plan**

- Inspect existing code, package managers, routes, dependencies and environmental variables. Identify re-usable working pieces. Describe edits before a broad refactor.
- Inspect the supplied WiseView screenshot; compare the exact control inventory in §2 with the current left panel.
- Check NASA archive docs and current IRSA SIA2/cutout behavior before coding; do not assume an earlier sample query still works.

**Phase 1: Actual FastAPI/IRSA vertical slice (P0)**

- Create real archive observation query by RA/Dec/FOV and metadata normalization.
- Create a real cutout request and parse `IMAGE`, WCS, `FLAGS`, `VARIANCE` as applicable.
- Return a genuine frame/preview plus usable provenance and science units. Implement bounded error handling and caches.
- Write backend tests for coordinate validation, FITS I/O, cutout URL construction, provider time parsing, invalid/no-coverage cases.

**Phase 2: Real Next.js instrument layout and left query controls (P0)**

- Build the WiseView-inspired persistent and scrollable sidebar, dominant viewport, timeline, observation list and inspector.
- Connect typed client to FastAPI, expose actual request progress, display real pixels using Canvas.
- Implement native pixel zoom/fit, min/max/stretch/invert, metadata and genuine observation source links.
- No placeholders masquerading as data.

**Phase 3: Scientifically safe time-lapse (P0)**

- Group/select compatible observations, implement reference WCS/grid creation and backend reprojection.
- Load at least two actual frames where public data permits; maintain position/scale/intensity between them; playback/step/scrub with real UTC dates.
- Implement all five challenge presets, URL query state and attribution.

**Phase 4: Researcher-quality options (P1)**

- Add mask visualizations, A/B compare, difference/stack, external catalogs, sliding epoch window, ROI and annotations only when actually implemented.

**Phase 5: Optional analyses (P2)**

- Add provenanced spectral extraction and cubes; leave ML extension architecture in place, but do not add or download unverified models just to populate UI.

**Do not complete a phase by substituting static screenshot reproductions for actual workflow behavior.**

---

## 17. Quality assurance and scientific acceptance tests

### Unit tests

- RA/Dec decimal and sexagesimal parsing including negative declination and RA wrap.
- FOV conversion: arcsec/arcmin/degree; zoom independent of angular cutout size.
- SIA/TAP query and cutout URL construction with URLs that already contain parameters.
- Real FITS HDU handling, non-square images, NaNs, signed pixel values, masks, float endian and shape.
- WCS pixel-to-world/world-to-pixel round-trip at multiple points.
- Correct display LUT mapping and inversion with no data-array mutation; negative and NaN tests.
- Time ordering with duplicate times, missing timestamps, superseded products and missing epochs.
- Native vs registered mode metadata and masks.
- Incompatible wavelength/calibration handling for blink/stack/difference.
- Cancellation, retries, no-coverage, archive downtime and partial success.

### Browser acceptance tests

1. App loads with no picture and an honest `No observation loaded` state.
2. The left query controls from §2 are immediately accessible; the panel independently scrolls at 1366×768.
3. Paste `133.786245 -7.244372` into coordinate input; correct parsing and field display. Screenshot values are **test inputs**, not expected NASA output.
4. Enter an invalid Dec and verify inline validation blocks submission.
5. Choose field size in arcseconds, run a real search, see genuine observation rows or truthful no-data/HTTP errors.
6. Select a real row: display original-derived pixel field, title/time, units, detector, source ID, and link.
7. Pixel zoom uses nearest neighbor; no decorative stars; invert and min/max update appearance with unchanged numeric pixel readout.
8. Select two compatible frames; blink interval slider alters actual switching rate; same sky position does not jump due to WCS mismatch.
9. Change query without submitting: currently displayed image remains explicitly associated with prior committed query.
10. Link sharing restores coordinate/FOV/detector/view settings and re-queries current real data.
11. Overlay failure or missing optional analysis leaves base image fully usable.
12. Mobile panel and timeline usable; 1440px desktop viewport remains the focus.
13. `No compatible frames` is not replaced by fake or procedurally generated data.

### Live-source integration tests

Use **actual, documented IRSA public products** for at least one automated/manual integration scenario; record source IDs, collection/release, query, source checksum (where available), testing date and limitations. Keep any tiny fixture derived from genuine FITS data with provenance, and clearly identify it as a test fixture—not a fictional sky view. Do not require an external service to be available for every unit test; separate network tests from deterministic offline tests.

Test challenge objects independently: Barnard's Star, Epsilon Indi B, WISE 0855−0714, RW Aurigae, R Draconis. **Passing a test means truthful query/render behavior**, not an assertion that a particular faint target visibly moved or that a previously undiscovered object exists.

---

## 18. Explicit anti-patterns: Codex must NOT do these

- No hero sections, gradient space backgrounds, generic SaaS statistics, rounded marketing cards, fake recent discoveries or animated fake starfields.
- No invented NASA images, perlin noise, placeholder astronomical textures, CSS dotted backgrounds sold as data, image-generation results, or random pixel arrays in the functional viewer.
- No fake archive record JSON shown as if retrieved, invented observation timestamps, or fake wavelength measurements.
- No AI smoothing, diffusion denoising, hallucinated detail, or superresolution in the default scientific image view.
- No browser-only fabricated 'processing' that subtracts compressed PNGs and labels the result a research-grade difference FITS.
- No assumption that WISE `W2` == SPHEREx `D2`, or that a six-detector image equals 102 fixed wavelength channels.
- No implicit normalization of every frame in a blink sequence when the user is evaluating brightness variability.
- No unmarked interpolated pixels described as original detector pixels.
- No always-on external overlays that replace the SPHEREx data.
- No dead controls, pretend toggles, opaque `Coming soon` buttons that look functional, or hidden essential settings.
- No hardcoded example coordinates, pixels, dates or mock results in production behavior outside explicitly labeled **test fixtures**.
- No required login, Firebase/Supabase, SQL/NoSQL DB, Redis, or commercial paid provider.
- No unrelated rewrites or architectural changes that violate team's Next.js/FastAPI decision.

---

## 19. Completion report expected from Codex

When you finish, report **concretely**, not with vague claims:

1. Files created/changed and why.
2. Exact run commands for Next.js and FastAPI; any environment variables, versions and setup.
3. Which features from this spec are genuinely complete (P0/P1/P2), and which are missing/disabled.
4. A successful real-data IRSA example: query parameters, actual returned observation/product IDs, source collection, and evidence of a displayed downloaded FITS cutout. **Do not claim this without executing and checking it.**
5. Screenshot of the working application with **real NASA imagery**, plus a screenshot of valid no-data state.
6. Test commands and results, frontend build results, and outstanding scientific limitations.
7. Confirmation that no synthetic data/images were substituted in the working UI and no database was added.

**If an external service cannot be reached during development, finish the real integration and show a truthful unavailable/error state; disclose that end-to-end live retrieval was unverified. Never fill the gap with simulated success.**

---

## 20. Source links and authority order

**User-provided references:**

- WiseView screenshot attached to the conversation: mandatory left settings layout and controls.
- NASA challenge brief: `Description-of-task.txt` (SPHEREx sky time-lapse, coordinate queries, five test targets).
- Team notes: `Notes.md` (cross-band processing ideas, quality/user flags, WISE/Gaia/Euclid, spectra, optional ML).
- Earlier architecture baseline: `PlanetX_Technical_Specification.md`; UI checklist: `PlanetX_Codex_Frontend_UI_Requirements.md`.

**Official technical documentation to consult and cite in implementation decisions:**

1. [IRSA SPHEREx mission archive](https://irsa.ipac.caltech.edu/Missions/spherex.html)
2. [SPHEREx data access: SIA2, TAP, cutout examples](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/)
3. [SPHEREx data releases and calibration compatibility](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-releases/)
4. [SPHEREx data product layout, FITS HDUs, PSF and WCS-WAVE](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/)
5. [IRSA SPHEREx cutout service](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/cutout_tool.html)
6. [IRSA SPHEREx visualization interface documentation](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/visualization.html)
7. [SPHEREx Python tutorials](https://caltech-ipac.github.io/irsa-tutorials/spherex/)
8. [WiseView reference tool](http://byw.tools/wiseview) (functional inspiration; WISE and SPHEREx differ scientifically)
9. [Gaia at MAST](https://archive.stsci.edu/missions-and-data/gaia)
10. [Aladin Lite](https://aladin.cds.unistra.fr/AladinLite/)

**Authority order:** live documented archive data and FITS metadata > official IRSA product/service documentation > challenge task > team requirements > screenshot ergonomics > optional implementation preferences. If UI convenience conflicts with scientific fidelity, preserve fidelity and explain the tradeoff.

---

# Final Codex instruction

**Build a real scientific instrument rather than reproducing a static WiseView screenshot.** Preserve WiseView's compact, persistent left query/settings experience; modernize the typography, spacing, docking and responsive behavior; make the main viewport show authentic SPHEREx FITS data with verifiable source metadata; and deliver a scientifically valid time-lapse. Prioritize the P0 end-to-end pipeline, and implement optional modules through well-defined interfaces without inventing results.
