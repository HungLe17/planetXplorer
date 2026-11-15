import { useEffect, useMemo, useState } from "react";
import PanelResizer from "./panel-resizer";
import { request } from "@/lib/api";
import type { Frame, Manifest, Query } from "@/lib/types";
import { catalogPosition, projectMarker, type CatalogResult, type Marker, type MovingResult } from "@/lib/known-objects";

type Timed<T> = { value: T; until: number };
const catalogs = new Map<string, Timed<CatalogResult>>();
const ephemerides = new Map<string, Timed<MovingResult>>();
const hour = 3600000;
function remember<T>(cache: Map<string, Timed<T>>, key: string, value: T, lifetime: number) {
  if (cache.size >= 512) cache.delete(cache.keys().next().value!);
  cache.set(key, {value, until:Date.now() + lifetime});
}
type DatedResult = {utc:string; result:MovingResult};
export function useKnownObjects(enabled: boolean, moving: boolean, query: Query | null,
  manifest: Manifest | null, contributors: Frame[], job: string, epoch: string) {
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [movingRefresh, setMovingRefresh] = useState(0);
  const shape = manifest?.processing?.output_shape;
  const width = shape?.[1] ?? 0, height = shape?.[0] ?? 0;
  const grid = manifest?.processing?.grid_header;
  const field = query && {ra_deg:query.ra_deg, dec_deg:query.dec_deg, fov_arcsec:query.fov_arcsec ?? 300};
  const dates = manifest?.observations?.length ? manifest.observations : manifest?.frames;
  const range = useMemo(() => {
    const times = dates?.map(r => r.observed_at).filter(Boolean).sort();
    return times?.length ? [times[0], times[times.length-1]] : [];
  }, [dates]);
  const catalogKey = enabled && field && epoch && JSON.stringify({...field,start_utc:range[0] ?? epoch,end_utc:range[1] ?? epoch});
  const [catalog, setCatalog] = useState<{key:string; value?:CatalogResult; error?:string} | null>(null);
  const epochs = useMemo(() => {
    const times = new Map<string, Frame>();
    for (const f of contributors) times.set(f.midpoint_utc || f.observation_id, f);
    return [...times.values()];
  }, [contributors]);
  const list = enabled && moving && field && epochs.length ? JSON.stringify(epochs.map(f => ({
    ...field, ...(f.midpoint_utc ? {midpoint_utc:f.midpoint_utc} : {job_id:job, observation_id:f.observation_id}),
  }))) : "";
  const [solar, setSolar] = useState<{key:string; dates:DatedResult[]; done:number; warnings:string[]} | null>(null);
  useEffect(() => {
    if (!catalogKey) return;
    const abort = new AbortController();
    const cached = catalogs.get(catalogKey);
    let timer: ReturnType<typeof setTimeout>;
    const refreshAfter = (ms: number) => {
      timer = setTimeout(() => setCatalogRefresh(n => n + 1), Math.max(1000, ms));
    };
    if (cached && cached.until > Date.now()) {
      setCatalog({key:catalogKey, value:cached.value});
      refreshAfter(cached.until - Date.now());
    } else {
      setCatalog({key:catalogKey});
      request<CatalogResult>("/api/known-objects/catalog",abort.signal,JSON.parse(catalogKey),110000)
        .then(value => {
          if (abort.signal.aborted) return;
          const lifetime = value.warnings.length ? 60000 : hour;
          remember(catalogs,catalogKey,value,lifetime);
          setCatalog({key:catalogKey,value});
          refreshAfter(lifetime);
        }).catch((error: Error) => {
          if (!abort.signal.aborted) {
            setCatalog({key:catalogKey,error:error.message || "Catalog lookup unavailable."});
            refreshAfter(60000);
          }
        });
    }
    return () => { abort.abort(); clearTimeout(timer); };
  }, [catalogKey,catalogRefresh]);
  useEffect(() => {
    if (!list) return;
    const abort = new AbortController();
    const bodies = JSON.parse(list) as {midpoint_utc?:string}[];
    const dates: DatedResult[] = [], warnings = new Set<string>();
    let refreshTimer: ReturnType<typeof setTimeout>;
    const load = async () => {
      setSolar({key:list,dates:[],done:0,warnings:[]});
      for (const [i, body] of bodies.entries()) {
        const key = JSON.stringify(body), cached = ephemerides.get(key);
        try {
          const value = cached && cached.until > Date.now() ? cached.value :
            await request<MovingResult>("/api/known-objects/moving",abort.signal,body,270000);
          if (abort.signal.aborted) return;
          if (!cached || cached.until <= Date.now()) remember(ephemerides,key,value,value.warnings.length ? 60000 : hour);
          value.warnings.forEach(w=>warnings.add(w));
          const utc = value.midpoint_utc || body.midpoint_utc;
          if (utc) dates.push({utc,result:value});
        } catch {
          if (abort.signal.aborted) return;
          warnings.add("A moving-object lookup is unavailable.");
        }
        setSolar({key:list,dates:[...dates],done:i+1,warnings:[...warnings]});
      }
      const nextExpiry = Math.min(...bodies.map(body => ephemerides.get(JSON.stringify(body))?.until ?? Date.now()+60000));
      refreshTimer = setTimeout(() => setMovingRefresh(n => n + 1), Math.max(1000, nextExpiry-Date.now()));
    };
    void load();
    return () => { abort.abort(); clearTimeout(refreshTimer); };
  }, [list,movingRefresh]);
  const fixed = catalog && catalog.key === catalogKey ? catalog : null;
  const current = solar?.key === list ? solar : null;
  const markers = useMemo(() => {
    const points: Marker[] = [];
    if (!query || !epoch || !enabled) return points;
    for (const star of fixed?.value?.objects ?? []) {
      const pos = catalogPosition(star,epoch);
      const xy = projectMarker(query,grid,width,height,pos.ra_deg,pos.dec_deg);
      if (xy) points.push({...star,...pos,...xy,key:star.id,moving:false});
    }
    const seen = new Set<string>();
    for (const {utc,result} of current?.dates ?? []) {
      for (const obj of result.objects) {
        const key = obj.id + "@" + utc;
        const xy = projectMarker(query,grid,width,height,obj.ra_deg,obj.dec_deg);
        if (xy && !seen.has(key)) {
          seen.add(key);
          points.push({...obj,...xy,key,moving:true,type:obj.category || obj.type,source:"JPL",
            epoch:"Exposure midpoint · " + utc});
        }
      }
    }
    return points;
  }, [enabled,query,grid,width,height,epoch,fixed,current]);
  return {markers, fetched:fixed?.value?.fetched_at, solarFetched:current?.dates.at(-1)?.result.fetched_at,
    looking:!!catalogKey && !fixed?.value && !fixed?.error,
    progress:list ? [current?.done ?? 0,epochs.length] : null,
    warnings:[...(fixed?.error ? [fixed.error] : fixed?.value?.warnings ?? []),...(current?.warnings ?? [])],
    retry:() => {
      if (catalogKey) catalogs.delete(catalogKey);
      if (list) for (const body of JSON.parse(list)) ephemerides.delete(JSON.stringify(body));
      setCatalogRefresh(n=>n+1);
      setMovingRefresh(n=>n+1);
    }};
}

