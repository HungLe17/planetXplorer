"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minus, Plus } from "lucide-react";
import { download } from "@/lib/workspace";
import {
  exportName,
  intensityByte,
  type Display,
  type RenderedFrame,
} from "@/lib/imaging";
import type { Query } from "@/lib/types";
import { useAssets } from "@/lib/use-assets";
type FrameImage = HTMLCanvasElement | HTMLImageElement;
function loadPreview(url: string, signal: AbortSignal) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    const stop = () => {
      image.removeAttribute("src");
      reject(signal.reason);
    };
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    image.onload = () => {
      signal.removeEventListener("abort", stop);
      resolve(image);
    };
    image.onerror = () => {
      signal.removeEventListener("abort", stop);
      reject(new Error("Image unavailable"));
    };
    image.crossOrigin = "anonymous";
    image.src = url;
  });
}
export default function SkyViewer({
  frames,
  index,
  onReady,
  onFailure,
  onPaint,
  zoom: magnification,
  onZoom,
  invert,
  grid,
  display,
  update,
  query,
  bounds,
  colors,
  onPixel,
  message,
}: {
  zoom: number;
  onZoom: (zoom: number) => void;
  invert: boolean;
  grid?: string;
  display: Display;
  update: (p: Partial<Display>) => void;
  query: Query | null;
  bounds: number[];
  colors: number[][];
  onPixel: (x: number, y: number) => void;
  message: string;
  frames: RenderedFrame[];
  index: number;
  onReady: (ready: boolean) => void;
  onFailure: () => void;
  onPaint: (query: Query) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    box = useRef<HTMLDivElement>(null),
    drag = useRef<{ x: number; y: number } | null>(null);
  const origin = useRef({ x: 0, y: 0 });
  const [exportError, setExportError] = useState("");
  const urls = useMemo(
    () => frames.filter((f) => !f.canvas).map((f) => f.url),
    [frames],
  );
  const { assets } = useAssets(urls, loadPreview);
  const images = frames.map((f) => f.canvas ?? assets.get(f.url)?.value);
  const currentImage = images[index];
  const currentWarnings = frames[index]?.warningPixels;
  const loaded = !!currentImage;
  const failed = urls.some((url) => assets.get(url)?.error);
  useEffect(() => {
    onReady(loaded);
  }, [loaded, onReady]);
  useEffect(() => {
    if (failed) onFailure();
  }, [failed, onFailure]);
  function geometry(img: FrameImage, width: number, height: number) {
    const fit =
      Math.min(width / img.width, height / img.height) * 0.94 * magnification;
    const w = img.width * fit,
      h = img.height * fit;
    return {
      x: (width - w) / 2 + display.panX,
      y: (height - h) / 2 + display.panY,
      w,
      h,
    };
  }
  function paint(
    ctx: CanvasRenderingContext2D,
    img: FrameImage,
    width: number,
    height: number,
    warningPixels?: Uint32Array,
  ) {
    const g = geometry(img, width, height);
    ctx.imageSmoothingEnabled = false;
    ctx.filter = invert ? "invert(1)" : "none";
    ctx.drawImage(img, g.x, g.y, g.w, g.h);
    ctx.filter = "none";
    if (display.markFlagged && warningPixels?.length) {
      const cellWidth = g.w / img.width, cellHeight = g.h / img.height;
      ctx.fillStyle = "#ffbd45";
      ctx.beginPath();
      for (const i of warningPixels) {
        ctx.rect(
          g.x + (i % img.width) * cellWidth,
          g.y + Math.floor(i / img.width) * cellHeight,
          cellWidth * 0.28,
          cellHeight * 0.28,
        );
      }
      ctx.fill();
    }
  }
  async function exportImage(animated: boolean) {
    if (!query || !box.current) return;
    setExportError("");
    try {
      const rect = box.current.getBoundingClientRect();
      const width = Math.round(rect.width),
        height = Math.round(rect.height);
      const numeric = !!frames[index].pixels;
      const scale = frames[index].previewScale ?? {
        bounds,
        stretch: display.stretch,
        units: "MJy/sr",
      };
      const rgb = numeric && display.mode === "rgb";
      const exportFrames = animated ? frames : [frames[index]];
      const qualityLegend = display.markFlagged && exportFrames.some((f) => f.warningPixels?.length);
      const scaleHeight = rgb ? 72 : 48;
      const legendHeight = display.legend ? scaleHeight + (qualityLegend ? 18 : 0) : 0;
      const out = document.createElement("canvas");
      out.width = Math.round(width);
      out.height = height + legendHeight;
      const ctx = out.getContext("2d", { willReadFrequently: true })!;
      const source = animated ? images : [currentImage];
      const name = exportName(
        animated ? frames : [frames[index]],
        query,
        magnification,
      );
      const lib = animated ? await import("gifenc") : null,
        gif = lib?.GIFEncoder();
      for (const [i, img] of source.entries()) {
        if (!img) throw Error("An observation is still loading.");
        ctx.filter = "none";
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, width, height);
        ctx.clip();
        paint(ctx, img, width, height, exportFrames[i].warningPixels);
        ctx.restore();
        ctx.fillStyle = "white";
        ctx.font = "13px monospace";
        if (display.coords)
          ctx.fillText(
            "ICRS " + query.ra_deg + "°, " + query.dec_deg + "°",
            8,
            18,
          );
        if (display.legend) {
          const { bounds: legendBounds, stretch, units } = scale;
          for (let channel = 0; channel < (rgb ? 3 : 1); channel++) {
            const gradient = ctx.createLinearGradient(30, 0, width - 8, 0);
            for (let i = 0; i < 256; i++) {
              const intensity =
                legendBounds[0] +
                (i / 255) * (legendBounds[1] - legendBounds[0]);
              const byte = intensityByte(intensity, legendBounds, stretch);
              const color = rgb
                ? [0, 1, 2].map((k) => (k === channel ? byte : 0))
                : numeric
                  ? colors[byte]
                  : [byte, byte, byte];
              gradient.addColorStop(
                i / 255,
                `rgb(${color.map((v) => (invert ? 255 - v : v)).join(",")})`,
              );
            }
            if (rgb) {
              ctx.fillStyle = "white";
              ctx.fillText("RGB"[channel], 8, height + 15 + channel * 14);
            }
            ctx.fillStyle = gradient;
            ctx.fillRect(30, height + 5 + channel * 14, width - 38, 12);
          }
          ctx.fillStyle = "white";
          ctx.fillText(
            legendBounds.map((v) => v.toPrecision(4)).join(" … ") +
              " " +
              units +
              " · " +
              stretch,
            8,
            height + scaleHeight - 8,
          );
          if (qualityLegend) {
            ctx.fillStyle = "#ffbd45";
            ctx.fillRect(9, height + scaleHeight + 3, 7, 7);
            ctx.fillStyle = "white";
            ctx.fillText("Flagged pixel", 22, height + scaleHeight + 11);
          }
        }
        if (lib && gif) {
          const rgba = ctx.getImageData(0, 0, out.width, out.height).data;
          const palette = lib.quantize(rgba, 256);
          gif.writeFrame(
            lib.applyPalette(rgba, palette),
            out.width,
            out.height,
            { palette, delay: 1000 / display.speed, repeat: 0 },
          );
        }
      }
      if (gif) {
        gif.finish();
        download(
          new Blob([new Uint8Array(gif.bytes())], { type: "image/gif" }),
          name + ".gif",
        );
      } else {
        const blob = await new Promise<Blob | null>((r) => out.toBlob(r));
        if (!blob) throw Error("Could not encode the PNG.");
        download(blob, name + ".png");
      }
    } catch (err) {
      setExportError((err as Error).message);
    }
  }
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
      if (!currentImage) return;
      paint(ctx, currentImage, rect.width, rect.height, currentWarnings);
      if (query) onPaint(query);
    };
    draw();
    const observer = new ResizeObserver(draw);
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, [
    currentImage,
    query,
    onPaint,
    display.panX,
    display.panY,
    magnification,
    invert,
    currentWarnings,
    display.markFlagged,
  ]);
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
            origin.current = { x: e.clientX, y: e.clientY };
            drag.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerMove={(e) => {
            if (drag.current) {
              const dx = e.clientX - drag.current.x,
                dy = e.clientY - drag.current.y;
              update({ panX: display.panX + dx, panY: display.panY + dy });
              drag.current = { x: e.clientX, y: e.clientY };
            }
          }}
          onPointerUp={(e) => {
            const img = currentImage,
              box = e.currentTarget.getBoundingClientRect();
            if (
              img &&
              Math.hypot(
                e.clientX - origin.current.x,
                e.clientY - origin.current.y,
              ) < 4
            ) {
              const g = geometry(img, box.width, box.height);
              const x = Math.floor(
                  ((e.clientX - box.left - g.x) / g.w) * img.width,
                ),
                y = Math.floor(
                  ((e.clientY - box.top - g.y) / g.h) * img.height,
                );
              if (x >= 0 && y >= 0 && x < img.width && y < img.height)
                onPixel(x, y);
            }
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        />
        {!frames.length && (
          <div className="sky-empty">
            <h2>No observation loaded</h2>
            <p>{message || "Enter coordinates to load observations."}</p>
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
      <div className="export-tools">
        <button disabled={!loaded} onClick={() => void exportImage(false)}>
          PNG
        </button>
        <button
          disabled={!images.every(Boolean) || frames.length < 2}
          onClick={() => void exportImage(true)}
        >
          GIF
        </button>
        <label>
          <input
            type="checkbox"
            checked={display.legend}
            onChange={(e) => update({ legend: e.target.checked })}
          />{" "}
          Color scale
        </label>
        <label>
          <input
            type="checkbox"
            checked={display.coords}
            onChange={(e) => update({ coords: e.target.checked })}
          />{" "}
          Coordinates
        </label>
        {currentWarnings && (
          <label className="quality-key">
            <input
              type="checkbox"
              checked={display.markFlagged}
              onChange={(e) => update({ markFlagged: e.target.checked })}
            />{" "}
            Mark flagged pixels ({currentWarnings.length})
          </label>
        )}
        {exportError && <span role="alert">{exportError}</span>}
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
          <input
            aria-label="Display zoom"
            type="range"
            min="1"
            max="8"
            step=".25"
            value={magnification}
            onChange={(e) => onZoom(Number(e.target.value))}
            disabled={!loaded}
          />
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
              update({ panX: 0, panY: 0 });
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
