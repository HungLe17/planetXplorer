import type { Detector, Frame, Query, Manifest, Sequence, Visit } from "./types";

export type Stop = { at: number; color: string };
export const grey = [
  { at: 0, color: "#000000" },
  { at: 1, color: "#ffffff" },
];
export const thermal = [
  { at: 0, color: "#080423" },
  { at: 0.36, color: "#772b83" },
  { at: 0.72, color: "#f36829" },
  { at: 1, color: "#ffffc8" },
];
export const detectors: Detector[] = ["D1", "D2", "D3", "D4", "D5", "D6"];
export const stretches = ["linear", "sqrt", "log", "asinh"];
export type SpectralMap = {
  id: string;
  name: string;
  operands: Record<string, number>;
  stops: Stop[];
  stretch: string;
  low: string;
  high: string;
  difference: boolean;
  windowDays: number;
  exclusionDays: number;
};
export function newMap(id: string, name: string): SpectralMap {
  return {
    id,
    name,
    operands: { D1: 1 },
    stops: grey,
    stretch: "asinh",
    low: "",
    high: "",
    difference: false,
    windowDays: 182.625,
    exclusionDays: 365.25,
  };
}
export const defaults = {
  // These scalar settings are read from version-one workspaces and share URLs.
  stretch: "asinh",
  low: "",
  high: "",
  stops: grey,
  mode: "single",
  operands: {} as Record<string, number>,
  rgb: ["", "", ""],
  difference: false,
  windowDays: 182.625,
  exclusionDays: 365.25,
  zoom: 1,
  panX: 0,
  panY: 0,
  invert: false,
  speed: 1,
  coords: false,
  legend: false,
  inspectFlagged: false,
  markFlagged: true,
  prefetchBands: false,
  maps: [newMap("map-1", "Map 1")],
};
export type Display = typeof defaults;
export function readMaps(value: unknown, legacy: Display): SpectralMap[] {
  if (value === undefined) {
    const map = {
      ...newMap("map-1", "Map 1"),
      stretch: legacy.stretch,
      low: legacy.low,
      high: legacy.high,
      stops: legacy.stops,
      difference: legacy.difference,
      windowDays: legacy.windowDays,
      exclusionDays: legacy.exclusionDays,
    };
    if (legacy.mode === "rgb")
      return ["Red", "Green", "Blue"].map((name, i) => ({
        ...map,
        id: "rgb-" + i,
        name,
        difference: false,
        operands: legacy.rgb[i] ? { ["exposure:" + legacy.rgb[i]]: 1 } : {},
        stops: [
          grey[0],
          { at: 1, color: ["#ff0000", "#00ff00", "#0000ff"][i] },
        ],
      }));
    return [
      {
        ...map,
        operands: Object.keys(legacy.operands).length
          ? legacy.operands
          : map.operands,
      },
    ];
  }
  if (!Array.isArray(value)) throw Error("Invalid map list.");
  const ids = new Set<string>();
  return value.map((row) => {
    if (
      !row ||
      typeof row !== "object" ||
      typeof row.id !== "string" ||
      !row.id ||
      ids.has(row.id) ||
      typeof row.name !== "string" ||
      !row.operands ||
      typeof row.operands !== "object" ||
      Array.isArray(row.operands) ||
      !Object.entries(row.operands).every(
        ([key, sign]) => key.length && (sign === 1 || sign === -1),
      ) ||
      !stretches.includes(row.stretch) ||
      typeof row.difference !== "boolean" ||
      ![row.windowDays, row.exclusionDays].every(
        (n) => Number.isFinite(n) && n >= 0 && n <= 1e6,
      ) ||
      ![row.low, row.high].every(
        (n) => typeof n === "string" && Number.isFinite(Number(n)),
      ) ||
      !Array.isArray(row.stops) ||
      row.stops.length < 2 ||
      row.stops.length > 32 ||
      !row.stops.every(
        (s: Stop) =>
          s &&
          Number.isFinite(s.at) &&
          s.at >= 0 &&
          s.at <= 1 &&
          typeof s.color === "string" &&
          /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s.color),
      )
    )
      throw Error("Invalid map settings.");
    ids.add(row.id);
    return {
      id: row.id,
      name: row.name,
      operands: { ...row.operands },
      stops: row.stops.map((s: Stop) => ({ ...s })),
      stretch: row.stretch,
      low: row.low,
      high: row.high,
      difference: row.difference,
      windowDays: row.windowDays,
      exclusionDays: row.exclusionDays,
    };
  });
}
function detectorFor(key: string): Detector | undefined {
  return key.match(/^(D[1-6])(?:\s|-(?:0[1-9]|1[0-7])$|$)/)?.[1] as Detector | undefined;
}
export function activeDetectors(s: Display): Detector[] {
  const selected = new Set<Detector>();
  for (const map of s.maps)
    for (const key of Object.keys(map.operands)) {
      const det = detectorFor(key);
      if (det) selected.add(det);
    }
  return detectors.filter((d) => selected.has(d));
}
export function activeChannels(
  s: Display,
): Partial<Record<Detector, string[]>> {
  const keys = [...new Set(s.maps.flatMap((m) => Object.keys(m.operands)))];
  const result: Partial<Record<Detector, string[]>> = {};
  for (const det of detectors) {
    const matching = keys.filter((k) => detectorFor(k) === det);
    if (matching.length && !matching.includes(det)) result[det] = matching;
  }
  return result;
}
export type PixelQuality = {
  archived: Float32Array;
  flags: Uint32Array;
  status: Uint8Array;
};
export type Plane = {
  frame: Frame;
  values: Float32Array;
  quality?: PixelQuality;
  wavelengths?: Float32Array;
  bandwidths?: Float32Array;
};
export type Product = {
  frame: Frame;
  layers: { map: SpectralMap; values: Float32Array }[];
  sourcePlanes: Plane[];
  inputs: Frame[];
  reference: Frame[];
  subtraction?: { referenceId: string; referenceDate: string };
};
export type PreviewScale = { bounds: number[]; stretch: string; units: string };
export type MapScale = {
  name: string;
  stops: Stop[];
  bounds: number[];
  stretch: string;
  signed?: boolean;
};
export type RenderedFrame = Frame & {
  subtraction?: Product["subtraction"];
  canvas?: HTMLCanvasElement;
  sourceDates?: string[];
  previewScale?: PreviewScale;
  warningPixels?: Uint32Array;
  mapScales?: MapScale[];
};
export function frameAsset(frame: Frame, path: string, base: string) {
  const url = new URL(path, new URL(frame.url, base));
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw Error("Unsupported image address.");
  return url.href;
}
type CycleStep = { visit: Visit; source: Frame };
type CycleInput = CycleStep & { members: Frame[] };

