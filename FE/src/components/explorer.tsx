"use client";
import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  FormEvent,
} from "react";
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Info,
  LoaderCircle,
  Pause,
  Play,
  Search,
  SkipBack,
  SkipForward,
  X,
  CalendarDays,
  PanelRight,
  RotateCcw,
  Crosshair,
  Layers,
  ChevronDown,
  SlidersHorizontal,
  Download,
  Minimize2,
  Maximize2,
  Repeat,
} from "lucide-react";
import SkyViewer from "./sky-viewer";
import Spectrum from "./spectrum";
import ImageControls from "./image-controls";
import WorkspacePanel from "./workspace-panel";
import { defaults, skyPixel, skyPosition, type Display } from "@/lib/imaging";
import { useImages } from "@/lib/use-images";
import {
  storageKey,
  readBackup,
  readDisplay,
  snapshot,
  type Backup,
  type Config,
  type Entry,
} from "@/lib/workspace";
import FieldSurveys from "./field-surveys";
import { presets, Frame, Manifest, Query, Preset } from "@/lib/types";
import {
  poll,
  submit,
  request,
  validateManifest,
  assetUrl,
  cancelJob,
  loadObservations,
} from "@/lib/api";
import { angularWidth, parseQuery, queryUrl } from "@/lib/view-url";
type LoadBatch = {
  jobId: string;
  ids?: string[];
  detector?: string;
  all?: boolean;
  recordIds?: string[];
  size: number;
};
const empty: Frame[] = [];
const stamp = (date?: string) =>
  date
    ? new Date(date).toLocaleString("en-GB", {
        timeZone: "UTC",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }) + " UTC"
    : "—";
