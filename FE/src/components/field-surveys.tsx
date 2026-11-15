import { useEffect, useState } from "react";
import { request, ServiceError } from "@/lib/api";
import type { Query } from "@/lib/types";

type Infrared = {
  observed_at?: string;
  observation_id?: string;
  images: { band: string; source_url: string; preview?: string; warning?: string }[];
};
type Exposures = {
  bands: { band: string; count: number; latest: string; release: string; source_url: string }[];
  unavailable: string[];
};
type Catalog = {
  galaxies: { id: string; ra_deg: number; dec_deg: number; redshift: number; tracers: string[] }[];
  source_url: string;
};

function useSurvey<T>(name: string, ra: number, dec: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setData(null);
    request<T>(`/api/surveys/${name}`, controller.signal, { ra_deg: ra, dec_deg: dec }, 180000)
      .then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch(reason => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason : new Error("Lookup unavailable."));
      });
    return () => controller.abort();
  }, [name, ra, dec, attempt]);
  const missingIndex = error instanceof ServiceError && error.code === "desi_index_missing";
  const status = missingIndex ? (
    <p role="status">{error.message} Run <code>python scripts/prepare_desi.py</code> from the backend directory, then reopen Surveys.</p>
  ) : error ? (
    <p role="status">Lookup unavailable. <button className="button" onClick={() => setAttempt(n => n + 1)}>Retry</button></p>
  ) : !data ? <p role="status">Loading…</p> : null;
  return { data, status };
}

export default function FieldSurveys({ query }: { query: Query }) {
  const { ra_deg: ra, dec_deg: dec } = query;
  const wise = useSurvey<Infrared>("neowise", ra, dec);
  const euclid = useSurvey<Exposures>("euclid", ra, dec);
  const desi = useSurvey<Catalog>("desi", ra, dec);
  return (
    <section className="field-surveys" aria-label="Field surveys">
      <h2>Field surveys</h2>
      <p className="mono">{ra.toFixed(6)}°, {dec.toFixed(6)}°</p>
      <p>Archive coverage across all dates. Playback uses SPHEREx.</p>
      <section>
        <h3>NEOWISE</h3>
        <p>Final Release · latest paired W1/W2 exposures</p>
        {wise.status}
        {wise.data && (wise.data.images.length ? <>
          <p>{wise.data.observed_at?.slice(0, 10)} UTC · {wise.data.observation_id}</p>
          <div className="survey-images">{wise.data.images.map(image =>
            <a key={image.band} href={image.source_url} target="_blank" rel="noreferrer">
              {image.preview && <img src={image.preview} alt={`NEOWISE ${image.band} cutout`} />}
              {image.band} FITS ↗ {image.warning && <small>{image.warning}</small>}
            </a>
          )}</div>
        </> : <p>No paired exposures at this position.</p>)}
      </section>
      <section>
        <h3>Euclid</h3><p>Level 2 calibrated exposures · field center</p>
        {euclid.status}
        {euclid.data && <>
          {!euclid.data.bands.length && <p>No matching exposures in the releases searched successfully.</p>}
          {euclid.data.bands.map(b => <a className="survey-row" key={b.release + b.band} href={b.source_url} target="_blank" rel="noreferrer">
            <strong>{b.release} · {b.band}</strong><span>{b.count} exposures ↗</span>
            <small>Latest {b.latest.slice(0, 10)} UTC</small>
          </a>)}
          {euclid.data.unavailable.length > 0 && <p>Unavailable releases: {euclid.data.unavailable.join(", ")}</p>}
        </>}
      </section>
      <section>
        <h3>DESI</h3><p>DR1 LSS galaxies · 2.5′ radius</p>
        {desi.status}
        {desi.data && <>
          <p>{desi.data.galaxies.length} matching {desi.data.galaxies.length === 1 ? "galaxy" : "galaxies"}</p>
          {desi.data.galaxies.map(g => <div className="survey-row" key={g.id}>
            <strong>{g.tracers.join(", ")}</strong><span>z {g.redshift.toFixed(5)}</span>
            <small>{g.id} · {g.ra_deg.toFixed(5)}°, {g.dec_deg.toFixed(5)}°</small>
          </div>)}
          <a href={desi.data.source_url} target="_blank" rel="noreferrer">Source catalogs ↗</a>
        </>}
      </section>
    </section>
  );
}
