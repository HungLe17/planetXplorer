import { useEffect, useMemo, useState } from "react";
import type { Manifest } from "./types";
import {
  products,
  displayBounds,
  palette,
  renderProduct,
  previewScale,
  type Display,
  type Plane,
  type RenderedFrame,
} from "./imaging";
const empty: NonNullable<Manifest["frames"]> = [];
export function useImages(manifest: Manifest | null, s: Display) {
  const [loaded, setLoaded] = useState<{
    manifest: Manifest;
    data: Plane[];
  } | null>(null);
  const [failure, setFailure] = useState("");
  const source = manifest?.frames ?? empty;
  const numeric = source.length > 0 && source.every((f) => f.pixels);
  const [height, width] = manifest?.processing?.output_shape ?? [0, 0];
  useEffect(() => {
    setFailure("");
    setLoaded(null);
    if (!manifest || !numeric) return;
    const abort = new AbortController();
    Promise.all(
      source.map(async (frame) => {
        const r = await fetch(new URL(frame.pixels!, frame.url), {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]),
        });
        if (!r.ok) throw Error("Brightness data could not be loaded.");
        const buffer = await r.arrayBuffer();
        if (!width || !height || buffer.byteLength !== width * height * 4)
          throw Error("Brightness data has an unexpected size.");
        return { frame, values: new Float32Array(buffer) };
      }),
    )
      .then((data) => {
        if (!abort.signal.aborted) setLoaded({ manifest, data });
      })
      .catch((e) => {
        if (!abort.signal.aborted) setFailure(String(e.message));
      });
    return () => abort.abort();
  }, [manifest, numeric, source, width, height]);
  const result = useMemo(
    () =>
      loaded?.manifest === manifest && loaded ? products(loaded.data, s) : [],
    [
      loaded,
      manifest,
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
    [result, s.low, s.high],
  );
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
          ? result.map((p) => ({
              ...p.frame,
              sourceDates: [
                ...new Set(
                  [...p.inputs, ...p.reference].map((f) => f.observed_at),
                ),
              ].sort(),
              url: renderProduct(p, width, height, s, bounds, colors),
            }))
          : previews,
    [
      numeric,
      validBounds,
      result,
      width,
      height,
      s.stretch,
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
    (numeric && loaded?.manifest === manifest && !result.length
      ? s.mode === "rgb"
        ? "Select three distinct wavelengths and their exposures for a static RGB image."
        : "No complete combination for this band selection and time window."
      : "");
  return { frames, result, numeric, bounds, colors, message, width, height };
}
