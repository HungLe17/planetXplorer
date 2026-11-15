import { useCallback, useMemo } from "react";
import { useAssets } from "./use-assets";
import type { Frame, Manifest, Query } from "./types";
import { assetUrl } from "./api";
import {
  products,
  cycleDifferences,
  mapBounds,
  isSignedMap,
  palette,
  renderProduct,
  frameAsset,
  imageTimeline,
  motionSelection,
  matchesChannel,
  responseKey,
  pixelFlagMarkers,
  grey,
  type Display,
  type CycleInput,
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
export function useImages(manifest: Manifest | null, s: Display, browse: boolean, choices: Record<string, boolean>, query: Query | null,
  referenceId: string | null = null, matchedSteps?: CycleInput[],
  automaticMap = false) {
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
  const eligibleFrames = useMemo(() => source.filter(f => {
    if (choices[f.observation_id] === false ||
        (query?.detectors && !query.detectors.some(det => det === f.detector))) return false;
    const labels = Object.entries(query?.channels ?? {}).find(([det]) => det === f.detector)?.[1];
    return !labels?.length || labels.some(key => matchesChannel(key, f));
  }), [source, choices, query]);
  const selectedData = useMemo(() => {
    const ids = new Set(eligibleFrames.map(f => f.observation_id));
    return data.filter(p => ids.has(p.frame.observation_id));
  }, [data, eligibleFrames]);
  const fullCycles = useMemo<CycleInput[]>(() => {
    const byId = new Map(eligibleFrames.map(f => [f.observation_id, f]));
    return (manifest?.visits ?? []).flatMap(visit => {
      if (visit.kind === "supplemental" || visit.status === "invalid") return [];
      const groups = new Map<string, Frame[]>();
      for (const id of visit.observation_ids) {
        const f = byId.get(id);
        if (!f) continue;
        const key = JSON.stringify([f.detector, f.nominal_channel ?? plan.responseKeys.get(id) ?? f.sequence_id ?? id]);
        const group = groups.get(key) ?? [];
        group.push(f); groups.set(key, group);
      }
      const members = [...groups.values()].flatMap(group => {
        const explicit = group.filter(f => choices[f.observation_id] === true);
        return explicit.length ? explicit :
          [group.find(f => plan.includedIds.has(f.observation_id)) ?? group[0]];
      });
      return members.length ? [{ visit, members, source: members[0] }] : [];
    });
  }, [eligibleFrames, manifest?.visits, choices, plan]);
  const cycleData = useMemo(() => {
    const ids = new Set(fullCycles.flatMap(step => step.members.map(f => f.observation_id)));
    return selectedData.filter(p => ids.has(p.frame.observation_id));
  }, [fullCycles, selectedData]);
  const differenceSteps = useMemo(() => {
    if (!matchedSteps) return fullCycles;
    const byId = new Map(eligibleFrames.map(f => [f.observation_id, f]));
    return matchedSteps.map(step => {
      const repeats = new Set(step.members.map(f => f.observation_id));
      const peers = step.visit.observation_ids.flatMap(id => {
        const frame = byId.get(id);
        return frame && !repeats.has(id) ? [frame] : [];
      });
      return { ...step, members: [step.source, ...peers] };
    });
  }, [matchedSteps, fullCycles, eligibleFrames]);
  const difference = useMemo(() => referenceId === null || browse ? null :
    cycleDifferences(selectedData, differenceSteps, s.maps, referenceId, automaticMap,
      manifest?.processing?.spectral_tolerance ?? 0.5),
    [selectedData, differenceSteps, s.maps, referenceId, browse, automaticMap, manifest?.processing?.spectral_tolerance]);
  const series = useMemo(() => {
    // Keep all requested wavelengths, with one automatic representative per
    // spectrum and cycle. Explicit checklist choices can include repeats.
    const maps = !manifest?.visits?.length ? [] :
      products(cycleData, s, manifest.visits, automaticMap ? "available" : false);
    const byVisit = new Map(maps.map(map => [map.frame.observation_id, map]));
    const groups = new Map<string, typeof plan.steps>();
    const reasons = new Map(plan.reasons);
    const responses = (frames: Frame[]) => frames.map(f => plan.responseKeys.get(f.observation_id) ?? responseKey(f)).sort();
    for (const step of plan.steps) {
      const map = byVisit.get(step.visit.id);
      const complete = map && map.layers.length === s.maps.length &&
        step.members.every(f => map.inputs.some(input => input.observation_id === f.observation_id));
      // Include primary and reference multiplicities. A sum of two frames or
      // a partial difference map cannot be compared with a one-frame product.
      let signature: string;
      if (complete) signature = JSON.stringify([responses(map.inputs), responses(map.reference)]);
      else if (step.members.length === 1 && !numeric) signature = "preview";
      else {
        reasons.set(step.visit.id, "Waiting for comparable map inputs");
        continue;
      }
      const group = groups.get(signature) ?? [];
      group.push(map ? { ...step, members: map.inputs } : step);
      groups.set(signature, group);
    }
    const pins = (group: typeof plan.steps) => group.filter(step => step.members.some(f => choices[f.observation_id])).length;
    const span = (group: typeof plan.steps) => Date.parse(group.at(-1)!.visit.end_utc) - Date.parse(group[0].visit.start_utc);
    const ordered = [...groups].sort(([a, x], [b, y]) => pins(y)-pins(x) || y.length-x.length ||
      span(y)-span(x) || Number(a === "preview") - Number(b === "preview"));
    const steps = ordered[0]?.[1] ?? [];
    for (const [,group] of ordered.slice(1)) for (const step of group)
      reasons.set(step.visit.id, "Different map inputs or calibration pending");
    const includedIds = new Set(steps.flatMap(step => step.members.map(f => f.observation_id)));
    const frameReasons = new Map(plan.frameReasons);
    for (const step of plan.steps) if (reasons.has(step.visit.id))
      for (const f of step.members) frameReasons.set(f.observation_id, reasons.get(step.visit.id)!);
    return {steps, allMapped: maps, includedIds, frameReasons, reasons};
  }, [plan, cycleData, s.maps, manifest?.visits, choices, automaticMap, numeric]);
  // A single pending exposure can paint immediately, including from a legacy
  // manifest without spectral matching. It never becomes a second motion step.
  const shown = useMemo(() => series.steps.length ? series.steps : plan.preview ? [plan.preview] : [], [series.steps, plan.preview]);
  const result = useMemo(() => {
    if (difference) return difference.products;
    if (matchedSteps) return products(selectedData, s, manifest?.visits, automaticMap ? "available" : false, matchedSteps);
    if (browse || !manifest?.visits?.length) return products(data, s, manifest?.visits, "mapped");
    const visible = new Set(shown.map(step => step.visit.id));
    const mapped = series.allMapped.filter(p => visible.has(p.frame.observation_id));
    const represented = new Set(mapped.map(p => p.frame.observation_id));
    const fallback = new Set(shown.filter(step => !represented.has(step.visit.id)).map(step => step.source.observation_id));
    return [...mapped, ...products(data.filter(p => fallback.has(p.frame.observation_id)), s, [], "mapped")];
  }, [difference, series.allMapped, shown, browse, data, selectedData, s.maps, manifest?.visits, matchedSteps, automaticMap]);
  const rendered = useMemo<RenderedFrame[]>(
    () =>
      result.map((p) => {
        const scales = p.layers.map(({ map, values }) => ({
          name: map.name,
          stretch: map.stretch,
          stops: map.stops,
          bounds: p.subtraction && difference ? difference.boundsByMap.get(map.id) ?? difference.bounds : mapBounds(values, map),
          signed: !!p.subtraction || isSignedMap(map),
        }));
        return {
          ...p.frame,
          matchedMap:p.matchedMap,
          subtraction: p.subtraction,
          canvas: renderProduct(p, width, height, scales),
          mapScales: scales,
          ...pixelFlagMarkers(p, count, data),
          sourceDates: [
            ...new Set([...p.inputs, ...p.reference].map((f) => f.observed_at)),
          ].sort(),
        };
      }),
    [result, difference, data, count, width, height],
  );
  const timeline = useMemo(
    () => imageTimeline(manifest, rendered, result, browse, difference?.steps ?? shown),
    [manifest, rendered, result, browse, shown, difference],
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
    (difference && !difference.products.length ? difference.reason || "Subtraction needs two calibrated cycles with matching wavelengths and overlapping measured pixels. Choose a reference or return to Visits to inspect exposures." : "") ||
    (invalid ? "Minimum exceeds maximum for " + invalid.name + "." : "") ||
    (numeric && !result.length
      ? !settled
        ? "Loading calibrated brightness data…"
        : !s.maps.length
          ? "Add a map to display a visit."
          : "No visit has a usable combination for these map inputs. Browse exposures to inspect individual data."
      : !numeric && !browse && manifest?.visits?.length && source.length
        ? "Only preview images are available. Browse exposures to view them."
        : "");
  return {
    ...timeline,
    steps:difference?.steps ?? series.steps,
    difference,
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
