import { Query } from "./types";
export function parseQuery(
  ra: string,
  dec: string,
  start: string,
  end: string,
  fov = "300",
  interval = "60",
): Query {
  if (!ra.trim() || !dec.trim())
    throw new Error(
      "Enter both right ascension and declination in decimal degrees.",
    );
  const field = Number(fov);
  const gap = Number(interval);
  if (!interval.trim() || !Number.isFinite(gap) || gap < 0 || gap > 3650)
    throw new Error("Observation spacing must be 0 to 3650 days.");
  if (!Number.isFinite(field) || field < 30 || field > 1800)
    throw new Error("Field of view must be 30 to 1800 arcseconds.");
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
    ...(field !== 300 ? { fov_arcsec: field } : {}),
    ...(gap !== 60 ? { min_interval_days: gap } : {}),
    ra_deg: r,
    dec_deg: d,
    ...(start ? { start_utc: start + "T00:00:00Z" } : {}),
    ...(end ? { end_utc: end + "T23:59:59Z" } : {}),
  };
}
export function queryUrl(query: Query) {
  const url = new URL("/explore", window.location.origin);
  url.searchParams.set("ra", String(query.ra_deg));
  url.searchParams.set("dec", String(query.dec_deg));
  if (query.fov_arcsec) url.searchParams.set("fov", String(query.fov_arcsec));
  if (query.min_interval_days != null && query.min_interval_days !== 60)
    url.searchParams.set("spacing", String(query.min_interval_days));
  if (query.start_utc)
    url.searchParams.set("start", query.start_utc.slice(0, 10));
  if (query.end_utc) url.searchParams.set("end", query.end_utc.slice(0, 10));
  return url.href;
}