function spacedSteps(available: CycleInput[], choices: Record<string, boolean>, minimumDays?: number) {
  if (!minimumDays || available.length < 2) return available;
  const minGap = minimumDays * 86400000;
  const retained = new Set(available.filter(c => c.members.some(f => choices[f.observation_id])));
  for (const c of [available[0], available.at(-1)!, ...available.slice(1,-1)]) {
    if ([...retained].every(other => Math.abs(Date.parse(c.source.observed_at) -
      Date.parse(other.source.observed_at)) >= minGap)) retained.add(c);
  }
  return available.filter(c => retained.has(c));
}

/** Matched uses the archive's calibrated sequence even when no composite visit map can be made. */
export function matchedEpochs(manifest: Manifest, sequence: Sequence, visits: Map<string, Visit>,
  choices: Record<string, boolean>, minimumDays?: number): CycleInput[] {
  const ids = new Set(sequence.frame_ids);
  const frames = manifest.frames.filter(f => ids.has(f.id) &&
    choices[f.observation_id] !== false && Number.isFinite(Date.parse(f.observed_at)))
    .sort((a,b) => Date.parse(a.observed_at) - Date.parse(b.observed_at) || a.observation_id.localeCompare(b.observation_id));
  const groups = new Map<string, CycleInput>();
  let legacy: Visit | undefined, lastLegacy = -Infinity;
  for (const f of frames) {
    let visit = visits.get(f.observation_id);
    if (!visit) {
      // Prepared manifests may predate visit IDs. Mirror the archive's 14-day gap
      // for these raw epochs, without exposing them as verified visit maps.
      const stamp = Date.parse(f.observed_at);
      if (!legacy || (f.visit_id && f.visit_id !== legacy.id) || stamp - lastLegacy > 14 * 86400000)
        legacy = {id:f.visit_id || f.observation_id, start_utc:f.observed_at, end_utc:f.observed_at,
          observation_ids:[], status:"pending", issues:[]};
      legacy.end_utc = f.observed_at;
      legacy.observation_ids.push(f.observation_id);
      lastLegacy = stamp;
      visit = legacy;
    }
    const step = groups.get(visit.id);
    if (step) {
      step.members.push(f);
      if (choices[f.observation_id] && !choices[step.source.observation_id]) step.source = f;
    } else groups.set(visit.id, {visit, source:f, members:[f]});
  }
  return spacedSteps([...groups.values()], choices, minimumDays);
}

/** Sequence IDs are assigned by the backend's pairwise five-position wavelength check.
 * An older frame without a sequence can be inspected, but can't establish a match. */
export function responseKey(frame: Frame) {
  return frame.sequence_id && frame.processing_version !== "unknown"
    ? JSON.stringify([frame.detector, frame.nominal_channel ?? null, frame.processing_version ?? "", frame.sequence_id])
    : JSON.stringify([frame.observation_id]);
}

type MotionOperand = {accepts:(f: Frame) => boolean; pinned:Set<string>};

/** Choose the common epochs for the complete image. Choosing each map input
 * independently can leave one epoch when a different pair of responses spans years. */
