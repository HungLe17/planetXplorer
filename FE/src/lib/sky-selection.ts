import type { SkyTarget } from "./exploration-presets";

export type SkyClick = { ra: number; dec: number; isDragging?: boolean };

export function customSkyTarget(position: SkyClick | null | undefined): SkyTarget | null {
  if (!position || position.isDragging || !Number.isFinite(position.ra)
    || !Number.isFinite(position.dec) || Math.abs(position.dec) > 90) return null;
  return {
    id: "custom",
    name: "Selected sky position",
    description: "A 15-arcminute field centered on your selected position.",
    ra_deg: position.ra >= 0 && position.ra < 360
      ? position.ra : ((position.ra % 360) + 360) % 360,
    dec_deg: position.dec,
    fov_arcsec: 900,
  };
}
