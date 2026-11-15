import { Query } from "./types";
export function parseQuery(
  ra: string,
  dec: string,
  start: string,
  end: string,
): Query {
  if (!ra.trim() || !dec.trim())
    throw new Error(
      "Enter both right ascension and declination in decimal degrees.",
    );
  const r = Number(ra),
    d = Number(dec);
  if (!Number.isFinite(r) || r < 0 || r >= 360)
    throw new Error(
      "Right ascension must be between 0° and 360° (excluding 360°).",
    );
  if (!Number.isFinite(d) || d < -90 || d > 90)
    throw new Error("Declination must be between −90° and +90°.");
  for (const date of [start, end])
    if (
      date &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date)
    )
      throw new Error("Enter a valid calendar date.");
  if (start && end && start > end)
    throw new Error("The start date must be on or before the end date.");
  return {
    ra_deg: r,
    dec_deg: d,
    ...(start ? { start_utc: start + "T00:00:00Z" } : {}),
    ...(end ? { end_utc: end + "T23:59:59Z" } : {}),
  };
}
export function angularWidth(input: string): number {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 30 || value > 1800)
    throw Error("Field of view must be between 30 and 1800 arcseconds.");
  return value;
}
export function separationDays(input: unknown): number {
  const value = typeof input === "string" || typeof input === "number" ? Number(input) : NaN;
  if (!Number.isFinite(value) || value <= 0)
    throw Error("Enter a minimum separation greater than zero days.");
  return value;
}
export function queryUrl(query: Query, view?: unknown, frame?: string) {
  const url = new URL("/explore", window.location.origin);
  url.searchParams.set("ra", String(query.ra_deg));
  url.searchParams.set("dec", String(query.dec_deg));
  if (query.min_separation_days !== undefined)
    url.searchParams.set("min_days", String(query.min_separation_days));
  if (query.detectors?.length)
    url.searchParams.set("bands", JSON.stringify({ detectors: query.detectors, channels: query.channels ?? {} }));
  if (query.fov_arcsec && query.fov_arcsec !== 300)
    url.searchParams.set("fov", String(query.fov_arcsec));
  if (query.start_utc)
    url.searchParams.set("start", query.start_utc.slice(0, 10));
  if (query.end_utc) url.searchParams.set("end", query.end_utc.slice(0, 10));
  if (view) url.searchParams.set("view", JSON.stringify(view));
  if (frame) url.searchParams.set("frame", frame);
  return url.href;
}
