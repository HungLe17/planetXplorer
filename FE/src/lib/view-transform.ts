export type Point = { x: number; y: number };
export type ViewTransform = Point & { scale: number };
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 32;

// Keep the image point beneath an anchor fixed while zooming. A second anchor
// includes the translation of a two-finger gesture's midpoint.
export function zoomAt(
  view: ViewTransform,
  scale: number,
  from: Point,
  to: Point = from,
): ViewTransform {
  const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
  const ratio = next / view.scale;
  return {
    scale: next,
    x: to.x - (from.x - view.x) * ratio,
    y: to.y - (from.y - view.y) * ratio,
  };
}
