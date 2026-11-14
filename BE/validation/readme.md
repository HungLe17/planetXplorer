# Real-data validation — 13 November 2026 UTC

All five challenge fields were queried against IRSA, downloaded as genuine FITS cutouts, wavelength-grouped, aligned and rendered. These results establish playable image sequences, not detections or verified variability of the named objects.

| Field | Frames | First / last date (UTC) | Detector |
|---|---:|---|---|
| Barnard's Star | 2 | 2025-08-21 / 2026-03-19 | D6 |
| Epsilon Indi B | 3 | 2025-04-24 / 2025-06-06 | D2 |
| WISE 0855 | 2 | 2025-05-05 / 2026-05-11 | D6 |
| RW Aurigae | 2 | 2025-09-09 / 2026-09-15 | D2 |
| R Draconis | 3 | 2025-04-24 / 2025-05-06 | D6 |

The adjacent target JSON reports preserve query coordinates, acquisition dates, source URLs, mask fractions, warnings, and omissions. Prepared PNGs and complete processing manifests are in `../demos/`. All selected frames report processing version 7.0.5; RW Aurigae includes both DR1 and QR3. Archive download failures and rejected candidates are reported explicitly. Date coverage is bounded by the metadata/sample limits and is not the mission's complete history.

Automated checks: 26 backend tests, including a real FITS fixture, passed. The existing frontend loaded and stepped through the genuine Barnard sequence using the actual API with no browser exceptions. A separate date-filtered live API query returned a real uncached frame and a working PNG asset. No synthetic data was used as a fallback in these live runs.

Reproduce: from BE run `.venv/Scripts/python scripts/prove_data.py --all --bundle`. This queries the current archive and can produce different compatible groups as products or availability change. Temporary detailed reports are written to `.cache/validation/`; copy reviewed reports here when updating the bundled examples.
