export type Query = {
  ra_deg: number;
  dec_deg: number;
  start_utc?: string;
  end_utc?: string;
  fov_arcsec?: number;
  min_interval_days?: number;
};
export type Frame = {
  id: string;
  url: string;
  observation_id: string;
  observed_at: string;
  detector: string;
  wavelength_um?: number;
  bandwidth_um?: number;
  release?: string;
  source_url?: string;
  sequence_id?: string;
  warnings?: string[];
  processing_version?: string;
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
  time_sample?: boolean;
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
  frames: Frame[];
  observations?: Observation[];
  sequences?: Sequence[];
  warnings?: string[];
  retrieved_at?: string;
  cached?: boolean;
  discovery_complete?: boolean;
  processing?: {
    stretch?: { vmin?: number; vmax?: number; units?: string };
    min_interval_days?: number;
    initial_detector?: string;
    initial_observation_ids?: string[];
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
