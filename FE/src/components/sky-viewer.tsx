"use client";
// @refresh reset
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Expand, Maximize2, Minimize2, Minus, Plus, RotateCcw } from "./icons";
import { download } from "@/lib/workspace";
import {
  exportName,
  intensityByte,
  palette,
  type Display,
  type RenderedFrame,
} from "@/lib/imaging";
import type { Query } from "@/lib/types";
import { useAssets } from "@/lib/use-assets";
import {
  zoomAt,
  MIN_ZOOM,
  MAX_ZOOM,
  type Point,
  type ViewTransform,
} from "@/lib/view-transform";

type FrameImage = HTMLCanvasElement | HTMLImageElement;
export type PixelBox = [number, number, number, number];
function loadPreview(url: string, signal: AbortSignal, retry = false) {
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
    const source = new URL(url, window.location.href);
    if (retry && /^https?:$/.test(source.protocol))
      source.searchParams.set("retry", String(Date.now()));
    image.src = source.href;
  });
}
export default function SkyViewer({
  frames,
  index,
  onReady,
  onPaint,
  zoom: magnification,
  invert,
  grid,
  display,
  update,
  query,
  bounds,
  colors,
  selection,
  onSelect,
  message,
  unmatchedFrames = false,
  cycleView,
}: {
  zoom: number;
  invert: boolean;
  grid?: string;
  display: Display;
  update: (p: Partial<Display>) => void;
  query: Query | null;
  bounds: number[];
  colors: number[][];
  selection: PixelBox | null;
  onSelect: (selection: PixelBox) => void;
  message: string;
  unmatchedFrames?: boolean;
  cycleView: boolean;
  frames: RenderedFrame[];
  index: number;
  onReady: (ready: boolean) => void;
  onPaint: (query: Query) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    box = useRef<HTMLDivElement>(null),
    shell = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const lastPointerType = useRef("");
  const panGesture = useRef(false);
  const [dragBox, setDragBox] = useState<PixelBox | null>(null);
  const multiTouch = useRef(false),
    tap = useRef<{ point: Point; time: number } | null>(null),
    start = useRef<Point | null>(null);
  const tapSelection = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (tapSelection.current !== null) clearTimeout(tapSelection.current);
    },
    [query],
  );
  const [fullscreen, setFullscreen] = useState(false),
    [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState(false);
  const exportController = useRef<AbortController | null>(null);
  useEffect(() => () => exportController.current?.abort(), []);
  const current = frames[index];
  const urls = useMemo(() => {
    const neighbors = frames.slice(Math.max(0, index - 2), index + 3);
    return [current, ...neighbors.filter(f => f !== current)]
      .filter(f => f && !f.canvas).map(f => f.url);
  }, [frames, current, index]);
  const { assets, retry } = useAssets(urls, loadPreview, 12);
  const entry =
    current && !current.canvas ? assets.get(current.url) : undefined;
  const currentImage = current?.canvas ?? entry?.value;
  const currentWarnings = current?.warningPixels;
  const loaded = !!currentImage;
  useEffect(() => {
    onReady(loaded);
  }, [loaded, onReady]);
  const transform = useRef<ViewTransform>({
    scale: magnification,
    x: display.panX,
    y: display.panY,
  });
  useLayoutEffect(() => {
    transform.current = {
      scale: magnification,
      x: display.panX,
      y: display.panY,
    };
  }, [magnification, display.panX, display.panY]);
  const fitScale = useCallback(() => {
    const rect = box.current?.getBoundingClientRect();
    return currentImage && rect?.width && rect.height
      ? Math.min(
          rect.width / currentImage.width,
          rect.height / currentImage.height,
        ) * 0.94
      : 1;
  }, [currentImage]);
  const commit = useCallback(
    (next: ViewTransform) => {
      const rect = box.current?.getBoundingClientRect();
      if (currentImage && rect) {
        const scale = fitScale() * next.scale;
        const mx = Math.max(0, (currentImage.width * scale - rect.width) / 2);
        const my = Math.max(0, (currentImage.height * scale - rect.height) / 2);
        next = {
          ...next,
          x: Math.max(-mx, Math.min(mx, next.x)),
          y: Math.max(-my, Math.min(my, next.y)),
        };
      }
      const previous = transform.current;
      if (
        next.scale === previous.scale &&
        next.x === previous.x &&
        next.y === previous.y
      )
        return;
      transform.current = next;
      update({ zoom: next.scale, panX: next.x, panY: next.y });
    },
    [currentImage, fitScale, update],
  );
  const fit = useCallback(() => commit({ scale: 1, x: 0, y: 0 }), [commit]);
  const anchor = useCallback((x: number, y: number) => {
    const r = box.current!.getBoundingClientRect();
    return { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 };
  }, []);
  const zoom = useCallback(
    (factor: number, point: Point = { x: 0, y: 0 }) =>
      commit(
        zoomAt(transform.current, transform.current.scale * factor, point),
      ),
    [commit],
  );
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!loaded) return;
      event.preventDefault();
      const delta =
        event.deltaY *
        (event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? element.clientHeight
            : 1);
      zoom(
        Math.exp(
          -Math.max(-1000, Math.min(1000, delta)) *
            (event.ctrlKey ? 0.01 : 0.0025),
        ),
        anchor(event.clientX, event.clientY),
      );
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [loaded, zoom, anchor]);
  useEffect(() => {
    setFullscreenSupported(!!shell.current?.requestFullscreen);
    const changed = () =>
      setFullscreen(document.fullscreenElement === shell.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
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
    if (display.markFlagged && warningPixels?.length) {
      const cellWidth = g.w / img.width,
        cellHeight = g.h / img.height;
      ctx.save();
      ctx.filter = "none";
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
      ctx.restore();
    }
  }
  function pixelBox(from: Point, to: Point): PixelBox | null {
    const rect = canvas.current?.getBoundingClientRect();
    if (!currentImage || !rect?.width || !rect.height) return null;
    const g = geometry(currentImage, rect.width, rect.height);
    const x = (v: number) =>
      Math.floor(((v - rect.left - g.x) * currentImage.width) / g.w);
    const y = (v: number) =>
      Math.floor(((v - rect.top - g.y) * currentImage.height) / g.h);
    const area: PixelBox = [
      Math.max(0, x(Math.min(from.x, to.x))),
      Math.max(0, y(Math.min(from.y, to.y))),
      Math.min(currentImage.width - 1, x(Math.max(from.x, to.x))),
      Math.min(currentImage.height - 1, y(Math.max(from.y, to.y))),
    ];
    return area[0] <= area[2] && area[1] <= area[3] ? area : null;
  }
  async function exportImage(animated: boolean) {
    if (!query || !box.current || !current || exportController.current) return;
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    setExportError("");
    try {
      const rect = box.current.getBoundingClientRect();
      const width = Math.round(rect.width),
        height = Math.round(rect.height);
      const exportFrames = animated ? frames : [frames[index]];
      const qualityLegend =
        display.markFlagged &&
        exportFrames.some((f) => f.warningPixels?.length);
      const scaleHeight =
        38 * Math.max(1, ...exportFrames.map((f) => f.mapScales?.length ?? 0));
      const legendHeight = display.legend
        ? scaleHeight + (qualityLegend ? 18 : 0)
        : 0;
      const out = document.createElement("canvas");
      out.width = Math.round(width);
      out.height = height + legendHeight;
      const ctx = out.getContext("2d", { willReadFrequently: true })!;
      const name = exportName(
        animated ? frames : [frames[index]],
        query,
        magnification,
      );
      const lib = animated ? await import("gifenc") : null,
        gif = lib?.GIFEncoder();
      for (const frame of exportFrames) {
        controller.signal.throwIfAborted();
        const img =
          frame.canvas ??
          assets.get(frame.url)?.value ??
          (await loadPreview(
            frame.url,
            AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
          ));

        ctx.filter = "none";
        ctx.clearRect(0, 0, out.width, out.height);
        ctx.fillStyle = "#000";
        if (animated) ctx.fillRect(0, 0, out.width, out.height);
        else if (legendHeight) ctx.fillRect(0, height, out.width, legendHeight);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, width, height);
        ctx.clip();
        paint(ctx, img, width, height, frame.warningPixels);
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
          const scales = frame.mapScales?.length
            ? frame.mapScales
            : [
                {
                  name: "Intensity",
                  bounds: frame.previewScale?.bounds ?? bounds,
                  stretch: frame.previewScale?.stretch ?? display.stretch,
                  stops: undefined,
                },
              ];
          for (const [row, scale] of scales.entries()) {
            const legendBounds = scale.bounds;
            const lut = scale.stops
              ? palette(scale.stops)
              : frame.canvas
                ? colors
                : null;
            const gradient = ctx.createLinearGradient(8, 0, width - 8, 0);
            for (let i = 0; i < 256; i++) {
              const intensity =
                legendBounds[0] +
                (i / 255) * (legendBounds[1] - legendBounds[0]);
              const byte = intensityByte(
                intensity,
                legendBounds,
                scale.stretch,
              );
              const color = lut?.[byte] ?? [byte, byte, byte, 255];
              gradient.addColorStop(
                i / 255,
                `rgba(${color
                  .slice(0, 3)
                  .map((v) => (invert ? 255 - v : v))
                  .join(",")},${(color[3] ?? 255) / 255})`,
              );
            }
            ctx.fillStyle = gradient;
            ctx.fillRect(8, height + 4 + row * 38, width - 16, 11);
            ctx.fillStyle = "white";
            const units = frame.previewScale?.units ?? "MJy/sr";
            ctx.fillText(
              `${scale.name} · ${legendBounds.map((v) => v.toPrecision(4)).join(" … ")} ${units} · ${scale.stretch}`,
              8,
              height + 30 + row * 38,
              width - 16,
            );
          }
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
      controller.signal.throwIfAborted();
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
      if (!controller.signal.aborted) setExportError((err as Error).message);
    } finally {
      exportController.current = null;
      if (!controller.signal.aborted) setExporting(false);
    }
  }
  useLayoutEffect(() => {
    const draw = () => {
      const c = canvas.current,
        b = box.current;
      if (!c || !b) return;
      const rect = b.getBoundingClientRect(),
        ratio = window.devicePixelRatio || 1;
      const width = Math.round(rect.width * ratio),
        height = Math.round(rect.height * ratio);
      if (c.width !== width) c.width = width;
      if (c.height !== height) c.height = height;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      if (!currentImage) return;
      paint(ctx, currentImage, rect.width, rect.height, currentWarnings);
      const area = dragBox ?? selection;
      if (area) {
        const g = geometry(currentImage, rect.width, rect.height);
        const w = g.w / currentImage.width,
          h = g.h / currentImage.height;
        ctx.save();
        ctx.filter = "none";
        ctx.strokeStyle = "#85e3bd";
        ctx.lineWidth = 2;
        ctx.strokeRect(
          g.x + area[0] * w,
          g.y + area[1] * h,
          (area[2] - area[0] + 1) * w,
          (area[3] - area[1] + 1) * h,
        );
        ctx.restore();
      }
      if (query) onPaint(query);
    };
    draw();
    const observer = new ResizeObserver(() => {
      commit(transform.current);
      draw();
    });
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, [
    commit,
    currentImage,
    query,
    onPaint,
    display.panX,
    display.panY,
    magnification,
    invert,
    currentWarnings,
    display.markFlagged,
    dragBox,
    selection,
  ]);
  function endPointer(
    event: React.PointerEvent<HTMLCanvasElement>,
    cancelled = false,
  ) {
    const point = pointers.current.get(event.pointerId);
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (pointers.current.size) return;
    const area =
      !cancelled && !multiTouch.current && start.current && !panGesture.current
        ? pixelBox(start.current, { x: event.clientX, y: event.clientY })
        : null;
    if (
      !cancelled &&
      !multiTouch.current &&
      point &&
      event.pointerType === "touch" &&
      start.current &&
      Math.hypot(point.x - start.current.x, point.y - start.current.y) < 8
    ) {
      const now = performance.now();
      if (
        tap.current &&
        now - tap.current.time < 300 &&
        Math.hypot(
          point.x - tap.current.point.x,
          point.y - tap.current.point.y,
        ) < 24
      ) {
        transform.current.scale > 1.01
          ? fit()
          : zoom(2, anchor(point.x, point.y));
        if (tapSelection.current !== null) clearTimeout(tapSelection.current);
        tap.current = null;
      } else {
        tap.current = { point, time: now };
        if (tapSelection.current !== null) clearTimeout(tapSelection.current);
        // On a narrow screen Details covers the canvas. Let a second tap reach it first.
        if (area) tapSelection.current = setTimeout(() => onSelect(area), 310);
      }
    } else if (area) onSelect(area);
    multiTouch.current = false;
    setDragBox(null);
    start.current = null;
  }
  return (
    <div className="sky-shell" ref={shell}>
      <div
        className={"sky-canvas " + (frames.length ? "has-image" : "")}
        ref={box}
      >
        <canvas
          ref={canvas}
          tabIndex={0}
          role="img"
          aria-description="Click to inspect a pixel or left-drag a region. Right-drag to pan. Use two fingers or scroll to pan and zoom."
          onContextMenu={(event) => {
            if (loaded) event.preventDefault();
          }}
          aria-label={
            current
              ? `Observation ${index + 1} of ${frames.length}. ${current.observed_at}`
              : "No observation loaded"
          }
          onPointerDown={(event) => {
            if (
              !loaded ||
              (event.pointerType === "mouse" &&
                event.button !== 0 &&
                event.button !== 2)
            )
              return;
            lastPointerType.current = event.pointerType;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {}
            pointers.current.set(event.pointerId, {
              x: event.clientX,
              y: event.clientY,
            });
            if (pointers.current.size === 1) {
              panGesture.current = event.button === 2;
              start.current = { x: event.clientX, y: event.clientY };
            }
            if (pointers.current.size > 1) {
              if (tapSelection.current !== null)
                clearTimeout(tapSelection.current);
              multiTouch.current = true;
              setDragBox(null);
              tap.current = null;
            }
          }}
          onPointerMove={(event) => {
            const before = pointers.current.get(event.pointerId);
            if (!before) return;
            const old = [...pointers.current.values()];
            pointers.current.set(event.pointerId, {
              x: event.clientX,
              y: event.clientY,
            });
            const next = [...pointers.current.values()];
            if (old.length >= 2) {
              const distance = (p: Point[]) =>
                Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
              const midpoint = (p: Point[]) =>
                anchor((p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2);
              if (distance(old) > 0)
                commit(
                  zoomAt(
                    transform.current,
                    (transform.current.scale * distance(next)) / distance(old),
                    midpoint(old),
                    midpoint(next),
                  ),
                );
            } else if (panGesture.current || multiTouch.current)
              commit({
                ...transform.current,
                x: transform.current.x + event.clientX - before.x,
                y: transform.current.y + event.clientY - before.y,
              });
            else if (start.current)
              setDragBox(
                pixelBox(start.current, { x: event.clientX, y: event.clientY }),
              );
          }}
          onPointerUp={(event) => endPointer(event)}
          onPointerCancel={(event) => endPointer(event, true)}
          onLostPointerCapture={(event) =>
            pointers.current.delete(event.pointerId)
          }
          onDoubleClick={(event) => {
            if (
              loaded &&
              event.detail > 0 &&
              lastPointerType.current !== "touch"
            )
              transform.current.scale > 1.01
                ? fit()
                : zoom(2, anchor(event.clientX, event.clientY));
          }}
          onKeyDown={(event) => {
            if (!loaded || event.ctrlKey || event.metaKey) return;
            if (["+", "=", "-", "0", "f", "1"].includes(event.key)) {
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "-") zoom(1 / 1.25);
              else if (["0", "f"].includes(event.key)) fit();
              else if (event.key === "1")
                commit({ scale: 1 / fitScale(), x: 0, y: 0 });
              else zoom(1.25);
            }
          }}
        />
        {current && loaded && (
          <div className="image-readout" role="group" aria-label="Displayed image">
            {fullscreen && unmatchedFrames && (
              <span>Browse / unmatched observations</span>
            )}

            <span>
              {current.visit_id && current.observation_id === current.visit_id
                ? "Visit composite"
                : (current.previewScale ? "Exposure PNG preview" : "Calibrated exposure") + " · " + current.detector}
              {current.observation_id !== current.visit_id &&
              current.wavelength_um != null
                ? ` / ${current.wavelength_um.toFixed(3)} µm`
                : ""}
            </span>
            <time dateTime={current.observed_at}>
              {new Date(current.observed_at)
                .toISOString()
                .replace("T", " ")
                .replace(/\.\d{3}Z$/, " UTC")}
            </time>
          </div>
        )}
        {!frames.length && (
          <div className="sky-empty">
            <h2>No observation loaded</h2>
            <p>{message || "Enter coordinates to load observations."}</p>
          </div>
        )}
        {current && !loaded && !entry?.error && (
          <div className="sky-empty">
            <p>Loading image…</p>
          </div>
        )}
        {entry?.error && (
          <div className="image-error" role="alert">
            <p>This image could not be loaded.</p>
            <button
              className="button"
              onClick={() => current && retry(current.url)}
            >
              <RotateCcw size={13} />
              Retry image
            </button>
            <span>You can also step to another frame.</span>
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
        <button
          disabled={!loaded || exporting}
          onClick={() => void exportImage(false)}
        >
          PNG
        </button>
        <button
          disabled={!loaded || exporting || !cycleView || frames.length < 2}
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
        {exporting && <span role="status">Preparing export…</span>}
        {exportError && <span role="alert">{exportError}</span>}
      </div>
      <div className="sky-bottom">
        <span className="gesture-hint">
          Left-drag to select · Right-drag to pan · Scroll to zoom
        </span>
        <div className="zoom-buttons">
          <button
            aria-label="Zoom out"
            title="Zoom out (-)"
            disabled={!loaded || magnification <= MIN_ZOOM}
            onClick={() => zoom(1 / 1.25)}
          >
            <Minus size={14} />
          </button>
          <input
            aria-label="Display zoom"
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step="0.01"
            value={magnification}
            onChange={(event) =>
              commit(
                zoomAt(transform.current, Number(event.target.value), {
                  x: 0,
                  y: 0,
                }),
              )
            }
            disabled={!loaded}
          />
          <span aria-label="Viewport zoom">
            {Math.round(magnification * 100)}%
          </span>
          <button
            aria-label="Zoom in"
            title="Zoom in (+)"
            disabled={!loaded || magnification >= MAX_ZOOM}
            onClick={() => zoom(1.25)}
          >
            <Plus size={14} />
          </button>
          <button
            className="text-tool"
            aria-label="Reset viewport"
            title="Fit image and reset pan (F or 0)"
            disabled={!loaded}
            onClick={fit}
          >
            <Maximize2 size={13} />
            Fit
          </button>
          <button
            className="text-tool"
            aria-label="Native pixel scale"
            title="One image pixel per CSS pixel (1)"
            disabled={!loaded}
            onClick={() => commit({ scale: 1 / fitScale(), x: 0, y: 0 })}
          >
            1:1
          </button>
          <button
            aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            title={
              fullscreenSupported
                ? "Toggle fullscreen"
                : "Fullscreen is unavailable in this browser"
            }
            disabled={!fullscreenSupported}
            onClick={() => {
              if (document.fullscreenElement === shell.current)
                void document.exitFullscreen();
              else void shell.current?.requestFullscreen().catch(() => {});
            }}
          >
            {fullscreen ? <Minimize2 size={14} /> : <Expand size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}