function commonResponses(cycles: CycleInput[], operands: MotionOperand[], singleExposure: boolean) {
  const options = operands.map(({accepts, pinned}) => {
    const coverage = new Map<string, Set<string>>();
    for (const c of cycles) for (const f of c.members.filter(accepts)) {
      const key = responseKey(f);
      if (!coverage.has(key)) coverage.set(key, new Set());
      coverage.get(key)!.add(c.visit.id);
    }
    const keys = pinned.size ? [...pinned] : [...coverage.keys()].sort();
    const alternatives = pinned.size && !singleExposure ? [keys] : keys.map(key => [key]);
    return alternatives.map(keys => ({
      keys, visits:new Set(cycles.filter(c => keys.every(key => coverage.get(key)?.has(c.visit.id))).map(c => c.visit.id)),
    })).filter(option => option.visits.size);
  }).sort((a,b) => a.length-b.length);

  const span = (cs: CycleInput[]) => cs.length ? Date.parse(cs.at(-1)!.visit.end_utc) - Date.parse(cs[0].visit.start_utc) : 0;
  let best: CycleInput[] = [], keys: string[] = [];
  function search(index: number, remaining: CycleInput[], selected: string[]) {
    if (remaining.length < best.length || (remaining.length === best.length && span(remaining) <= span(best))) return;
    if (index === options.length) {
      best = remaining;
      keys = selected;
      return;
    }
    const narrowed = options[index].map(option => ({
      keys:option.keys, visits:remaining.filter(c => option.visits.has(c.visit.id)),
    })).sort((a,b) => b.visits.length-a.visits.length || span(b.visits)-span(a.visits));
    const seen = new Set<string>();
    for (const option of narrowed) {
      if (!option.visits.length || option.visits.length < best.length) break;
      const signature = JSON.stringify(option.visits.map(c => c.visit.id));
      if (seen.has(signature)) continue;
      seen.add(signature);
      search(index + 1, option.visits, [...selected, ...option.keys]);
      if (best.length === remaining.length) break;
    }
  }
  search(0, cycles, []);
  return {candidates:best, selectedKeys:new Set(keys)};
}

export function motionSelection(manifest: Manifest | null, display: Display,
  choices: Record<string, boolean>, query: Query | null) {
  const reasons = new Map<string, string>();
  const frameReasons = new Map<string, string>();
  const allowed = (frame: Frame) => {
    const detector = frame.detector as Detector;
    const labels = query?.channels?.[detector];
    return (!query?.detectors || query.detectors.includes(detector)) &&
      (!labels?.length || labels.some(label => matchesChannel(label, frame)));
  };
  const byId = new Map(manifest?.frames.filter(allowed).map(f => [f.observation_id, f]));
  const order = new Map(manifest?.processing?.sampling_order?.map((id,i) => [id,i]));
  const cycles: CycleInput[] = [];
  for (const visit of manifest?.visits ?? []) {
    if (visit.kind === "supplemental" || visit.status === "invalid") continue;
    const members = visit.observation_ids.flatMap(id => {
      const frame = byId.get(id);
      return frame && choices[id] !== false ? [frame] : [];
    }).sort((a,b) => (order.get(a.observation_id) ?? Infinity) - (order.get(b.observation_id) ?? Infinity) ||
      Date.parse(a.observed_at) - Date.parse(b.observed_at) ||
      a.observation_id.localeCompare(b.observation_id));
    reasons.set(visit.id, members.length ? "No comparable exposure" : "No included exposure available");
    if (members.length) cycles.push({visit, members, source:members[0]});
  }
  cycles.sort((a,b) => Date.parse(a.visit.start_utc) - Date.parse(b.visit.start_utc));
  const chosen = cycles.flatMap(c => c.members.filter(f => choices[f.observation_id]));
  const mapKeys = [...new Set(display.maps.flatMap(map => Object.keys(map.operands)))];
  const inMap = (f: Frame) => mapKeys.some(key => matchesChannel(key, f));
  // For example, a D6-only search can still compare its D6 exposures when the
  // default D1 map is selected. Keep its image labeled as an individual exposure.
  const raw = !!chosen.some(f => !inMap(f)) || !cycles.some(c => c.members.some(inMap));
  const nativeOperands = [...new Set([...Object.values(query?.channels ?? {}).flat(), ...chosen.map(f => f.channel || f.detector)])];
  const nativeMap = raw && nativeOperands.length > 1 ? {
    ...newMap("timeline-selection", "Selected wavelengths"),
    operands:Object.fromEntries(nativeOperands.map(key => [key, 1]))
  } : null;
  const keys = raw ? (nativeMap ? nativeOperands : [""]) : mapKeys.flatMap(key => {
    const labels = query?.channels?.[key as Detector];
    return labels?.length ? labels : [key];
  });
  const operands = keys.map(key => {
    const accepts = (f: Frame) => !key || matchesChannel(key, f);
    const pinned = new Set(chosen.filter(accepts).map(responseKey));
    return {accepts, pinned};
  });
  const {candidates, selectedKeys} = commonResponses(cycles, operands, raw && !nativeMap);
  const available: CycleInput[] = [];
  const includedIds = new Set<string>();
  for (const cycle of candidates) {
    const members: Frame[] = [];
    for (const key of selectedKeys) {
      const matches = cycle.members.filter(f => responseKey(f) === key);
      const manual = matches.filter(f => choices[f.observation_id]);
      if (matches.length) members.push(...(manual.length ?
        (raw && !nativeMap ? manual.slice(0,1) : manual) : [matches[0]]));
    }
    if (!members.length) continue;
    available.push({...cycle, members, source:members[0]});
  }
  // Explicit choices take precedence. Auto reserves the endpoints, then fills
  // interior gaps like the download scheduler. Return steps in time order.
  const steps = spacedSteps(available, choices, query?.min_separation_days);
  const retained = new Set(steps);
  for (const c of available) {
    if (!retained.has(c)) reasons.set(c.visit.id, "Inside the selected sampling interval");
    else {
      reasons.delete(c.visit.id);
      for (const f of c.members) includedIds.add(f.observation_id);
    }
  }
  for (const c of cycles) for (const f of c.members) {
    if (!includedIds.has(f.observation_id)) frameReasons.set(f.observation_id,
      reasons.get(c.visit.id) ?? (selectedKeys.has(responseKey(f)) ? "Repeat of this wavelength" : "Different wavelength sequence"));
  }
  return {steps, includedIds, reasons, frameReasons, raw:raw && !nativeMap, nativeMap, preview:cycles[0]};
}
export function imageTimeline(
  manifest: Manifest | null,
  rendered: RenderedFrame[],
  products: Product[],
  raw: boolean,
  steps: CycleStep[] = motionSelection(manifest, defaults, {}, null).steps,
) {
  if (!manifest) return { frames: rendered, result: products };
  const calibrated = new Map(
    rendered.map((frame, index) => [
      frame.observation_id,
      { frame, product: products[index] },
    ]),
  );
  const frames: RenderedFrame[] = [];
  const result: (Product | undefined)[] = [];
  const scale = previewScale(manifest);
  const grouped = !raw && manifest.visits?.length;
  const sources = grouped ? steps.map(({visit, source}) => {
    const composite = calibrated.get(visit.id)?.frame;
    return composite ?? { ...source, visit_id: visit.id };
  }) : manifest.frames;
  for (const source of sources) {
    const entry = calibrated.get(source.observation_id);
    if (entry) {
      frames.push(entry.frame.visit_id === source.visit_id ? entry.frame : { ...entry.frame, visit_id: source.visit_id });
      result.push(entry.product);
    } else {
      frames.push({ ...source, previewScale: scale });
      result.push(undefined);
    }
  }
  return { frames, result };
}

