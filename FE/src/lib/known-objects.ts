import type { Query } from "./types";

export type CatalogObject = {
  id: string; name: string; type: string; source: string; source_url?: string;
  ra_deg: number; dec_deg: number; epoch_jyear: number | null;
  pmra_masyr: number | null; pmdec_masyr: number | null;
  aliases: string[]; sources: string[];
};
export type Marker = {
  key: string; id: string; name: string; type: string; ra_deg: number; dec_deg: number;
  epoch: string; source: string; source_url?: string; moving: boolean;
  u: number; v: number;
};
export type CatalogResult = {objects: CatalogObject[]; fetched_at: string; warnings: string[]};
export type MovingResult = {
  objects: {id: string; name: string; type: string; category?: string; ra_deg: number; dec_deg: number; source_url?: string}[];
  midpoint_utc?: string; fetched_at: string; warnings: string[];
};
type Grid = Record<string, string | number>;
const rad = Math.PI / 180;

/** Fractional edge coordinates on the north-up image; FITS pixel centers start at 1. */
export function projectMarker(query: Query, grid: Grid | undefined, width: number, height: number, ra: number, dec: number) {
  if (!width || !height) return null;
  const center = Number(grid?.CRVAL2 ?? query.dec_deg) * rad;
  const delta = (ra - Number(grid?.CRVAL1 ?? query.ra_deg)) * rad;
  const d = dec * rad;
  const divisor = Math.sin(center) * Math.sin(d) + Math.cos(center) * Math.cos(d) * Math.cos(delta);
  if (!(divisor > 0)) return null;
  const xi = Math.cos(d) * Math.sin(delta) / (divisor * rad);
  const eta = (Math.cos(center) * Math.sin(d) - Math.sin(center) * Math.cos(d) * Math.cos(delta)) / (divisor * rad);
  const scaleX = Number(grid?.CDELT1 ?? -6.14 / 3600), scaleY = Number(grid?.CDELT2 ?? 6.14 / 3600);
  const a = Number(grid?.CD1_1 ?? scaleX * Number(grid?.PC1_1 ?? 1));
  const b = Number(grid?.CD1_2 ?? scaleX * Number(grid?.PC1_2 ?? 0));
  const c = Number(grid?.CD2_1 ?? scaleY * Number(grid?.PC2_1 ?? 0));
  const d2 = Number(grid?.CD2_2 ?? scaleY * Number(grid?.PC2_2 ?? 1));
  const det = a * d2 - b * c;
  const x = Number(grid?.CRPIX1 ?? (width + 1) / 2) + (d2 * xi - b * eta) / det;
  const y = Number(grid?.CRPIX2 ?? (height + 1) / 2) + (a * eta - c * xi) / det;
  const u = (x - 0.5) / width, v = 1 - (y - 0.5) / height;
  return u >= 0 && u < 1 && v >= 0 && v < 1 ? {u,v} : null;
}

export function catalogPosition(star: CatalogObject, utc: string) {
  if (star.pmra_masyr == null || star.pmdec_masyr == null || star.epoch_jyear == null) {
    return {ra_deg:star.ra_deg, dec_deg:star.dec_deg, epoch: star.epoch_jyear == null
      ? "Catalog position · epoch unavailable" : "Catalog position · J" + star.epoch_jyear};
  }
  const years = 2000 + (Date.parse(utc) - Date.UTC(2000, 0, 1, 12)) / (365.25 * 86400000) - star.epoch_jyear;
  const east = years * star.pmra_masyr * rad / 3600000;
  const north = years * star.pmdec_masyr * rad / 3600000;
  const ra = star.ra_deg * rad, dec = star.dec_deg * rad;
  const radial = Math.cos(dec) - north * Math.sin(dec);
  const x = radial * Math.cos(ra) - east * Math.sin(ra);
  const y = radial * Math.sin(ra) + east * Math.cos(ra);
  const z = Math.sin(dec) + north * Math.cos(dec);
  return {ra_deg:(Math.atan2(y,x) / rad + 360) % 360, dec_deg:Math.atan2(z,Math.hypot(x,y)) / rad,
    epoch:"Proper motion · " + utc};
}
