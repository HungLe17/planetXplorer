export type Query = {
  fov_arcsec?: number;
  live?: boolean;
  ra_deg: number;
  dec_deg: number;
  start_utc?: string;
  end_utc?: string;
};
export type Frame = {
  id: string;
  url: string;
  observation_id: string;
  observed_at: string;
  detector: string;
  wavelength_um?: number;
  bandwidth_um?: number;
  sequence_id?: string;
  pixels?: string;
  quality?: string;
  channel?: string;
  processing_version?: string;
  exposure_flags?: Record<string, string | number>;
  flag_names?: Record<string, string>;
  release?: string;
  source_url?: string;
  warnings?: string[];
};
export type Observation = {
  id: string;
  source_url: string;
  observed_at: string;
  detector: string;
  release: string;
  status: "pending" | "loading" | "ready" | "failed";
  reason?: string;
  frame_id?: string;
};
export type Sequence = {
  id: string;
  detector: string;
  wavelength_um: number;
  processing_version: string;
  frame_ids: string[];
  stretch: { vmin?: number; vmax?: number; units?: string };
};
export type Manifest = {
  observations?: Observation[];
  sequences?: Sequence[];
  discovery_complete?: boolean;
  frames: Frame[];
  warnings?: string[];
  retrieved_at?: string;
  cached?: boolean;
  processing?: {
    batch_size?: number;
    revision?: number;
    output_shape?: number[];
    archive_complete?: boolean;
    refreshing_cache?: boolean;
    cache_fallback?: boolean;
    archive_products?: Record<string, string>;
    stretch?: { vmin?: number; vmax?: number; units?: string };
  };
  grid?: string;
  stretch?: string;
};
export type Job = {
  status:
    | "queued"
    | "running"
    | "complete"
    | "partial"
    | "failed"
    | "cancelling"
    | "cancelled";
  stage?: string;
  warnings?: string[];
  error?: string;
  manifest?: Manifest;
};
export type Preset = {
  id: string;
  name: string;
  kind: string;
  ra: string;
  dec: string;
  note: string;
};
// Supplied challenge coordinate; other positions come from the backend after verification.
export const presets: Preset[] = [
  {
    id: "barnard",
    name: "Barnard’s Star",
    kind: "High proper motion",
    ra: "",
    dec: "",
    note: "Compare position against background stars.",
  },
  {
    id: "epsilon",
    name: "Epsilon Indi B",
    kind: "Brown dwarf system",
    ra: "",
    dec: "",
    note: "Inspect the brown dwarf field across epochs.",
  },
  {
    id: "wise",
    name: "WISE 0855",
    kind: "Brown dwarf",
    ra: "133.795129",
    dec: "-7.245147",
    note: "Challenge reference coordinates. Proper motion can shift the object away from this position.",
  },
  {
    id: "rw",
    name: "RW Aurigae",
    kind: "Variable star",
    ra: "",
    dec: "",
    note: "Compare brightness at matching wavelengths.",
  },
  {
    id: "rdraconis",
    name: "R Draconis",
    kind: "Variable star",
    ra: "",
    dec: "",
    note: "Inspect brightness changes across available epochs.",
  },
];
