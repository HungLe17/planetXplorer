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
import { Crosshair, Download, Expand, Maximize2, Minimize2, Minus, Move, Plus, RotateCcw } from "./icons";
import { download } from "@/lib/workspace";
import {
  exportName,
  intensityByte,
  palette,
  skyPosition,
  type GridHeader,
  type Display,
  type RenderedFrame,
} from "@/lib/imaging";
import type { Query } from "@/lib/types";
import type { Marker } from "@/lib/known-objects";
import { ObjectInfo } from "./known-objects";
import Notification from "./notification";
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

function frameLegend(frame: RenderedFrame, bounds: number[], stretch: string, colors: number[][], invert: boolean) {
  const scales = frame.mapScales ?? [{
    name: "Intensity", bounds: frame.previewScale?.bounds ?? bounds,
    stretch: frame.previewScale?.stretch ?? stretch, stops: undefined,
  }];
  return scales.map(scale => {
    const [lo, hi] = scale.bounds;
    const lut = scale.stops ? palette(scale.stops) : frame.canvas ? colors : null;
    const stops = Array.from({length:256}, (_, i) => {
      const byte = intensityByte(lo + i / 255 * (hi - lo), scale.bounds, scale.stretch);
      const rgba = lut?.[byte] ?? [byte, byte, byte, 255];
      const rgb = rgba.slice(0, 3).map(v => invert ? 255 - v : v);
      return `rgba(${rgb.join(",")},${(rgba[3] ?? 255) / 255})`;
    });
    const units = frame.previewScale?.units ?? "MJy/sr";
    return {stops, label:`${scale.name} · ${lo.toPrecision(4)} … ${hi.toPrecision(4)} ${units} · ${scale.stretch}`};
  });
}