export function ObjectInfo({point}: {point:Marker}) {
  return <div className="object-info">
    <strong>{point.name}</strong>
    <span>{point.type} · {point.source}</span>
    {point.id !== point.name && <small>{point.id}</small>}
    <span className="mono">{point.ra_deg.toFixed(6)}°, {point.dec_deg.toFixed(6)}°</span>
    <small>{point.epoch}</small>
    {point.source_url?.startsWith("https://") && <a href={point.source_url} target="_blank" rel="noreferrer">Source record ↗</a>}
  </div>;
}

export function ObjectPanel({query, data, chosen, select, moving, toggleMoving, times, epoch, changeEpoch, close}: {
  query: Query; data:ReturnType<typeof useKnownObjects>; chosen:Marker | undefined; select:(key:string)=>void;
  moving:boolean; toggleMoving:(b:boolean)=>void; times:string[]; epoch:string; changeEpoch:(s:string)=>void; close:()=>void;
}) {
  const atlas = new URL("https://aladin.cds.unistra.fr/AladinLite/");
  atlas.searchParams.set("ra",String(query.ra_deg));
  atlas.searchParams.set("dec",String(query.dec_deg));
  atlas.searchParams.set("fov",String((query.fov_arcsec ?? 300)/3600));
  atlas.searchParams.set("theme","dark");
  return <aside className="catalog-window" id="catalog-panel" aria-label="Aladin and known objects">
    <PanelResizer panel="catalog" />
    <div className="catalog-scroll">
    <div className="catalog-window-title"><h2>Known objects</h2><button type="button" aria-label="Close known objects" onClick={close}>×</button></div>
    <iframe title="Aladin Lite sky atlas" src={atlas.href} loading="lazy" referrerPolicy="no-referrer" />
    <a href={atlas.href} target="_blank" rel="noreferrer">Open Aladin Lite ↗</a>
    {times.length > 1 && <label>Stellar position epoch<select value={epoch} onChange={e=>changeEpoch(e.target.value)}>
      {times.map(t=><option key={t}>{t}</option>)}</select></label>}
    <label><input type="checkbox" checked={moving} onChange={e=>toggleMoving(e.target.checked)} /> Asteroids and comets</label>
    <div role="status">{data.looking ? "Searching catalogs…" : data.markers.length + " positions on image"}
      {data.progress && <small>Moving-object epochs · {data.progress[0]}/{data.progress[1]}</small>}</div>
    {!!data.markers.length && <label>Object on image<select value={chosen?.key ?? ""} onChange={e=>select(e.target.value)}>
      <option value="">Select a circle or object</option>
      {data.markers.map(m=><option key={m.key} value={m.key}>{m.name}{m.moving ? " · "+m.epoch : ""}</option>)}</select></label>}
    {chosen && <ObjectInfo point={chosen} />}
    {!!data.warnings.length && <div role="status">{data.warnings.map(w=><p key={w}>{w}</p>)}
      <button className="button" onClick={data.retry}>Retry lookup</button></div>}
    {data.fetched && <small>Catalog lookup · {data.fetched}</small>}
    {data.solarFetched && <small>JPL lookup · {data.solarFetched}</small>}
    </div>
  </aside>;
}
