import type { Frame, Query, Manifest } from "./types";

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
export type Display = typeof defaults;
export const defaults = {
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
};
export type PixelQuality = {
  archived: Float32Array;
  flags: Uint32Array;
  status: Uint8Array;
};
export type Plane = {
  frame: Frame;
  values: Float32Array;
  quality?: PixelQuality;
};
export type Product = {
  frame: Frame;
  planes: Float32Array[];
  /** Original bands are available for direct exposures and static RGB only. */
  sourcePlanes?: Plane[];
  inputs: Frame[];
  reference: Frame[];
};
export type PreviewScale = { bounds: number[]; stretch: string; units: string };
export type RenderedFrame = Frame & {
  canvas?: HTMLCanvasElement;
  sourceDates?: string[];
  previewScale?: PreviewScale;
  warningPixels?: Uint32Array;
};
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
  return `${span}_N-up_E-left_RA${query.ra_deg}_Dec${query.dec_deg}_FOV${query.fov_arcsec ?? 300}arcsec_zoom${magnification}`;
}
const day = 86400000;

function reduce(arrays: Float32Array[], mean: boolean) {
  if (arrays.length === 1) return arrays[0];
  return Float32Array.from(arrays[0], (_, i) => {
    let sum = 0,
      count = 0;
    for (const a of arrays)
      if (Number.isFinite(a[i])) {
        sum += a[i];
        count++;
      }
    return count ? sum / (mean ? count : 1) : NaN;
  });
}

export function products(data: Plane[], s: Display): Product[] {
  if (!data.length) return [];
  if (s.mode === "single" && !s.difference && !Object.keys(s.operands).length)
    return data.map((p) => ({
      frame: p.frame,
      planes: [p.values],
      sourcePlanes: [p],
      inputs: [p.frame],
      reference: [],
    }));
  if (s.mode === "rgb") {
    const chosen = s.rgb.map((id) =>
      data.find((p) => p.frame.observation_id === id),
    );
    if (
      chosen.some((p) => !p) ||
      new Set(chosen.map((p) => p!.frame.channel)).size !== 3
    )
      return [];
    const inputs = chosen.map((p) => p!.frame);
    return [
      {
        frame: inputs[0],
        planes: chosen.map((p) => p!.values),
        sourcePlanes: chosen.map((p) => p!),
        inputs,
        reference: [],
      },
    ];
  }
  const byChannel = new Map<string, Plane[]>();
  for (const p of data) {
    const key = p.frame.channel!;
    if (!byChannel.has(key)) byChannel.set(key, []);
    byChannel.get(key)!.push(p);
  }
  const mostFrequent = Array.from(byChannel).sort(
    (a, b) => b[1].length - a[1].length,
  )[0][0];
  const operands = Object.entries(s.operands).length
    ? Object.entries(s.operands)
    : [[mostFrequent, 1] as [string, number]];
  const channels = (name: string) =>
    Array.from(byChannel.keys()).filter(
      (k) => k === name || k.split(" ")[0] === name,
    );
  const selected = new Set(operands.flatMap(([name]) => channels(name)));
  const combined =
    operands.length > 1 || operands.some(([n]) => !byChannel.has(n));
  const selectedEpochs = data.filter((p) => selected.has(p.frame.channel!));
  const epochs =
    combined && !s.difference ? selectedEpochs.slice(0, 1) : selectedEpochs;
  const result: Product[] = [];
  for (const epoch of epochs) {
    const time = Date.parse(epoch.frame.observed_at);
    const inputs = new Set<Frame>(),
      reference = new Set<Frame>();
    const terms: Float32Array[] = [];
    for (const [name, sign] of operands) {
      const parts: Float32Array[] = [];
      const selectedChannels = channels(name);
      for (const key of selectedChannels) {
        const group = byChannel.get(key)!;
        const distance = (p: Plane) =>
          Math.abs(Date.parse(p.frame.observed_at) - time) / day;
        const inside = s.difference
          ? group.filter((p) => distance(p) <= s.windowDays / 2)
          : combined
            ? group
            : [epoch];
        if (!inside.length) continue;
        let values = reduce(
          inside.map((p) => p.values),
          !s.difference,
        );
        if (s.difference) {
          const outside = group.filter(
            (p) => distance(p) > Math.max(s.windowDays, s.exclusionDays) / 2,
          );
          if (!outside.length) continue;
          outside.forEach((p) => reference.add(p.frame));
          const background = reduce(
            outside.map((p) => p.values),
            false,
          );
          values = Float32Array.from(values, (v, i) => v - background[i]);
        }
        inside.forEach((p) => inputs.add(p.frame));
        parts.push(values);
      }
      if (!parts.length || parts.length !== selectedChannels.length) break;
      const term = reduce(parts, true);
      terms.push(sign === -1 ? Float32Array.from(term, (v) => -v) : term);
    }
    if (terms.length !== operands.length) continue;
    const values =
      terms.length === 1
        ? terms[0]
        : Float32Array.from(terms[0], (_, i) =>
            terms.reduce((n, t) => n + t[i], 0),
          );
    result.push({
      frame: epoch.frame,
      planes: [values],
      sourcePlanes:
        !combined && !s.difference && operands[0][1] === 1
          ? [epoch]
          : undefined,
      inputs: [...inputs],
      reference: [...reference],
    });
  }
  return result;
}

