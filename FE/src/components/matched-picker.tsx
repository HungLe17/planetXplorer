import { useRef } from "react";
import { detectors } from "@/lib/imaging";
import type { MatchedSpectrum } from "@/lib/matched-spectra";

function caption(s: MatchedSpectrum) {
  const channel = s.nominal ? s.id + " · " + s.wavelength_um.toFixed(3) : s.wavelength_um.toFixed(6);
  return `${channel} µm · ${s.epochs.length} ${s.epochs.length === 1 ? "epoch" : "epochs"}`;
}

export default function MatchedPicker({spectra, selected, currentId, select, stamp, allInputs, selectAll}: {
  allInputs?: boolean;
  selectAll?: () => void;
  spectra: MatchedSpectrum[];
  selected: MatchedSpectrum;
  currentId?: string;
  select: (id: string, frame: string) => void;
  stamp: (date: string) => string;
}) {
  const picker = useRef<HTMLDetailsElement>(null);
  return <details className="matched-picker" ref={picker}>
    <summary aria-label="Matched spectra">{allInputs ? "All map inputs" : <>{!selected.nominal && selected.detector+" · "}{caption(selected)}{selected.partial && " · partial coverage"}</>}</summary>
    <div className="matched-options">
      {selectAll && <button type="button" onClick={() => {
        selectAll(); if (picker.current) picker.current.open=false;
      }}>All map inputs</button>}
      {detectors.map(detector => {
        const bands = spectra.filter(s => s.detector === detector);
        return bands.length > 0 && <details key={detector} open={selected.detector === detector}>
          <summary aria-label={detector + " spectra"}>{detector}</summary>
          {bands.map(s => <details key={s.id} open={s.id === selected.id}>
            <summary aria-label={`${detector} ${caption(s)} · ${s.processing_version}`}
              onClick={event => {
                if (selected.id !== s.id) {
                  // Selecting opens this spectrum; keep the native toggle from closing it again.
                  event.preventDefault();
                  select(s.id, s.epochs[0].source.observation_id);
                }
              }}>
              {caption(s)} <small>{!s.nominal && "field calibration · "}{s.processing_version}{s.partial && " · partial coverage"}</small>
            </summary>
            {s.epochs.map(({source}) => <button key={source.observation_id} type="button"
              aria-pressed={s.id === selected.id && source.observation_id === currentId}
              onClick={() => {
                select(s.id, source.observation_id);
                if (picker.current) picker.current.open = false;
              }}>{stamp(source.observed_at)} {source.wavelength_um != null &&
                <small>· {source.wavelength_um.toFixed(6)} µm measured</small>}</button>)}
          </details>)}
        </details>;
      })}
    </div>
  </details>;
}
