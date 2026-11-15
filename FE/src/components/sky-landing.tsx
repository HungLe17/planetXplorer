"use client";

import { useEffect, useRef, useState } from "react";
import { explorerHref, skyTargets, viewingPresets } from "@/lib/exploration-presets";
import { customSkyTarget, type SkyClick } from "@/lib/sky-selection";

type SkyTarget = (typeof skyTargets)[number];
type Source = { data?: { id?: string } };
type Catalog = { addSources: (sources: unknown[]) => void; removeAll: () => void };
type Atlas = {
  gotoRaDec: (ra: number, dec: number) => void;
  setFoV: (degrees: number) => void;
  getRaDec: () => [number, number];
  addCatalog: (catalog: unknown) => void;
  on: (event: "click", callback: (position: SkyClick) => void) => void;
};
type AladinApi = {
  init: Promise<unknown>;
  aladin: (container: string, options: Record<string, unknown>) => Atlas;
  catalog: (options: Record<string, unknown>) => Catalog;
  source: (ra: number, dec: number, data: Record<string, string>) => unknown;
};

let atlasLoader: Promise<AladinApi> | undefined;
function loadAtlas() {
  if (!atlasLoader) {
    atlasLoader = new Promise<AladinApi>((resolve, reject) => {
      const existing = (window as unknown as { A?: AladinApi }).A;
      if (existing) { void existing.init.then(() => resolve(existing), reject); return; }
      const script = document.createElement("script");
      script.src = "https://aladin.cds.unistra.fr/aladin_3.9.0-beta.js";
      script.async = true;
      const timer = window.setTimeout(() => reject(new Error("Sky atlas connection timed out.")), 25000);
      script.onload = () => {
        window.clearTimeout(timer);
        const api = (window as unknown as { A?: AladinApi }).A;
        if (!api) { reject(new Error("Sky atlas could not initialize.")); return; }
        void api.init.then(() => resolve(api), reject);
      };
      script.onerror = () => {
        window.clearTimeout(timer);
        script.remove();
        reject(new Error("The sky atlas is temporarily unavailable."));
      };
      document.head.appendChild(script);
    }).catch(error => { atlasLoader = undefined; throw error; });
  }
  return atlasLoader;
}

