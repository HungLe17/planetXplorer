"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import type { Frame } from "@/lib/types";
export default function SkyViewer({
  frames,
  index,
  onReady,
  onFailure,
  zoom: magnification,
  onZoom,
  invert,
  grid,
}: {
  zoom: number;
  onZoom: (zoom: number) => void;
  invert: boolean;
  grid?: string;
  frames: Frame[];
  index: number;
  onReady: (ready: boolean) => void;
  onFailure: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    box = useRef<HTMLDivElement>(null),
    images = useRef<HTMLImageElement[]>([]),
    drag = useRef<{ x: number; y: number } | null>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const [loaded, setLoaded] = useState(0);
  useEffect(() => {
    let alive = true;
    images.current = [];
    setLoaded(0);
    setView({ scale: 1, x: 0, y: 0 });
    onZoom(1);
    onReady(false);
    if (!frames.length) return;
    Promise.all(
      frames.map(
        (f) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image();
            const timer = setTimeout(() => {
              image.src = "";
              reject(new Error("Image timeout"));
            }, 30000);
            image.onload = () => {
              clearTimeout(timer);
              resolve(image);
            };
            image.onerror = () => {
              clearTimeout(timer);
              reject(new Error("Image unavailable"));
            };
            image.src = f.url;
          }),
      ),
    )
      .then((result) => {
        if (alive) {
          images.current = result;
          setLoaded(result.length);
          onReady(true);
        }
      })
      .catch(() => {
        if (alive) onFailure();
      });
    return () => {
      alive = false;
    };
  }, [frames, onReady, onFailure, onZoom]);
  useLayoutEffect(() => {
    const draw = () => {
      const c = canvas.current,
        b = box.current;
      if (!c || !b) return;
      const rect = b.getBoundingClientRect(),
        ratio = window.devicePixelRatio || 1;
      c.width = rect.width * ratio;
      c.height = rect.height * ratio;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.scale(ratio, ratio);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const img = images.current[index];
      if (!img) return;
      const fit =
        Math.min(rect.width / img.width, rect.height / img.height) * 0.94;
      const w = img.width * fit * magnification,
        h = img.height * fit * magnification;
      ctx.imageSmoothingEnabled = false;
      ctx.filter = invert ? "invert(1)" : "none";
      ctx.drawImage(
        img,
        (rect.width - w) / 2 + view.x,
        (rect.height - h) / 2 + view.y,
        w,
        h,
      );
    };
    draw();
    const observer = new ResizeObserver(draw);
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, [index, loaded, view, magnification, invert]);
  const zoom = (n: number) =>
    onZoom(Math.max(1, Math.min(8, magnification * n)));
  return (
    <div className="sky-shell">
      <div
        className={"sky-canvas " + (frames.length ? "has-image" : "")}
        ref={box}
      >
        <canvas
          ref={canvas}
          aria-label={
            frames.length
              ? `Observation ${index + 1} of ${frames.length}. ${frames[index]?.observed_at}`
              : "No observation loaded"
          }
          onPointerDown={(e) => {
            if (!frames.length) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerMove={(e) => {
            if (drag.current) {
              const dx = e.clientX - drag.current.x,
                dy = e.clientY - drag.current.y;
              setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
              drag.current = { x: e.clientX, y: e.clientY };
            }
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        />
        {!frames.length && (
          <div className="sky-empty">
            <h2>No observation loaded</h2>
            <p>Enter coordinates to load observations.</p>
          </div>
        )}
        {!!frames.length && !loaded && (
          <div className="sky-empty">
            <p>Preparing observation images…</p>
          </div>
        )}
        {!!frames.length && grid?.includes("north up") && (
          <div className="orientation" aria-label="North up, east left">
            <span>N</span>
            <div>↑</div>
            <span>E ←</span>
          </div>
        )}
      </div>
      <div className="sky-bottom">
        <div className="zoom-buttons">
          <button
            aria-label="Zoom out"
            disabled={!loaded || magnification === 1}
            onClick={() => zoom(1 / 1.25)}
          >
            <Minus size={14} />
          </button>
          <span>{Math.round(magnification * 100)}%</span>
          <button
            aria-label="Zoom in"
            disabled={!loaded || magnification === 8}
            onClick={() => zoom(1.25)}
          >
            <Plus size={14} />
          </button>
          <button
            aria-label="Reset viewport"
            disabled={!loaded}
            onClick={() => {
              setView({ scale: 1, x: 0, y: 0 });
              onZoom(1);
            }}
          >
            <Maximize2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
