"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { request, ServiceError } from "@/lib/api";
import type { Observation, Visit } from "@/lib/types";
import type { SpectrumBin } from "@/lib/imaging";
import { SpectrumGraph } from "@/components/spectrum";
import "./region.css";

type Exposure = Pick<Observation, "id" | "release" | "observed_at" | "detector">;
type Catalog = { discovering: false; records: Exposure[]; visits: Visit[]; count: number };
type Discovery = Catalog | { discovering: true; count: number };
type Measurement = {
  id: string;
  finite: number;
  pixels: number;
  covered: number;
  bins: Omit<SpectrumBin, "detector">[];
};
type Batch = { measurements: Measurement[]; errors: Record<string, string> };

function parseSelection(search: string) {
  const params = new URLSearchParams(search);
  const number = (key: string) => params.get(key)?.trim() ? Number(params.get(key)) : NaN;
  const raw = params.get("box")?.split(",") ?? [];
  const box = raw.map(value => value.trim() ? Number(value) : NaN);
  const width = number("width"), height = number("height");
  const ra = number("ra"), dec = number("dec"), fov = number("fov");
  if (!(ra >= 0 && ra < 360 && dec >= -90 && dec <= 90 && fov >= 30 && fov <= 1800) ||
      ![width, height].every(v => Number.isInteger(v) && v >= 1 && v <= 512) ||
      box.length !== 4 || !box.every(Number.isInteger) ||
      !(0 <= box[0] && box[0] <= box[2] && box[2] < width &&
        0 <= box[1] && box[1] <= box[3] && box[3] < height)) return null;
  return { ra_deg: ra, dec_deg: dec, fov_arcsec: fov, width, height, box };
}

const format = (n: number) => Number(n.toPrecision(6)).toString();

