import { matchedEpochs } from "./imaging";
import { isNominalSpectrum, spectrumId, spectraTable } from "./nominal-spectra";
import type { Detector, Frame, Manifest, Sequence } from "./types";

export type MatchedSpectrum = Sequence & {
  epochs: ReturnType<typeof matchedEpochs>;
  sequenceIds: string[];
  partial: boolean;
  nominal?: number;
};

function responseMask(frame: Frame) {
  let mask = 0;
  for (let i = 0; i < 5; i++) {
    const wave = frame.match_wavelengths?.[i], width = frame.match_bandwidths?.[i];
    if (wave != null && width != null && Number.isFinite(wave) && Number.isFinite(width) && wave > 0 && width > 0)
      mask |= 1 << i;
  }
  return mask;
}

function compatible(a: Frame, b: Frame, tolerance: number) {
  const mask = responseMask(a) & responseMask(b);
  for (let i = 0; i < 5; i++) {
    if (!(mask & (1 << i))) continue;
    const width = Math.min(a.match_bandwidths![i]!, b.match_bandwidths![i]!);
    if (Math.abs(a.match_wavelengths![i]! - b.match_wavelengths![i]!) > tolerance * width) return false;
  }
  return true;
}

/** Whole-field sequence IDs stay intact. Raw blinking can also use a measured overlap. */
export function matchedSpectra(manifest: Manifest | null, choices: Record<string, boolean>, minimumDays?: number): MatchedSpectrum[] {
  if (!manifest?.frames.length) return [];
  const tolerance = manifest.processing?.spectral_tolerance ?? 0.5;
  const byId = new Map(manifest.frames.map(f => [f.id,f]));
  const visits = new Map((manifest.visits ?? []).flatMap(v => v.observation_ids.map(id => [id,v] as const)));
  const nominal = new Map<string, Frame[]>();
  for (const f of manifest.frames) {
    if (f.nominal_channel == null) continue;
    const id = spectrumId(f.detector, f.nominal_channel);
    if (!isNominalSpectrum(id)) continue;
    const group = nominal.get(id);
    if (group) group.push(f);
    else nominal.set(id,[f]);
  }
  const published: MatchedSpectrum[] = [...nominal].map(([id,frames]) => {
    const first = frames[0], detector = first.detector as Detector, channel = first.nominal_channel!;
    const versions = [...new Set(frames.map(f => f.processing_version).filter(Boolean))].join(", ");
    const sequence = {id, detector, wavelength_um:spectraTable[detector][channel-1].center_um,
      processing_version:versions || "unrecorded", frame_ids:frames.map(f => f.id), stretch:{}};
    return {...sequence, nominal:channel, sequenceIds:[...new Set(frames.flatMap(f => f.sequence_id ?? []))],
      partial:false, epochs:matchedEpochs(manifest, sequence, visits, choices, minimumDays)};
  });
  const groups: {s:Sequence; frames:Frame[]; mask:number; ids:string[]}[] = [];
  for (const s of manifest.sequences ?? []) {
    const frames = s.frame_ids.flatMap(id => byId.get(id) ?? []).filter(f => f.nominal_channel == null);
    if (!frames.length || !s.processing_version || s.processing_version === "unknown") continue;
    const mask = frames.reduce((m,f) => m & responseMask(f), 31);
    const group = groups.find(g => {
      if (g.s.detector !== s.detector || g.s.processing_version !== s.processing_version) return false;
      const shared = mask & g.mask;
      const corners = shared >> 1;
      // Require the center and at least two common off-center samples for the entire group.
      return !!(shared & 1) && !!(corners & (corners - 1)) &&
        frames.every(f => g.frames.every(other => compatible(f, other, tolerance)));
    });
    if (group) {
      group.frames.push(...frames);
      group.ids.push(s.id);
      group.mask &= mask;
    } else groups.push({s, frames, mask, ids:[s.id]});
  }
  const legacy = groups.map(({s,frames,mask,ids}) => {
    const sequence = {...s, frame_ids:frames.map(f => f.id)};
    return {...sequence, sequenceIds:ids, partial:ids.length > 1 && mask !== 31,
      epochs:matchedEpochs(manifest, sequence, visits, choices, minimumDays)};
  });
  return [...published,...legacy].filter(s => s.epochs.length).sort((a,b) => b.epochs.length - a.epochs.length ||
    a.detector.localeCompare(b.detector) || a.wavelength_um - b.wavelength_um);
}