export default function SkyLanding() {
  const container = useRef<HTMLDivElement>(null);
  const atlas = useRef<Atlas | null>(null);
  const atlasApi = useRef<AladinApi | null>(null);
  const selectionCatalog = useRef<Catalog | null>(null);
  const [selected, setSelected] = useState<SkyTarget>(skyTargets[0]);
  const [preset, setPreset] = useState(viewingPresets[0].id);
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState("Connecting to the sky atlas…");
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [survey, setSurvey] = useState("https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color");
  const visible = skyTargets.filter(target =>
    `${target.name} ${target.description}`.toLowerCase().includes(filter.toLowerCase()));
  const activePreset = viewingPresets.find(item => item.id === preset) ?? viewingPresets[0];

  useEffect(() => {
    let cancelled = false;
    const host = container.current;
    if (!host) return;
    setFailed(false);
    setStatus("Connecting to the sky atlas…");
    void loadAtlas().then(api => {
      if (cancelled) return;
      const view = api.aladin("#landing-sky-atlas", {
        survey, target: "270 +15", fov: 250, projection: "AIT", cooFrame: "ICRSd",
        showLayersControl: false, showGotoControl: false, showShareControl: false,
        showFullscreenControl: false, showZoomControl: true, showReticle: false,
      });
      atlas.current = view;
      atlasApi.current = api;
      let objectClickHandled = false;
      const catalog = api.catalog({
        name: "Places to explore", color: "#b7edce", shape: "circle", sourceSize: 17,
        displayLabel: true, labelColumn: "name", labelColor: "#f2fff8",
        labelFont: "12px sans-serif",
        onClick: (source: Source) => {
          const target = skyTargets.find(item => item.id === source?.data?.id);
          if (target) { objectClickHandled = true; setSelected(target); }
        },
      });
      catalog.addSources(skyTargets.map(target => api.source(target.ra_deg, target.dec_deg,
        { id: target.id, name: target.name })));
      view.addCatalog(catalog);
      selectionCatalog.current = api.catalog({
        name: "Selected sky position", color: "#ffe6a2", shape: "cross", sourceSize: 22,
        displayLabel: true, labelColumn: "name", labelColor: "#ffe6a2",
        onClick: () => { objectClickHandled = true; },
      });
      view.addCatalog(selectionCatalog.current);
      view.on("click", position => {
        const handled = objectClickHandled;
        objectClickHandled = false;
        if (handled) return;
        const target = customSkyTarget(position);
        if (target) setSelected(target);
      });
      setStatus("Click anywhere to choose a field · Drag to travel · Scroll to zoom");
    }).catch(error => {
      if (!cancelled) { setFailed(true); setStatus(error instanceof Error ? error.message : "Sky atlas unavailable."); }
    });
    return () => {
      cancelled = true;
      atlas.current = null;
      atlasApi.current = null;
      selectionCatalog.current = null;
      host.replaceChildren();
    };
  }, [attempt, survey]);

  useEffect(() => {
    const catalog = selectionCatalog.current;
    const api = atlasApi.current;
    if (!catalog || !api) return;
    catalog.removeAll();
    if (selected.id === "custom") {
      catalog.addSources([api.source(selected.ra_deg, selected.dec_deg, { name: "Selected position" })]);
    }
  }, [selected, status]);

  function focus(target: SkyTarget) {
    setSelected(target);
    atlas.current?.gotoRaDec(target.ra_deg, target.dec_deg);
    atlas.current?.setFoV(Math.max(1.5, target.fov_arcsec / 360));
  }

  function openCenter() {
    const position = atlas.current?.getRaDec();
    if (!position) return;
    const target = customSkyTarget({ ra: position[0], dec: position[1] });
    if (!target) return;
    window.location.assign(explorerHref(target, preset));
  }

  return <main className="sky-landing">
    <div id="landing-sky-atlas" ref={container} className="landing-atlas" aria-label="Interactive sky atlas" />
    <div className="landing-shade" />
    <header className="landing-header">
      <a className="landing-brand" href="/" aria-label="PlanetXplorer home"><span className="landing-orbit">✦</span> planet<span>X</span>plorer</a>
      <div className="landing-header-note"><span /> A window into the infrared universe</div>
      <a className="landing-text-link" href={explorerHref(selected, preset)}>Open explorer <span>↗</span></a>
    </header>

    <aside className="landing-panel" aria-label="Choose a sky destination">
      <p className="landing-eyebrow">START WITH A LITTLE CURIOSITY</p>
      <h1>The sky is<br />your starting point.</h1>
      <p className="landing-intro">Click anywhere on the sky to choose a field, or start with a familiar destination. Then open it in the explorer.</p>
      <label className="landing-search"><span>⌕</span><input type="search" placeholder="Find a destination…" value={filter} onChange={event => setFilter(event.target.value)} aria-label="Find a destination" /><kbd>SKY</kbd></label>
      <div className="landing-section-label"><span>PLACES TO EXPLORE</span><span>{visible.length.toString().padStart(2, "0")}</span></div>
      <div className="landing-targets">
        {visible.map((target, index) => <button className={selected.id === target.id ? "landing-target selected" : "landing-target"} key={target.id} onClick={() => focus(target)}>
          <span className="landing-target-index">{(index + 1).toString().padStart(2, "0")}</span>
          <span><strong>{target.name}</strong><small>{target.description}</small></span><span className="landing-target-arrow">↗</span>
        </button>)}
        {!visible.length && <p className="landing-empty">No matching destination. Pan the map and open its center to explore any position.</p>}
      </div>
      <div className="landing-panel-footer"><span className="landing-live-dot" /> Actual sky imagery · Local target guide</div>
    </aside>

    <div className="landing-map-tools">
      <label>Background sky<select value={survey} onChange={event => setSurvey(event.target.value)}><option value="https://irsa.ipac.caltech.edu/data/hips/CDS/2MASS/Color">2MASS infrared</option><option value="P/DSS2/color">DSS optical</option></select></label>
      <button onClick={() => { atlas.current?.gotoRaDec(270, 15); atlas.current?.setFoV(250); }}>All sky <span>↺</span></button>
    </div>

    <section className="landing-launch" aria-label="Open a sky field">
      <div className="landing-launch-heading"><span className="landing-eyebrow">YOUR NEXT DESTINATION</span><span>↗</span></div>
      <h2>{selected.name}</h2>
      <div className="landing-coordinates">RA {selected.ra_deg.toFixed(4)}° <span> / </span> DEC {selected.dec_deg.toFixed(4)}°</div>
      {selected.id === "custom" && <p className="landing-preset-description">{selected.description}</p>}
      <label className="landing-preset-label">View it through<select value={preset} onChange={event => setPreset(event.target.value)} aria-label="Viewing preset">{viewingPresets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <p className="landing-preset-description">{activePreset.description}</p>
      <a className="landing-launch-button" href={explorerHref(selected, preset)}>Explore this field <span>→</span></a>
      <button className="landing-center-button" onClick={openCenter} disabled={failed || !atlas.current}>Or explore the current map center</button>
    </section>

    <div className="landing-map-status" role="status"><span className={failed ? "landing-status-error" : "landing-live-dot"} />{status}{failed && <button onClick={() => setAttempt(value => value + 1)}>Retry atlas</button>}</div>
    <div className="landing-survey-credit">SKY BACKGROUND: {survey.includes("2MASS") ? "2MASS" : "DSS"} / CDS ALADIN<br />SPHEREx observations load when you open a field.</div>
  </main>;
}
