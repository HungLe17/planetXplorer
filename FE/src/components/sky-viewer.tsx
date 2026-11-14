"use client";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import type { Frame } from "@/lib/types";
import {
  zoomAt,
  MIN_ZOOM,
  MAX_ZOOM,
  type Point,
  type ViewTransform,
} from "@/lib/view-transform";

type CachedImage = {
  image: HTMLImageElement;
  status: "loading" | "ready" | "error";
  timer: ReturnType<typeof setTimeout>;
};
export default function SkyViewer({
  frames,
  index,
  onReady,
  onFailure,
  zoom: magnification,
  onZoom,
  invert,
  grid,
  unmatchedFrames = false,
}: {
  frames: Frame[];
  index: number;
  onReady: (ready: boolean) => void;
  onFailure: () => void;
  zoom: number;
  onZoom: (zoom: number) => void;
  invert: boolean;
  grid?: string;
  unmatchedFrames?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    box = useRef<HTMLDivElement>(null),
    shell = useRef<HTMLDivElement>(null);
  const cache = useRef(new Map<string, CachedImage>());
  const transform = useRef<ViewTransform>({ scale: magnification, x: 0, y: 0 });
  const pointers = useRef(new Map<number, Point>());
  const lastPointerType = useRef("");
  const multiTouch = useRef(false),
    tap = useRef<{ point: Point; time: number } | null>(null),
    start = useRef<Point | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 }),
    [cacheRevision, setCacheRevision] = useState(0),
    [retry, setRetry] = useState(0);
  const [fullscreen, setFullscreen] = useState(false),
    [fullscreenSupported, setFullscreenSupported] = useState(false);
  const current = frames[index],
    url = current?.url;
  const entry = url ? cache.current.get(url) : undefined;
  const loaded = entry?.status === "ready";
  const fitScale = useCallback(() => {
    const image = url ? cache.current.get(url)?.image : undefined,
      rect = box.current?.getBoundingClientRect();
    return image?.naturalWidth && rect
      ? Math.min(
          rect.width / image.naturalWidth,
          rect.height / image.naturalHeight,
        ) * 0.94
      : 1;
  }, [url]);
  const commit = useCallback(
    (next: ViewTransform) => {
      const image = url ? cache.current.get(url)?.image : undefined,
        rect = box.current?.getBoundingClientRect();
      if (image?.naturalWidth && rect && rect.width > 0 && rect.height > 0) {
        const fit =
          Math.min(
            rect.width / image.naturalWidth,
            rect.height / image.naturalHeight,
          ) * 0.94;
        const mx = Math.max(
            0,
            (image.naturalWidth * fit * next.scale - rect.width) / 2,
          ),
          my = Math.max(
            0,
            (image.naturalHeight * fit * next.scale - rect.height) / 2,
          );
        next = {
          ...next,
          x: Math.max(-mx, Math.min(mx, next.x)),
          y: Math.max(-my, Math.min(my, next.y)),
        };
      }
      if (
        next.scale === transform.current.scale &&
        next.x === transform.current.x &&
        next.y === transform.current.y
      )
        return;
      transform.current = next;
      setPan({ x: next.x, y: next.y });
      onZoom(next.scale);
    },
    [onZoom, url],
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
  useLayoutEffect(() => {
    if (transform.current.scale !== magnification)
      commit(zoomAt(transform.current, magnification, { x: 0, y: 0 }));
  }, [magnification, commit]);
  useEffect(() => {
    const wanted = frames
      .slice(Math.max(0, index - 2), index + 3)
      .map((f) => f.url);
    for (const source of wanted) {
      if (cache.current.has(source)) continue;
      const image = new Image();
      const item: CachedImage = {
        image,
        status: "loading",
        timer: setTimeout(() => finish("error"), 30000),
      };
      function finish(status: "ready" | "error") {
        if (cache.current.get(source) !== item) return;
        clearTimeout(item.timer);
        item.status = status;
        setCacheRevision((n) => n + 1);
      }
      cache.current.set(source, item);
      image.onload = () => finish("ready");
      image.onerror = () => finish("error");
      image.src =
        retry && source === url
          ? source + (source.includes("?") ? "&" : "?") + "retry=" + retry
          : source;
    }
    for (const [source, item] of cache.current) {
      if (cache.current.size <= 12) break;
      if (wanted.includes(source)) continue;
      cache.current.delete(source);
      clearTimeout(item.timer);
      item.image.onload = null;
      item.image.onerror = null;
      if (item.status === "loading") item.image.src = "";
    }
    setCacheRevision((n) => n + 1);
  }, [frames, index, retry, url]);
  useEffect(() => {
    onReady(loaded);
    if (entry?.status === "error") onFailure();
  }, [loaded, url, entry?.status, onReady, onFailure]);
  useEffect(
    () => () => {
      for (const item of cache.current.values()) {
        clearTimeout(item.timer);
        item.image.onload = null;
        item.image.onerror = null;
        if (item.status === "loading") item.image.src = "";
      }
      cache.current.clear();
    },
    [],
  );
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!url || cache.current.get(url)?.status !== "ready") return;
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
  }, [url, zoom, anchor]);
  useEffect(() => {
    setFullscreenSupported(!!shell.current?.requestFullscreen);
    const changed = () =>
      setFullscreen(document.fullscreenElement === shell.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useLayoutEffect(() => {
    const draw = () => {
      const c = canvas.current,
        b = box.current;
      if (!c || !b) return;
      const rect = b.getBoundingClientRect(),
        ratio = window.devicePixelRatio || 1;
      if (!rect.width || !rect.height) return;
      const w = Math.round(rect.width * ratio),
        h = Math.round(rect.height * ratio);
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      const item = url ? cache.current.get(url) : undefined;
      if (item?.status !== "ready") return;
      const img = item.image,
        fit =
          Math.min(
            rect.width / img.naturalWidth,
            rect.height / img.naturalHeight,
          ) * 0.94;
      const dw = img.naturalWidth * fit * magnification,
        dh = img.naturalHeight * fit * magnification;
      ctx.imageSmoothingEnabled = false;
      ctx.filter = invert ? "invert(1)" : "none";
      ctx.drawImage(
        img,
        (rect.width - dw) / 2 + pan.x,
        (rect.height - dh) / 2 + pan.y,
        dw,
        dh,
      );
    };
    draw();
    const observer = new ResizeObserver(() => {
      commit(transform.current);
      draw();
    });
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, [url, cacheRevision, pan, magnification, invert, commit]);
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
          aria-description="Drag to pan. Pinch or scroll to zoom. Plus and minus zoom; F fits the image; 1 shows native pixels."
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
            <p>Enter coordinates to load observations.</p>
          </div>
        )}
        {current && !loaded && entry?.status !== "error" && (
          <div className="sky-empty">
            <p>Loading image…</p>
          </div>
        )}
        {entry?.status === "error" && (
          <div className="image-error" role="alert">
            <p>This image could not be loaded.</p>
            <button
              className="button"
              onClick={() => {
                const item = cache.current.get(url!);
                if (item) {
                  clearTimeout(item.timer);
                  item.image.onload = null;
                  item.image.onerror = null;
                }
                cache.current.delete(url!);
                setRetry((n) => n + 1);
                setCacheRevision((n) => n + 1);
              }}
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
