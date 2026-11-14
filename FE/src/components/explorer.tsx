"use client";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useLayoutEffect,
  FormEvent,
  type ReactNode,
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
  Repeat,
  Download,
  Maximize2,
  Minimize2,
  SlidersHorizontal,
} from "lucide-react";
import SkyViewer from "./sky-viewer";
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
import { parseQuery, queryUrl } from "@/lib/view-url";
import { elapsedTime } from "@/lib/observation-time";
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
function Notification({
  children,
  label,
  onDismiss,
  variant,
}: {
  children: ReactNode;
  label: string;
  onDismiss: () => void;
  variant?: "error" | "processing";
}) {
  return (
    <p className={variant} role={variant === "error" ? "alert" : undefined}>
      {variant === "processing" ? (
        <LoaderCircle size={14} className="spin" />
      ) : (
        <Info size={14} />
      )}
      <span className="notification-copy">{children}</span>
      <button
        type="button"
        className="notification-close"
        aria-label={`Dismiss ${label}`}
        title="Dismiss notification"
        onClick={onDismiss}
      >
        <X size={14} />
      </button>
    </p>
  );
}
export default function Explorer() {
  const [targets, setTargets] = useState(presets),
    [selected, setSelected] = useState(""),
    [ra, setRa] = useState(""),
    [dec, setDec] = useState(""),
    [start, setStart] = useState(""),
    [end, setEnd] = useState("");
  const [manifest, setManifest] = useState<Manifest | null>(null),
    [focusedFrame, setFocusedFrame] = useState<string | null>(null),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [stage, setStage] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [copied, setCopied] = useState(false);
  const [dismissedDraft, setDismissedDraft] = useState("");
  const [progressDismissed, setProgressDismissed] = useState(false);
  const [previousDismissed, setPreviousDismissed] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [datesOpen, setDatesOpen] = useState(false);
  const [fov, setFov] = useState("300");
  const [spacing, setSpacing] = useState("60");
  const draftKey = JSON.stringify([ra, dec, fov, spacing, start, end]);
  const [fieldJobId, setFieldJobId] = useState("");
  const [sequenceId, setSequenceId] = useState("");
  const [viewMode, setViewMode] = useState<"browse" | "matched">("browse");
  const [timelineIds, setTimelineIds] = useState<Set<string> | null>(null);
  const [showAllRecords, setShowAllRecords] = useState(false);
  const [loop, setLoop] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [recordSearch, setRecordSearch] = useState("");
  const [dockExpanded, setDockExpanded] = useState(false);
  const [detectorFilter, setDetectorFilter] = useState("");
  const [tab, setTab] = useState("Settings");
  const [zoom, setZoom] = useState(1);
  const [invert, setInvert] = useState(false);
  const [dockOpen, setDockOpen] = useState(true);
  const [committed, setCommitted] = useState<Query | null>(null);
  const controller = useRef<AbortController | null>(null),
    generation = useRef(0),
    activeJob = useRef<string | null>(null);
  const [displayedQuery, setDisplayedQuery] = useState<Query | null>(null);
  const allFrames = manifest?.frames || empty;
  const initialIds = manifest?.processing?.initial_observation_ids;
  const selectedIds = useMemo(
    () =>
      timelineIds ||
      new Set(initialIds || allFrames.map((f) => f.observation_id)),
    [timelineIds, initialIds, allFrames],
  );
  const selectedFrames = useMemo(
    () => allFrames.filter((f) => selectedIds.has(f.observation_id)),
    [allFrames, selectedIds],
  );
  const selectionRef = useRef(selectedIds);
  useLayoutEffect(() => {
    selectionRef.current = selectedIds;
  }, [selectedIds]);
  const sequences = manifest?.sequences || [];
  const sequenceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const frame of selectedFrames)
      if (frame.sequence_id)
        counts.set(frame.sequence_id, (counts.get(frame.sequence_id) || 0) + 1);
    return counts;
  }, [selectedFrames]);
  const sequenceCount = (id: string) => sequenceCounts.get(id) || 0;
  const rankedSequences = useMemo(
    () =>
      [...sequences].sort(
        (a, b) =>
          (sequenceCounts.get(b.id) || 0) - (sequenceCounts.get(a.id) || 0) ||
          b.frame_ids.length - a.frame_ids.length,
      ),
    [sequences, sequenceCounts],
  );
  const sequence =
    sequences.find((s) => s.id === sequenceId) || rankedSequences[0];
  const frames = useMemo(
    () =>
      viewMode === "matched" && sequence
        ? selectedFrames.filter((f) => f.sequence_id === sequence.id)
        : selectedFrames,
    [selectedFrames, viewMode, sequence?.id],
  );
  const index = Math.max(
    0,
    frames.findIndex((f) => f.url === focusedFrame),
  );
  const frame = frames[index];
  const framesRef = useRef(frames),
    allFramesRef = useRef(allFrames);
  useLayoutEffect(() => {
    framesRef.current = frames;
    allFramesRef.current = allFrames;
  }, [frames, allFrames]);
  const setIndex = useCallback(
    (next: number | ((current: number) => number)) => {
      setFocusedFrame((previous) => {
        const list = framesRef.current,
          current = Math.max(
            0,
            list.findIndex((f) => f.url === previous),
          );
        const target = typeof next === "function" ? next(current) : next;
        return (
          list[Math.max(0, Math.min(list.length - 1, target))]?.url || null
        );
      });
    },
    [],
  );
  useEffect(() => {
    if (frames.length && !frames.some((f) => f.url === focusedFrame))
      setFocusedFrame(frames[0].url);
  }, [frames, focusedFrame]);
  useEffect(() => {
    setPlaying(false);
  }, [viewMode]);
  useEffect(() => {
    if (viewMode === "matched") setPlaying(false);
  }, [sequence?.id]);
  const frameByObservation = useMemo(
    () => new Map(allFrames.map((f) => [f.observation_id, f])),
    [allFrames],
  );
  const observations = manifest?.observations;
  const pointingCount = useMemo(
    () =>
      new Set((observations || []).map((o) => o.id.replace(/D[1-6]$/, "")))
        .size,
    [observations],
  );
  const filteredObservations = useMemo(
    () =>
      (observations || []).filter(
        (o) =>
          (!detectorFilter || o.detector === detectorFilter) &&
          (showAllRecords || o.time_sample !== false) &&
          (!statusFilter || o.status === statusFilter) &&
          (!recordSearch ||
            `${o.id} ${o.observed_at} ${o.release}`
              .toLowerCase()
              .includes(recordSearch.toLowerCase())),
      ),
    [observations, detectorFilter, statusFilter, recordSearch, showAllRecords],
  );
  const visibleIds = observations
    ? filteredObservations.map((o) => o.id)
    : allFrames.map((f) => f.observation_id);
  const allVisibleChecked =
    visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleChecked = visibleIds.some((id) => selectedIds.has(id));
  const checkedToLoad = (observations || [])
    .filter(
      (o) =>
        selectedIds.has(o.id) &&
        (o.status === "pending" || o.status === "failed"),
    )
    .map((o) => o.id);
  function includeObservation(id: string, checked = true) {
    setPlaying(false);
    setTimelineIds((previous) => {
      const next = new Set(previous || selectionRef.current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  const pendingCount = filteredObservations.filter(
    (o) => o.status === "pending",
  ).length;
  const failedRecords = filteredObservations.filter(
    (o) => o.status === "failed",
  );
  const canPlay = ready && frames.length > 1;
  const displayRange =
    sequences.find((s) => s.id === frame?.sequence_id)?.stretch ||
    manifest?.processing?.stretch;
  const unmatchedFrames =
    viewMode === "browse" &&
    new Set(selectedFrames.map((f) => f.sequence_id || f.detector)).size > 1;
  function setMode(mode: "browse" | "matched") {
    if (mode === viewMode) return;
    setPlaying(false);
    setViewMode(mode);
    if (mode === "matched" && (!sequence || sequenceCount(sequence.id) < 2))
      setSequenceId(rankedSequences[0]?.id || "");
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
  const load = useCallback(
    async (
      query: Query,
      more?: {
        jobId: string;
        ids?: string[];
        detector?: string;
        all?: boolean;
        recordIds?: string[];
        includeFailed?: boolean;
      },
    ) => {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const current = ++generation.current;
      setBusy(true);
      setError("");
      setNotice("");
      setDismissedDraft("");
      setProgressDismissed(false);
      setPreviousDismissed(false);
      if (more)
        setTimelineIds(
          new Set([
            ...selectionRef.current,
            ...(more.ids || more.recordIds || []),
          ]),
        );
      if (!more) setPlaying(false);
      setCommitted(query);
      if (!more) {
        setSequenceId("");
        setDetectorFilter("");
        setStatusFilter("");
        setRecordSearch("");
        setViewMode("browse");
        setZoom(1);
      }
      setStage(more ? "Loading images" : "Finding observations");
      window.history.replaceState({}, "", queryUrl(query));
      try {
        const id = more
          ? await loadObservations(
              more.jobId,
              abort.signal,
              more.ids || more.recordIds?.slice(0, 8),
              more.detector,
            )
          : await submit(query, abort.signal);
        const attempted = new Set(
          more?.includeFailed
            ? more.ids || more.recordIds?.slice(0, 8) || []
            : [],
        );
        let deadline = Date.now() + (more ? 150000 : 180000);
        if (abort.signal.aborted || current !== generation.current) {
          void cancelJob(id).catch(() => {});
          return;
        }
        activeJob.current = id;
        setFieldJobId(id);
        let revision = "",
          published = false,
          targetSelected = false;
        const previousUrls = new Set(allFramesRef.current.map((f) => f.url));
        while (!abort.signal.aborted) {
          if (Date.now() > deadline) {
            void cancelJob(id).catch(() => {});
            throw new Error(
              "Search timed out. Narrow the date range or try again later.",
            );
          }
          const job = await poll(id, abort.signal);
          if (current !== generation.current) return;
          const progress = job.stage?.match(/^fetch:(\d+)\/(\d+)$/);
          setStage(
            progress
              ? `Checked ${progress[1]} of ${progress[2]} cutouts`
              : stages[job.stage || job.status] || "Processing observations",
          );
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
          if (job.manifest) {
            const nextRevision = JSON.stringify(job.manifest);
            if (nextRevision !== revision) {
              revision = nextRevision;
              const result = validateManifest(job.manifest);
              setManifest({
                ...result,
                warnings: [...(result.warnings || []), ...(job.warnings || [])],
              });
              setDisplayedQuery(query);
              if (
                !targetSelected &&
                (more?.ids?.length === 1 || more?.detector)
              ) {
                const requested = result.frames.find((f) =>
                  more.ids?.length === 1
                    ? f.observation_id === more.ids[0]
                    : f.detector === more.detector && !previousUrls.has(f.url),
                );
                if (requested) {
                  setSequenceId(requested.sequence_id || "");
                  setViewMode("browse");
                  setFocusedFrame(requested.url);
                  targetSelected = true;
                }
              }
              if (!published && !more) {
                setFocusedFrame(null);
                setTimelineIds(null);
                setShowAllRecords(false);
                setDetectorFilter(result.processing?.initial_detector || "");
              }
              published = true;
            }
          }
          if (job.status === "complete" || job.status === "partial") {
            if (!job.manifest)
              throw new Error("The service returned no observation manifest.");
            if (
              !job.manifest.frames.length &&
              !job.manifest.observations?.length
            )
              setNotice(
                "No comparable observations were found for this field and date range.",
              );
            else if (!job.manifest.frames.length)
              setNotice(
                "No image in this batch could be loaded. Inspect the failed rows or load another observation.",
              );
            const remaining =
              job.manifest.observations?.filter(
                (o) =>
                  (o.status === "pending" ||
                    (more?.includeFailed &&
                      o.status === "failed" &&
                      !attempted.has(o.id))) &&
                  (!more?.detector || o.detector === more.detector) &&
                  (!more?.recordIds || more.recordIds.includes(o.id)),
              ) || [];
            if (more?.all && remaining.length) {
              const nextIds = more.recordIds
                ? remaining.slice(0, 8).map((o) => o.id)
                : [];
              nextIds.forEach((id) => attempted.add(id));
              await loadObservations(id, abort.signal, nextIds, more.detector);
              deadline = Date.now() + 150000;
              continue;
            }
            return;
          }
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              abort.signal.removeEventListener("abort", done);
              resolve();
            };
            const timer = setTimeout(done, 2000);
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
    if (window.innerWidth < 1024) setInspectorOpen(false);
    if (window.innerWidth < 700) setDockOpen(false);
    const abort = new AbortController();
    const params = new URLSearchParams(window.location.search);
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
        // Open an authentic reference field; shared URLs and draft edits take precedence.
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
      const field = params.get("fov") || "300";
      const interval = params.get("spacing") ?? "60";
      setFov(field);
      setSpacing(interval);
      setRa(r);
      setDec(d);
      setStart(s);
      setEnd(e);
      if (s || e) setDatesOpen(true);
      try {
        const query = parseQuery(r, d, s, e, field, interval);
        // Strict Mode cleans up its first mount before this task runs.
        queueMicrotask(() => {
          if (!abort.signal.aborted) void load(query);
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
      if (
        (e.target as HTMLElement).closest(
          'input,select,textarea,button,a,[role="button"]',
        )
      )
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
  }, [canPlay, frames.length, playing]);
  const onReady = useCallback((value: boolean) => setReady(value), []);
  const onFailure = useCallback(() => {
    setReady(false);
    setPlaying(false);
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
      void load(parseQuery(ra, dec, start, end, fov, spacing));
    } catch (err) {
      setError((err as Error).message);
    }
  }
  async function share() {
    if (!committed) return;
    const url = queryUrl(committed);
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
          {["Settings", "Links", "Help", "About"].map((value) => (
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
                <div
                  className="fixed-field"
                  title="Angular field retrieved from the archive; independent of zoom."
                >
                  <label htmlFor="fov">Field of view</label>
                  <div>
                    <input
                      id="fov"
                      type="number"
                      min="30"
                      max="1800"
                      value={fov}
                      onChange={(e) => setFov(e.target.value)}
                    />
                    <span>arcsec</span>
                  </div>
                </div>
                <div className="dataset-field">
                  <label htmlFor="observation-spacing">
                    Observation spacing
                  </label>
                  <select
                    id="observation-spacing"
                    value={spacing}
                    onChange={(e) => setSpacing(e.target.value)}
                  >
                    {!["0", "30", "60", "90", "180", "365"].includes(
                      spacing,
                    ) && <option value={spacing}>{spacing} days</option>}
                    <option value="60">At least 2 months (60 days)</option>
                    <option value="90">At least 3 months (90 days)</option>
                    <option value="180">At least 6 months (180 days)</option>
                    <option value="365">At least 1 year (365 days)</option>
                    <option value="30">At least 1 month (30 days)</option>
                    <option value="0">All exposures</option>
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
                        setZoom(1);
                        setInvert(false);
                        setSpeed(1);
                        setFov("300");
                        setSpacing("60");
                        setError("");
                        setNotice("");
                      }}
                    >
                      <RotateCcw size={14} />
                    </button>
                  )}
                </div>
              </form>
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
                <label className="slider-label" htmlFor="zoom">
                  Zoom{" "}
                  <span>
                    {zoom.toFixed(2)}
                    <small> × fit</small>
                  </span>
                </label>
                <input
                  id="zoom"
                  type="range"
                  min="0.02"
                  max="32"
                  step="0.01"
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                  disabled={!ready}
                />
              </section>
              <section className="control-section">
                <div className="control-section-heading">
                  <span>Image appearance</span>
                </div>
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
                      value={displayRange?.vmin?.toPrecision(4) ?? "—"}
                    />
                  </label>
                  <label>
                    Max pixel value
                    <input
                      disabled
                      value={displayRange?.vmax?.toPrecision(4) ?? "—"}
                    />
                  </label>
                </div>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={invert}
                    onChange={(e) => setInvert(e.target.checked)}
                    disabled={!ready}
                  />
                  Invert grayscale
                </label>
              </section>
            </>
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
                  <p>
                    Observation counts refer to detector images covering the
                    coordinate, not distinct objects or dates. Multiple
                    detectors can contribute images from one pointing. Blink
                    aligned observations from different dates to inspect motion
                    relative to background stars. Use Matched for compatible
                    wavelength and calibration groups.
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
              dismissedDraft !== draftKey &&
              (Number(fov) !== (committed.fov_arcsec || 300) ||
                Number(spacing) !== (committed.min_interval_days ?? 60) ||
                Number(ra) !== committed.ra_deg ||
                Number(dec) !== committed.dec_deg ||
                start !== (committed.start_utc?.slice(0, 10) || "") ||
                end !== (committed.end_utc?.slice(0, 10) || "")) && (
                <Notification
                  label="query change notice"
                  onDismiss={() => setDismissedDraft(draftKey)}
                >
                  Query edited. The viewer still shows the last searched field.
                  Search to apply changes.
                </Notification>
              )}
            {busy && !progressDismissed && (
              <Notification
                variant="processing"
                label="search progress"
                onDismiss={() => setProgressDismissed(true)}
              >
                {stage}.
                {manifest?.frames.length ? " Previous field shown." : ""}
              </Notification>
            )}
            {!busy &&
              !previousDismissed &&
              displayedQuery &&
              committed &&
              displayedQuery !== committed &&
              frames.length > 0 && (
                <Notification
                  label="previous field notice"
                  onDismiss={() => setPreviousDismissed(true)}
                >
                  Showing the previous field. The latest search has no result.
                </Notification>
              )}
            {error && (
              <Notification
                variant="error"
                label="error"
                onDismiss={() => setError("")}
              >
                {error}
              </Notification>
            )}
            {notice && (
              <Notification label="notice" onDismiss={() => setNotice("")}>
                {notice}
              </Notification>
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
                      aria-pressed={viewMode === "browse"}
                      onClick={() => setMode("browse")}
                      title="Browse loaded observations in acquisition order"
                    >
                      Browse
                    </button>
                    <button
                      aria-pressed={viewMode === "matched"}
                      onClick={() => setMode("matched")}
                      title="Play observations with compatible wavelength and calibration"
                    >
                      Matched
                    </button>
                  </div>
                  {viewMode === "matched" && sequences.length > 0 ? (
                    <>
                      <label className="sr-only" htmlFor="sequence">
                        Wavelength sequence
                      </label>
                      <select
                        id="sequence"
                        value={sequence?.id || ""}
                        onChange={(e) => {
                          setSequenceId(e.target.value);
                          setFocusedFrame(null);
                          setPlaying(false);
                        }}
                      >
                        {rankedSequences
                          .filter((g) => g.frame_ids.length)
                          .map((g) => (
                            <option key={g.id} value={g.id}>
                              {g.detector} / {g.wavelength_um.toFixed(3)}{" "}
                              microns / {sequenceCount(g.id)} checked /{" "}
                              {g.frame_ids.length} loaded
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
                        : `${selectedFrames.length} image${selectedFrames.length === 1 ? "" : "s"} in timeline`}
                    </span>
                  )}
                </div>
              )}
              <SkyViewer
                key={
                  displayedQuery
                    ? `${displayedQuery.ra_deg}/${displayedQuery.dec_deg}/${displayedQuery.fov_arcsec || 300}`
                    : "empty"
                }
                frames={frames}
                index={index}
                onReady={onReady}
                onFailure={onFailure}
                zoom={zoom}
                onZoom={setZoom}
                invert={invert}
                grid={manifest?.grid}
                unmatchedFrames={unmatchedFrames}
                emptyState={
                  allFrames.length || observations?.length
                    ? {
                        title: selectedIds.size
                          ? "No checked images loaded"
                          : "No observations selected",
                        message: selectedIds.size
                          ? "Load the checked observations, or choose a matched group containing checked images."
                          : "Check observations in the list to add them to the timeline.",
                      }
                    : undefined
                }
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
                    title={
                      canPlay
                        ? viewMode === "browse"
                          ? "Browse loaded images"
                          : "Play matched observations"
                        : "At least two ready images are needed"
                    }
                    disabled={!canPlay && !playing}
                    onClick={() => {
                      if (frame) setFocusedFrame(frame.url);
                      if (viewMode === "matched" && sequence)
                        setSequenceId(sequence.id);
                      setPlaying((p) => !p);
                    }}
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
                {frames.length > 1 && (
                  <div
                    className="timeline-dates"
                    aria-label="Observation time separation"
                  >
                    <span>
                      Actual span:{" "}
                      {elapsedTime(
                        frames[0].observed_at,
                        frames[frames.length - 1].observed_at,
                      )}
                    </span>
                    <span>
                      {index > 0
                        ? `${elapsedTime(frames[index - 1].observed_at, frames[index].observed_at)} since previous`
                        : "First observation"}
                    </span>
                  </div>
                )}
              </div>
              {frames.length === 1 && (
                <div className="playback-guidance">
                  {viewMode === "matched" ? (
                    <>
                      <span>One checked frame in this matched group.</span>
                      {selectedFrames.length > 1 && (
                        <button onClick={() => setMode("browse")}>
                          Browse all {selectedFrames.length} images
                        </button>
                      )}
                    </>
                  ) : (
                    <span>
                      One image in timeline. Check or load another to play.
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
                          {manifest ? manifest.stretch || "Not supplied" : "—"}
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
                            ? manifest.cached
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
                  {observations
                    ? filteredObservations.length
                    : allFrames.length}{" "}
                  shown
                </span>
                {observations && (
                  <span
                    className="pointing-count"
                    title={`${pointingCount} distinct pointings. The complete archive catalog remains available; closely spaced exposures are hidden by default.`}
                  >
                    {observations.length} archive matches
                  </span>
                )}
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
                      <label className="exposure-toggle">
                        <input
                          type="checkbox"
                          checked={showAllRecords}
                          onChange={(e) => setShowAllRecords(e.target.checked)}
                        />
                        All exposures
                      </label>
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
                        disabled={busy || !pendingCount || !committed}
                        onClick={() => {
                          if (committed)
                            void load(committed, {
                              jobId: fieldJobId,
                              detector: detectorFilter || undefined,
                              ids: filteredObservations
                                .filter((o) => o.status === "pending")
                                .slice(0, 8)
                                .map((o) => o.id),
                            });
                        }}
                      >
                        {pendingCount
                          ? `Load next ${Math.min(8, pendingCount)}`
                          : "No pending images"}
                      </button>
                      <button
                        className="button"
                        disabled={busy || !pendingCount || !committed}
                        onClick={() => {
                          if (committed)
                            void load(committed, {
                              jobId: fieldJobId,
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
                          disabled={busy || !committed}
                          onClick={() => {
                            if (committed)
                              void load(committed, {
                                jobId: fieldJobId,
                                ids: failedRecords.slice(0, 8).map((o) => o.id),
                              });
                          }}
                        >
                          Retry {Math.min(8, failedRecords.length)} failed
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
                {observations?.length || allFrames.length ? (
                  <div className="timeline-selection">
                    <span>
                      {selectedFrames.length} images in timeline
                      {checkedToLoad.length
                        ? ` / ${checkedToLoad.length} checked to load`
                        : ""}
                    </span>
                    {checkedToLoad.length > 0 && (
                      <button
                        className="button"
                        disabled={busy || !committed}
                        onClick={() => {
                          if (committed)
                            void load(committed, {
                              jobId: fieldJobId,
                              all: true,
                              recordIds: checkedToLoad,
                              includeFailed: true,
                            });
                        }}
                      >
                        Load checked ({checkedToLoad.length})
                      </button>
                    )}
                    <button
                      className="clear-timeline"
                      disabled={!selectedIds.size}
                      onClick={() => {
                        setPlaying(false);
                        setTimelineIds(new Set());
                      }}
                    >
                      Clear timeline
                    </button>
                  </div>
                ) : null}
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th className="timeline-check-cell">
                          <input
                            type="checkbox"
                            aria-label="Select all visible observations for timeline"
                            checked={allVisibleChecked}
                            disabled={!visibleIds.length}
                            ref={(node) => {
                              if (node)
                                node.indeterminate =
                                  someVisibleChecked && !allVisibleChecked;
                            }}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setPlaying(false);
                              setTimelineIds((previous) => {
                                const next = new Set(
                                  previous || selectionRef.current,
                                );
                                visibleIds.forEach((id) => {
                                  if (checked) next.add(id);
                                  else next.delete(id);
                                });
                                return next;
                              });
                            }}
                          />
                          <span className="sr-only">Timeline</span>
                        </th>
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
                                <td className="timeline-check-cell">
                                  <input
                                    type="checkbox"
                                    aria-label={`Include ${o.id} in timeline`}
                                    checked={selectedIds.has(o.id)}
                                    onChange={(e) =>
                                      includeObservation(o.id, e.target.checked)
                                    }
                                  />
                                </td>
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
                                        includeObservation(f.observation_id);
                                        setSequenceId(f.sequence_id || "");
                                        setViewMode("browse");
                                        setFocusedFrame(f.url);
                                        setPlaying(false);
                                      } else if (committed)
                                        void load(committed, {
                                          jobId: fieldJobId,
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
                        : allFrames.map((f, i) => (
                            <tr
                              key={f.id}
                              className={f.url === frame?.url ? "active" : ""}
                            >
                              <td className="timeline-check-cell">
                                <input
                                  type="checkbox"
                                  aria-label={`Include ${f.observation_id} in timeline`}
                                  checked={selectedIds.has(f.observation_id)}
                                  onChange={(e) =>
                                    includeObservation(
                                      f.observation_id,
                                      e.target.checked,
                                    )
                                  }
                                />
                              </td>
                              <td>
                                <button
                                  aria-label={`Select frame ${i + 1}`}
                                  onClick={() => {
                                    setPlaying(false);
                                    includeObservation(f.observation_id);
                                    setViewMode("browse");
                                    setFocusedFrame(f.url);
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
