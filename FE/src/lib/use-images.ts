import { useCallback, useMemo } from "react";
import { useAssets } from "./use-assets";
import type { Frame, Manifest, Query } from "./types";
import { assetUrl } from "./api";
import {
  products,
  cycleDifferences,
  mapBounds,
  palette,
  renderProduct,
  frameAsset,
  imageTimeline,
  motionSelection,
  responseKey,
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
export function useImages(manifest: Manifest | null, s: Display, raw: boolean, choices: Record<string, boolean>, query: Query | null,
  referenceId: string | null = null, differenceMapId = "") {
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
  const plan = useMemo(() => motionSelection(manifest, s, choices, query), [manifest, s.maps, choices, query]);
  const differenceMaps = plan.nativeMap ? [plan.nativeMap] : plan.raw ? [] : s.maps;
  const differenceMap = differenceMaps.find(m => m.id === differenceMapId) ?? differenceMaps[0];
  const difference = useMemo(() => referenceId === null || raw ? null :
    cycleDifferences(data, plan.steps, differenceMap, referenceId), [data, plan, differenceMap, referenceId, raw]);
  const series = useMemo(() => {
    const selected = data.filter(p => plan.includedIds.has(p.frame.observation_id));
    const style = plan.nativeMap ? {...s, maps:[plan.nativeMap]} : s;
    const maps = plan.raw || !manifest?.visits?.length ? [] : products(selected, style, manifest.visits);
    const byVisit = new Map(maps.map(map => [map.frame.observation_id, map]));
    const groups = new Map<string, typeof plan.steps>();
    const reasons = new Map(plan.reasons);
    const responses = (frames: Frame[]) => frames.map(responseKey).sort();
    for (const step of plan.steps) {
      const map = byVisit.get(step.visit.id);
      const complete = map && map.layers.length === style.maps.length &&
        step.members.every(f => map.inputs.some(input => input.observation_id === f.observation_id));
      // Include primary and reference multiplicities. A sum of two frames or
      // a partial difference map cannot be compared with a one-frame product.
      let signature: string;
      if (complete) signature = JSON.stringify([responses(map.inputs), responses(map.reference)]);
      else if (step.members.length === 1 && (plan.raw || (style.maps.length === 1 && !style.maps[0].difference &&
        Object.keys(style.maps[0].operands).length === 1))) signature = "raw";
      else {
        reasons.set(step.visit.id, "Waiting for comparable map inputs");
        continue;
      }
      const group = groups.get(signature) ?? [];
      group.push(step);
      groups.set(signature, group);
    }
    const pins = (group: typeof plan.steps) => group.filter(step => step.members.some(f => choices[f.observation_id])).length;
    const span = (group: typeof plan.steps) => Date.parse(group.at(-1)!.visit.end_utc) - Date.parse(group[0].visit.start_utc);
    const ordered = [...groups].sort(([a, x], [b, y]) => pins(y)-pins(x) || y.length-x.length ||
      span(y)-span(x) || Number(a === "raw") - Number(b === "raw"));
    const [signature, steps] = ordered[0] ?? ["", [] as typeof plan.steps];
    for (const [,group] of ordered.slice(1)) for (const step of group)
      reasons.set(step.visit.id, "Different map inputs or calibration pending");
    const includedIds = new Set(steps.flatMap(step => step.members.map(f => f.observation_id)));
    const frameReasons = new Map(plan.frameReasons);
    for (const step of plan.steps) if (reasons.has(step.visit.id))
      for (const f of step.members) frameReasons.set(f.observation_id, reasons.get(step.visit.id)!);
    const mapped = signature !== "raw" ? steps.flatMap(step => byVisit.get(step.visit.id) ?? []) : [];
    return {steps, mapped, includedIds, frameReasons, reasons};
  }, [plan, data, s.maps, manifest?.visits, choices]);
  // A single pending exposure can paint immediately, including from a legacy
  // manifest without spectral matching. It never becomes a second motion step.
  const shown = useMemo(() => series.steps.length ? series.steps : plan.preview ? [plan.preview] : [], [series.steps, plan.preview]);
  const result = useMemo(() => {
    if (difference) return difference.products;
    if (raw || !manifest?.visits?.length) return products(data, s, manifest?.visits, true);
    const mapped = series.mapped;
    const represented = new Set(mapped.map(p => p.frame.observation_id));
    const fallback = new Set(shown.filter(step => !represented.has(step.visit.id)).map(step => step.source.observation_id));
    return [...mapped, ...products(data.filter(p => fallback.has(p.frame.observation_id)), s, [], true)];
  }, [difference, series.mapped, shown, raw, data, s.maps, manifest?.visits]);
  const rendered = useMemo<RenderedFrame[]>(
    () =>
      result.map((p) => {
        const scales = p.layers.map(({ map, values }) => ({
          name: map.name,
          stretch: map.stretch,
          stops: map.stops,
          bounds: p.subtraction && difference ? difference.bounds : mapBounds(values, map),
          signed: !!p.subtraction,
        }));
        const used = new Set([...p.inputs, ...(p.subtraction ? p.reference : [])].map((f) => f.observation_id));
        const bands = p.sourcePlanes.filter(
          (plane) => used.has(plane.frame.observation_id) && plane.quality,
        );
        const warnings: number[] = [];
        for (let i = 0; i < count; i++) {
          if (
            p.layers.some((l) => p.subtraction ? Number.isFinite(l.values[i]) : l.values[i] >= 0) &&
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
          subtraction: p.subtraction,
          canvas: renderProduct(p, width, height, scales),
          mapScales: scales,
          warningPixels: bands.length ? Uint32Array.from(warnings) : undefined,
          sourceDates: [
            ...new Set([...p.inputs, ...p.reference].map((f) => f.observed_at)),
          ].sort(),
        };
      }),
    [result, difference, count, width, height],
  );
  const timeline = useMemo(
    () => imageTimeline(manifest, rendered, result, raw, difference?.steps ?? shown),
    [manifest, rendered, result, raw, shown, difference],
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
    (difference && !difference.products.length ? "Subtraction needs two calibrated cycles with matching wavelengths and overlapping measured pixels. Choose a reference or return to Visits to inspect exposures." : "") ||
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
    steps:difference?.steps ?? series.steps,
    difference, differenceMaps, differenceMap,
    includedIds:series.includedIds,
    reasons:series.reasons,
    frameReasons:series.frameReasons,
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
