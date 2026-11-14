import { defaults, type Display } from "./imaging";
import type { Query, Manifest } from "./types";
import { parseQuery } from "./view-url";

export const storageKey = "planetXplorer.workspace.v1";
export type Snapshot = Record<string, string>;
export type Config = {
  query: Query | null;
  display: Display;
  frame: string;
  fov: number;
};
export type Entry = {
  id: string;
  name: string;
  note: string;
  flag: string;
  config: Config;
  position: { ra_deg: number; dec_deg: number };
  sources: string[];
  metadata: Record<string, unknown>;
  snapshot: Snapshot;
  snapshotComplete?: boolean;
};
export type Backup = {
  version: 1;
  exported: string;
  config?: Config;
  locations?: Entry[];
  snapshot?: Snapshot;
  snapshotComplete?: boolean;
};
export function snapshot(m: Manifest | null): Snapshot {
  return (
    m?.processing?.archive_products ??
    Object.fromEntries(
      (m?.frames ?? []).map((f) => [
        f.observation_id,
        f.source_url || f.processing_version || f.release || "",
      ]),
    )
  );
}
function productIdentity(url: string) {
  // Legacy preview manifests store the cutout request in the source URL.
  return url.split("?")[0];
}
export function changes(
  old: Snapshot,
  current: Snapshot,
  baselineComplete = false,
) {
  let added = 0,
    revised = 0;
  for (const [id, version] of Object.entries(current)) {
    if (!Object.hasOwn(old, id)) added++;
    else if (productIdentity(old[id]) !== productIdentity(version)) revised++;
  }
  const parts: string[] = [];
  if (added && baselineComplete)
    parts.push(added + " additional observations since the export.");
  if (revised)
    parts.push(
      revised +
        " previously recorded observations have different processing versions.",
    );
  if (!baselineComplete) {
    parts.push(
      added
        ? added +
            " currently visible observations were absent from the partial export. Their arrival since export cannot be confirmed."
        : "The export contains partial archive coverage. New arrivals cannot be confirmed.",
    );
  }
  return parts.join(" ");
}