// The backend classifies each native detector pixel before alignment. Bit 7
// records missing uncertainty independently of how brightness may be displayed.
const pixelState = {
  outside: 0,
  measured: 1,
  warning: 2,
  overflow: 3,
  inspectOnly: 4,
  unavailable: 5,
} as const;
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

function displaySample(
  scienceValue: number,
  quality: PixelQuality | undefined,
  i: number,
  inspectFlagged: boolean,
): number | "overflow" {
  if (!quality) return scienceValue;
  switch (quality.status[i] & 0x7f) {
    case pixelState.measured:
      return Number.isFinite(scienceValue) ? scienceValue : quality.archived[i];
    case pixelState.warning:
      return quality.archived[i];
    case pixelState.overflow:
      return "overflow";
    case pixelState.inspectOnly:
      return inspectFlagged ? quality.archived[i] : NaN;
    default:
      return NaN;
  }
}

export function bandWarning(
  quality: PixelQuality,
  i: number,
  inspectFlagged: boolean,
) {
  const state = quality.status[i] & 0x7f;
  return (
    state === pixelState.warning ||
    state === pixelState.overflow ||
    (state === pixelState.inspectOnly && inspectFlagged)
  );
}

export function pixelVisible(p: Product, i: number, inspectFlagged: boolean) {
  for (let band = 0; band < p.planes.length; band++) {
    const sample = displaySample(
      p.planes[band][i],
      p.sourcePlanes?.[band]?.quality,
      i,
      inspectFlagged,
    );
    if (sample !== "overflow" && !Number.isFinite(sample)) return false;
  }
  return true;
}

export function inspectBand(plane: Plane, i: number, inspectFlagged: boolean) {
  const q = plane.quality;
  if (!q)
    return {
      archived: NaN,
      flags: [] as string[],
      treatment: Number.isFinite(plane.values[i])
        ? "Aligned measurement · archive flags unavailable"
        : "No data · archive flags unavailable",
      uncertaintyUnavailable: false,
      warning: false,
    };
  const flags = [];
  const bits = q.flags[i];
  for (let bit = 0; bit < 32; bit++) {
    if ((bits >>> bit) & 1)
      flags.push(
        plane.frame.flag_names?.[bit] ?? flagNames[bit] ?? `Bit ${bit}`,
      );
  }
  const state = q.status[i] & 0x7f;
  let treatment: string;
  switch (state) {
    case pixelState.measured:
      treatment = "Measured brightness";
      break;
    case pixelState.warning:
      treatment = "Measured brightness · flagged";
      break;
    case pixelState.overflow:
      treatment = "Overflow · shown at maximum";
      break;
    case pixelState.inspectOnly:
      treatment = inspectFlagged
        ? "Flagged measurement · inspection only"
        : "Masked · enable Inspect flagged pixels";
      break;
    case pixelState.outside:
      treatment = "Outside exposure";
      break;
    default:
      treatment = "No usable measurement";
  }
  return {
    archived: q.archived[i],
    flags,
    treatment,
    uncertaintyUnavailable: !!(q.status[i] & 0x80),
    warning: bandWarning(q, i, inspectFlagged),
  };
}

