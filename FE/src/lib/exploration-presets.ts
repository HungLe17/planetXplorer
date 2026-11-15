import { defaults, newMap, type Display } from "./imaging";
import type { Detector, Query } from "./types";

export type SkyTarget = {
  id: string;
  name: string;
  ra_deg: number;
  dec_deg: number;
  fov_arcsec: number;
  description: string;
};

export type ViewingPreset = {
  id: string;
  name: string;
  description: string;
  detectors: Detector[];
  channels: NonNullable<Query["channels"]>;
  display: Display;
};

export const skyTargets: SkyTarget[] = [
  {
    id: "barnard",
    name: "Barnard’s Star",
    ra_deg: 269.4462685026598,
    dec_deg: 4.768204478798892,
    fov_arcsec: 300,
    description: "Compare its position against the surrounding stars.",
  },
  {
    id: "epsilon",
    name: "Epsilon Indi B",
    ra_deg: 331.09664385226796,
    dec_deg: -56.800660204005,
    fov_arcsec: 300,
    description: "Inspect the field across wavelengths and observing dates.",
  },
  {
    id: "wise",
    name: "WISE 0855",
    ra_deg: 133.7951291667,
    dec_deg: -7.2451472222,
    fov_arcsec: 300,
    description: "Start from the challenge reference position and compare observations.",
  },
  {
    id: "rw",
    name: "RW Aurigae",
    ra_deg: 76.95658657557492,
    dec_deg: 30.401291346112224,
    fov_arcsec: 300,
    description: "Compare brightness at matching wavelengths across observing dates.",
  },
  {
    id: "rdraconis",
    name: "R Draconis",
    ra_deg: 248.16723307280128,
    dec_deg: 66.75502382666444,
    fov_arcsec: 300,
    description: "Inspect brightness changes across the available observations.",
  },
  {
    id: "orion",
    name: "Orion Nebula",
    ra_deg: 83.82,
    dec_deg: -5.3875,
    fov_arcsec: 1800,
    description: "Explore a 30-arcminute field centered on Orion.",
  },
  {
    id: "pleiades",
    name: "Pleiades",
    ra_deg: 56.75,
    dec_deg: 24.1167,
    fov_arcsec: 1800,
    description: "Explore a 30-arcminute field centered on the Pleiades.",
  },
];

function colorDisplay(
  id: string,
  bands: [Detector, Detector, Detector],
  stretch: "sqrt" | "asinh",
): Display {
  return {
    ...structuredClone(defaults),
    maps: bands.map((detector, index) => ({
      ...newMap(`${id}-${index + 1}`, ["Blue", "Green", "Red"][index]),
      operands: { [detector]: 1 },
      stretch,
      stops: [
        { at: 0, color: "#00000000" },
        { at: 1, color: ["#0000ff", "#00ff00", "#ff0000"][index] },
      ],
    })),
  };
}

const importedDisplay = colorDisplay("imported-rgb", ["D1", "D3", "D6"], "sqrt");
importedDisplay.zoom = 1.0081633277165025;
importedDisplay.markFlagged = false;
const importedMapIds = [
  "map-1",
  "2244eb33-54b8-4a70-a93c-6f19b48622f5",
  "90e0233d-e357-4d33-b846-8ddc92f2d8a9",
];
importedDisplay.maps.forEach((map, index) => {
  map.id = importedMapIds[index];
  map.name = `Map ${index + 1}`;
});

export const viewingPresets: ViewingPreset[] = [
  {
    id: "imported-rgb",
    name: "Your RGB",
    description: "Your saved colors and square-root stretches: D1-01 blue, D3-17 green, D6-17 red.",
    detectors: ["D1", "D3", "D6"],
    channels: { D1: ["D1-01"], D3: ["D3-17"], D6: ["D6-17"] },
    display: importedDisplay,
  },
  {
    id: "starlight",
    name: "Starlight",
    description: "All channels in D1 blue, D2 green, and D3 red, with an asinh stretch.",
    detectors: ["D1", "D2", "D3"],
    channels: {},
    display: colorDisplay("starlight", ["D1", "D2", "D3"], "asinh"),
  },
  {
    id: "warm-dust",
    name: "Warm dust",
    description: "All channels in D4 blue, D5 green, and D6 red, with an asinh stretch.",
    detectors: ["D4", "D5", "D6"],
    channels: {},
    display: colorDisplay("warm-dust", ["D4", "D5", "D6"], "asinh"),
  },
];

export function clonePresetDisplay(preset: ViewingPreset): Display {
  return structuredClone(preset.display);
}

export function explorerHref(target: SkyTarget, presetId = viewingPresets[0].id) {
  const preset = viewingPresets.find((item) => item.id === presetId) ?? viewingPresets[0];
  const params = new URLSearchParams({
    ra: String(target.ra_deg),
    dec: String(target.dec_deg),
    fov: String(target.fov_arcsec),
    bands: JSON.stringify({ detectors: preset.detectors, channels: preset.channels }),
    view: JSON.stringify(preset.display),
  });
  return `/explore?${params}`;
}