/** Older manifests can lack the physical calibration of their baked PNG stretch. */
export function previewScale(manifest: Manifest): PreviewScale {
  const scale = manifest.processing?.stretch;
  const stretch = manifest.stretch?.toLowerCase().split(/[\s(]/)[0];
  if (
    scale &&
    Number.isFinite(scale.vmin) &&
    Number.isFinite(scale.vmax) &&
    scale.vmin! < scale.vmax! &&
    scale.units &&
    stretch &&
    ["linear", "asinh", "sqrt", "log"].includes(stretch)
  ) {
    return { bounds: [scale.vmin!, scale.vmax!], stretch, units: scale.units };
  }
  return { bounds: [0, 255], stretch: "linear", units: "display levels" };
}
export function exportName(
  frames: RenderedFrame[],
  query: Query,
  magnification: number,
) {
  const dates = frames
    .flatMap((f) => f.sourceDates ?? [f.observed_at])
    .map(Date.parse);
  const stamp = (time: number) =>
    new Date(time).toISOString().slice(0, 19).replaceAll(":", "-") + "Z";
  const begin = stamp(Math.min(...dates)),
    end = stamp(Math.max(...dates));
  const span = begin === end ? begin : begin + "_to_" + end;
  const reference = frames[0]?.subtraction?.referenceDate;
  return `${span}${reference ? "_minus_" + stamp(Date.parse(reference)) : ""}_N-up_E-left_RA${query.ra_deg}_Dec${query.dec_deg}_FOV${query.fov_arcsec ?? 300}arcsec_zoom${magnification}`;
}

const day = 86400000;
export function archivedAt(p: Plane, i: number) {
  if (!p.quality) return p.values[i];
  return (p.quality.status[i] & 0x7f) === 0 ? NaN : p.quality.archived[i];
}
function displayArray(p: Plane) {
  const output = new Float32Array(p.values.length);
  let max = -Infinity;
  for (let i = 0; i < output.length; i++) {
    const value = archivedAt(p, i);
    output[i] = Number.isFinite(value) && value >= 0 ? value : NaN;
    if (output[i] > max) max = output[i];
  }
  const q = p.quality;
  // Infinity here is a display-only sentinel for an overflow with no finite reference.
  if (q)
    for (let i = 0; i < output.length; i++) {
      if (q.status[i] & 0x7f && Number.isNaN(q.archived[i]) && q.flags[i] & 2)
        output[i] = Number.isFinite(max) ? max : Infinity;
    }
  return output;
}
export function matchesChannel(
  key: string,
  frame: Pick<
    Frame,
    | "channel"
    | "detector"
    | "wavelength_um"
    | "bandwidth_um"
    | "processing_version"
    | "nominal_channel"
  > & { observation_id?: string; id?: string },
) {
  if (frame.channel === key || frame.detector === key) return true;
  if (frame.nominal_channel != null && key === frame.detector + "-" + String(frame.nominal_channel).padStart(2,"0")) return true;
  if (key.startsWith("exposure:"))
    return key.slice(9) === (frame.observation_id ?? frame.id);
  // Sequence labels may change as exposures arrive. Compare the field-center wavelength
  // using the same fraction of a bandwidth as discovery when a saved label is inexact.
  const match = /^(D[1-6])\s+([\d.]+)\s+.*?\(([^()]+)\)$/.exec(key);
  const version =
    frame.processing_version ?? frame.channel?.match(/\(([^()]+)\)$/)?.[1];
  return (
    !!match &&
    frame.detector === match[1] &&
    version === match[3] &&
    frame.wavelength_um != null &&
    frame.bandwidth_um != null &&
    Math.abs(frame.wavelength_um - Number(match[2])) <= 0.5 * frame.bandwidth_um + 0.0000005
  );
}
function channelMatches(planes: Plane[], key: string) {
  const exact = planes.filter((p) => p.frame.channel === key);
  return exact.length
    ? exact
    : planes.filter((p) => matchesChannel(key, p.frame));
}
type MapTerms = {
  primary: Plane[];
  reference: Plane[];
  terms: { plane: Plane; sign: number }[];
};
function mapTerms(
  map: SpectralMap,
  visitPlanes: Plane[],
  comparison: Plane[],
): MapTerms | null {
  const selected = new Map<Plane, number>();
  for (const [key, sign] of Object.entries(map.operands)) {
    const found = channelMatches(visitPlanes, key);
    if (!found.length) return null;
    for (const plane of found) selected.set(plane, sign);
  }
  if (!selected.size) return null;
  const primary = new Set(selected.keys()),
    reference = new Set<Plane>();
  const terms = Array.from(selected, ([plane, sign]) => ({ plane, sign }));
  if (map.difference) {
    for (const [plane, sign] of selected) {
      const channel = plane.frame.channel;
      if (!channel) return null;
      const time = Date.parse(plane.frame.observed_at);
      let hasReference = false;
      for (const other of comparison) {
        if (
          visitPlanes.includes(other) ||
          !matchesChannel(channel, other.frame)
        )
          continue;
        const days = Math.abs(Date.parse(other.frame.observed_at) - time) / day;
        if (days <= map.windowDays / 2) {
          terms.push({ plane: other, sign });
          primary.add(other);
        } else if (days > Math.max(map.exclusionDays, map.windowDays) / 2) {
          terms.push({ plane: other, sign: -sign });
          reference.add(other);
          hasReference = true;
        }
      }
      if (!hasReference) return null;
    }
  }
  return { primary: [...primary], reference: [...reference], terms };
}
export function products(
  data: Plane[],
  s: Display,
  visits: Visit[] = [],
  raw = false,
): Product[] {
  const displays = new Map<Plane, Float32Array>();
  function values(p: Plane) {
    let array = displays.get(p);
    if (!array) {
      array = displayArray(p);
      displays.set(p, array);
    }
    return array;
  }
  const byId = new Map(data.map((p) => [p.frame.observation_id, p]));
  const groups = visits.map((visit) => ({
    visit,
    planes: visit.observation_ids.flatMap((id) => {
      const plane = byId.get(id);
      return plane ? [plane] : [];
    }),
  }));
  if (raw || !visits.length) {
    const lookup = new Map(
      groups.flatMap((g) =>
        g.visit.observation_ids.map((id) => [id, g.planes] as const),
      ),
    );
    return data.map((p) => {
      const map = {
        ...(s.maps[0] ?? defaults.maps[0]),
        name: p.frame.detector,
      };
      return {
        frame: p.frame,
        layers: [{ map, values: values(p) }],
        sourcePlanes: lookup.get(p.frame.observation_id) ?? [p],
        inputs: [p.frame],
        reference: [],
      };
    });
  }
  const output: Product[] = [];
  const cycles = groups.filter(({ visit }) =>
    visit.kind !== "supplemental" && visit.status !== "invalid");
  const comparison = cycles.flatMap(g => g.planes);
  for (const { visit, planes } of cycles) {
    if (!planes.length) continue;
    const layers: Product["layers"] = [],
      inputs = new Set<Frame>(),
      reference = new Set<Frame>();
    for (const map of s.maps) {
      const input = mapTerms(map, planes, comparison);
      if (!input) continue;
      const arrays = input.terms.map((t) => ({
        values: values(t.plane),
        sign: t.sign,
      }));
      const combined =
        arrays.length === 1 && arrays[0].sign === 1
          ? arrays[0].values
          : Float32Array.from(arrays[0].values, (_, i) =>
              arrays.reduce((sum, t) => sum + t.values[i] * t.sign, 0),
            );
      layers.push({ map, values: combined });
      input.primary.forEach((p) => inputs.add(p.frame));
      input.reference.forEach((p) => reference.add(p.frame));
    }
    if (layers.length)
      output.push({
        frame: {
          ...planes[0].frame,
          visit_id: visit.id,
          observation_id: visit.id,
          observed_at: visit.start_utc,
        },
        layers,
        sourcePlanes: planes,
        inputs: [...inputs],
        reference: [...reference],
      });
  }
  return output;
}

// A fixed reference uses the signed, calibrated map inputs on the common grid.
// Display-only substitutions (particularly saturated NaN pixels) are not measurements.
export function cycleDifferences(data: Plane[], steps: CycleInput[], map: SpectralMap | undefined, referenceId: string) {
  const planes = new Map(data.map(p => [p.frame.observation_id, p]));
  const samples = steps.flatMap(step => {
    const members = step.members.flatMap(f => planes.get(f.observation_id) ?? []);
    if (members.length !== step.members.length) return [];
    const terms = map ? mapTerms({...map, difference:false}, members, [])?.terms :
      members.length === 1 ? [{plane:members[0], sign:1}] : undefined;
    if (!terms?.length || terms.some(({plane:{frame}}) =>
      !frame.sequence_id || !frame.processing_version || frame.processing_version === "unknown")) return [];
    const signature = JSON.stringify(terms.map(t => JSON.stringify([responseKey(t.plane.frame), t.sign])).sort());
    return [{step, terms, signature}];
  });
  const reference = referenceId ? samples.find(s => s.step.visit.id === referenceId) : samples[0];
  const options = samples.map(s => s.step.visit);
  const products: Product[] = [];
  const matched: CycleInput[] = [];
  let peak = 0;
  function mapValue(terms: MapTerms["terms"], i: number) {
    let sum = 0;
    for (const {plane, sign} of terms) {
      const value = archivedAt(plane, i);
      if (!Number.isFinite(value) || value < 0) return NaN;
      sum += sign * value;
    }
    return sum;
  }
  if (reference) {
    const base = Float64Array.from(reference.terms[0].plane.values, (_, i) => mapValue(reference.terms, i));
    const residualMap = {...newMap("cycle-difference", "Δ " + (map?.name ?? reference.step.source.detector)),
      stretch:"linear", stops:[
        {at:0, color:"#40bfff"}, {at:127/255, color:"#000000"}, {at:128/255, color:"#000000"}, {at:1, color:"#ff983e"},
      ]};
    for (const {step, terms, signature} of samples) {
      if (signature !== reference.signature) continue;
      const values = Float32Array.from(base, (baseValue, i) => mapValue(terms, i) - baseValue);
      let covered = false;
      for (const v of values) if (Number.isFinite(v)) { peak = Math.max(peak, Math.abs(v)); covered = true; }
      if (!covered) continue;
      matched.push(step);
      const primary = terms.map(t => t.plane), referencePlanes = reference.terms.map(t => t.plane);
      products.push({
        frame:{...step.source, visit_id:step.visit.id, observation_id:step.visit.id, observed_at:step.visit.start_utc},
        layers:[{map:residualMap, values}], sourcePlanes:[...new Set([...primary, ...referencePlanes])],
        inputs:primary.map(p => p.frame), reference:referencePlanes.map(p => p.frame),
        subtraction:{referenceId:reference.step.visit.id, referenceDate:reference.step.visit.start_utc},
      });
    }
  }
  const valid = matched.length >= 2;
  return {steps:valid ? matched : [], products:valid ? products : [], options, reference:reference?.step.visit, bounds:[-peak, peak]};
}

const flagNames: Record<number, string> = {
  0: "TRANSIENT",
  1: "OVERFLOW",
  2: "SUR_ERROR",
  6: "NONFUNC",
  7: "DICHROIC",
  9: "MISSING_DATA",
  10: "HOT",
  11: "COLD",
  12: "FULLSAMPLE",
  14: "PHANMISS",
  15: "NONLINEAR",
  17: "PERSIST",
  19: "OUTLIER",
  20: "CROSSTALK",
  21: "SOURCE",
  22: "GHOST",
  23: "GHOST_FPA",
  24: "GHOST_EXT",
  25: "STREAK",
  26: "BLOOM",
  27: "SNOWBALL",
  28: "HALO",
  29: "SATELLITE_HALO",
};

export function flagLabels(frame: Frame, bits: number) {
  const labels: string[] = [];
  for (let bit = 0; bit < 32; bit++)
    if ((bits >>> bit) & 1)
      labels.push(frame.flag_names?.[bit] ?? flagNames[bit] ?? "Bit " + bit);
  return labels;
}
export function inspectBand(p: Plane, i: number) {
  const q = p.quality,
    archived = archivedAt(p, i),
    bits = q?.flags[i] ?? 0;
  let treatment = "Recorded brightness";
  if (q && !(q.status[i] & 0x7f)) treatment = "Outside exposure";
  else if (Number.isNaN(archived) && bits & 2)
    treatment = "Overflow · display marker";
  else if (!Number.isFinite(archived)) treatment = "No finite measurement";
  else if (archived < 0) treatment = "Negative measurement · blank on image";
  return {
    archived,
    flags: flagLabels(p.frame, bits),
    treatment,
    uncertaintyUnavailable: !!(q && q.status[i] & 0x80),
    warning: !!(bits & ~(1 << 21)),
  };
}
export type PixelRect = [number, number, number, number];
export type SpectrumBin = {
  wave: number;
  mean: number;
  finite: number;
  detector: string;
};
export type BandSample = {
  plane: Plane;
  wave: number;
  mean: number;
  finite: number;
  total: number;
  overflow: number;
  negative: number;
  flags: Map<string, number>;
};
/** One detector-specific Voronoi bin per distinct measured field-center wavelength.
 * The same boundaries bin both selections. An unobserved wavelength never creates a point. */
export function spectrumBins(planes: Plane[]) {
  const centers = new Map<string, number[]>();
  for (const p of planes) {
    const wave = p.frame.wavelength_um;
    if (wave == null || !Number.isFinite(wave)) continue;
    const group = centers.get(p.frame.detector) ?? [];
    group.push(wave);
    centers.set(p.frame.detector, group);
  }
  for (const [detector, values] of centers)
    centers.set(
      detector,
      [...new Set(values)].sort((a, b) => a - b),
    );
  return centers;
}
function nearestBin(centers: number[], wave: number) {
  let lo = 0,
    hi = centers.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (wave > (centers[mid] + centers[mid + 1]) / 2) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
export function measureSpectrum(
  planes: Plane[],
  centers: Map<string, number[]>,
  width: number,
  box: PixelRect,
  details: boolean,
) {
  const samples: BandSample[] = [];
  let minWave = 0.75, maxWave = 5, maxBrightness = 0;
  const totals = new Map(
    Array.from(
      centers,
      ([detector, wavelengths]) =>
        [
          detector,
          wavelengths.map(() => ({ detector, wave: 0, sum: 0, finite: 0 })),
        ] as const,
    ),
  );
  for (const plane of planes) {
    const flags = new Map<string, number>(),
      labels = new Map<number, string[]>();
    const bins = centers.get(plane.frame.detector);
    const group = totals.get(plane.frame.detector);
    let sum = 0,
      finite = 0,
      overflow = 0,
      negative = 0,
      waveSum = 0,
      nWave = 0;
    const q = plane.quality;
    for (let y = box[1]; y <= box[3]; y++)
      for (let x = box[0]; x <= box[2]; x++) {
        const i = y * width + x;
        if (q && !(q.status[i] & 0x7f)) continue;
        const v = archivedAt(plane, i),
          w = plane.wavelengths?.[i] ?? (plane.frame.spectral ? undefined : plane.frame.wavelength_um);
        if (details && q) {
          const bits = q.flags[i];
          let names = labels.get(bits);
          if (!names) {
            names = flagLabels(plane.frame, bits);
            labels.set(bits, names);
          }
          for (const name of names) flags.set(name, (flags.get(name) ?? 0) + 1);
        }
        if (w != null && Number.isFinite(w)) {
          nWave++;
          waveSum += w;
        }
        if (!Number.isFinite(v)) {
          if (Number.isNaN(v) && q && q.flags[i] & 2) overflow++;
          continue;
        }
        finite++;
        sum += v;
        if (v < 0) negative++;
        if (w == null || !Number.isFinite(w) || !bins?.length || !group)
          continue;
        minWave = Math.min(minWave, w);
        maxWave = Math.max(maxWave, w);
        maxBrightness = Math.max(maxBrightness, v);
        const bin = group[nearestBin(bins, w)];
        bin.wave += w;
        bin.sum += v;
        bin.finite++;
      }
    samples.push({
      plane,
      wave: nWave ? waveSum / nWave : NaN,
      mean: finite ? sum / finite : NaN,
      total: (box[2] - box[0] + 1) * (box[3] - box[1] + 1),
      finite,
      negative,
      overflow,
      flags,
    });
  }
  return {
    samples,
    domain: [minWave, maxWave, 0, maxBrightness > 0 ? maxBrightness * 1.04 : 1],
    bins: [...totals.values()]
      .flat()
      .filter((b) => b.finite > 0)
      .map((b) => ({
        detector: b.detector,
        wave: b.wave / b.finite,
        mean: b.sum / b.finite,
        finite: b.finite,
      }))
      .sort((a, b) => a.wave - b.wave),
  };
}

export function mapBounds(values: Float32Array, map: SpectralMap) {
  let min = Infinity,
    max = -Infinity;
  for (const v of values)
    if (Number.isFinite(v) && v >= 0) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  return [
    map.low === "" ? (Number.isFinite(min) ? min : 0) : Number(map.low),
    map.high === "" ? (Number.isFinite(max) ? max : 1) : Number(map.high),
  ];
}
export function palette(stops: Stop[]) {
  const ordered = [...stops].sort((a, b) => a.at - b.at);
  const rgba = (c: string) =>
    [1, 3, 5, 7].map((k) =>
      c.length <= k ? 255 : parseInt(c.slice(k, k + 2), 16),
    );
  return Array.from({ length: 256 }, (_, i) => {
    const x = i / 255;
    const right =
      ordered.find((stop) => stop.at >= x) ?? ordered[ordered.length - 1];
    const left = ordered[Math.max(0, ordered.indexOf(right) - 1)];
    const t = Math.max(
      0,
      Math.min(1, (x - left.at) / (right.at - left.at || 1)),
    );
    const a = rgba(left.color),
      b = rgba(right.color);
    // Interpolate premultiplied colors so a transparent-to-white stop fades cleanly.
    const alpha = (1 - t) * a[3] + t * b[3];
    return [
      ...[0, 1, 2].map((k) =>
        alpha
          ? Math.round(((1 - t) * a[k] * a[3] + t * b[k] * b[3]) / alpha)
          : 0,
      ),
      Math.round(alpha),
    ];
  });
}

export function intensityByte(
  value: number,
  bounds: number[],
  stretch: string,
) {
  if (bounds[1] === bounds[0]) return 128;
  const t = Math.max(
    0,
    Math.min(1, (value - bounds[0]) / (bounds[1] - bounds[0])),
  );
  switch (stretch) {
    case "sqrt":
      return Math.round(255 * Math.sqrt(t));
    case "log":
      return Math.round((255 * Math.log1p(100 * t)) / Math.log(101));
    case "asinh":
      return Math.round((255 * Math.asinh(10 * t)) / Math.asinh(10));
    default:
      return Math.round(255 * t);
  }
}

export function fillComposite(
  out: Uint8ClampedArray,
  layers: Product["layers"],
  scales: MapScale[],
) {
  const paints = layers.map(({ values }, n) => ({
    values,
    scale: scales[n],
    colors: palette(scales[n].stops),
  }));
  for (let i = 0; i < out.length / 4; i++) {
    let red = 0,
      green = 0,
      blue = 0,
      alpha = 0;
    for (const { values, scale, colors } of paints) {
      const v = values[i];
      if (Number.isNaN(v) || (v < 0 && !scale.signed) || scale.bounds[0] > scale.bounds[1])
        continue;
      const color =
        colors[
          v === Infinity ? 255 : intensityByte(v, scale.bounds, scale.stretch)
        ];
      const a = color[3] / 255;
      red += a * color[0];
      green += a * color[1];
      blue += a * color[2];
      alpha += a;
    }
    // Add premultiplied RGBA, saturate and store straight-alpha ImageData.
    const a = Math.min(1, alpha);
    if (a) {
      out[i * 4] = Math.min(255, red) / a;
      out[i * 4 + 1] = Math.min(255, green) / a;
      out[i * 4 + 2] = Math.min(255, blue) / a;
      out[i * 4 + 3] = a * 255;
    }
  }
}
export function renderProduct(
  p: Product,
  width: number,
  height: number,
  scales: MapScale[],
) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!,
    img = ctx.createImageData(width, height);
  fillComposite(img.data, p.layers, scales);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

// Inverse gnomonic projection on the north-up 6.14 arcsec common grid.
export type GridHeader = Record<string, string | number>;

/** FITS linear transform from detector pixels to tangent-plane degrees. */
export function gridMatrix(grid?: GridHeader) {
  if (grid && [grid.CD1_1, grid.CD1_2, grid.CD2_1, grid.CD2_2].some(v => v !== undefined))
    return [Number(grid.CD1_1 ?? 0), Number(grid.CD1_2 ?? 0), Number(grid.CD2_1 ?? 0), Number(grid.CD2_2 ?? 0)];
  const sx = Number(grid?.CDELT1 ?? -6.14 / 3600), sy = Number(grid?.CDELT2 ?? 6.14 / 3600);
  return [sx * Number(grid?.PC1_1 ?? 1), sx * Number(grid?.PC1_2 ?? 0),
    sy * Number(grid?.PC2_1 ?? 0), sy * Number(grid?.PC2_2 ?? 1)];
}

export function skyPosition(
  q: Query,
  x: number,
  y: number,
  width: number,
  height: number,
  grid?: GridHeader,
) {
  const rad = Math.PI / 180,
    d = Number(grid?.CRVAL2 ?? q.dec_deg) * rad;
  const [a11, a12, a21, a22] = gridMatrix(grid);
  const dx = x + 1 - Number(grid?.CRPIX1 ?? (width + 1) / 2);
  const dy = height - y - Number(grid?.CRPIX2 ?? (height + 1) / 2);
  const xi = (a11 * dx + a12 * dy) * rad, eta = (a21 * dx + a22 * dy) * rad;
  const a = Math.cos(d) - eta * Math.sin(d);
  return {
    ra_deg: (360 + Number(grid?.CRVAL1 ?? q.ra_deg) + Math.atan2(xi, a) / rad) % 360,
    dec_deg:
      Math.atan2(Math.sin(d) + eta * Math.cos(d), Math.hypot(a, xi)) / rad,
  };
}

/** Return zero-based display coordinates, or null outside the current cutout. */
export function skyPixel(
  q: Query,
  position: Pick<Query, "ra_deg" | "dec_deg">,
  width: number,
  height: number,
): [number, number] | null {
  const rad = Math.PI / 180,
    delta = (position.ra_deg - q.ra_deg) * rad;
  const center = q.dec_deg * rad,
    dec = position.dec_deg * rad;
  const cosDec = Math.cos(dec),
    sinDec = Math.sin(dec),
    sinCenter = Math.sin(center),
    cosCenter = Math.cos(center);
  const projection = sinCenter * sinDec + cosCenter * cosDec * Math.cos(delta);
  if (projection <= 0 || !width || !height) return null;
  const pixelAngle = (6.14 / 3600) * rad;
  const x = Math.round(
    (width - 1) / 2 - (cosDec * Math.sin(delta)) / (projection * pixelAngle),
  );
  const y = Math.round(
    (height - 1) / 2 -
      (cosCenter * sinDec - sinCenter * cosDec * Math.cos(delta)) /
        (projection * pixelAngle),
  );
  return x >= 0 && x < width && y >= 0 && y < height
    ? [Math.max(0, x), Math.max(0, y)]
    : null;
}
