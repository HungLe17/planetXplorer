import { useEffect, useRef, useState } from "react";

const panels = {
  settings: "Query and display settings", inspector: "Frame details",
  catalog: "Aladin and known objects", observations: "Observations",
};
type Panel = keyof typeof panels;

function measure(panel: Panel, handle: HTMLDivElement) {
  const root = handle.closest<HTMLElement>(".app-layout")!;
  const box = handle.parentElement!.getBoundingClientRect();
  const viewer = root.querySelector(".viewer-section")!.getBoundingClientRect();
  const phone = matchMedia("(max-width: 700px)").matches;
  const overlay = matchMedia("(max-width: 1100px)").matches;
  const height = panel === "observations" || (panel === "settings" && phone);
  const size = height ? box.height : box.width;
  const min = height ? 85 : panel === "settings" ? 240 : panel === "catalog" ? 156 : 180;
  let max = height ? Math.min(innerHeight * 0.65, size + viewer.height - 170)
    : Math.min(700, size + viewer.width - 240);
  if (!height && panel === "settings") max = Math.min(max, innerWidth * 0.48);
  if (!overlay && (panel === "catalog" || panel === "inspector")) {
    const workspace = handle.closest(".workspace-grid")!;
    const both = workspace.classList.contains("with-catalog") && !workspace.classList.contains("inspector-collapsed");
    const fraction = both ? (panel === "catalog" ? 0.36 : 0.42) : 0.6;
    max = Math.min(max, workspace.clientWidth * fraction);
  }
  if (overlay && (panel === "catalog" || panel === "inspector")) {
    max = panel === "catalog" ? root.querySelector(".workspace-grid")!.clientWidth * 0.8 : innerWidth - 24;
  }
  return {root, height, size, min, max:Math.max(min, Math.floor(max)),
    sign:panel === "inspector" || panel === "observations" ? -1 : 1};
}

export default function PanelResizer({panel}: {panel:Panel}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{cursor:number; start:number} | null>(null);
  const [range, setRange] = useState({min:0, max:100, now:0, height:panel === "observations"});
  useEffect(() => {
    const handle = ref.current!;
    const update = () => {
      const {min,max,size,height} = measure(panel, handle);
      setRange({min,max,now:Math.round(size),height});
    };
    const observer = new ResizeObserver(update);
    observer.observe(handle.parentElement!);
    observer.observe(handle.closest(".app-layout")!);
    update();
    return () => observer.disconnect();
  }, [panel]);
  function resize(g: ReturnType<typeof measure>, size: number) {
    g.root.style.setProperty(`--${panel}-${g.height ? "height" : "width"}`,
      Math.round(Math.max(g.min, Math.min(g.max, size))) + "px");
  }
  return <div ref={ref} role="separator" tabIndex={0} aria-label={"Resize " + panels[panel]}
    aria-controls={panel + "-panel"}
    aria-orientation={range.height ? "horizontal" : "vertical"} aria-valuemin={range.min}
    aria-valuemax={range.max} aria-valuenow={range.now} aria-valuetext={range.now + " pixels"}
    className={"panel-resizer resizer-" + panel}
    onPointerDown={e => {
      if (e.button !== 0) return;
      const g = measure(panel, e.currentTarget);
      drag.current = {cursor:g.height ? e.clientY : e.clientX, start:g.size};
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.focus();
      e.preventDefault();
    }}
    onPointerMove={e => {
      if (!drag.current || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const g = measure(panel, e.currentTarget);
      const delta = (g.height ? e.clientY : e.clientX) - drag.current.cursor;
      resize(g, drag.current.start + g.sign * delta);
    }}
    onLostPointerCapture={() => { drag.current = null; }}
    onKeyDown={e => {
      const g = measure(panel, e.currentTarget);
      const increase = g.height ? "ArrowDown" : "ArrowRight";
      const decrease = g.height ? "ArrowUp" : "ArrowLeft";
      if (e.key !== increase && e.key !== decrease && e.key !== "Home" && e.key !== "End") return;
      e.preventDefault();
      const delta = (e.shiftKey ? 48 : 16) * g.sign * (e.key === increase ? 1 : -1);
      resize(g, e.key === "Home" ? g.min : e.key === "End" ? g.max : g.size + delta);
    }} />;
}
