import { detectors } from "@/lib/imaging";
import { fieldKey, type BandDraft } from "@/lib/search-bands";
import type { Query } from "@/lib/types";
import { spectraTable, spectrumId, isNominalSpectrum, nominalLabel } from "@/lib/nominal-spectra";

export default function SearchBands({ query, draft, change }: {
  query: Query | null; draft: BandDraft; change: (value: BandDraft) => void;
}) {
  const field = fieldKey(query);
  const summary = detectors.filter(d => d in draft).map(d => {
    const choice = draft[d];
    if (!choice) return d + " · All spectra";
    if (!choice.labels.length || (choice.field !== field && choice.labels.some(s => !isNominalSpectrum(s))))
      return d + " · Choose spectra";
    return choice.labels.map(s => isNominalSpectrum(s) ? s : s.split(/\s+/).slice(0,3).join(" ")).join(", ");
  });
  return <details className="search-bands">
    <summary><strong>Bands</strong><span>{summary.join(" / ") || "Choose at least one band"}</span></summary>
    <div className="band-picker">{detectors.map(d => {
      const chosen = d in draft;
      const choice = draft[d];
      const labels = choice?.labels.filter(s => isNominalSpectrum(s) || choice.field === field) ?? [];
      const select = (id: string, on: boolean) => change({...draft,
        [d]:{field, labels:on ? [...labels,id] : labels.filter(s => s !== id)}});
      return <div key={d}>
        <label><input type="checkbox" aria-label={d + " detector"} checked={chosen} onChange={e => {
          const updated = { ...draft };
          if (e.target.checked) updated[d] = null;
          else delete updated[d];
          change(updated);
        }} />{d}</label>
        {chosen && <div className="band-options" role="group" aria-label={d + " spectra"}>
          <label><input type="checkbox" checked={!choice}
            onChange={e => change({...draft,[d]:e.target.checked ? null : {field,labels:[]}})} />All spectra</label>
          {spectraTable[d].map(row => {
            const id = spectrumId(d,row.channel);
            return <label key={id} title={`Calibrated pixel centers: ${row.min_um}–${row.max_um} µm`}>
              <input type="checkbox" checked={labels.includes(id)} onChange={e => select(id,e.target.checked)} />
              {nominalLabel(d,row.channel)}
            </label>;
          })}
          {labels.filter(s => !isNominalSpectrum(s)).map(s => <label key={s}>
            <input type="checkbox" checked onChange={() => select(s,false)} />{s} · saved field calibration
          </label>)}
        </div>}
      </div>;
    })}</div>
  </details>;
}
