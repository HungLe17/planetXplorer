import { useEffect, useState } from "react";
import { request } from "@/lib/api";
import type { Query } from "@/lib/types";

type SurveyImages = {
  observed_at?: string;
  images: {band:string; source_url:string; product_url?:string; observed_at?:string; preview?:string; warning?:string}[];
};

function SurveyColumn({survey, query}:{survey:"euclid-images"|"neowise";query:Query}) {
  const [data,setData] = useState<SurveyImages | null>(null);
  const [error,setError] = useState("");
  const [attempt,setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setData(null); setError("");
    request<SurveyImages>("/api/surveys/"+survey,abort.signal,
      {ra_deg:query.ra_deg,dec_deg:query.dec_deg},180000)
      .then(result => {if(!abort.signal.aborted)setData(result);})
      .catch(reason => {if(!abort.signal.aborted)setError(reason instanceof Error ? reason.message : "Archive lookup unavailable.");});
    return () => abort.abort();
  },[survey,query.ra_deg,query.dec_deg,attempt]);
  const title = survey === "neowise" ? "NEOWISE" : "EUCLID";
  return <section className="survey-comparison-column" aria-label={title+" images"}>
    <h3>{title}</h3>
    <p>{survey === "neowise" ? "Latest paired W1/W2 · 4′ cutouts" : "MER background-subtracted mosaics · 30″ cutouts"}</p>
    <p>Native archive grid and date · independent intensity scale</p>
    {!data && !error && <p role="status">Finding coverage and loading cutouts…</p>}
    {error && <p role="status">{error} <button onClick={()=>setAttempt(n=>n+1)}>Retry {title}</button></p>}
    {data && !data.images.length && <p>No image coverage found at this position.</p>}
    <div className="survey-comparison-images">{data?.images.map(image => <figure key={image.source_url}>
      <figcaption>{image.band} · {(image.observed_at ?? data.observed_at)?.slice(0,10) ?? "Archive epoch"}</figcaption>
      {image.preview && <img src={image.preview} alt={title+" "+image.band+" archive cutout preview"} />}
      {image.warning && <p>{image.warning}</p>}
      <a href={image.source_url} target="_blank" rel="noreferrer">Download FITS cutout ↗</a>
      {image.product_url && <a href={image.product_url} target="_blank" rel="noreferrer">Original science FITS ↗</a>}
    </figure>)}</div>
    {data && <p>Asinh preview of archive science data. FITS links retain the original measurements.</p>}
  </section>;
}

export default function SurveyComparison({query}:{query:Query|null}) {
  const [open,setOpen] = useState(false);
  return <details className="survey-comparison" onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>EUCLID / NEOWISE comparison</summary>
    {open && (query ? <div className="survey-comparison-grid">
      <SurveyColumn survey="euclid-images" query={query}/>
      <SurveyColumn survey="neowise" query={query}/>
    </div> : <p>Search a sky position to inspect archive images.</p>)}
  </details>;
}
