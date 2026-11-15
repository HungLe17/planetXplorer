import { detectors, matchesChannel } from "./imaging";
import { isNominalSpectrum } from "./nominal-spectra";
import type { Detector, Manifest, Observation, Query } from "./types";

export type Bands = { detectors: Detector[]; channels: Partial<Record<Detector, string[]>> };
export type BandDraft = Partial<Record<Detector, null | { field: string; labels: string[] }>>;

export function fieldKey(q: Query | null) {
  return q ? JSON.stringify([q.ra_deg, q.dec_deg, q.fov_arcsec ?? 300, q.start_utc, q.end_utc]) : "";
}
export function draftBands(bands: Bands, field: string): BandDraft {
  return Object.fromEntries(bands.detectors.map(d => [
    d, bands.channels[d]?.length ? { field, labels: bands.channels[d] } : null,
  ]));
}
export function selectedBands(draft: BandDraft, field: string): Bands | null {
  const chosen = detectors.filter(d => d in draft);
  const channels: Bands["channels"] = {};
  if (!chosen.length) return null;
  for (const d of chosen) {
    const sub = draft[d];
    if (sub) {
      if (!sub.labels.length || (sub.field !== field && sub.labels.some(s => !isNominalSpectrum(s)))) return null;
      channels[d] = sub.labels;
    }
  }
  return { detectors: chosen, channels };
}

export function readBands(value: unknown): Bands {
  if (!value || typeof value !== "object" || !("detectors" in value) || !Array.isArray(value.detectors))
    throw Error("Invalid saved detector selection.");
  const chosen = [...new Set(value.detectors)];
  if (!chosen.length || !chosen.every(d => detectors.includes(d))) throw Error("Invalid saved detector selection.");
  const rows = "channels" in value ? value.channels : {};
  if (!rows || typeof rows !== "object" || Array.isArray(rows)) throw Error("Invalid saved spectrum selection.");
  const channels: Bands["channels"] = {};
  for (const [key, labels] of Object.entries(rows)) {
    if (!chosen.includes(key) || !Array.isArray(labels) || !labels.length || labels.length > 512 ||
        !labels.every(label => typeof label === "string" && label.length <= 160 &&
          ((label.startsWith(key + "-") && isNominalSpectrum(label)) ||
          (label.startsWith(key + " ") && /^D[1-6]\s+\d+(?:\.\d+)?\s+[^()]+\s+\([^)]+\)$/.test(label)))))
      throw Error("Invalid saved spectrum selection.");
    channels[key as Detector] = [...new Set<string>(labels)];
  }
  return { detectors: detectors.filter(d => chosen.includes(d)), channels };
}

export function inSearch(record: Observation, query: Query | null) {
  if (record.selection === "excluded" || (query?.detectors && !query.detectors.includes(record.detector))) return false;
  const labels = query?.channels?.[record.detector];
  return !labels?.length || labels.some(label => matchesChannel(label, record) ||
    (isNominalSpectrum(label) ? record.nominal_channel == null : !record.channel));
}

/** Keep each request within one archive wavelength track, including a short final batch. */
export function nextSpectrumBatch(rows: Observation[], plan: Manifest["processing"], size: number) {
  if (!rows.length) return {ids:[] as string[]};
  if (plan?.sampling_tracks) {
    const eligible = new Set(rows.map(row => row.id));
    const unloaded = new Set(rows.filter(row => row.status !== "ready").map(row => row.id));
    const firstTrack = (tracks: string[][]) => {
      for (const track of tracks) {
        const ids = track.filter(id => unloaded.has(id));
        if (ids.length) return ids.slice(0, size);
      }
    };
    const primary = firstTrack(plan.sampling_tracks);
    if (primary) return {ids:primary};
    const metadata = (plan.sampling_metadata_ids ?? []).filter(id => eligible.has(id)).slice(0, size);
    if (metadata.length) return {ids:metadata, metadataOnly:true};
    const extra = firstTrack(plan.background_tracks ?? []);
    if (extra) return {ids:extra};
    // An unclassified exposure requires its own metadata check.
    return {ids:[rows[0].id]};
  }
  // Older manifests can identify a wavelength by its stored channel label.
  const first = rows[0];
  const group = first.channel ? rows.filter(row => row.channel === first.channel) : rows;
  return {ids:group.slice(0, size).map(row => row.id)};
}
