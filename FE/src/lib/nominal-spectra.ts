import table from "../../../BE/app/data/spherex-spectra.json";
import type { Detector } from "./types";

export const spectraTable = table;
export const isNominalSpectrum = (s: string) => /^D[1-6]-(?:0[1-9]|1[0-7])$/.test(s);
export function spectrumId(detector: string, channel: number) {
  return detector + "-" + String(channel).padStart(2, "0");
}
export function nominalLabel(detector: Detector, channel: number) {
  return spectrumId(detector, channel) + " · " + spectraTable[detector][channel - 1].center_um.toFixed(3) + " µm";
}
