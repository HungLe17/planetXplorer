"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Expand,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  RotateCcw,
} from "lucide-react";
import { download } from "@/lib/workspace";
import {
  exportName,
  intensityByte,
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
  onFailure,
  onPaint,
  zoom: magnification,
  invert,
  grid,
  display,
  update,
  query,
  bounds,
  colors,
  onPixel,
  message,
  unmatchedFrames = false,
}: {
  zoom: number;
  invert: boolean;
  grid?: string;
  display: Display;
  update: (p: Partial<Display>) => void;
  query: Query | null;
  bounds: number[];
  colors: number[][];
  onPixel: (x: number, y: number) => void;
  message: string;
  unmatchedFrames?: boolean;
  frames: RenderedFrame[];
  index: number;
  onReady: (ready: boolean) => void;
  onFailure: () => void;
  onPaint: (query: Query) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    box = useRef<HTMLDivElement>(null),
    shell = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const lastPointerType = useRef("");
  const multiTouch = useRef(false),
    tap = useRef<{ point: Point; time: number } | null>(null),
    start = useRef<Point | null>(null);
  const [fullscreen, setFullscreen] = useState(false),
    [fullscreenSupported, setFullscreenSupported] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exporting, setExporting] = useState(false);
  const exportController = useRef<AbortController | null>(null);
  useEffect(() => () => exportController.current?.abort(), []);
  const current = frames[index];
  const urls = useMemo(
    () =>
      frames
        .slice(Math.max(0, index - 2), index + 3)
        .filter((f) => !f.canvas)
        .map((f) => f.url),
    [frames, index],
  );
  const { assets, retry } = useAssets(urls, loadPreview, 12);
  const entry =
    current && !current.canvas ? assets.get(current.url) : undefined;
  const currentImage = current?.canvas ?? entry?.value;
  const currentWarnings = current?.warningPixels;
  const loaded = !!currentImage;
  useEffect(() => {
    onReady(loaded);
    if (entry?.error) onFailure();
  }, [current?.url, entry?.error, loaded, onReady, onFailure]);
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
    ctx.filter = "none";
    if (display.markFlagged && warningPixels?.length) {
      const cellWidth = g.w / img.width,
        cellHeight = g.h / img.height;
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
    if (!query || !box.current || !current || exportController.current) return;
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
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
      const qualityLegend =
        display.markFlagged &&
        exportFrames.some((f) => f.warningPixels?.length);
      const scaleHeight = rgb ? 72 : 48;
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
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, out.width, out.height);
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
    if (
      !cancelled &&
      !multiTouch.current &&
      start.current &&
      currentImage &&
      Math.hypot(
        event.clientX - start.current.x,
        event.clientY - start.current.y,
      ) < 4
    ) {
      const r = event.currentTarget.getBoundingClientRect();
      const g = geometry(currentImage, r.width, r.height);
      const x = Math.floor(
        ((event.clientX - r.left - g.x) * currentImage.width) / g.w,
      );
      const y = Math.floor(
        ((event.clientY - r.top - g.y) * currentImage.height) / g.h,
      );
      if (x >= 0 && y >= 0 && x < currentImage.width && y < currentImage.height)
        onPixel(x, y);
    }
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
        tap.current = null;
      } else tap.current = { point, time: now };
    }
    multiTouch.current = false;
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
          aria-description="Select a pixel to inspect. Drag to pan. Pinch or scroll to zoom. Plus and minus zoom; F fits the image; 1 shows native pixels."
          aria-label={
            current
              ? `Observation ${index + 1} of ${frames.length}. ${current.observed_at}`
              : "No observation loaded"
          }
          onPointerDown={(event) => {
            if (
              !loaded ||
              (event.pointerType === "mouse" && event.button !== 0)
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
            if (pointers.current.size === 1)
              start.current = { x: event.clientX, y: event.clientY };
            if (pointers.current.size > 1) {
              multiTouch.current = true;
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
            } else
              commit({
                ...transform.current,
                x: transform.current.x + event.clientX - before.x,
                y: transform.current.y + event.clientY - before.y,
              });
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
          <div className="image-readout">
            {fullscreen && unmatchedFrames && (
              <span>Browse / unmatched observations</span>
            )}

            <span>
              {current.detector}
              {current.wavelength_um != null
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
          disabled={!loaded || exporting || frames.length < 2}
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
          Drag to pan · Scroll or pinch to zoom
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