export default function RegionSpectrumPage() {
  const [aperture, setAperture] = useState<ReturnType<typeof parseSelection>>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [samples, setSamples] = useState<Record<string, Measurement>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("Reading selected region…");
  const [paused, setPaused] = useState(false);
  const [retry, setRetry] = useState(false);
  const [running, setRunning] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [activeVisit, setActiveVisit] = useState("");
  const session = useRef<{id: string; catalog: Catalog | null; samples: Record<string, Measurement>}>({
    id: "", catalog: null, samples: {},
  });

  useEffect(() => {
    const selection = parseSelection(window.location.search);
    setAperture(selection);
    if (!selection) setStatus("Invalid region link. Select a region in the viewer and open its spectrum again.");
  }, []);

  useEffect(() => {
    if (!aperture || paused) return;
    const controller = new AbortController();
    const signal = controller.signal;
    const state = session.current;
    async function run() {
      await Promise.resolve();
      if (signal.aborted) return;
      setRunning(true);
      setRetry(false);
      setErrors({});
      try {
        if (!state.id) {
          setStatus("Opening archive lookup…");
          const opened = await request<{id: string}>("/api/region-spectra", signal, aperture);
          signal.throwIfAborted();
          state.id = opened.id;
        }
        const path = "/api/region-spectra/" + encodeURIComponent(state.id);
        while (!state.catalog) {
          const page = await request<Discovery>(path + "/catalog", signal, {}, 90000);
          signal.throwIfAborted();
          if (page.discovering) setStatus(`Searching all archive dates · ${page.count} exposures found…`);
          else {
            state.catalog = page;
            setCatalog(page);
          }
        }
        const queue = state.catalog.records.filter(row => !state.samples[row.id]).map(row => row.id);
        let failures = 0;
        for (let i = 0; i < queue.length; i += 2) {
          setStatus(`Retrieving spectra · ${Object.keys(state.samples).length} of ${state.catalog.count} exposures measured…`);
          const batch = await request<Batch>(path + "/measure", signal, {ids: queue.slice(i, i + 2)}, 360000);
          signal.throwIfAborted();
          for (const row of batch.measurements) state.samples[row.id] = row;
          setSamples({...state.samples});
          failures += Object.keys(batch.errors).length;
          setErrors(previous => ({...previous, ...batch.errors}));
        }
        // Repeat visit validation with the measured wavelengths and pointing headers.
        const final = await request<Catalog>(path + "/catalog", signal, {}, 90000);
        signal.throwIfAborted();
        state.catalog = final;
        setCatalog(final);
        setRetry(failures > 0);
        setStatus(!final.count ? "No archived exposures intersect the selected region." :
          `${Object.keys(state.samples).length} of ${final.count} exposures measured${failures ? ` · ${failures} failed` : " · complete"}`);
      } catch (error) {
        if (!signal.aborted) {
          if (error instanceof ServiceError && error.code === "region_expired") {
            session.current = {id: "", catalog: null, samples: {}};
            setCatalog(null);
            setSamples({});
          }
          setStatus(error instanceof Error ? error.message : "Region lookup failed.");
          setRetry(true);
        }
      } finally {
        if (!signal.aborted) setRunning(false);
      }
    }
    void run();
    return () => controller.abort();
  }, [aperture, attempt, paused]);

  const visit = catalog?.visits.find(v => v.id === activeVisit) ?? catalog?.visits[0];
  const records = useMemo(() => new Map(catalog?.records.map(r => [r.id, r])), [catalog]);
  const rows = (visit?.observation_ids ?? []).map(id => records.get(id)!).filter(Boolean);
  const graph = rows.flatMap(row => (samples[row.id]?.bins ?? []).map(b => ({...b, detector: row.detector})))
    .sort((a, b) => a.wave - b.wave);
  const domain = useMemo(() => {
    let lo = 0.75, hi = 5, max = 1;
    for (const row of Object.values(samples)) for (const b of row.bins) {
      lo = Math.min(lo, b.wave);
      hi = Math.max(hi, b.wave);
      max = Math.max(max, b.mean);
    }
    return [lo, hi, 0, max];
  }, [samples]);

  return <main className="region-page">
    <header>
      <a href="/explore">planetXplorer</a>
      <h1>Region spectrum</h1>
      {aperture && <p>Field {format(aperture.ra_deg)}°, {format(aperture.dec_deg)}° ·
        {" "}Pixels ({aperture.box[0]+1}, {aperture.box[1]+1}) – ({aperture.box[2]+1}, {aperture.box[3]+1}) ·
        {" "}D1–D6 · All archive dates</p>}
    </header>
    <div className="region-progress">
      <p role="status">{paused ? "Lookup paused" : status}</p>
      {running && !paused && <button className="button" onClick={() => {setRunning(false); setPaused(true);}}>Pause lookup</button>}
      {paused && <button className="button" onClick={() => setPaused(false)}>Resume lookup</button>}
      {retry && !running && !paused && <button className="button" onClick={() => setAttempt(n => n + 1)}>Retry lookup</button>}
    </div>
    {visit && <section aria-label="Region measurements">
      <label htmlFor="region-visit">Observation cycle or supplemental group</label>
      <select id="region-visit" value={visit.id} onChange={e => setActiveVisit(e.target.value)}>
        {catalog!.visits.map(v => <option key={v.id} value={v.id}>
          {v.start_utc.slice(0, 10)} – {v.end_utc.slice(0, 10)} · {v.kind === "supplemental" ? "Additional exposures" : "Cycle"}
        </option>)}
      </select>
      <p>{rows.length} exposures · {visit.kind === "supplemental" ? "Supplemental coverage" :
        visit.status === "complete" ? "Verified cycle" : visit.status === "invalid" ? "Conflicting or incomplete coverage" : "Coverage pending validation"}</p>
      {!!visit.issues.length && <details><summary>Coverage details</summary><ul>{visit.issues.map(s => <li key={s}>{s}</li>)}</ul></details>}
      <SpectrumGraph title="Region" rows={graph} domain={domain} connect={visit.status === "complete" && visit.kind !== "supplemental"} />
      <div className="region-table"><table>
        <caption>Calibrated measurements by exposure</caption>
        <thead><tr><th>Exposure · UTC</th><th>Detector</th><th>Wavelength (µm)</th><th>Mean (MJy/sr)</th><th>Finite pixels</th></tr></thead>
        <tbody>{rows.flatMap(row => {
          const sample = samples[row.id];
          const name = <><strong>{row.id}</strong><br/>{row.observed_at.replace("T", " ").replace(/(Z|\+00:00)$/, "")} · {row.release}</>;
          return sample?.bins.length ? sample.bins.map((b, i) => <tr key={row.id + ":" + i}>
            <td>{name}</td><td>{row.detector}</td><td>{format(b.wave)}</td><td>{format(b.mean)}</td><td>{b.finite} / {sample.pixels}</td>
          </tr>) : [<tr key={row.id}><td>{name}</td><td>{row.detector}</td><td colSpan={3}>{errors[row.id] ??
            (sample ? (sample.covered ? "No finite spectral samples" : "Outside sampled pixels") : "Pending")}</td></tr>];
        })}</tbody>
      </table></div>
    </section>}
  </main>;
}
