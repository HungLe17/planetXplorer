import { useCallback, useMemo } from "react";
import { useAssets } from "./use-assets";
import type { Manifest } from "./types";
import {
  products,
  bandWarning,
  pixelVisible,
  displayBounds,
  palette,
  renderProduct,
  previewScale,
  type Display,
  type Plane,
  type PixelQuality,
  type RenderedFrame,
} from "./imaging";
const empty: NonNullable<Manifest["frames"]> = [];
export function useImages(manifest: Manifest | null, s: Display) {
  const source = manifest?.frames ?? empty;
  const numeric = source.length > 0 && source.every((f) => f.pixels);
  const [height, width] = manifest?.processing?.output_shape ?? [0, 0];
  const urls = useMemo(
    () => (numeric ? source.map((f) => new URL(f.pixels!, f.url).href) : []),
    [source, numeric],
  );
  const load = useCallback(
    async (url: string, signal: AbortSignal) => {
      const r = await fetch(url, { signal });
      if (!r.ok) throw Error("Brightness data could not be loaded.");
      const buffer = await r.arrayBuffer();
      if (!width || !height || buffer.byteLength !== width * height * 4)
        throw Error("Brightness data has an unexpected size.");
      return new Float32Array(buffer);
    },
    [width, height],
  );
  const { assets, version } = useAssets(urls, load);
  const qualityUrls = useMemo(
    () => source.map((f) => numeric && f.quality ? new URL(f.quality, f.url).href : ""),
    [source, numeric],
  );
  const qualityRequests = useMemo(() => qualityUrls.filter(Boolean), [qualityUrls]);
  const loadQuality = useCallback(
    async (url: string, signal: AbortSignal): Promise<PixelQuality> => {
      const response = await fetch(url, { signal });
      if (!response.ok) throw Error("Pixel quality data could not be loaded.");
      const buffer = await response.arrayBuffer();
      const count = width * height;
      if (!count || buffer.byteLength !== count * 9)
        throw Error("Pixel quality data has an unexpected size.");
      return {
        archived: new Float32Array(buffer, 0, count),
        flags: new Uint32Array(buffer, count * 4, count),
        status: new Uint8Array(buffer, count * 8, count),
      };
    },
    [width, height],
  );
  const { assets: qualityAssets, version: qualityVersion } = useAssets(qualityRequests, loadQuality);
  const data = useMemo(
    () =>
      urls.flatMap((url, i): Plane[] => {
        const values = assets.get(url)?.value;
        const quality = qualityAssets.get(qualityUrls[i])?.value;
        return values && (!qualityUrls[i] || quality) ? [{ frame: source[i], values, quality }] : [];
      }),
    [urls, assets, version, source, qualityUrls, qualityAssets, qualityVersion],
  );
  const failure = urls.map((url) => assets.get(url)?.error).find(Boolean)
    || qualityRequests.map((url) => qualityAssets.get(url)?.error).find(Boolean);
  const result = useMemo(
    () => products(data, s),
    [
      data,
      s.mode,
      s.rgb,
      s.operands,
      s.difference,
      s.windowDays,
      s.exclusionDays,
    ],
  );
  const bounds = useMemo(
    () => displayBounds(result, s),
    [result, s.low, s.high, s.inspectFlagged],
  );
  const warningPixels = useMemo(() => result.map((p) => {
    const bands = p.sourcePlanes;
    if (!bands?.some((band) => band.quality)) return undefined;
    const pixels: number[] = [];
    for (let i = 0; i < width * height; i++) {
      if (bands.some((band) => band.quality && bandWarning(band.quality, i, s.inspectFlagged))
        && pixelVisible(p, i, s.inspectFlagged)) pixels.push(i);
    }
    return Uint32Array.from(pixels);
  }), [result, width, height, s.inspectFlagged]);
  const colors = useMemo(() => palette(s.stops), [s.stops]);
  const previews = useMemo<RenderedFrame[]>(() => {
    if (!manifest || numeric) return empty;
    const scale = previewScale(manifest);
    return source.map((frame) => ({ ...frame, previewScale: scale }));
  }, [manifest, numeric, source]);
  const validBounds = bounds[1] >= bounds[0];
  const frames = useMemo<RenderedFrame[]>(
    () =>
      numeric && !validBounds
        ? empty
        : numeric
          ? result.map((p, i) => ({
              ...p.frame,
              warningPixels: warningPixels[i],
              sourceDates: [
                ...new Set(
                  [...p.inputs, ...p.reference].map((f) => f.observed_at),
                ),
              ].sort(),
              canvas: renderProduct(p, width, height, s, bounds, colors),
            }))
          : previews,
    [
      numeric,
      validBounds,
      result,
      width,
      height,
      s.stretch,
      s.inspectFlagged,
      warningPixels,
      bounds,
      colors,
      previews,
    ],
  );
  const message =
    failure ||
    (numeric && !validBounds
      ? "Minimum brightness must be at or below maximum brightness."
      : "") ||
    (numeric && data.length < urls.length && !result.length
      ? "Loading calibrated brightness data…"
      : "") ||
    (numeric && data.length === urls.length && !result.length
      ? s.mode === "rgb"
        ? "Select three distinct wavelengths and their exposures for a static RGB image."
        : "No complete combination for this band selection and time window."
      : "");
  const settled =
    !numeric ||
    (urls.every((url) => assets.get(url)?.value || assets.get(url)?.error)
      && qualityRequests.every((url) => qualityAssets.get(url)?.value || qualityAssets.get(url)?.error));
  return {
    frames,
    result,
    numeric,
    bounds,
    colors,
    message,
    width,
    height,
    failure,
    settled,
  };
}
