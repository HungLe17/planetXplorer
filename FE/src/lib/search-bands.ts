import { detectors, matchesChannel } from "./imaging";
import type { Detector, Observation, Query } from "./types";

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
      if (sub.field !== field || !sub.labels.length) return null;
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
  if (!rows || typeof rows !== "object" || Array.isArray(rows)) throw Error("Invalid saved subband selection.");
  const channels: Bands["channels"] = {};
  for (const [key, labels] of Object.entries(rows)) {
    if (!chosen.includes(key) || !Array.isArray(labels) || !labels.length || labels.length > 512 ||
        !labels.every(label => typeof label === "string" && label.length <= 160 &&
          label.startsWith(key + " ") && /^D[1-6]\s+\d+(?:\.\d+)?\s+[^()]+\s+\([^)]+\)$/.test(label)))
      throw Error("Invalid saved subband selection.");
    channels[key as Detector] = [...new Set<string>(labels)];
  }
  return { detectors: detectors.filter(d => chosen.includes(d)), channels };
}

export function inSearch(record: Observation, query: Query | null) {
  if (record.selection === "excluded" || (query?.detectors && !query.detectors.includes(record.detector))) return false;
  const labels = query?.channels?.[record.detector];
  return !labels?.length || !record.channel || labels.some(label => matchesChannel(label, record));
}