function captionLines(ctx: CanvasRenderingContext2D, text: string, width: number) {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? line + " " + word : word;
    if (line && ctx.measureText(next).width > width) {
      lines.push(line);
      line = "";
    }
    for (const character of (line ? " " : "") + word) {
      if (line && ctx.measureText(line + character).width > width) {
        lines.push(line);
        line = "";
      }
      line += character;
    }
  }
  if (line) lines.push(line);
  return lines;
}

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
  gridHeader,
  display,
  update,
  query,
  bounds,
  colors,
  markers,
  chosenObject,
  onMarker,
  selection,
  onSelect,
  message,
  searchError,
  onRetrySearch,
  onInspectExposure,
  unmatchedFrames = false,
  cycleView,
  subtracting,
  canSubtract,
  onSubtract,
}: {
  zoom: number;
  invert: boolean;
  grid?: string;
  gridHeader?: GridHeader;
  display: Display;
  update: (p: Partial<Display>) => void;
  query: Query | null;
  bounds: number[];
  colors: number[][];
  markers: Marker[];
  chosenObject?: Marker;
  onMarker: (key: string) => void;
  selection: PixelBox | null;
  onSelect: (selection: PixelBox) => void;
  message: string;
  searchError?: string;
  onRetrySearch?: () => void;
  onInspectExposure?: () => void;
  unmatchedFrames?: boolean;
  cycleView: boolean;
  subtracting?: boolean;
  canSubtract?: boolean;
  onSubtract?: (enabled: boolean) => void;
  frames: RenderedFrame[];
  index: number;
  onReady: (ready: boolean) => void;
  onPaint: (query: Query) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    box = useRef<HTMLDivElement>(null),
    shell = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const skyReadout = useRef<HTMLDivElement>(null);
  const cursor = useRef<Point | null>(null);
  const lastPointerType = useRef("");
  const panGesture = useRef(false);
  const rightDrag = useRef(false);
  const [regionMenu, setRegionMenu] = useState<Point | null>(null);
  const [tool, setTool] = useState<"select" | "pan">("select");
  const regionMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setRegionMenu(null); }, [query, selection, index]);
  useEffect(() => {
    if (!regionMenu) return;
    regionMenuRef.current?.querySelector("a")?.focus();
    const outside = (event: PointerEvent) => {
      if (!regionMenuRef.current?.contains(event.target as Node)) setRegionMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setRegionMenu(null);
        canvas.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [regionMenu]);
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
  const legend = useMemo(() => display.legend && current
    ? frameLegend(current, bounds, display.stretch, colors, invert) : [],
    [current, bounds, display.legend, display.stretch, colors, invert]);
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
  const currentSerious = current?.seriousPixels;
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
    g: { x: number; y: number; w: number; h: number },
    warningPixels?: Uint32Array,
    seriousPixels?: Uint32Array,
  ) {
    ctx.imageSmoothingEnabled = false;
    ctx.filter = invert ? "invert(1)" : "none";
    ctx.drawImage(img, g.x, g.y, g.w, g.h);
    if (display.markFlagged && (warningPixels?.length || seriousPixels?.length)) {
      const cellWidth = g.w / img.width,
        cellHeight = g.h / img.height;
      ctx.save();
      ctx.filter = "none";
      const inset = Math.min(0.5, cellWidth / 4, cellHeight / 4);
      ctx.lineWidth = inset * 2;
      for (const [indices, color] of [[warningPixels, "rgba(255,214,0,0.5)"], [seriousPixels, "rgba(255,140,0,0.5)"]] as const) {
        ctx.strokeStyle = color;
        ctx.beginPath();
        for (const i of indices ?? []) {
          ctx.rect(g.x + (i % img.width) * cellWidth + inset,
            g.y + Math.floor(i / img.width) * cellHeight + inset,
            cellWidth - inset * 2, cellHeight - inset * 2);
        }
        ctx.stroke();
      }
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
  function updateCoordinates() {
    if (!skyReadout.current || !query) return;
    const cell = currentImage && cursor.current && pixelBox(cursor.current, cursor.current);
    const area = cell || (currentImage && selection);
    let position: Pick<Query, "ra_deg" | "dec_deg"> = query;
    let label = "Field center";
    if (currentImage) {
      const x = area ? (area[0] + area[2]) / 2 : (currentImage.width - 1) / 2;
      const y = area ? (area[1] + area[3]) / 2 : (currentImage.height - 1) / 2;
      position = skyPosition(query, x, y, currentImage.width, currentImage.height, gridHeader);
      if (area) label = area[0] === area[2] && area[1] === area[3]
        ? `Pixel (${x + 1}, ${y + 1})` : "Selected region center";
    }
    const value = `${label} · RA ${position.ra_deg.toFixed(6)}° · Dec ${position.dec_deg.toFixed(6)}° (ICRS)`;
    if (skyReadout.current.textContent !== value) skyReadout.current.textContent = value;
  }
  async function exportImage(animated: boolean) {
    if (!query || !currentImage || !current || exportController.current) return;
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    setExportError("");
    try {
      const width = Math.max(1024, currentImage.width);
      const height = Math.round(currentImage.height * width / currentImage.width);
      const exportFrames = animated ? frames : [frames[index]];
      const qualityLegend =
        display.markFlagged &&
        exportFrames.some((f) => f.warningPixels?.length || f.seriousPixels?.length);
      const out = document.createElement("canvas");
      out.width = width;
      const ctx = out.getContext("2d", { willReadFrequently: true })!;
      const font = "18px monospace", lineHeight = 26, gap = 12, rampHeight = 22;
      ctx.font = font;
      const position = skyPosition(query, (currentImage.width - 1) / 2,
        (currentImage.height - 1) / 2, currentImage.width, currentImage.height, gridHeader);
      const coordinates = display.coords ? captionLines(ctx,
        `ICRS · RA ${position.ra_deg.toFixed(6)}° · Dec ${position.dec_deg.toFixed(6)}°`, width - 24) : [];
      const legends = exportFrames.map(frame => display.legend
        ? frameLegend(frame, bounds, display.stretch, colors, invert)
          .map(scale => ({ ...scale, lines: captionLines(ctx, scale.label, width - 24) }))
        : []);
      const coordinateHeight = coordinates.length ? gap + coordinates.length * lineHeight : 0;
      const legendHeight = Math.max(0, ...legends.map(scales => scales.reduce((sum, scale) =>
        sum + gap + rampHeight + scale.lines.length * lineHeight, 0)));
      const qualityHeight = display.legend && qualityLegend ? gap + lineHeight : 0;
      const footerHeight = coordinateHeight + legendHeight + qualityHeight;
      out.height = height + (footerHeight ? footerHeight + gap : 0);
      const name = exportName(
        animated ? frames : [frames[index]],
        query,
        1,
      );
      const lib = animated ? await import("gifenc") : null,
        gif = lib?.GIFEncoder();
      for (const [frameIndex, frame] of exportFrames.entries()) {
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
        else if (footerHeight) ctx.fillRect(0, height, width, out.height - height);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, width, height);
        ctx.clip();
        const scale = Math.min(width / img.width, height / img.height);
        const mapWidth = Math.round(img.width * scale), mapHeight = Math.round(img.height * scale);
        const mapX = Math.round((width - mapWidth) / 2);
        paint(ctx, img, { x: mapX, y: 0, w: mapWidth, h: mapHeight }, frame.warningPixels, frame.seriousPixels);
        ctx.restore();
        ctx.fillStyle = "white";
        ctx.font = font;
        ctx.textBaseline = "top";
        ctx.textAlign = "center";
        let y = height;
        if (coordinates.length) {
          y += gap;
          for (const line of coordinates) {
            ctx.fillText(line, width / 2, y);
            y += lineHeight;
          }
        }
        if (display.legend) {
          for (const legend of legends[frameIndex]) {
            y += gap;
            const gradient = ctx.createLinearGradient(mapX, 0, mapX + mapWidth, 0);
            legend.stops.forEach((color, index) => gradient.addColorStop(index / 255, color));
            ctx.fillStyle = gradient;
            ctx.fillRect(mapX, y, mapWidth, rampHeight);
            y += rampHeight;
            ctx.fillStyle = "white";
            for (const line of legend.lines) {
              ctx.fillText(line, width / 2, y);
              y += lineHeight;
            }
          }
          if (qualityLegend) {
            y += gap;
            ctx.textAlign = "left";
            ctx.strokeStyle = "rgba(255,214,0,0.5)";
            ctx.strokeRect(12.5, y + 4.5, 12, 12);
            ctx.strokeStyle = "rgba(255,140,0,0.5)";
            ctx.strokeRect(208.5, y + 4.5, 12, 12);
            ctx.fillStyle = "white";
            ctx.fillText("Warning", 32, y);
            ctx.fillText("Serious", 228, y);
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
      updateCoordinates();
      const width = Math.round(rect.width * ratio),
        height = Math.round(rect.height * ratio);
      if (c.width !== width) c.width = width;
      if (c.height !== height) c.height = height;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      if (!currentImage) return;
      paint(ctx, currentImage, geometry(currentImage, rect.width, rect.height), currentWarnings, currentSerious);
      if (markers.length) {
        const g = geometry(currentImage, rect.width, rect.height);
        ctx.save();
        ctx.filter = "none";
        ctx.beginPath();
        ctx.rect(g.x, g.y, g.w, g.h);
        ctx.clip();
        for (const marker of markers) {
          const selected = marker.key === chosenObject?.key;
          ctx.beginPath();
          ctx.arc(g.x + marker.u * g.w, g.y + marker.v * g.h, selected ? 8 : 6, 0, 2 * Math.PI);
          ctx.lineWidth = 3.5;
          ctx.strokeStyle = "#142024";
          ctx.stroke();
          ctx.lineWidth = selected ? 2 : 1.5;
          ctx.strokeStyle = selected ? "#ffffff" : marker.moving ? "#ffc66a" : "#81e9fd";
          ctx.stroke();
        }
        ctx.restore();
      }
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
    currentSerious,
    display.markFlagged,
    dragBox,
    selection,
    markers,
    chosenObject,
    gridHeader,
    display.coords,
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
    if (!cancelled && !multiTouch.current && !panGesture.current && start.current && currentImage &&
        markers.length && Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) < 4) {
      const rect = event.currentTarget.getBoundingClientRect();
      const g = geometry(currentImage, rect.width, rect.height);
      const x = event.clientX - rect.left - g.x, y = event.clientY - rect.top - g.y;
      let nearest: Marker | undefined;
      let distance = 9;
      if (x >= 0 && y >= 0 && x < g.w && y < g.h) {
        for (const marker of markers) {
          const d = Math.hypot(marker.u * g.w - x, marker.v * g.h - y);
          if (d < distance) { nearest = marker; distance = d; }
        }
      }
      if (nearest) {
        if (tapSelection.current !== null) clearTimeout(tapSelection.current);
        tap.current = null;
        start.current = null;
        setDragBox(null);
        onMarker(nearest.key);
        return;
      }
    }
    if (!cancelled && !multiTouch.current && event.button === 2 && !rightDrag.current && selection && query) {
      const here = { x: event.clientX, y: event.clientY };
      const cell = pixelBox(here, here);
      if (cell && cell[0] >= selection[0] && cell[0] <= selection[2] &&
          cell[1] >= selection[1] && cell[1] <= selection[3]) {
        const rect = event.currentTarget.getBoundingClientRect();
        setRegionMenu({
          x: Math.max(0, Math.min(here.x - rect.left, rect.width - 250)),
          y: Math.max(0, Math.min(here.y - rect.top, rect.height - 138)),
        });
      }
    }
    const area =
      !cancelled && !multiTouch.current && start.current && !panGesture.current
        ? pixelBox(start.current, { x: event.clientX, y: event.clientY })
        : null;
    if (
      !cancelled &&
      !multiTouch.current && !panGesture.current &&
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
      <div className="canvas-toolbar">
        <div className="canvas-tool-group" role="group" aria-label="Canvas interaction">
          <button aria-label="Select region" aria-pressed={tool === "select"}
            title="Select pixels or drag a region (V)" disabled={!loaded}
            onClick={() => { setTool("select"); setRegionMenu(null); }}>
            <Crosshair size={14} /><span>Select</span>
          </button>
          <button aria-label="Pan image" aria-pressed={tool === "pan"}
            title="Drag to pan the image (H)" disabled={!loaded}
            onClick={() => { setTool("pan"); setRegionMenu(null); }}>
            <Move size={14} /><span>Pan</span>
          </button>
          <button aria-label="Recenter image" title="Center the image while keeping the current zoom"
            disabled={!loaded} onClick={() => commit({...transform.current,x:0,y:0})}>
            <Crosshair size={14} /><span>Recenter</span>
          </button>
          {onSubtract && <label className="subtract-toggle">
            <input type="checkbox" aria-label="Compare with reference" checked={!!subtracting}
              disabled={!canSubtract && !subtracting} onChange={e => onSubtract(e.target.checked)} />
            Subtract
          </label>}
        </div>
        <span className="canvas-tool-hint">
          {tool === "pan" ? "Drag to pan the image" : "Click a pixel or drag a region"}
        </span>
      </div>
      <div
        className={"sky-canvas " + (frames.length ? "has-image" : "") + (tool === "pan" ? " pan-tool" : "")}
        ref={box}
      >
        <canvas
          ref={canvas}
          tabIndex={0}
          role="img"
          aria-description={tool === "pan"
            ? "Drag to pan. Press V to select pixels or regions. Scroll to zoom."
            : "Click to inspect a pixel or left-drag a region. Press H to pan. Right-click the selection for its full spectrum. Right-drag to pan. Use two fingers or scroll to pan and zoom."}
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
              panGesture.current = event.button === 2 || tool === "pan";
              rightDrag.current = false;
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
            if (display.coords) {
              cursor.current = {x:event.clientX, y:event.clientY};
              updateCoordinates();
            }
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
            } else if (panGesture.current || multiTouch.current) {
              if (panGesture.current && !rightDrag.current && start.current) {
                if (Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) < 4) return;
                rightDrag.current = true;
              }
              commit({
                ...transform.current,
                x: transform.current.x + event.clientX - before.x,
                y: transform.current.y + event.clientY - before.y,
              });
            }
            else if (start.current)
              setDragBox(
                pixelBox(start.current, { x: event.clientX, y: event.clientY }),
              );
          }}
          onPointerLeave={() => { cursor.current = null; updateCoordinates(); }}
          onPointerUp={(event) => {
            if (event.pointerType === "touch") { cursor.current = null; updateCoordinates(); }
            endPointer(event);
          }}
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
            if (event.key.toLowerCase() === "v" || event.key.toLowerCase() === "h") {
              event.preventDefault();
              event.stopPropagation();
              setTool(event.key.toLowerCase() === "h" ? "pan" : "select");
              setRegionMenu(null);
              return;
            }
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
        {regionMenu && selection && query && currentImage && (
          <div className="region-menu" ref={regionMenuRef} role="dialog" aria-label="Selected region spectrum"
            style={{left:regionMenu.x, top:regionMenu.y}}>
            <strong>Full region spectrum</strong>
            <p>Retrieving all six bands across every available date can take a very long time.</p>
            <div>
              <a className="button" target="_blank" rel="noopener noreferrer" onClick={() => setRegionMenu(null)}
                href={"/region-spectrum?" + new URLSearchParams({
                  ra:String(query.ra_deg), dec:String(query.dec_deg), fov:String(query.fov_arcsec ?? 300),
                  width:String(currentImage.width), height:String(currentImage.height), box:selection.join(","),
                })}>Open in new tab</a>
              <button className="button" onClick={() => setRegionMenu(null)}>Cancel</button>
            </div>
          </div>
        )}
        {current && loaded && (
          <div className="image-readout" role="group" aria-label="Displayed image">
            {fullscreen && chosenObject && <ObjectInfo point={chosenObject} />}
            {fullscreen && unmatchedFrames && (
              <span>Individual exposure · unmatched measurements</span>
            )}

            <span>
              {current.subtraction
                ? `Cycle difference · reference ${current.subtraction.referenceDate.slice(0, 10)}`
                : current.matchedMap ? "Matched spectrum map · " + current.detector
                : current.matchedMap === false ? "Calibrated exposure · no complete map for this epoch"
                : current.visit_id && current.observation_id === current.visit_id
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
            <h2>{searchError ? "Observation search failed" : onInspectExposure ? "Map inputs incomplete" : "No observation loaded"}</h2>
            <p role={searchError ? "alert" : undefined}>{searchError || message || "Enter coordinates to load observations."}</p>
            {searchError && onRetrySearch && <button className="button" onClick={onRetrySearch}>Retry observation search</button>}
            {onInspectExposure && <button className="button" onClick={onInspectExposure}>Inspect loaded exposure</button>}
            {!message && !searchError && <ol className="empty-workflow">
              <li>Choose a sky position</li>
              <li>Search observations</li>
              <li>Inspect pixels and compare cycles</li>
            </ol>}
          </div>
        )}
        {current && !loaded && !entry?.error && (
          <div className="sky-empty">
            <p>Loading image…</p>
          </div>
        )}
        {entry?.error && (
          <Notification key={current?.observation_id} label="image download error"><div role="alert">
            <p>This image could not be loaded.</p>
            <button
              className="button"
              onClick={() => current && retry(current.url)}
            >
              <RotateCcw size={13} />
              Retry image
            </button>
            <span>You can also step to another frame.</span>
          </div></Notification>
        )}
        {display.coords && query && <div className="sky-coordinate-readout" role="group" aria-label="Sky coordinates" ref={skyReadout} />}
        {!!frames.length && grid?.includes("north up") && (
          <div className="orientation" aria-label="North up, east left">
            <span>N</span>
            <div>↑</div>
            <span>E ←</span>
          </div>
        )}
      </div>
      {loaded && legend.length > 0 && <div className="live-color-scale" role="group" aria-label="Displayed color scale">
        {legend.map((scale, i) => <div key={i}>
          <div className="scale-ramp" style={{backgroundImage:`linear-gradient(to right,${scale.stops.join(",")})`}} />
          <span>{scale.label}</span>
        </div>)}
      </div>}
      <div className="export-tools">
        <div className="canvas-tool-group" role="group" aria-label="Image export">
        <span className="canvas-tool-label"><Download size={12} />Export</span>
        <button
          disabled={!loaded || exporting}
          title="Download the full map and selected annotations as PNG"
          onClick={() => void exportImage(false)}
        >
          PNG
        </button>
        <button
          disabled={!loaded || exporting || !cycleView || frames.length < 2}
          title={cycleView && frames.length >= 2 ? "Export the full cycle maps as an animated GIF" : "GIF export needs two comparable observing epochs"}
          onClick={() => void exportImage(true)}
        >
          GIF
        </button>
        </div>
        <div className="canvas-tool-group" role="group" aria-label="Image overlays">
        <span className="canvas-tool-label">Overlays</span>
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
            Mark flagged pixels ({currentWarnings.length + (currentSerious?.length ?? 0)})
            <span> · yellow warning · orange serious</span>
          </label>
        )}
        </div>
        {exporting && <span role="status">Preparing export…</span>}
        {exportError && <Notification label="export error" onDismiss={() => setExportError("")}>
          <span role="alert">{exportError}</span>
        </Notification>}
      </div>
      <div className="sky-bottom">
        <span className="gesture-hint">
          {tool === "pan" ? "Pan · Drag to move · V to select" : "Select · Drag a region · H to pan"} · Scroll to zoom
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
