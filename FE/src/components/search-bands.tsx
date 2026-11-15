import { useEffect, useRef, useState } from "react";
import { request } from "@/lib/api";
import { detectors } from "@/lib/imaging";
import { fieldKey, type BandDraft } from "@/lib/search-bands";
import type { Detector, Query } from "@/lib/types";

type Page = { channels: string[]; next_cursor: number | null; unavailable: number; total: number };

function Subbands({ detector, query, labels, change }: {
  detector: Detector; query: Query | null; labels: string[] | null; change: (labels: string[] | null) => void;
}) {
  const [options, setOptions] = useState<string[]>(labels ?? []);
  const [next, setNext] = useState<number | null>(0);
  const [missing, setMissing] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function discover(cursor: number) {
    if (!query || busy) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    try {
      const page = await request<Page>(`/api/archive/channels/${detector}?cursor=${cursor}`, abort.signal, query, 90000);
      if (abort.signal.aborted) return;
      setOptions(old => [...new Set([...old, ...page.channels])].sort((a, b) => a.localeCompare(b, "en", {numeric:true})));
      if (cursor === next) setNext(page.next_cursor);
      setMissing(old => [...old.filter(n => n !== cursor), ...(page.unavailable ? [cursor] : [])]);
    } catch {
      if (!abort.signal.aborted) {
        setError("Wavelength lookup failed.");
        setMissing(old => old.includes(cursor) ? old : [...old, cursor]);
      }
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  }
  return <div className="band-options">
    <label><input type="checkbox" checked={labels === null} onChange={() => change(labels === null ? [] : null)} />All subbands</label>
    {options.map(label => <label key={label}><input type="checkbox" checked={!!labels?.includes(label)}
      onChange={e => change(e.target.checked ? [...(labels ?? []), label] : labels!.filter(l => l !== label))} />{label}</label>)}
    {next !== null && !missing.includes(next) && <button className="button" type="button" disabled={!query || busy} onClick={() => discover(next)}>
      {next === 0 ? "Find subbands" : "Find more subbands"}</button>}
    {missing.length > 0 && <button className="button" type="button" disabled={busy} onClick={() => discover(missing[0])}>Retry wavelength lookup</button>}
    <small role="status">{busy ? "Reading wavelength metadata…" : error || (missing.length ? "Some wavelength metadata is unavailable." :
      !query ? "Enter the field coordinates to find subbands." : next === null && !options.length ? "No subbands found for this field." : "")}</small>
  </div>;
}
export default function SearchBands({ query, draft, change }: {
  query: Query | null; draft: BandDraft; change: (value: BandDraft) => void;
}) {
  const field = fieldKey(query);
  const summary = detectors.filter(d => d in draft).map(d => {
    const sub = draft[d];
    if (!sub) return d + " · All subbands";
    if (sub.field !== field || !sub.labels.length) return d + " · Choose subbands";
    return d + " · " + sub.labels.map(label => label.split(/\s+/)[1] + " µm").join(", ");
  });
  return <details className="search-bands">
    <summary><strong>Bands</strong><span>{summary.join(" / ") || "Choose at least one band"}</span></summary>
    <div className="band-picker">{detectors.map(d => {
      const chosen = d in draft;
      const sub = draft[d];
      return <div key={d}>
        <label><input type="checkbox" aria-label={d + " detector"} checked={chosen} onChange={e => {
          const updated = { ...draft };
          if (e.target.checked) updated[d] = null;
          else delete updated[d];
          change(updated);
        }} />{d}</label>
        {chosen && <div key={field} role="group" aria-label={d + " subbands"}>
          {sub && sub.field !== field && <small>Field changed. Choose subbands for this field.</small>}
          <Subbands detector={d} query={query} labels={sub ? sub.field === field ? sub.labels : [] : null}
            change={labels => change({ ...draft, [d]: labels === null ? null : { field, labels } })} />
        </div>}
      </div>;
    })}</div>
  </details>;
}
