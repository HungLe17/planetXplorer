import { useCallback, useMemo } from "react";
import { useAssets } from "./use-assets";
import type { Manifest } from "./types";
import { assetUrl } from "./api";
import {
  products,
  mapBounds,
  palette,
  renderProduct,
  frameAsset,
  imageTimeline,
  cycleSteps,
  archivedAt,
  grey,
  type Display,
  type Plane,
  type PixelQuality,
  type RenderedFrame,
} from "./imaging";

const empty: Manifest["frames"] = [];
async function fetchBytes(
  url: string,
  signal: AbortSignal,
  size: number,
  kind: string,
) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw Error(kind + " data could not be loaded.");
  const buffer = await response.arrayBuffer();
  if (!size || buffer.byteLength !== size)
    throw Error(kind + " data has unexpected dimensions.");
  return buffer;
}
export function useImages(manifest: Manifest | null, s: Display, raw: boolean) {
  const source = manifest?.frames ?? empty;
  const [height, width] = manifest?.processing?.output_shape ?? [0, 0];
  const count = width * height;
  const requests = useMemo(
    () =>
      source
        .filter((f) => f.pixels || f.quality)
        .map((f) => ({
          // Quality already carries the original brightness. Only legacy frames
          // without that sidecar need the separate resampled intensity payload.
          frame: f,
          pixels: f.quality ? "" : frameAsset(f, f.pixels!, assetUrl("/")),
          quality: f.quality ? frameAsset(f, f.quality, assetUrl("/")) : "",
        })),
    [source],
  );
  const numeric = requests.length > 0;
  const urls = useMemo(
    () => requests.map((r) => r.pixels).filter(Boolean),
    [requests],
  );
  const qualityUrls = useMemo(
    () => requests.map((r) => r.quality).filter(Boolean),
    [requests],
  );
  const load = useCallback(
    async (url: string, signal: AbortSignal) =>
      new Float32Array(await fetchBytes(url, signal, 4 * count, "Brightness")),
    [count],
  );
  const loadQuality = useCallback(
    async (url: string, signal: AbortSignal): Promise<PixelQuality> => {
      const b = await fetchBytes(url, signal, 9 * count, "Pixel quality");
      return {
        archived: new Float32Array(b, 0, count),
        flags: new Uint32Array(b, 4 * count, count),
        status: new Uint8Array(b, 8 * count, count),
      };
    },
    [count],
  );
  const { assets, version } = useAssets(urls, load);
  const { assets: quality, version: qualityVersion } = useAssets(
    qualityUrls,
    loadQuality,
  );
  const data = useMemo(
    () => requests.flatMap(({ frame, pixels, quality: q }): Plane[] => {
      const qdata = quality.get(q)?.value;
      const values = qdata?.archived ?? assets.get(pixels)?.value;
      return values ? [{ frame, values, quality: qdata }] : [];
    }),
    [requests, assets, quality, version, qualityVersion],
  );
  const maps = useMemo(
    () => products(data, s, manifest?.visits, raw),
    [data, s.maps, manifest?.visits, raw],
  );
  const steps = useMemo(() => cycleSteps(manifest), [manifest]);
  // A cycle waiting for map inputs can display its representative exposure.
  const result = useMemo(() => {
    if (raw || !steps.length) return maps;
    const mapped = new Set(maps.map(p => p.frame.observation_id));
    const fallback = new Set(steps.filter(step => !mapped.has(step.visit.id))
      .map(step => step.source.observation_id));
    return [...maps, ...products(data.filter(p => fallback.has(p.frame.observation_id)), s, [], true)];
  }, [maps, steps, raw, data, s.maps]);
  const rendered = useMemo<RenderedFrame[]>(
    () =>
      result.map((p) => {
        const scales = p.layers.map(({ map, values }) => ({
          name: map.name,
          stretch: map.stretch,
          stops: map.stops,
          bounds: mapBounds(values, map),
        }));
        const used = new Set(p.inputs.map((f) => f.observation_id));
        const bands = p.sourcePlanes.filter(
          (plane) => used.has(plane.frame.observation_id) && plane.quality,
        );
        const warnings: number[] = [];
        for (let i = 0; i < count; i++) {
          if (
            p.layers.some((l) => l.values[i] >= 0) &&
            bands.some(
              (b) =>
                b.quality &&
                ((b.quality.flags[i] & ~(1 << 21)) !== 0 ||
                  (b.quality.status[i] & 0x80) !== 0) &&
                !(archivedAt(b, i) < 0),
            )
          )
            warnings.push(i);
        }
        return {
          ...p.frame,
          canvas: renderProduct(p, width, height, scales),
          mapScales: scales,
          warningPixels: bands.length ? Uint32Array.from(warnings) : undefined,
          sourceDates: [
            ...new Set([...p.inputs, ...p.reference].map((f) => f.observed_at)),
          ].sort(),
        };
      }),
    [result, count, width, height],
  );
  const timeline = useMemo(
    () => imageTimeline(manifest, rendered, result, raw, steps),
    [manifest, rendered, result, raw, steps],
  );
  const failure =
    urls.map((u) => assets.get(u)?.error).find(Boolean) ||
    qualityUrls.map((u) => quality.get(u)?.error).find(Boolean);
  const settled =
    !numeric ||
    (urls.every((u) => assets.get(u)?.value || assets.get(u)?.error) &&
      qualityUrls.every(
        (u) => quality.get(u)?.value || quality.get(u)?.error,
      ));
  const colors = useMemo(() => palette(s.maps[0]?.stops ?? grey), [s.maps]);
  const invalid = s.maps.find(
    (m) => m.low !== "" && m.high !== "" && Number(m.low) > Number(m.high),
  );
  const message =
    failure ||
    (invalid ? "Minimum exceeds maximum for " + invalid.name + "." : "") ||
    (numeric && !result.length
      ? !settled
        ? "Loading calibrated brightness data…"
        : !s.maps.length
          ? "Add a map to display a visit."
          : "No visit has a usable combination for these map inputs. Browse exposures to inspect individual data."
      : !numeric && !raw && manifest?.visits?.length && source.length
        ? "Only preview images are available. Browse exposures to view them."
        : "");
  return {
    ...timeline,
    steps,
    data,
    numeric,
    bounds: rendered[0]?.mapScales?.[0]?.bounds ?? [0, 1],
    colors,
    message,
    width,
    height,
    failure,
    settled,
  };
}

/** Called by the mounted Details panel for the exposures in its spectrum. */
export function useSpectralPlanes(planes: Plane[], count: number) {
  const urls = useMemo(() => planes.map(({frame}) => frame.spectral
    ? frameAsset(frame, frame.spectral, assetUrl("/")) : ""), [planes]);
  const wanted = useMemo(() => urls.filter(Boolean), [urls]);
  const load = useCallback(async (url: string, signal: AbortSignal) => {
    const buffer = await fetchBytes(url, signal, 8 * count, "Wavelength");
    return {
      wavelengths: new Float32Array(buffer, 0, count),
      bandwidths: new Float32Array(buffer, 4 * count, count),
    };
  }, [count]);
  const { assets, version, retry } = useAssets(wanted, load);
  const measured = useMemo(() => planes.map((p, i) => {
    const wave = assets.get(urls[i])?.value;
    return wave ? { ...p, ...wave } : p;
  }), [planes, urls, assets, version]);
  const failed = wanted.filter(url => assets.get(url)?.error);
  return {
    planes: measured,
    loading: wanted.some(url => !assets.get(url)?.value && !assets.get(url)?.error),
    failed: failed.length,
    retry: () => failed.forEach(retry),
  };
}