const stages: Record<string, string> = {
  query: "Finding observations",
  fetch: "Retrieving cutouts",
  validate: "Checking wavelengths",
  align: "Aligning observations",
  render: "Preparing images",
  queued: "Waiting for processing",
};
export default function Explorer() {
  const [targets, setTargets] = useState(presets),
    [selected, setSelected] = useState(""),
    [ra, setRa] = useState(""),
    [dec, setDec] = useState(""),
    [start, setStart] = useState(""),
    [end, setEnd] = useState("");
  const [manifest, setManifest] = useState<Manifest | null>(null),
    [selectedFrame, setSelectedFrame] = useState(""),
    [playing, setPlaying] = useState(false),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [stage, setStage] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [copied, setCopied] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [datesOpen, setDatesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [fieldJobId, setFieldJobId] = useState("");
  const [sequenceId, setSequenceId] = useState("");
  const [viewMode, setViewMode] = useState<"browse" | "matched">("browse");
  const [loop, setLoop] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [recordSearch, setRecordSearch] = useState("");
  const [dockExpanded, setDockExpanded] = useState(false);
  const [detectorFilter, setDetectorFilter] = useState("");
  const [tab, setTab] = useState("Settings");
  const [display, setDisplay] = useState(defaults);
  const update = useCallback(
    (patch: Partial<Display>) => setDisplay((old) => ({ ...old, ...patch })),
    [],
  );
  const setSpeed = (speed: number) => update({ speed });
  const setInvert = (invert: boolean) => update({ invert });
  const { speed, zoom, invert } = display;
  const [fov, setFov] = useState("300");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [consent, setConsent] = useState<boolean | null>(null);
  const [pixel, setPixel] = useState<[number, number] | null>(null);
  const restoreFrame = useRef("");
  const restorePosition = useRef<Entry["position"] | null>(null);
  const timing = useRef<{
    query: Query;
    job: string;
    start: number;
    painted: boolean;
  } | null>(null);
  const lastSaved = useRef<Backup | null>(null);
  const science = useImages(manifest, display);
  const [dockOpen, setDockOpen] = useState(true);
  const [committed, setCommitted] = useState<Query | null>(null);
  const controller = useRef<AbortController | null>(null),
    generation = useRef(0),
    activeJob = useRef<string | null>(null);
  const [displayedQuery, setDisplayedQuery] = useState<Query | null>(null);
  const allFrames = manifest?.frames ?? empty;
  const batchSize = Math.max(
    1,
    Math.min(8, manifest?.processing?.batch_size ?? 8),
  );
  const sequences = manifest?.sequences ?? [];
  const sequence =
    sequences.find((s) => s.id === sequenceId) ||
    [...sequences].sort((a, b) => b.frame_ids.length - a.frame_ids.length)[0];
  const derived =
    display.mode === "rgb" ||
    display.difference ||
    Object.keys(display.operands).length > 0;
  const matched = viewMode === "matched" && !derived;
  const frames = useMemo(
      () =>
        matched
          ? science.frames.filter(
              (f) => sequence && f.sequence_id === sequence.id,
            )
          : science.frames,
      [matched, science.frames, sequence],
    ),
    index = Math.max(
      0,
      frames.findIndex((f) => f.observation_id === selectedFrame),
    ),
    frame = frames[index];
  const setIndex = useCallback(
    (value: number | ((current: number) => number)) => {
      restoreFrame.current = "";
      setSelectedFrame((selected) => {
        const old = Math.max(
          0,
          frames.findIndex((f) => f.observation_id === selected),
        );
        return (
          frames[typeof value === "number" ? value : value(old)]
            ?.observation_id ?? ""
        );
      });
    },
    [frames],
  );
  const product = frame
    ? science.result[science.frames.indexOf(frame)]
    : undefined;
  const observedFrames = useRef(allFrames);
  useEffect(() => {
    observedFrames.current = allFrames;
  }, [allFrames]);
  const frameByObservation = useMemo(
    () => new Map(allFrames.map((f) => [f.observation_id, f])),
    [allFrames],
  );
  const observations = manifest?.observations?.length
    ? manifest.observations
    : undefined;
  const filteredObservations = useMemo(
    () =>
      (observations || []).filter(
        (o) =>
          (!detectorFilter || o.detector === detectorFilter) &&
          (!statusFilter || o.status === statusFilter) &&
          (!recordSearch ||
            `${o.id} ${o.observed_at} ${o.release}`
              .toLowerCase()
              .includes(recordSearch.toLowerCase())),
      ),
    [observations, detectorFilter, statusFilter, recordSearch],
  );
  const pendingCount = filteredObservations.filter(
    (o) => o.status === "pending",
  ).length;
  const failedRecords = filteredObservations.filter(
    (o) => o.status === "failed",
  );
  const unmatchedFrames =
    !matched &&
    !derived &&
    new Set(frames.map((f) => f.sequence_id || f.channel || f.detector)).size >
      1;
  function setMode(mode: "browse" | "matched") {
    setPlaying(false);
    if (derived) update({ mode: "single", difference: false, operands: {} });
    setViewMode(mode);
    if (mode === "matched" && sequence) setSequenceId(sequence.id);
  }
  function exportCatalog() {
    const quote = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const rows = [
      [
        "observation_id",
        "observed_at_utc",
        "detector",
        "release",
        "status",
        "wavelength_um",
        "bandwidth_um",
        "reason",
        "source_url",
      ],
      ...filteredObservations.map((o) => {
        const f = frameByObservation.get(o.id);
        return [
          o.id,
          o.observed_at,
          o.detector,
          o.release,
          o.status,
          f?.wavelength_um,
          f?.bandwidth_um,
          o.reason,
          f?.source_url || o.source_url,
        ];
      }),
    ];
    const url = URL.createObjectURL(
      new Blob([rows.map((r) => r.map(quote).join(",")).join("\r\n")], {
        type: "text/csv;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "observations.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const configuration: Config = {
    query: displayedQuery,
    display,
    frame: frame?.observation_id ?? "",
    fov:
      Number(fov) >= 30 && Number(fov) <= 1800
        ? Number(fov)
        : (displayedQuery?.fov_arcsec ?? 300),
  };
  const backup: Backup = {
    version: 1,
    exported: new Date().toISOString(),
    locations: entries,
    config: configuration,
    snapshot: snapshot(manifest),
    snapshotComplete: manifest?.processing?.archive_complete === true,
  };
  const position =
    displayedQuery && pixel && science.width
      ? skyPosition(displayedQuery, ...pixel, science.width, science.height)
      : displayedQuery;
  const selectedEntry =
    position && frame
      ? {
          position: { ra_deg: position.ra_deg, dec_deg: position.dec_deg },
          config: configuration,
          sources: (product
            ? [...product.inputs, ...product.reference]
            : [frame]
          ).map((f) => f.observation_id),
          metadata: frame.exposure_flags ?? {},
          snapshot: snapshot(manifest),
          snapshotComplete: manifest?.processing?.archive_complete === true,
        }
      : null;
  useEffect(() => {
    if (!frame) return;
    const wanted = frames.find(
      (f) => f.observation_id === restoreFrame.current,
    );
    if (wanted) {
      restoreFrame.current = "";
      setSelectedFrame(wanted.observation_id);
    } else {
      if (!busy && science.settled) restoreFrame.current = "";
      if (frame.observation_id !== selectedFrame)
        setSelectedFrame(frame.observation_id);
    }
  }, [frames, frame, selectedFrame, busy, science.settled]);
  useEffect(() => {
    if (consent === true)
      try {
        const previous = lastSaved.current;
        const pending = !displayedQuery && previous?.config?.query;
        const next = pending
          ? {
              ...backup,
              config: { ...previous.config!, display, fov: configuration.fov },
              snapshot: previous.snapshot,
              snapshotComplete: previous.snapshotComplete,
            }
          : backup;
        if (restoreFrame.current && next.config)
          next.config = { ...next.config, frame: restoreFrame.current };
        localStorage.setItem(storageKey, JSON.stringify(next));
        lastSaved.current = next;
      } catch {
        setError("Could not save the workspace on this device.");
      }
  }, [consent, display, displayedQuery, entries, fov, frame, manifest]);
  useEffect(() => {
    if (restorePosition.current && displayedQuery && science.width) {
      setPixel(
        skyPixel(
          displayedQuery,
          restorePosition.current,
          science.width,
          science.height,
        ),
      );
      restorePosition.current = null;
    }
  }, [displayedQuery, science.width, science.height]);
  function allowSave(yes: boolean) {
    try {
      if (!yes) localStorage.removeItem(storageKey);
      setConsent(yes);
    } catch {
      setError("Device storage is unavailable.");
    }
  }
  const canPlay =
    ready && frames.length > 1 && (!busy || committed === displayedQuery);
  const load = useCallback(
    async (
      query: Query,
      wantedFrame = "",
      wantedPosition: Entry["position"] | null = null,
      more?: LoadBatch,
    ) => {
      controller.current?.abort();
      if (activeJob.current) void cancelJob(activeJob.current).catch(() => {});
      activeJob.current = null;
      const abort = new AbortController();
      controller.current = abort;
      const current = ++generation.current;
      const started = performance.now();
      let publication = "";
      let targetSelected = false;
      let firstFramePublished = false;
      let previousPendingCount = Infinity;
      const before = new Set(
        observedFrames.current.map((f) => f.observation_id),
      );
      timing.current = null;
      setBusy(true);
      setError("");
      setNotice("");
      if (!more) setPlaying(false);
      setCommitted(query);
      setStage(more ? "Loading images" : "Finding observations");
      restorePosition.current = null;
      restoreFrame.current = "";
      if (!more) window.history.replaceState({}, "", queryUrl(query));
      try {
        const id = more
          ? await loadObservations(
              more.jobId,
              abort.signal,
              more.ids ?? more.recordIds?.slice(0, more.size),
              more.detector,
            )
          : await submit(query, abort.signal);
        let deadline = Date.now() + 180000;
        if (abort.signal.aborted || current !== generation.current) {
          void cancelJob(id).catch(() => {});
          return;
        }
        activeJob.current = id;
        timing.current = { query, job: id, start: started, painted: false };
        while (!abort.signal.aborted) {
          if (Date.now() > deadline) {
            void cancelJob(id).catch(() => {});
            throw new Error(
              "Search timed out. Narrow the date range or try again later.",
            );
          }
          const job = await poll(id, abort.signal);
          if (abort.signal.aborted || current !== generation.current) return;
          const progress = job.stage?.match(/^fetch:(\d+)\/(\d+)$/);
          setStage(
            progress
              ? `Checked ${progress[1]} of ${progress[2]} cutouts`
              : stages[job.stage || job.status] || "Processing observations",
          );
          const finished =
            job.status === "complete" || job.status === "partial";
          if (
            job.manifest &&
            (finished ||
              publication ||
              job.manifest.frames.length ||
              job.manifest.observations?.length)
          ) {
            const signature = JSON.stringify([
              job.manifest.processing?.revision ??
                job.manifest.observations?.map((o) => [o.id, o.status]),
              job.manifest.processing?.refreshing_cache === true,
              job.manifest.processing?.archive_complete === true,
              job.manifest.frames.map((f) => [f.id, f.url]),
            ]);
            if (finished || signature !== publication) {
              const result = validateManifest(job.manifest);
              if (!publication) {
                if (!more) {
                  restoreFrame.current = wantedFrame;
                  restorePosition.current = wantedPosition;
                  setPixel(null);
                  setSelectedFrame("");
                  setSequenceId("");
                  setViewMode("browse");
                  setDetectorFilter("");
                  setRecordSearch("");
                  setStatusFilter("");
                }
                setFieldJobId(id);
                setDisplayedQuery(query);
              }
              if (result.frames.length && !firstFramePublished) {
                firstFramePublished = true;
                performance.measure(`planetx:${id}:first-manifest`, {
                  start: started,
                });
              }
              if (
                more &&
                !targetSelected &&
                (more.ids?.length === 1 || more.detector)
              ) {
                const wanted = result.frames.find((f) =>
                  more.ids?.length === 1
                    ? f.observation_id === more.ids[0]
                    : f.detector === more.detector &&
                      !before.has(f.observation_id),
                );
                if (wanted) {
                  setViewMode("browse");
                  setSequenceId(wanted.sequence_id ?? "");
                  setDisplay((previous) => ({
                    ...previous,
                    mode: "single",
                    operands: {},
                    difference: false,
                  }));
                  restoreFrame.current = wanted.observation_id;
                  setSelectedFrame(wanted.observation_id);
                  targetSelected = true;
                }
              }
              publication = signature;
              setManifest({
                ...result,
                warnings: [...(result.warnings || []), ...(job.warnings || [])],
              });
            }
          }
          if (job.status === "cancelled" || job.status === "cancelling") {
            setNotice("Search cancelled.");
            return;
          }
          if (job.status === "failed")
            throw new Error(
              typeof job.error === "string"
                ? job.error
                : "The observations could not be processed. Please try another field.",
            );
          if (finished) {
            if (!job.manifest)
              throw new Error("The service returned no observation manifest.");
            if (more?.all) {
              const remaining = (job.manifest.observations ?? []).filter(
                (o) =>
                  o.status === "pending" &&
                  (!more.detector || o.detector === more.detector) &&
                  (!more.recordIds || more.recordIds.includes(o.id)),
              );
              if (remaining.length) {
                if (remaining.length >= previousPendingCount)
                  throw new Error(
                    "Loading stopped because the last batch made no progress. Retry the pending observations.",
                  );
                previousPendingCount = remaining.length;
                await loadObservations(
                  id,
                  abort.signal,
                  remaining.slice(0, more.size).map((o) => o.id),
                  more.detector,
                );
                deadline = Date.now() + 150000;
                continue;
              }
            }
            if (
              !job.manifest.frames.length &&
              job.manifest.observations?.length
            )
              setNotice(
                "No image in this batch could be loaded. Inspect the failed rows or load another observation.",
              );
            else if (job.manifest.processing?.cache_fallback)
              setNotice(
                "Showing saved observations. The archive could not confirm the latest data.",
              );
            else if (!job.manifest.frames.length)
              setNotice(
                "No comparable observations were found for this field and date range.",
              );
            else if (job.manifest.frames.length === 1)
              setNotice(
                "One observation is available. At least two comparable observations are needed for playback.",
              );
            else if (job.status === "partial")
              setNotice(
                "Some observations could not be processed. Available frames are shown.",
              );
            return;
          }
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              abort.signal.removeEventListener("abort", done);
              resolve();
            };
            const timer = setTimeout(done, 500);
            abort.signal.addEventListener("abort", done, { once: true });
          });
        }
      } catch (e) {
        if (!abort.signal.aborted && current === generation.current)
          setError(
            e instanceof TypeError
              ? "The observation service is unavailable. Please try again when the service is connected."
              : e instanceof Error
                ? e.message
                : "Unable to retrieve observations.",
          );
      } finally {
        if (current === generation.current) {
          setBusy(false);
          activeJob.current = null;
        }
      }
    },
    [],
  );
  function loadBatch(batch: Omit<LoadBatch, "jobId" | "size">) {
    if (displayedQuery && fieldJobId)
      void load(displayedQuery, "", null, {
        ...batch,
        jobId: fieldJobId,
        size: batchSize,
      });
  }
  function cancelSearch() {
    const id = activeJob.current;
    controller.current?.abort();
    const current = ++generation.current;
    activeJob.current = null;
    setBusy(false);
    setNotice("Search cancelled.");
    if (id)
      void cancelJob(id).catch(() => {
        if (generation.current === current)
          setError(
            "The service could not confirm cancellation. It may still be finishing its current request.",
          );
      });
  }
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 1023px)");
    const changed = () => {
      if (narrow.matches) setInspectorOpen(false);
    };
    narrow.addEventListener("change", changed);
    return () => narrow.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    if (window.innerWidth < 700) setDockOpen(false);
    if (window.innerWidth < 1024) setInspectorOpen(false);
    const abort = new AbortController();
    const params = new URLSearchParams(window.location.search);
    let saved: Backup | undefined;
    try {
      const viaUrl = params.has("ra") || params.has("dec");
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        saved = readBackup(raw);
        lastSaved.current = saved;
        setEntries(saved.locations ?? []);
        setConsent(true);
      }
      const state = params.get("view");
      if (state) setDisplay(readDisplay(JSON.parse(state)));
      else if (!viaUrl && saved?.config) setDisplay(saved.config.display);
      if (!params.has("ra") && saved?.config?.query) {
        const q = saved.config.query;
        params.set("ra", String(q.ra_deg));
        params.set("dec", String(q.dec_deg));
        params.set("fov", String(q.fov_arcsec ?? 300));
        if (q.start_utc) params.set("start", q.start_utc.slice(0, 10));
        if (q.end_utc) params.set("end", q.end_utc.slice(0, 10));
        params.set("frame", saved.config.frame);
      }
      setFov(
        viaUrl
          ? (params.get("fov") ?? "300")
          : String(saved?.config?.fov ?? 300),
      );
    } catch {
      setError("Could not restore saved settings.");
    }
    const hasSharedField = params.has("ra") || params.has("dec");
    request<{
      presets?: Array<{
        id: string;
        ra_deg: number;
        dec_deg: number;
        coordinate_epoch?: string;
        cached_manifest_available?: boolean;
      }>;
    }>("/api/presets", abort.signal)
      .then((data) => {
        if (abort.signal.aborted || !Array.isArray(data.presets)) return;
        setTargets((values) =>
          values.map((p) => {
            const source = data.presets!.find((s) => s.id === p.id);
            return source &&
              Number.isFinite(source.ra_deg) &&
              Number.isFinite(source.dec_deg)
              ? {
                  ...p,
                  ra: String(source.ra_deg),
                  dec: String(source.dec_deg),
                }
              : p;
          }),
        );
        // Only open an archive-backed field that the service can supply immediately.
        // Shared URLs and edits made while presets are loading take precedence.
        const initial = data.presets.find(
          (p) =>
            p.cached_manifest_available &&
            Number.isFinite(p.ra_deg) &&
            Number.isFinite(p.dec_deg),
        );
        const opening =
          initial ||
          data.presets.find(
            (p) => Number.isFinite(p.ra_deg) && Number.isFinite(p.dec_deg),
          );
        if (
          !hasSharedField &&
          opening &&
          generation.current === 0 &&
          !document.querySelector<HTMLInputElement>('input[name="ra"]')
            ?.value &&
          !document.querySelector<HTMLInputElement>('input[name="dec"]')?.value
        ) {
          setSelected(opening.id);
          setRa(String(opening.ra_deg));
          setDec(String(opening.dec_deg));
          void load({ ra_deg: opening.ra_deg, dec_deg: opening.dec_deg });
        }
      })
      .catch(() => {});
    if (hasSharedField) {
      const r = params.get("ra") || "",
        d = params.get("dec") || "",
        s = params.get("start") || "",
        e = params.get("end") || "";
      setRa(r);
      setDec(d);
      setStart(s);
      setEnd(e);
      if (s || e) setDatesOpen(true);
      try {
        const query = {
          ...parseQuery(r, d, s, e),
          fov_arcsec: angularWidth(params.get("fov") ?? "300"),
          live: true,
        };
        // Strict Mode cleans up its first mount before this task runs.
        queueMicrotask(() => {
          if (!abort.signal.aborted)
            void load(query, params.get("frame") ?? "");
        });
      } catch (err) {
        setError((err as Error).message);
      }
    }
    return () => {
      abort.abort();
      controller.current?.abort();
    };
  }, [load]);
  useEffect(() => {
    if (!playing || !canPlay) return;
    const timer = setTimeout(() => {
      if (!loop && index === frames.length - 1) {
        setPlaying(false);
        return;
      }
      setIndex((i) => (i + 1) % frames.length);
    }, 1000 / speed);
    return () => clearTimeout(timer);
  }, [playing, canPlay, speed, frames.length, index, loop, setIndex]);
  useEffect(() => {
    const hide = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener("visibilitychange", hide);
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setInspectorOpen(false);
      }
      if ((e.target as HTMLElement).closest("input,select,textarea,button,a"))
        return;
      if (e.code === "Space") {
        if (!canPlay && !playing) return;
        e.preventDefault();
        setPlaying((p) => !p);
      }
      if (!frames.length) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setPlaying(false);
        setIndex((i) => (i + 1) % frames.length);
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPlaying(false);
        setIndex((i) => (i - 1 + frames.length) % frames.length);
      }
    };
    window.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("keydown", keys);
    };
  }, [canPlay, frames.length, playing, setIndex]);
  const onReady = useCallback((value: boolean) => setReady(value), []);
  const onFailure = useCallback(() => {
    setError(
      "An observation image could not be loaded. Search again to refresh the sequence.",
    );
  }, []);
  const onPaint = useCallback((query: Query) => {
    const run = timing.current;
    if (run && run.query === query && !run.painted) {
      run.painted = true;
      performance.measure(`planetx:${run.job}:first-canvas-draw`, {
        start: run.start,
      });
    }
  }, []);
  function choose(p: Preset) {
    setSelected(p.id);
    setRa(p.ra);
    setDec(p.dec);
    setNotice(
      p.ra
        ? p.note
        : "Verified coordinates for this target will be supplied by the observation service. You can also enter coordinates manually.",
    );
    setError("");
  }
  function search(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    try {
      void load({
        ...parseQuery(ra, dec, start, end),
        fov_arcsec: angularWidth(fov),
        live: true,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }
  function restoreConfig(
    c: Config,
    wantedPosition: Entry["position"] | null = null,
  ) {
    setDisplay(c.display);
    setFov(String(c.fov));
    if (c.query) {
      const q = c.query;
      setRa(String(q.ra_deg));
      setDec(String(q.dec_deg));
      setStart(q.start_utc?.slice(0, 10) ?? "");
      setEnd(q.end_utc?.slice(0, 10) ?? "");
      setSelected("");
      void load({ ...q, live: true }, c.frame, wantedPosition);
    }
  }
  function importBackup(b: Backup) {
    if (b.locations)
      setEntries((old) =>
        Array.from(
          new Map([...old, ...b.locations!].map((e) => [e.id, e])).values(),
        ),
      );
    if (b.config) restoreConfig(b.config);
  }
  useEffect(() => {
    if (!displayedQuery || busy || displayedQuery !== committed) return;
    const url = queryUrl(
      displayedQuery,
      display,
      playing ? undefined : frame?.observation_id,
    );
    window.history.replaceState({}, "", url);
  }, [displayedQuery, committed, busy, display, frame, playing]);
  async function share() {
    if (!committed) return;
    const url = queryUrl(
      displayedQuery ?? committed,
      display,
      frame?.observation_id,
    );
    window.history.replaceState({}, "", url);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setNotice("Copy the address from your browser to share this field.");
    }
  }
  function step(n: number) {
    setPlaying(false);
    setIndex((i) => Math.max(0, Math.min(frames.length - 1, i + n)));
  }
  return (
    <div className={"app-layout" + (settingsOpen ? "" : " settings-collapsed")}>
      <a className="skip-link" href="#workspace">
        Skip to workspace
      </a>
      <header className="app-header">
        <a className="brand" href="/" aria-label="Planet X home">
          <span className="brand-mark">
            <Crosshair size={21} strokeWidth={1.5} />
          </span>
          <span>
            Planet <b>X</b>
          </span>
        </a>
        <div className="header-actions">
          <button
            className="button mobile-field-toggle"
            aria-label="Toggle field settings"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <SlidersHorizontal size={14} />
            Field
          </button>
          <button
            className="button share"
            onClick={share}
            disabled={!committed}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Link copied" : "Share field"}
          </button>
        </div>
      </header>
      <aside className="sidebar" aria-label="Query and display settings">
        <nav className="panel-tabs" aria-label="Settings navigation">
          {["Settings", "Surveys", "Links", "Help", "About"].map((value) => (
            <button
              key={value}
              onClick={() => setTab(value)}
              aria-pressed={tab === value}
              className={tab === value ? "active" : ""}
            >
              {value}
            </button>
          ))}
        </nav>
        <div className="settings-scroll">
          {tab === "Settings" ? (
            <>
              <form className="search-panel" onSubmit={search} noValidate>
                <div className="control-section-heading">
                  <span>Sky coordinates</span>
                </div>
                <div className="preset-field">
                  <label htmlFor="preset">Reference target</label>
                  <select
                    id="preset"
                    value={selected}
                    onChange={(e) => {
                      const p = targets.find((p) => p.id === e.target.value);
                      if (p) choose(p);
                    }}
                  >
                    <option value="">Custom coordinates</option>
                    {targets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="search-fields">
                  <label>
                    Right ascension <span>RA · °</span>
                    <input
                      name="ra"
                      inputMode="decimal"
                      placeholder="0.000000"
                      value={ra}
                      onChange={(e) => {
                        setRa(e.target.value);
                        setSelected("");
                      }}
                    />
                  </label>
                  <label>
                    Declination <span>Dec · °</span>
                    <input
                      name="dec"
                      inputMode="decimal"
                      placeholder="+0.000000"
                      value={dec}
                      onChange={(e) => {
                        setDec(e.target.value);
                        setSelected("");
                      }}
                    />
                  </label>
                </div>
                <div className="fixed-field">
                  <label htmlFor="fov">Field of view (arcsec)</label>
                  <input
                    id="fov"
                    type="number"
                    min="30"
                    max="1800"
                    required
                    value={fov}
                    onChange={(e) => setFov(e.target.value)}
                  />
                  <input
                    aria-label="Field of view slider"
                    type="range"
                    min="30"
                    max="1800"
                    value={fov}
                    onChange={(e) => setFov(e.target.value)}
                  />
                </div>
                <div className="dataset-field">
                  <label htmlFor="dataset">Dataset</label>
                  <select id="dataset" disabled>
                    <option>SPHEREx / IRSA</option>
                  </select>
                </div>
                <button
                  className="button date-toggle"
                  type="button"
                  aria-expanded={datesOpen}
                  onClick={() => setDatesOpen(!datesOpen)}
                >
                  <CalendarDays size={13} /> Dates{start || end ? " · set" : ""}
                  <ChevronDown size={12} />
                </button>
                {datesOpen && (
                  <div className="search-fields date-fields">
                    <label>
                      From <span>UTC</span>
                      <input
                        type="date"
                        name="start"
                        value={start}
                        onChange={(e) => setStart(e.target.value)}
                      />
                    </label>
                    <label>
                      To <span>UTC</span>
                      <input
                        type="date"
                        name="end"
                        value={end}
                        onChange={(e) => setEnd(e.target.value)}
                      />
                    </label>
                  </div>
                )}
                <div className="query-actions">
                  <button
                    className="button primary"
                    type="submit"
                    disabled={busy}
                  >
                    {busy ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <Search size={14} />
                    )}
                    {busy ? "Searching" : "Search observations"}
                  </button>
                  {busy ? (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Cancel search"
                      title="Cancel search"
                      onClick={cancelSearch}
                    >
                      <X size={14} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Reset defaults"
                      title="Reset query and display defaults"
                      onClick={() => {
                        setRa("");
                        setDec("");
                        setStart("");
                        setEnd("");
                        setSelected("");
                        setDisplay(defaults);
                        setFov("300");
                        setError("");
                        setNotice("");
                      }}
                    >
                      <RotateCcw size={14} />
                    </button>
                  )}
                </div>
              </form>
              {manifest?.frames.length && !science.numeric ? (
                <p className="preview-note">
                  Prepared PNG preview. Search observations to load calibrated
                  brightness values for color and band controls.
                </p>
              ) : null}
              {science.numeric && (
                <ImageControls
                  s={display}
                  update={update}
                  frames={manifest?.frames ?? empty}
                  bounds={science.bounds}
                />
              )}
              <WorkspacePanel
                backup={backup}
                saveEntries={setEntries}
                selected={selectedEntry}
                consent={consent}
                setConsent={allowSave}
                restore={importBackup}
                reopen={(e) => restoreConfig(e.config, e.position)}
                onError={setError}
              />
              <section className="control-section">
                <div className="control-section-heading">
                  <span>Playback & scale</span>
                </div>
                <label className="slider-label" htmlFor="interval">
                  Blink interval{" "}
                  <span>
                    {Math.round(1000 / speed)} <small>ms</small>
                  </span>
                </label>
                <input
                  id="interval"
                  type="range"
                  min="100"
                  max="2000"
                  step="100"
                  value={Math.round(1000 / speed)}
                  onChange={(e) => setSpeed(1000 / Number(e.target.value))}
                />
              </section>
              <section className="control-section">
                <div className="control-section-heading">
                  <span>Image appearance</span>
                </div>
                {!science.numeric && (
                  <>
                    <label className="slider-label" htmlFor="stretch">
                      Display stretch <span>Shared</span>
                    </label>
                    <select id="stretch" disabled>
                      <option>{manifest?.stretch || "Asinh"}</option>
                    </select>
                    <div className="range-fields">
                      <label>
                        Min pixel value
                        <input
                          disabled
                          value={
                            manifest?.processing?.stretch?.vmin?.toPrecision(
                              4,
                            ) ?? "—"
                          }
                        />
                      </label>
                      <label>
                        Max pixel value
                        <input
                          disabled
                          value={
                            manifest?.processing?.stretch?.vmax?.toPrecision(
                              4,
                            ) ?? "—"
                          }
                        />
                      </label>
                    </div>
                  </>
                )}
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={invert}
                    onChange={(e) => setInvert(e.target.checked)}
                    disabled={!ready}
                  />
                  {science.numeric ? "Invert colors" : "Invert grayscale"}
                </label>
              </section>
            </>
          ) : tab === "Surveys" ? (
            displayedQuery ? (
              <FieldSurveys
                key={`${displayedQuery.ra_deg},${displayedQuery.dec_deg}`}
                query={displayedQuery}
              />
            ) : (
              <p className="panel-copy">
                Search a sky position to load survey data.
              </p>
            )
          ) : (
            <section className="panel-copy">
              {tab === "Links" ? (
                <>
                  <h2>Archive resources</h2>
                  <a
                    href="https://irsa.ipac.caltech.edu/Missions/spherex.html"
                    target="_blank"
                    rel="noreferrer"
                  >
                    SPHEREx archive <ArrowUpRight size={14} />
                  </a>
                  <a
                    href="https://caltech-ipac.github.io/spherex-archive-documentation/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Data documentation <ArrowUpRight size={14} />
                  </a>
                </>
              ) : tab === "Help" ? (
                <>
                  <h2>Inspecting a field</h2>
                  <p>
                    Enter right ascension (0–360°) and declination (−90–90°) in
                    decimal degrees, then search observations.
                  </p>
                  <p>
                    The field of view defines the sky area retrieved. Zoom only
                    magnifies the displayed pixels. Drag the image to pan.
                  </p>
                  <p>
                    Play blinks between loaded observations in acquisition
                    order. Use Space to play or pause and arrow keys to step.
                  </p>
                  <p>
                    Inversion changes the grayscale display only. Compare
                    matching wavelengths before interpreting changes in
                    brightness.
                  </p>
                </>
              ) : (
                <>
                  <h2>Planet X</h2>
                  <p>
                    A workspace for inspecting infrared observations across
                    time.
                  </p>
                  <p>
                    Data: SPHEREx / NASA / Caltech / IPAC IRSA. Each loaded
                    frame retains its archive source and acquisition details.
                  </p>
                  <p>
                    Apparent changes can reflect wavelength, calibration, or
                    instrument effects. This viewer does not verify discoveries.
                  </p>
                </>
              )}
            </section>
          )}
        </div>
      </aside>
      <main id="workspace">
        <div className="content">
          <h1 className="sr-only">Planet X</h1>
          <div className="feedback" aria-live="polite">
            {committed &&
              !busy &&
              (Number(ra) !== committed.ra_deg ||
                Number(dec) !== committed.dec_deg ||
                Number(fov) !== (committed.fov_arcsec ?? 300) ||
                start !== (committed.start_utc?.slice(0, 10) || "") ||
                end !== (committed.end_utc?.slice(0, 10) || "")) && (
                <p>
                  <Info size={14} />
                  Query edited. The viewer still shows the last searched field.
                  Search to apply changes.
                </p>
              )}
            {busy && (
              <p className="processing">
                <LoaderCircle size={14} className="spin" />
                {displayedQuery === committed &&
                manifest?.processing?.refreshing_cache
                  ? "Showing cached observations while checking the archive for updates."
                  : `${stage}.`}
                {manifest?.frames.length
                  ? displayedQuery === committed
                    ? ` ${manifest.frames.length} observation${manifest.frames.length === 1 ? "" : "s"} available.`
                    : " Previous field shown."
                  : ""}
              </p>
            )}
            {!busy &&
              displayedQuery &&
              committed &&
              displayedQuery !== committed &&
              frames.length > 0 && (
                <p>
                  <Info size={14} />
                  Showing the previous field. The latest search has no result.
                </p>
              )}
            {error && (
              <p role="alert" className="error">
                <Info size={15} />
                {error}
              </p>
            )}
            {science.failure && frames.length > 0 && (
              <p role="alert">{science.failure}</p>
            )}
            {notice && (
              <p>
                <Info size={15} />
                {notice}
              </p>
            )}
          </div>
          <div
            className={
              "workspace-grid" + (inspectorOpen ? "" : " inspector-collapsed")
            }
          >
            <section className="viewer-section" aria-label="Observation viewer">
              <div className="section-heading">
                <span className="field-readout mono">
                  {displayedQuery && frames.length
                    ? `${displayedQuery.ra_deg.toFixed(6)}, ${displayedQuery.dec_deg.toFixed(6)}`
                    : ""}
                </span>
                <div className="viewer-heading-actions">
                  <button
                    className={
                      "inspector-toggle " + (inspectorOpen ? "is-active" : "")
                    }
                    aria-label="Toggle frame details"
                    aria-expanded={inspectorOpen}
                    onClick={() => setInspectorOpen(!inspectorOpen)}
                  >
                    <PanelRight size={14} />
                    <span>Details</span>
                  </button>
                </div>
              </div>
              {allFrames.length > 0 && (
                <div className="sequence-toolbar">
                  <div
                    className="view-modes"
                    role="group"
                    aria-label="Playback mode"
                  >
                    <button
                      aria-pressed={!matched && !derived}
                      onClick={() => setMode("browse")}
                      title="Browse loaded observations in acquisition order"
                    >
                      Browse
                    </button>
                    <button
                      aria-pressed={matched}
                      disabled={!sequences.some((s) => s.frame_ids.length)}
                      onClick={() => setMode("matched")}
                      title="Play observations with compatible wavelength and calibration"
                    >
                      Matched
                    </button>
                  </div>
                  {matched && sequences.length > 0 ? (
                    <>
                      <label className="sr-only" htmlFor="sequence">
                        Wavelength sequence
                      </label>
                      <select
                        id="sequence"
                        value={sequence?.id || ""}
                        onChange={(e) => {
                          setSequenceId(e.target.value);
                          setSelectedFrame("");
                          setPlaying(false);
                        }}
                      >
                        {[...sequences]
                          .filter((g) => g.frame_ids.length)
                          .sort(
                            (a, b) => b.frame_ids.length - a.frame_ids.length,
                          )
                          .map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.detector} / {g.wavelength_um.toFixed(3)}{" "}
                              microns / {g.frame_ids.length} frame
                              {g.frame_ids.length === 1 ? "" : "s"}
                            </option>
                          ))}
                      </select>
                    </>
                  ) : (
                    <span
                      className={
                        unmatchedFrames
                          ? "wavelength-warning"
                          : "browse-summary"
                      }
                    >
                      {unmatchedFrames
                        ? "Unmatched observations; brightness is not directly comparable."
                        : derived
                          ? String(frames.length) +
                            (frames.length === 1
                              ? " derived image"
                              : " derived images")
                          : `${allFrames.length} loaded image${allFrames.length === 1 ? "" : "s"}`}
                    </span>
                  )}
                </div>
              )}
              <SkyViewer
                unmatchedFrames={unmatchedFrames}
                frames={frames}
                index={index}
                onReady={onReady}
                onFailure={onFailure}
                onPaint={onPaint}
                zoom={zoom}
                invert={invert}
                display={display}
                update={update}
                query={displayedQuery}
                bounds={
                  science.numeric
                    ? science.bounds
                    : [
                        manifest?.processing?.stretch?.vmin ?? 0,
                        manifest?.processing?.stretch?.vmax ?? 1,
                      ]
                }
                colors={science.colors}
                onPixel={(x, y) => setPixel([x, y])}
                message={science.message}
                grid={manifest?.grid}
              />
              <div className="playback">
                <div className="transport">
                  <button
                    aria-label="First frame"
                    disabled={frames.length < 2}
                    onClick={() => {
                      setPlaying(false);
                      setIndex(0);
                    }}
                  >
                    <SkipBack size={15} />
                  </button>
                  <button
                    aria-label="Previous frame"
                    disabled={frames.length < 2}
                    onClick={() => step(-1)}
                  >
                    <ChevronLeft size={17} />
                  </button>
                  <button
                    className="play"
                    aria-label={playing ? "Pause" : "Play"}
                    disabled={!canPlay && !playing}
                    onClick={() => setPlaying((p) => !p)}
                  >
                    {playing ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                  <button
                    aria-label="Next frame"
                    disabled={frames.length < 2}
                    onClick={() => step(1)}
                  >
                    <ChevronRight size={17} />
                  </button>
                  <button
                    aria-label="Last frame"
                    disabled={frames.length < 2}
                    onClick={() => {
                      setPlaying(false);
                      setIndex(frames.length - 1);
                    }}
                  >
                    <SkipForward size={15} />
                  </button>
                </div>
                <div className="speed">
                  <label htmlFor="speed">Speed</label>
                  <select
                    id="speed"
                    value={speed}
                    onChange={(e) => setSpeed(Number(e.target.value))}
                  >
                    {![0.5, 1, 2, 4].includes(speed) && (
                      <option value={speed}>
                        {Math.round(1000 / speed)} ms
                      </option>
                    )}
                    <option value={0.5}>2000 ms</option>
                    <option value={1}>1000 ms</option>
                    <option value={2}>500 ms</option>
                    <option value={4}>250 ms</option>
                  </select>
                </div>
                <button
                  className={"loop-toggle " + (loop ? "active" : "")}
                  aria-label="Loop playback"
                  aria-pressed={loop}
                  title="Loop playback"
                  onClick={() => setLoop((v) => !v)}
                >
                  <Repeat size={14} />
                </button>
                <span className="frame-counter">
                  {frames.length ? String(index + 1).padStart(2, "0") : "—"}{" "}
                  <span>
                    /{" "}
                    {frames.length
                      ? String(frames.length).padStart(2, "0")
                      : "—"}
                  </span>
                </span>
              </div>
              <div className="timeline">
                <input
                  aria-label="Observation timeline"
                  type="range"
                  min={0}
                  max={Math.max(1, frames.length - 1)}
                  value={index}
                  disabled={frames.length < 2}
                  onChange={(e) => {
                    setPlaying(false);
                    setIndex(Number(e.target.value));
                  }}
                />
                <div>
                  <span>
                    {frames.length ? stamp(frames[0].observed_at) : ""}
                  </span>
                  <span>
                    {frames.length
                      ? stamp(frames[frames.length - 1].observed_at)
                      : ""}
                  </span>
                </div>
              </div>
              {frames.length === 1 && (
                <div className="playback-guidance">
                  {matched ? (
                    <>
                      <span>One matched frame loaded.</span>
                      {allFrames.length > 1 && (
                        <button onClick={() => setMode("browse")}>
                          Browse all {allFrames.length} images
                        </button>
                      )}
                    </>
                  ) : (
                    <span>
                      One image loaded. Load more observations to play.
                    </span>
                  )}
                </div>
              )}
            </section>
            {inspectorOpen && (
              <aside className="inspector" aria-label="Frame details">
                <div className="section-heading">
                  <h2>Frame details</h2>
                  <button
                    className="inspector-close"
                    aria-label="Close frame details"
                    onClick={() => setInspectorOpen(false)}
                  >
                    <X size={14} />
                  </button>
                </div>
                {!frame ? (
                  <p className="inspector-empty">Select an observation.</p>
                ) : (
                  <>
                    {product && (
                      <div className="detail-group">
                        <h3>Contributing exposures</h3>
                        {product.inputs.map((f) => (
                          <p key={f.id}>
                            {f.channel} · {stamp(f.observed_at)}
                          </p>
                        ))}
                        {product.reference.map((f) => (
                          <p key={f.id}>Reference · {stamp(f.observed_at)}</p>
                        ))}
                        {(display.mode === "rgb" ||
                          product.sourcePlanes?.some((p) => p.quality)) && (
                          <Spectrum
                            product={product}
                            pixel={pixel}
                            width={science.width}
                            height={science.height}
                            inspectFlagged={display.inspectFlagged}
                          />
                        )}
                      </div>
                    )}
                    <div className="detail-group">
                      <h3>Acquisition</h3>
                      <dl>
                        <dt>Observed at</dt>
                        <dd>{stamp(frame?.observed_at)}</dd>
                        <dt>Detector</dt>
                        <dd>{frame?.detector || "—"}</dd>
                        <dt>Release</dt>
                        <dd>{frame?.release || "—"}</dd>
                      </dl>
                    </div>
                    <div className="detail-group">
                      <h3>Spectral information</h3>
                      <dl>
                        <dt>Wavelength</dt>
                        <dd>
                          {frame?.wavelength_um != null
                            ? `${frame.wavelength_um.toFixed(3)} μm`
                            : "—"}
                        </dd>
                        <dt>Bandwidth</dt>
                        <dd>
                          {frame?.bandwidth_um != null
                            ? `${frame.bandwidth_um.toFixed(3)} μm`
                            : "—"}
                        </dd>
                        <dt>Display stretch</dt>
                        <dd>
                          {science.numeric
                            ? display.stretch
                            : manifest?.stretch || "—"}
                        </dd>
                      </dl>
                    </div>
                    <div className="detail-group">
                      <h3>Provenance</h3>
                      <dl>
                        <dt>Observation ID</dt>
                        <dd className="mono break">
                          {frame?.observation_id || "—"}
                        </dd>
                        <dt>Retrieved</dt>
                        <dd>{stamp(manifest?.retrieved_at)}</dd>
                        <dt>Data origin</dt>
                        <dd>
                          {manifest
                            ? manifest.cached ||
                              manifest.processing?.refreshing_cache ||
                              manifest.processing?.cache_fallback
                              ? "Cached archive data"
                              : "Live archive query"
                            : "—"}
                        </dd>
                      </dl>
                      {frame?.source_url &&
                        /^https?:\/\//.test(frame.source_url) && (
                          <a
                            className="source-link"
                            href={assetUrl(frame.source_url)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open archive source <ArrowUpRight size={13} />
                          </a>
                        )}
                    </div>
                    {[
                      ...(manifest?.warnings || []),
                      ...(frame?.warnings || []),
                    ].map((warning, i) => (
                      <p className="warning" key={i}>
                        <Info size={13} />
                        {warning}
                      </p>
                    ))}
                  </>
                )}
              </aside>
            )}
          </div>
          <section
            className={
              "observations-dock " +
              (!dockOpen ? "collapsed" : "") +
              (dockExpanded ? " expanded" : "")
            }
            aria-label="Observations"
          >
            <div className="dock-header">
              <button
                className="dock-heading"
                onClick={() => {
                  setDockOpen(!dockOpen);
                  if (dockExpanded) setDockExpanded(false);
                }}
                aria-expanded={dockOpen}
              >
                <Layers size={14} />
                <strong>Observations</strong>
                <span className="count-badge">
                  {observations?.length ?? allFrames.length}
                </span>
                <ChevronDown size={14} />
              </button>
              <button
                className="dock-expand"
                aria-label={
                  dockExpanded ? "Restore image view" : "Expand observations"
                }
                title={
                  dockExpanded ? "Restore image view" : "Expand observations"
                }
                onClick={() => {
                  setDockExpanded((v) => !v);
                  setDockOpen(true);
                }}
              >
                {dockExpanded ? (
                  <Minimize2 size={14} />
                ) : (
                  <Maximize2 size={14} />
                )}
              </button>
            </div>
            {dockOpen && (
              <>
                {observations && (
                  <>
                    <div className="catalog-controls">
                      <label htmlFor="detector-filter">Detector</label>
                      <select
                        id="detector-filter"
                        value={detectorFilter}
                        onChange={(e) => setDetectorFilter(e.target.value)}
                      >
                        <option value="">All six</option>
                        {["D1", "D2", "D3", "D4", "D5", "D6"].map((d) => (
                          <option key={d} value={d}>
                            {d} (
                            {observations?.filter((o) => o.detector === d)
                              .length ?? 0}
                            )
                          </option>
                        ))}
                      </select>
                      <label className="sr-only" htmlFor="status-filter">
                        Observation status
                      </label>
                      <select
                        id="status-filter"
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value)}
                      >
                        <option value="">All statuses</option>
                        <option value="ready">Loaded</option>
                        <option value="pending">Not loaded</option>
                        <option value="loading">Loading</option>
                        <option value="failed">Failed</option>
                      </select>
                      <input
                        className="catalog-search"
                        aria-label="Find observation"
                        placeholder="Find observation…"
                        value={recordSearch}
                        onChange={(e) => setRecordSearch(e.target.value)}
                      />
                      <span>
                        {
                          filteredObservations.filter(
                            (o) => o.status === "ready",
                          ).length
                        }{" "}
                        loaded /{" "}
                        {filteredObservations.filter(
                          (o) => o.status === "failed",
                        ).length || 0}{" "}
                        failed /{" "}
                        {filteredObservations.filter(
                          (o) =>
                            o.status === "pending" || o.status === "loading",
                        ).length || 0}{" "}
                        not loaded
                      </span>
                      <button
                        className="button"
                        disabled={busy || !pendingCount || !fieldJobId}
                        onClick={() => {
                          loadBatch({
                            detector: detectorFilter || undefined,
                            ids: filteredObservations
                              .filter((o) => o.status === "pending")
                              .slice(0, batchSize)
                              .map((o) => o.id),
                          });
                        }}
                      >
                        {pendingCount
                          ? `Load next ${Math.min(batchSize, pendingCount)}`
                          : "No pending images"}
                      </button>
                      <button
                        className="button"
                        disabled={busy || !pendingCount || !fieldJobId}
                        onClick={() => {
                          loadBatch({
                            detector: detectorFilter || undefined,
                            all: true,
                            recordIds: filteredObservations
                              .filter((o) => o.status === "pending")
                              .map((o) => o.id),
                          });
                        }}
                      >
                        Load all{detectorFilter ? ` ${detectorFilter}` : ""}
                      </button>
                      {busy && (
                        <button
                          className="button"
                          aria-label="Stop loading"
                          onClick={cancelSearch}
                        >
                          Stop
                        </button>
                      )}
                      {failedRecords.length > 0 && (
                        <button
                          className="button"
                          disabled={busy || !fieldJobId}
                          onClick={() => {
                            loadBatch({
                              ids: failedRecords
                                .slice(0, batchSize)
                                .map((o) => o.id),
                            });
                          }}
                        >
                          Retry {Math.min(batchSize, failedRecords.length)}{" "}
                          failed
                        </button>
                      )}
                      <button
                        className="catalog-export"
                        aria-label="Export observation catalog"
                        title="Export filtered catalog as CSV"
                        disabled={!filteredObservations.length}
                        onClick={exportCatalog}
                      >
                        <Download size={15} />
                      </button>
                      {manifest?.discovery_complete === false && (
                        <span>Partial archive results; refine dates.</span>
                      )}
                    </div>
                  </>
                )}
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Frame</th>
                        <th>Acquired · UTC</th>
                        <th>Detector</th>
                        <th>Release</th>
                        <th>Observation ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {observations
                        ? filteredObservations.map((o) => {
                            const f = frameByObservation.get(o.id);
                            return (
                              <tr
                                key={o.id}
                                className={
                                  frame?.observation_id === o.id ? "active" : ""
                                }
                              >
                                <td>
                                  <button
                                    disabled={busy && !f}
                                    title={
                                      o.reason ||
                                      (f
                                        ? "Inspect observation"
                                        : "Load this observation")
                                    }
                                    onClick={() => {
                                      setDockExpanded(false);
                                      if (f) {
                                        setSequenceId(f.sequence_id || "");
                                        setViewMode("browse");
                                        update({
                                          mode: "single",
                                          difference: false,
                                          operands: {},
                                        });
                                        setSelectedFrame(f.observation_id);
                                        setPlaying(false);
                                      } else if (fieldJobId)
                                        loadBatch({
                                          ids: [o.id],
                                        });
                                    }}
                                  >
                                    {f
                                      ? "View"
                                      : o.status === "failed"
                                        ? "Retry"
                                        : o.status === "loading"
                                          ? "Loading"
                                          : "Load"}
                                  </button>
                                </td>
                                <td>
                                  {stamp(o.observed_at).replace(" UTC", "")}
                                </td>
                                <td>{o.detector}</td>
                                <td>{o.release}</td>
                                <td>
                                  <span
                                    className="observation-status"
                                    title={o.reason || ""}
                                  >
                                    {o.status}
                                    {o.reason ? `: ${o.reason}` : ""}
                                  </span>
                                  <span className="mono">{o.id}</span>
                                </td>
                              </tr>
                            );
                          })
                        : frames.map((f, i) => (
                            <tr
                              key={f.id}
                              className={i === index ? "active" : ""}
                            >
                              <td>
                                <button
                                  aria-label={`Select frame ${i + 1}`}
                                  onClick={() => {
                                    setPlaying(false);
                                    setIndex(i);
                                  }}
                                >
                                  {String(i + 1).padStart(2, "0")}
                                  <ChevronRight size={12} />
                                </button>
                              </td>
                              <td>
                                {stamp(f.observed_at).replace(" UTC", "")}
                              </td>
                              <td>{f.detector}</td>
                              <td>{f.release || "—"}</td>
                              <td className="mono">{f.observation_id}</td>
                            </tr>
                          ))}
                    </tbody>
                  </table>
                  {!!observations?.length && !filteredObservations.length && (
                    <div className="table-empty">
                      <span>No matching observations</span>
                      <button
                        onClick={() => {
                          setDetectorFilter("");
                          setStatusFilter("");
                          setRecordSearch("");
                        }}
                      >
                        Clear filters
                      </button>
                    </div>
                  )}
                  {!(observations?.length || allFrames.length) && (
                    <div className="table-empty">
                      <span>No observations</span>
                    </div>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