function object(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function strings(v: unknown): v is Snapshot {
  return object(v) && Object.values(v).every((x) => typeof x === "string");
}
function between(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}
function position(
  v: unknown,
): v is Record<string, unknown> & Entry["position"] {
  return (
    object(v) &&
    between(v.ra_deg, 0, 360) &&
    v.ra_deg < 360 &&
    between(v.dec_deg, -90, 90)
  );
}
export function readDisplay(v: unknown): Display {
  if (!object(v)) throw Error("Invalid display settings.");
  const s = {
    ...defaults,
    ...Object.fromEntries(
      Object.keys(defaults)
        .filter((k) => Object.hasOwn(v, k))
        .map((k) => [k, v[k]]),
    ),
  } as Display;
  if (
    !["single", "rgb"].includes(s.mode) ||
    !["linear", "sqrt", "asinh", "log"].includes(s.stretch) ||
    !between(s.zoom, 1, 8) ||
    !between(s.speed, 0.1, 10) ||
    ![s.windowDays, s.exclusionDays].every((n) => between(n, 0, 1e6)) ||
    ![s.invert, s.coords, s.legend, s.difference, s.markFlagged, s.inspectFlagged].every(
      (x) => typeof x === "boolean",
    ) ||
    ![s.panX, s.panY].every(Number.isFinite) ||
    ![s.low, s.high].every(
      (x) => typeof x === "string" && Number.isFinite(Number(x)),
    ) ||
    !Array.isArray(s.stops) ||
    s.stops.length < 2 ||
    s.stops.length > 32 ||
    !s.stops.every(
      (p) =>
        object(p) &&
        between(p.at, 0, 1) &&
        typeof p.color === "string" &&
        /^#[a-f0-9]{6}$/i.test(p.color),
    ) ||
    !Array.isArray(s.rgb) ||
    s.rgb.length !== 3 ||
    !s.rgb.every((x) => typeof x === "string") ||
    !object(s.operands) ||
    !Object.values(s.operands).every((x) => x === 1 || x === -1)
  )
    throw Error("Invalid display settings.");
  return s;
}
function config(v: unknown): Config {
  if (!object(v) || !between(v.fov, 60, 1800) || typeof v.frame !== "string")
    throw Error("Invalid workspace configuration.");
  let query: Query | null = null;
  if (v.query !== null) {
    const q = v.query;
    if (!position(q) || !object(q)) throw Error("Invalid saved sky position.");
    const date = (value: unknown) => {
      if (value === undefined) return "";
      if (
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(value) ||
        !Number.isFinite(Date.parse(value))
      )
        throw Error("Invalid saved UTC date.");
      return value.slice(0, 10);
    };
    const bounds = parseQuery(
      String(q.ra_deg),
      String(q.dec_deg),
      date(q.start_utc),
      date(q.end_utc),
    );
    const fov = q.fov_arcsec === undefined ? v.fov : q.fov_arcsec;
    if (!between(fov, 60, 1800)) throw Error("Invalid saved field of view.");
    query = { ...bounds, fov_arcsec: fov };
  }
  return { query, frame: v.frame, fov: v.fov, display: readDisplay(v.display) };
}
export function readBackup(raw: string): Backup {
  const b: unknown = JSON.parse(raw);
  if (
    !object(b) ||
    b.version !== 1 ||
    typeof b.exported !== "string" ||
    !Number.isFinite(Date.parse(b.exported)) ||
    (b.config === undefined && !Array.isArray(b.locations))
  )
    throw Error("Unsupported workspace JSON.");
  const result: Backup = { version: 1, exported: b.exported };
  if (b.config !== undefined) result.config = config(b.config);
  if (b.snapshot !== undefined) {
    if (!strings(b.snapshot)) throw Error("Invalid archive snapshot.");
    if (
      b.snapshotComplete !== undefined &&
      typeof b.snapshotComplete !== "boolean"
    )
      throw Error("Invalid archive coverage marker.");
    result.snapshot = b.snapshot;
    result.snapshotComplete = b.snapshotComplete === true;
  }
  if (b.locations !== undefined) {
    if (!Array.isArray(b.locations)) throw Error("Invalid locations.");
    const seen = new Set<string>();
    result.locations = b.locations.map((e) => {
      if (
        !object(e) ||
        typeof e.id !== "string" ||
        !e.id ||
        seen.has(e.id) ||
        typeof e.name !== "string" ||
        typeof e.flag !== "string" ||
        typeof e.note !== "string" ||
        !position(e.position) ||
        !Array.isArray(e.sources) ||
        !e.sources.every((x) => typeof x === "string") ||
        !strings(e.snapshot) ||
        (e.snapshotComplete !== undefined &&
          typeof e.snapshotComplete !== "boolean") ||
        !object(e.metadata)
      )
        throw Error("Invalid or duplicate location entry.");
      seen.add(e.id);
      return {
        id: e.id,
        name: e.name,
        note: e.note,
        flag: e.flag,
        position: e.position,
        sources: e.sources,
        metadata: e.metadata,
        snapshot: e.snapshot,
        snapshotComplete: e.snapshotComplete === true,
        config: config(e.config),
      };
    });
  }
  return result;
}

export type ArchiveSnapshot = {
  products: Snapshot;
  warnings: string[];
  complete: boolean;
};
export type ArchiveCheck = { labels: string[]; details: string };
type ArchiveLookup = (
  query: Query,
  signal: AbortSignal,
) => Promise<ArchiveSnapshot>;
export async function checkImportedFields(
  b: Backup,
  signal: AbortSignal,
  lookup: ArchiveLookup,
  report: (check: ArchiveCheck) => void,
) {
  const fields = new Map<
    string,
    {
      query: Query;
      entries: { label: string; baseline?: Snapshot; complete?: boolean }[];
    }
  >();
  function collect(
    c: Config,
    label: string,
    baseline?: Snapshot,
    complete?: boolean,
  ) {
    if (!c.query) return;
    const q = c.query;
    const key = JSON.stringify([
      q.ra_deg,
      q.dec_deg,
      q.start_utc,
      q.end_utc,
      q.fov_arcsec ?? 300,
    ]);
    if (!fields.has(key)) fields.set(key, { query: q, entries: [] });
    fields.get(key)!.entries.push({ label, baseline, complete });
  }
  if (b.config)
    collect(b.config, "Current view", b.snapshot, b.snapshotComplete);
  for (const e of b.locations ?? [])
    collect(
      e.config,
      e.name ||
        e.position.ra_deg.toFixed(5) +
          "°, " +
          e.position.dec_deg.toFixed(5) +
          "°",
      e.snapshot,
      e.snapshotComplete,
    );
  for (const { query, entries } of fields.values()) {
    if (signal.aborted) return;
    try {
      const now = await lookup({ ...query, live: true }, signal);
      if (signal.aborted) return;
      // Entries for the same field may have been recorded at different times.
      const summaries = new Map<string, string[]>();
      for (const { label, baseline, complete } of entries) {
        let details = baseline
          ? changes(baseline, now.products, complete)
          : "The export contains no comparison snapshot.";
        if (!details)
          details = "No changes found in the compared observations.";
        if (!now.complete) details += " Archive coverage is incomplete.";
        const labels = summaries.get(details) ?? [];
        labels.push(label);
        summaries.set(details, labels);
      }
      for (const [details, labels] of summaries) report({ labels, details });
    } catch (err) {
      if (signal.aborted) return;
      report({
        labels: entries.map((e) => e.label),
        details:
          "Freshness check unavailable. " +
          (err instanceof Error ? err.message : "Archive lookup failed."),
      });
    }
  }
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