export function displayBounds(images: Product[], s: Display) {
  let min = Infinity,
    max = -Infinity;
  for (const p of images) {
    const qualityRgb =
      p.planes.length === 3 && p.sourcePlanes?.some((band) => band.quality);
    for (let i = 0; i < p.planes[0].length; i++) {
      if (qualityRgb && !pixelVisible(p, i, s.inspectFlagged)) continue;
      for (let band = 0; band < p.planes.length; band++) {
        const v = displaySample(
          p.planes[band][i],
          p.sourcePlanes?.[band]?.quality,
          i,
          s.inspectFlagged,
        );
        if (v !== "overflow" && Number.isFinite(v)) {
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
      }
    }
  }
  return [
    s.low === "" ? (Number.isFinite(min) ? min : 0) : Number(s.low),
    s.high === "" ? (Number.isFinite(max) ? max : 1) : Number(s.high),
  ];
}
export function palette(stops: Stop[]) {
  const ordered = [...stops].sort((a, b) => a.at - b.at);
  return Array.from({ length: 256 }, (_, i) => {
    const t = i / 255;
    const right = ordered.find((s) => s.at >= t) ?? ordered[ordered.length - 1];
    const left = ordered[Math.max(0, ordered.indexOf(right) - 1)];
    const f = Math.max(
      0,
      Math.min(1, (t - left.at) / (right.at - left.at || 1)),
    );
    return [1, 3, 5].map((k) =>
      Math.round(
        parseInt(left.color.slice(k, k + 2), 16) * (1 - f) +
          parseInt(right.color.slice(k, k + 2), 16) * f,
      ),
    );
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

export function renderProduct(
  p: Product,
  width: number,
  height: number,
  s: Display,
  bounds: number[],
  colors: number[][],
) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d")!,
    im = ctx.createImageData(width, height);
  fillImageData(
    im.data,
    p.planes,
    bounds,
    s.stretch,
    colors,
    p.sourcePlanes,
    s.inspectFlagged,
  );
  ctx.putImageData(im, 0, 0);
  return c;
}

export function fillImageData(
  out: Uint8ClampedArray,
  planes: Float32Array[],
  bounds: number[],
  stretch: string,
  colors: number[][],
  sourcePlanes?: Plane[],
  inspectFlagged = false,
) {
  for (let i = 0; i < planes[0].length; i++) {
    const offset = 4 * i;
    out[offset + 3] = 255;
    for (let band = 0; band < planes.length; band++) {
      const v = displaySample(
        planes[band][i],
        sourcePlanes?.[band]?.quality,
        i,
        inspectFlagged,
      );
      if (v !== "overflow" && !Number.isFinite(v)) {
        out.fill(0, offset, offset + 4);
        break;
      }
      const intensity =
        v === "overflow" ? 255 : intensityByte(v, bounds, stretch);
      if (planes.length === 1) out.set(colors[intensity], offset);
      else out[offset + band] = intensity;
    }
  }
}

// Inverse gnomonic projection on the north-up 6.14 arcsec common grid.
export function skyPosition(
  q: Query,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const rad = Math.PI / 180,
    d = q.dec_deg * rad;
  const xi = ((((width - 1) / 2 - x) * 6.14) / 3600) * rad,
    eta = ((((height - 1) / 2 - y) * 6.14) / 3600) * rad;
  const a = Math.cos(d) - eta * Math.sin(d);
  return {
    ra_deg: (360 + q.ra_deg + Math.atan2(xi, a) / rad) % 360,
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
