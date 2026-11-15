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
} from "./icons";
import SkyViewer, { type PixelBox } from "./sky-viewer";
import Spectrum from "./spectrum";
import ImageControls from "./image-controls";
import WorkspacePanel from "./workspace-panel";
import { CycleCatalog, ExposureTable } from "./observation-catalog";
import SearchBands from "./search-bands";
import MatchedPicker from "./matched-picker";
import { matchedSpectra } from "@/lib/matched-spectra";
import Notification, { NotificationBell, NotificationCenter } from "./notification";
import PanelResizer from "./panel-resizer";
import { ObjectPanel, useKnownObjects } from "./known-objects";
import { draftBands, fieldKey, inSearch, nextSpectrumBatch, readBands, selectedBands, type BandDraft } from "@/lib/search-bands";
import {
  activeChannels,
  activeDetectors,
  defaults,
  detectors,
  matchesChannel,
  skyPixel,
  skyPosition,
  type Display,
} from "@/lib/imaging";
import { useImages } from "@/lib/use-images";
import {
  storageKey,
  readBackup,
  readDisplay,
  snapshot,
  defaultFieldNames,
  type Backup,
  type Config,
  type Entry,
} from "@/lib/workspace";
import FieldSurveys from "./field-surveys";
import SurveyComparison from "./survey-comparison";
import { presets, Frame, Manifest, Query, Preset, Observation } from "@/lib/types";
import {
  poll,
  submit,
  request,
  validateManifest,
  assetUrl,
  cancelJob,
  loadObservations,
} from "@/lib/api";
import { angularWidth, parseQuery, queryUrl, separationDays } from "@/lib/view-url";
import { clonePresetDisplay, skyTargets, viewingPresets } from "@/lib/exploration-presets";
type LoadBatch = {
  jobId: string;
  ids?: string[];
  detector?: string;
  all?: boolean;
  recordIds?: string[];
  size: number;
  automatic?: boolean;
  resume?: boolean;
  channels?: Query["channels"];
  metadataOnly?: boolean;
};
const empty: Frame[] = [];
type RestorePosition = Entry["position"] & { scope?: Entry["scope"] };
function mapRequest(display: Display) {
  return {
    detectors: activeDetectors(display),
    channels: activeChannels(display),
  };
}
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
  const [targets, setTargets] = useState<Preset[]>(() => [
    ...presets,
    ...skyTargets.filter(t => !presets.some(p => p.id === t.id)).map(t => ({
      id: t.id, name: t.name, ra: String(t.ra_deg), dec: String(t.dec_deg),
      kind: "Sky landmark", note: t.description,
    })),
  ]),
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
  const [knownOpen, setKnownOpen] = useState(false);
  const [showMoving, setShowMoving] = useState(true);
  const [objectKey, setObjectKey] = useState("");
  const [preferredEpoch, setPreferredEpoch] = useState("");
  const [datesOpen, setDatesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [canvasFocused, setCanvasFocused] = useState(false);
  const savedLocations = useRef<HTMLDetailsElement>(null);
  const [fieldJobId, setFieldJobId] = useState("");
  const [sequenceId, setSequenceId] = useState("");
  const [viewMode, setViewMode] = useState<"visits" | "browse" | "matched">(
    "visits",
  );
  const [loop, setLoop] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [recordSearch, setRecordSearch] = useState("");
  const [dockExpanded, setDockExpanded] = useState(false);
  const [detectorFilter, setDetectorFilter] = useState("");
  const [tab, setTab] = useState("Settings");
  const [display, setDisplay] = useState(defaults);
  const automaticMap = useRef(true);
  const update = useCallback(
    (patch: Partial<Display>) => {
      if (patch.maps) {
        automaticMap.current = false;
      }
      setDisplay((old) => ({ ...old, ...patch }));
    },
    [],
  );
  const setSpeed = (speed: number) => update({ speed });
  const setInvert = (invert: boolean) => update({ invert });
  const { speed, zoom, invert } = display;
  const [fov, setFov] = useState("300");
  const [minDays, setMinDays] = useState<string | null>(null);
  const [bandDraft, setBandDraft] = useState<BandDraft>({ D1: null });
  const field = useMemo(() => {
    try { return { ...parseQuery(ra, dec, start, end), fov_arcsec: angularWidth(fov) }; }
    catch { return null; }
  }, [ra, dec, start, end, fov]);
  const searchBands = selectedBands(bandDraft, fieldKey(field));
  const [entries, setEntries] = useState<Entry[]>([]);
  const [fieldNames, setFieldNames] = useState(defaultFieldNames);
  const [consent, setConsent] = useState<boolean | null>(null);
  const [selection, setSelection] = useState<PixelBox | null>(null);
  const [timelineChoices, setTimelineChoices] = useState<Record<string,boolean>>({});
  const [displayedQuery, setDisplayedQuery] = useState<Query | null>(null);
  const pixel: [number, number] | null = selection
    ? [
        Math.floor((selection[0] + selection[2]) / 2),
        Math.floor((selection[1] + selection[3]) / 2),
      ]
    : null;
  const [spectrumVisit, setSpectrumVisit] = useState("");
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoPaused, setAutoPaused] = useState(false);
  const attempted = useRef(new Set<string>());
  const priorityRequests = useRef(new Map<string, Promise<void>>());
  const priorityAcknowledged = useRef(0);
  const priorityController = useRef<AbortController | null>(null);
  const restoreFrame = useRef("");
  const restorePosition = useRef<RestorePosition | null>(null);
  const timing = useRef<{
    query: Query;
    job: string;
    start: number;
    painted: boolean;
  } | null>(null);
  const lastSaved = useRef<Backup | null>(null);
  const hasCycles = !!manifest?.visits?.some(v => v.kind !== "supplemental");
  const [referenceCycle, setReferenceCycle] = useState<string | null>(null);
  const subtracting = referenceCycle !== null && viewMode !== "browse";
  const [dockOpen, setDockOpen] = useState(true);
  const [committed, setCommitted] = useState<Query | null>(null);
  const bandsEdited = !!committed?.live && (
    !searchBands || JSON.stringify(searchBands.detectors) !== JSON.stringify(committed.detectors) ||
    JSON.stringify(searchBands.channels) !== JSON.stringify(committed.channels ?? {})
  );
  const controller = useRef<AbortController | null>(null),
    generation = useRef(0),
    activeJob = useRef<string | null>(null);
  const allFrames = manifest?.frames ?? empty;
  useEffect(() => {
    if (!automaticMap.current || !manifest) return;
    const available = detectors.filter(det => {
      if (displayedQuery?.detectors && !displayedQuery.detectors.includes(det)) return false;
      const channels = displayedQuery?.channels?.[det];
      return manifest.frames.some(f => f.detector === det &&
        (!channels?.length || channels.some(key => matchesChannel(key, f))));
    });
    const operands = Object.fromEntries(available.map(det => [det, 1]));
    setDisplay(old => old.maps.length !== 1 ||
      JSON.stringify(old.maps[0].operands) === JSON.stringify(operands) ? old :
      { ...old, maps: [{ ...old.maps[0], operands }] });
  }, [manifest, displayedQuery, display.maps]);
  const batchSize = Math.max(
    1,
    Math.min(8, manifest?.processing?.batch_size ?? 8),
  );
  const spectra = useMemo(() => matchedSpectra(manifest, timelineChoices, displayedQuery?.min_separation_days),
    [manifest, timelineChoices, displayedQuery?.min_separation_days]);
  const sequence = spectra.find(s => s.id === sequenceId) ?? spectra.find(s => s.sequenceIds.includes(sequenceId)) ?? spectra[0];
  const matched = viewMode === "matched" || (viewMode !== "browse" && !hasCycles && !!sequence);
  const derived = (viewMode === "visits" && hasCycles && !matched) || subtracting;
  const matchedSteps = sequence?.epochs;
  const science = useImages(manifest, display, !derived, timelineChoices, displayedQuery,
    subtracting ? referenceCycle : null, matched ? matchedSteps : undefined,
    automaticMap.current);
  const frames = useMemo(() => {
    if (!matched || subtracting) return science.frames;
    const byId = new Map(science.frames.map(f => [f.observation_id, f]));
    return (matchedSteps ?? []).flatMap(step => byId.get(step.source.observation_id) ?? []);
  }, [matched, subtracting, matchedSteps, science.frames]),
    index = Math.max(
      0,
      frames.findIndex((f) => f.observation_id === selectedFrame || (derived && f.visit_id === selectedFrame)),
    ),
    frame = frames[index];
  const isVisitMap = !!frame?.visit_id && frame.observation_id === frame.visit_id;
  const steps = matched && !subtracting ? (matchedSteps ?? []) : science.steps;
  const cycleIndex = frame ? steps.findIndex(({ visit }) =>
    frame.visit_id === visit.id || visit.observation_ids.includes(frame.observation_id)) : -1;
  const selectCycle = useCallback((position: number) => {
    const step = steps[position];
    if (!step) return;
    const key = matched && !subtracting ? step.source.observation_id : step.visit.id;
    restoreFrame.current = key;
    if (!matched) setViewMode("visits");
    setSelectedFrame(key);
  }, [steps, matched, subtracting]);
  // A raw exposure outside a cycle can jump to the nearest cycle in either direction.
  const previousCycle = cycleIndex >= 0 ? cycleIndex - 1
    : steps.findLastIndex(s => frame && Date.parse(s.visit.end_utc) < Date.parse(frame.observed_at));
  const nextCycle = cycleIndex >= 0 ? cycleIndex + 1
    : steps.findIndex(s => !frame || Date.parse(s.visit.start_utc) > Date.parse(frame.observed_at));
  const product = frame
    ? science.result[science.frames.indexOf(frame)]
    : undefined;
  const residual = product?.subtraction && pixel
    ? product.layers[0].values[pixel[1] * science.width + pixel[0]] : undefined;
  const contributors = useMemo(() => {
    if (!frame) return empty;
    if (!isVisitMap && !product?.matchedMap) return [frame];
    const members = [...(product?.inputs ?? []), ...(product?.reference ?? [])];
    return [...new Map(members.map(f => [f.observation_id, f])).values()];
  }, [frame, isVisitMap, product]);
  const epochs = useMemo(() => [...new Set(contributors.map(f => f.midpoint_utc || f.observed_at))]
    .sort((a, b) => Date.parse(a) - Date.parse(b)), [contributors]);
  const epoch = epochs.includes(preferredEpoch) ? preferredEpoch : epochs[0] ?? "";
  const known = useKnownObjects(knownOpen, showMoving, displayedQuery, manifest, contributors, fieldJobId, epoch);
  const chosenObject = known.markers.find(marker => marker.key === objectKey);
  function selectObject(key: string) {
    setObjectKey(key);
    setPlaying(false);
  }
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
  const catalogVisits = manifest?.visits;
  const catalogRecords = useMemo<Observation[]>(() => observations ?? allFrames.map(f => ({
    id: f.observation_id,
    visit_id: f.visit_id,
    observed_at: f.observed_at,
    detector: f.detector as Observation["detector"],
    channel: f.channel,
    nominal_channel: f.nominal_channel,
    wavelength_um: f.wavelength_um,
    bandwidth_um: f.bandwidth_um,
    release: f.release ?? "—",
    source_url: f.source_url ?? "",
    status: "ready",
  })), [observations, allFrames]);
  const cycleCount = catalogVisits?.filter(v => v.kind !== "supplemental").length ?? 0;
  const visibleMaps = useMemo(() => new Set(science.steps.map(s => s.visit.id)), [science.steps]);
  const timelineChecklist = {
    choices: timelineChoices,
    includedIds: science.includedIds,
    frameReasons: science.frameReasons,
    withinBands: (record: Observation) => inSearch(record, displayedQuery),
    setIncluded: setTimelineIncluded,
  };
  function setTimelineIncluded(id: string, included: boolean) {
    setPlaying(false);
    setTimelineChoices(old => ({...old, [id]:included}));
    if (included && !frameByObservation.has(id)) {
      const record = catalogRecords.find(row => row.id === id);
      if (record && (!busy || activeJob.current === fieldJobId)) requestRecord(record);
    }
  }
  function inspectRecord(record: Observation) {
    const raw = frameByObservation.get(record.id);
    setDockExpanded(false);
    if (raw) {
      setSequenceId(raw.sequence_id ?? "");
      restoreFrame.current = raw.observation_id;
      setViewMode("browse");
      setSelectedFrame(raw.observation_id);
      setPlaying(false);
    } else if (fieldJobId && displayedQuery && inSearch(record, displayedQuery)) {
      restoreFrame.current = record.id;
      setViewMode("browse");
      setSelectedFrame(record.id);
      setPlaying(false);
      requestRecord(record);
    }
  }
  function requestRecord(record: Observation) {
      if (!displayedQuery || !fieldJobId || !inSearch(record, displayedQuery)) return;
      const key = fieldJobId + "/" + record.id;
      if (priorityRequests.current.has(key)) return;
      if (!priorityController.current || priorityController.current.signal.aborted)
        priorityController.current = new AbortController();
      const signal = priorityController.current.signal;
      const accepted = request(`/api/jobs/${encodeURIComponent(fieldJobId)}/priority/${encodeURIComponent(record.id)}`,
        signal, {}).then(() => {
        if (signal.aborted) return;
        priorityAcknowledged.current++;
        if (!activeJob.current)
          void load(displayedQuery, "", null, {jobId: fieldJobId, size: batchSize, resume: true});
      }).catch(err => {
        if (!signal.aborted) setError(err.message);
      }).finally(() => {
        if (priorityRequests.current.get(key) === accepted) priorityRequests.current.delete(key);
      });
      priorityRequests.current.set(key, accepted);
  }
  function openCycle(id: string) {
    setDockExpanded(false);
    restoreFrame.current = id;
    setMode("visits");
    setSelectedFrame(id);
  }
  const visit =
    manifest?.visits?.find(
      (v) => v.id === (frame?.visit_id ?? frame?.observation_id),
    ) ??
    manifest?.visits?.find((v) =>
      v.observation_ids.includes(frame?.observation_id ?? ""),
    ) ??
    manifest?.visits?.find((v) => v.kind !== "supplemental" && v.status !== "invalid");
  const visitMembers = useMemo(
    () => new Set(visit?.observation_ids ?? []),
    [visit],
  );
  const requestSpectra = !!visit && spectrumVisit === visit.id;
  const pendingSpectrumInputs = observations?.filter(o => visitMembers.has(o.id) &&
    (o.status === "pending" || o.status === "loading") && inSearch(o, displayedQuery)) ?? [];
  const detailPlanes = useMemo(
    () =>
      science.data.filter((p) =>
        visit
          ? visitMembers.has(p.frame.observation_id)
          : p.frame.observation_id === frame?.observation_id,
      ),
    [science.data, visit, visitMembers, frame?.observation_id],
  );
  const conflicts = useMemo(() => (manifest?.visits ?? []).filter(v =>
    v.kind !== "supplemental" && v.status === "invalid"), [manifest?.visits]);
  const cycleMembers = useMemo(() => new Set(manifest?.visits?.filter(v =>
    v.kind !== "supplemental" && v.status !== "invalid").flatMap(v => v.observation_ids)), [manifest?.visits]);
  const requestedId = restoreFrame.current;
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
  const selectable = filteredObservations.filter(o => inSearch(o, displayedQuery));
  const canRequest = (record: Observation) => (!busy || fieldJobId === activeJob.current) && inSearch(record, displayedQuery);
  const pendingRecords = selectable.filter(o => o.status === "pending" && o.selection !== "unavailable");
  const nextPending = nextSpectrumBatch(pendingRecords, manifest?.processing, batchSize);
  const nextFailed = nextSpectrumBatch(selectable.filter(o => o.status === "failed"), manifest?.processing, batchSize);
  const unmatchedFrames =
    !matched &&
    !derived &&
    new Set(frames.map((f) => f.sequence_id || f.channel || f.detector)).size >
      1;
  function setMode(mode: "visits" | "browse" | "matched") {
    setPlaying(false);
    setReferenceCycle(null);
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
    version: 2,
    exported: new Date().toISOString(),
    locations: entries,
    fieldNames,
    config: configuration,
    snapshot: snapshot(manifest),
    snapshotComplete: manifest?.processing?.archive_complete === true,
  };
  const position =
    displayedQuery && pixel && science.width
      ? skyPosition(displayedQuery, ...pixel, science.width, science.height, manifest?.processing?.grid_header)
      : displayedQuery;
  const selectedEntry: Omit<Entry, "id" | "name" | "note" | "fields"> | null =
    position && frame
      ? {
          position: { ra_deg: position.ra_deg, dec_deg: position.dec_deg },
          config: {...configuration, fov:displayedQuery?.fov_arcsec ?? configuration.fov},
          scope: selection && science.width && science.height
            ? {kind:"region", box:selection, width:science.width, height:science.height} : {kind:"frame"},
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
      (f) => f.observation_id === restoreFrame.current || (derived && f.visit_id === restoreFrame.current),
    );
    const key = (f: typeof frame) => derived && f.visit_id ? f.visit_id : f.observation_id;
    if (wanted) {
      restoreFrame.current = "";
      setSelectedFrame(key(wanted));
    } else {
      if (
        !busy &&
        science.settled &&
        !observations?.some(
          (o) => o.status === "pending" || o.status === "loading",
        )
      )
        restoreFrame.current = "";
      if (key(frame) !== selectedFrame)
        setSelectedFrame(key(frame));
    }
  }, [frames, frame, selectedFrame, derived, busy, science.settled, observations]);
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
  }, [consent, display, displayedQuery, entries, fieldNames, fov, frame, manifest]);
  useEffect(() => {
    if (restorePosition.current && displayedQuery && science.width) {
      const scope = restorePosition.current.scope;
      if (scope?.kind === "frame") setSelection(null);
      else if (scope?.kind === "region") {
        if (scope.width === science.width && scope.height === science.height) {
          setSelection(scope.box);
          setInspectorOpen(true);
        } else {
          setSelection(null);
          setNotice("The saved region uses a different image grid. Its pixel boundaries could not be restored.");
        }
      } else {
        const point = skyPixel(displayedQuery, restorePosition.current, science.width, science.height);
        if (point) setSelection([point[0], point[1], point[0], point[1]]);
      }
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
    ready && steps.length > 1 && (!busy || committed === displayedQuery);
  const toggleMotion = useCallback(() => {
    if (playing) setPlaying(false);
    else if (canPlay) {
      if (!derived || cycleIndex < 0) selectCycle(Math.max(0, cycleIndex));
      setPlaying(true);
    }
  }, [playing, canPlay, derived, cycleIndex, selectCycle]);
  const load = useCallback(
    async (
      query: Query,
      wantedFrame = "",
      wantedPosition: RestorePosition | null = null,
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
      const submittedBatches = new Set(more?.ids ? [JSON.stringify([!!more.metadataOnly, more.ids])] : []);
      const before = new Set(
        observedFrames.current.map((f) => f.observation_id),
      );
      if (!more) timing.current = null;
      setBusy(true);
      setAutoBusy(more?.automatic === true);
      if (!more) {
        priorityController.current?.abort();
        priorityRequests.current.clear();
        attempted.current.clear();
        setAutoPaused(false);
        setSpectrumVisit("");
      }
      setError("");
      setNotice("");
      if (!more) setPlaying(false);
      setCommitted(query);
      setStage(more ? "Loading images" : "Finding observations");
      if (!more) {
        restorePosition.current = null;
        restoreFrame.current = "";
      }
      if (!more) window.history.replaceState({}, "", queryUrl(query));
      try {
        const id = more?.resume ? more.jobId : more
          ? await loadObservations(
              more.jobId,
              abort.signal,
              more.ids ?? more.recordIds?.slice(0, more.size),
              more.detector,
              more.channels,
              more.metadataOnly,
            )
          : await submit(query, abort.signal);
        let deadline = Date.now() + 180000;
        if (abort.signal.aborted || current !== generation.current) {
          void cancelJob(id).catch(() => {});
          return;
        }
        activeJob.current = id;
        if (!more) timing.current = { query, job: id, start: started, painted: false };
        while (!abort.signal.aborted) {
          if (Date.now() > deadline) {
            void cancelJob(id).catch(() => {});
            throw new Error(
              "Search timed out. Narrow the date range or try again later.",
            );
          }
          const acknowledgedBeforePoll = priorityAcknowledged.current;
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
          if (finished) {
            await Promise.all(priorityRequests.current.values());
            if (abort.signal.aborted || current !== generation.current) return;
            if (acknowledgedBeforePoll !== priorityAcknowledged.current) continue;
          }
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
                  setSelection(null);
                  setSelectedFrame("");
                  setTimelineChoices({});
                  setReferenceCycle(null);
                  setSequenceId("");
                  const restoreRaw = wantedFrame && (
                    result.frames.some(f => f.observation_id === wantedFrame) ||
                    result.observations?.some(o => o.id === wantedFrame)
                  );
                  setViewMode(restoreRaw ? "browse" : "visits");
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
                !more.automatic &&
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
                  o.status === "pending" && o.selection !== "unavailable" && inSearch(o, query) &&
                  (!more.detector || o.detector === more.detector) &&
                  (!more.recordIds || more.recordIds.includes(o.id)),
              );
              if (remaining.length) {
                const next = nextSpectrumBatch(remaining, job.manifest.processing, more.size);
                const signature = JSON.stringify([!!next.metadataOnly, next.ids]);
                if (submittedBatches.has(signature))
                  throw new Error(
                    "Loading stopped because the last batch made no progress. Retry the pending observations.",
                  );
                submittedBatches.add(signature);
                await loadObservations(
                  id,
                  abort.signal,
                  next.ids,
                  more.detector,
                  undefined,
                  next.metadataOnly,
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
            const timer = setTimeout(done, firstFramePublished ? 400 : 120);
            abort.signal.addEventListener("abort", done, { once: true });
          });
        }
      } catch (e) {
        if (more?.automatic && current === generation.current) {
          attempted.current.clear();
          if (!abort.signal.aborted) setAutoPaused(true);
        }
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
          setAutoBusy(false);
          activeJob.current = null;
        }
      }
    },
    [],
  );
  useEffect(() => {
    if (
      busy ||
      autoPaused || priorityRequests.current.size ||
      !observations ||
      !displayedQuery?.live ||
      displayedQuery !== committed ||
      !fieldJobId || !manifest || (!manifest.visits?.length && !manifest.processing?.sampling_tracks)
    )
      return;
    const samplingOrder = manifest.processing?.sampling_order;
    // Expanding the untouched display sum must not request more archive bands.
    // Legacy discovery still needs its initially submitted representative band.
    const automaticDemand = automaticMap.current && !samplingOrder;
    const detectors = automaticDemand
      ? [displayedQuery.detectors?.[0] ?? "D1"]
      : activeDetectors(display);
    const channels = automaticDemand
      ? displayedQuery.channels ?? {}
      : activeChannels(display);
    const pinnedIds = new Set(
      display.maps.flatMap(m => Object.keys(m.operands))
        .filter(key => key.startsWith("exposure:"))
        .map(key => key.slice(9)),
    );
    const representativeRank = new Map(samplingOrder?.map((id, i) => [id, i]));
    const metadataIds = new Set(manifest.processing?.sampling_metadata_ids);
    const wanted = observations.filter(o => (o.status === "pending" || (o.status === "ready" && metadataIds.has(o.id))) &&
      o.selection !== "unavailable" && inSearch(o, displayedQuery));
    const needed = (o: (typeof wanted)[number]) => {
      if (pinnedIds.has(o.id)) return true;
      const detector = detectors.find((d) => d === o.detector);
      if (!detector) return false;
      const restriction = channels[detector];
      return (
        !restriction?.length ||
        !o.channel ||
        restriction.some((name) => matchesChannel(name, o))
      );
    };
    const priority = (o: (typeof wanted)[number]) => {
      if (requestedId === o.id || pinnedIds.has(o.id) || timelineChoices[o.id] === true) return -2;
      if (requestSpectra && inspectorOpen && visitMembers.has(o.id)) return -1;
      if (samplingOrder) {
        if (o.status === "pending" && timelineChoices[o.id] !== false && representativeRank.has(o.id)) return 0;
        if (timelineChoices[o.id] !== false && metadataIds.has(o.id)) return 1;
        return display.prefetchBands ? 3 : 4;
      }
      // Explicitly edited maps can request their inputs in older manifests.
      if (
        requestedId &&
        manifest.visits?.some(
          (v) => v.id === requestedId && v.observation_ids.includes(o.id),
        ) &&
        needed(o)
      )
        return -1;
      if (visitMembers.has(o.id) && cycleMembers.has(o.id) && needed(o)) return 0;
      if ((cycleMembers.has(o.id) || !hasCycles) && needed(o)) return 2;
      return display.prefetchBands ? 3 : 4;
    };
    const needsMapFilter = (o: Observation) => !samplingOrder && !!channels[o.detector]?.length &&
      !display.prefetchBands && o.id !== requestedId && !pinnedIds.has(o.id) && !timelineChoices[o.id] &&
      !(requestSpectra && inspectorOpen && visitMembers.has(o.id));
    const attemptKey = (o: Observation) => JSON.stringify([o.id, metadataIds.has(o.id), needsMapFilter(o) ? channels[o.detector] : null]);
    const queued = wanted
      .filter((o) => priority(o) < 4 && !attempted.current.has(attemptKey(o)))
      .sort((a, b) => priority(a) - priority(b) ||
        (representativeRank.get(a.id) ?? Infinity) - (representativeRank.get(b.id) ?? Infinity));
    if (!queued.length) return;
    const narrow = needsMapFilter(queued[0]);
    const eligible = queued.filter(o => needsMapFilter(o) === narrow &&
      (!manifest.processing?.sampling_tracks || priority(o) === priority(queued[0])));
    const {ids, metadataOnly} = nextSpectrumBatch(eligible, manifest.processing, batchSize);
    const batchIds = new Set(ids);
    for (const row of eligible) if (batchIds.has(row.id)) attempted.current.add(attemptKey(row));
    void load(displayedQuery, "", null, {
      jobId: fieldJobId,
      ids,
      metadataOnly,
      channels: narrow ? channels : undefined,
      size: batchSize,
      automatic: true,
    });
  }, [
    busy,
    autoPaused,
    observations,
    displayedQuery,
    committed,
    fieldJobId,
    manifest?.visits,
    manifest?.processing?.sampling_order,
    manifest?.processing?.sampling_tracks,
    manifest?.processing?.background_tracks,
    manifest?.processing?.sampling_metadata_ids,
    timelineChoices,
    display.maps,
    display.prefetchBands,
    requestSpectra,
    inspectorOpen,
    visitMembers,
    cycleMembers,
    hasCycles,
    batchSize,
    load,
    requestedId,
  ]);
  function loadBatch(batch: Omit<LoadBatch, "jobId" | "size">) {
    if (displayedQuery && fieldJobId)
      void load(displayedQuery, "", null, {
        ...batch,
        jobId: fieldJobId,
        size: batchSize,
      });
  }
  function cancelSearch() {
    priorityController.current?.abort();
    priorityRequests.current.clear();
    attempted.current.clear();
    setAutoPaused(true);
    setAutoBusy(false);
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
    let openingDisplay = defaults;
    try {
      const viaUrl = params.has("ra") || params.has("dec");
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        saved = readBackup(raw);
        lastSaved.current = saved;
        setEntries(saved.locations ?? []);
        setFieldNames(saved.fieldNames ?? defaultFieldNames);
        setConsent(true);
      }
      const state = params.get("view");
      if (state) openingDisplay = readDisplay(JSON.parse(state));
      else if (!viaUrl && saved?.config) openingDisplay = saved.config.display;
      automaticMap.current = !state && (viaUrl || !saved?.config);
      setDisplay(openingDisplay);
      if (!params.has("ra") && saved?.config?.query) {
        const q = saved.config.query;
        params.set("ra", String(q.ra_deg));
        params.set("dec", String(q.dec_deg));
        params.set("fov", String(q.fov_arcsec ?? 300));
        if (q.min_separation_days !== undefined) params.set("min_days", String(q.min_separation_days));
        if (q.start_utc) params.set("start", q.start_utc.slice(0, 10));
        if (q.end_utc) params.set("end", q.end_utc.slice(0, 10));
        params.set("frame", saved.config.frame);
        if (q.detectors?.length) params.set("bands", JSON.stringify({detectors:q.detectors,channels:q.channels ?? {}}));
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
          if (opening.cached_manifest_available)
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
        const bands = params.has("bands") ? readBands(JSON.parse(params.get("bands")!)) : mapRequest(openingDisplay);
        if (!bands.detectors.length) bands.detectors = ["D1"];
        const spacing = params.get("min_days");
        setMinDays(spacing);
        const query = {
          ...parseQuery(r, d, s, e),
          ...(spacing === null ? {} : {min_separation_days: separationDays(spacing)}),
          fov_arcsec: angularWidth(params.get("fov") ?? "300"),
          live: true,
          ...bands,
        };
        setBandDraft(draftBands(bands, fieldKey(query)));
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
      priorityController.current?.abort();
    };
  }, [load]);
  useEffect(() => {
    if (playing && steps.length < 2) setPlaying(false);
    if (!playing || !canPlay) return;
    const timer = setTimeout(() => {
      if (!loop && (nextCycle < 0 || nextCycle >= steps.length)) {
        setPlaying(false);
        return;
      }
      selectCycle(nextCycle >= 0 && nextCycle < steps.length ? nextCycle : 0);
    }, 1000 / speed);
    return () => clearTimeout(timer);
  }, [playing, canPlay, speed, steps.length, nextCycle, loop, selectCycle]);
  useEffect(() => {
    const hide = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener("visibilitychange", hide);
    const keys = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") {
        if (document.querySelector("dialog[open]")) return;
        if (canvasFocused) {
          setCanvasFocused(false);
          return;
        }
        setInspectorOpen(false);
      }
      if ((e.target as HTMLElement).closest("input,select,textarea,button,a,summary,[role=separator],[contenteditable=true]"))
        return;
      if (e.code === "Space") {
        if (!canPlay && !playing) return;
        e.preventDefault();
        toggleMotion();
      }
      if (steps.length < 2) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setPlaying(false);
        selectCycle(nextCycle >= 0 && nextCycle < steps.length ? nextCycle : 0);
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPlaying(false);
        selectCycle(previousCycle >= 0 ? previousCycle : steps.length - 1);
      }
    };
    window.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("keydown", keys);
    };
  }, [canPlay, steps.length, playing, selectCycle, nextCycle, previousCycle, toggleMotion, canvasFocused]);
  const onReady = useCallback((value: boolean) => setReady(value), []);
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
    const target = skyTargets.find(t => t.id === p.id);
    if (target) setFov(String(target.fov_arcsec));
    setNotice(
      p.ra
        ? p.note
        : "Verified coordinates for this target will be supplied by the observation service. You can also enter coordinates manually.",
    );
    setError("");
  }
  function search(e: FormEvent) {
    e.preventDefault();
    if (busy && !autoBusy) return;
    try {
      if (!searchBands) throw Error("Choose at least one detector and confirm its spectra for this field.");
      void load({
        ...parseQuery(ra, dec, start, end),
        ...(minDays === null ? {} : {min_separation_days: separationDays(minDays)}),
        fov_arcsec: angularWidth(fov),
        live: true,
        ...searchBands,
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }
  function restoreConfig(
    c: Config,
    wantedPosition: RestorePosition | null = null,
  ) {
    automaticMap.current = false;
    setDisplay(c.display);
    setFov(String(c.fov));
    if (c.query) {
      const q = c.query;
      setMinDays(q.min_separation_days === undefined ? null : String(q.min_separation_days));
      const bands = q.detectors?.length ? readBands(q) : mapRequest(c.display);
      if (!bands.detectors.length) bands.detectors = ["D1"];
      setBandDraft(draftBands(bands, fieldKey({ ...q, fov_arcsec: c.fov })));
      setRa(String(q.ra_deg));
      setDec(String(q.dec_deg));
      setStart(q.start_utc?.slice(0, 10) ?? "");
      setEnd(q.end_utc?.slice(0, 10) ?? "");
      setSelected("");
      void load(
        { ...q, fov_arcsec: c.fov, live: true, ...bands },
        c.frame,
        wantedPosition,
      );
    }
  }
  function importBackup(b: Backup) {
    if (b.fieldNames) setFieldNames(b.fieldNames);
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
  function jumpToCycle(position: number) {
    setPlaying(false);
    selectCycle(position);
  }
  return (
    <NotificationCenter><div className={"app-layout" + (settingsOpen ? "" : " settings-collapsed") + (canvasFocused ? " canvas-focused" : "")}>
      <a className="skip-link" href="#workspace">
        Skip to workspace
      </a>
      <header className="app-header">
        <a className="brand" href="/" aria-label="planetXplorer home">
          <span className="brand-mark">
            <Crosshair size={21} strokeWidth={1.5} />
          </span>
          <span>
            planet<b>X</b>plorer
          </span>
        </a>
        <div className="header-context">
          <span>SPHEREx / IRSA</span>
          <span>Observation workspace</span>
        </div>
        <div className="header-actions">
          <button
            className="button share"
            onClick={share}
            disabled={!committed}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Link copied" : "Share field"}
          </button>
          <NotificationBell />
        </div>
      </header>
      <div className="workspace-toolbar" role="toolbar" aria-label="Workspace tools">
        <div className="toolbar-group">
          <span className="toolbar-label">Field</span>
          <button className="toolbar-button" aria-label="Toggle field settings"
            aria-controls="settings-panel" aria-expanded={settingsOpen && !canvasFocused}
            aria-pressed={settingsOpen && !canvasFocused}
            title="Show or hide field settings"
            onClick={() => { setCanvasFocused(false); setSettingsOpen(!settingsOpen || canvasFocused); }}>
            <SlidersHorizontal size={14} /><span>Settings</span>
          </button>
          <button className="toolbar-button" aria-label="Open saved locations"
            title="Open saved locations and workspace files"
            onClick={() => {
              setCanvasFocused(false);
              setSettingsOpen(true);
              setTab("Settings");
              if (savedLocations.current) savedLocations.current.open = true;
              requestAnimationFrame(() => {
                savedLocations.current?.scrollIntoView({ block: "nearest" });
                savedLocations.current?.querySelector("summary")?.focus({ preventScroll: true });
              });
            }}>
            <Layers size={14} /><span>Locations</span>
          </button>
        </div>
        <div className="toolbar-group">
          <span className="toolbar-label">Panels</span>
          <button className="toolbar-button" aria-label="Toggle observations"
            aria-controls="observations-panel" aria-expanded={dockOpen && !canvasFocused}
            aria-pressed={dockOpen && !canvasFocused} title="Show or hide the observation catalog"
            onClick={() => { setCanvasFocused(false); setDockOpen(!dockOpen || canvasFocused); setDockExpanded(false); }}>
            <Layers size={14} /><span>Observations</span>
          </button>
          <button className="toolbar-button" aria-label="Toggle frame details"
            aria-controls="inspector-panel" aria-expanded={inspectorOpen && !canvasFocused}
            aria-pressed={inspectorOpen && !canvasFocused} title="Show pixel spectra and frame details"
            onClick={() => {
              setCanvasFocused(false);
              setInspectorOpen(!inspectorOpen || canvasFocused);
              if (inspectorOpen && !canvasFocused) setSpectrumVisit("");
            }}>
            <PanelRight size={14} /><span>Details</span>
          </button>
          <button className="toolbar-button" aria-pressed={knownOpen && !canvasFocused}
            disabled={!displayedQuery || !frame} title="Identify cataloged objects in this field"
            onClick={() => { setCanvasFocused(false); setKnownOpen(!knownOpen || canvasFocused); }}>
            <Crosshair size={14} /><span>Known objects</span>
          </button>
        </div>
        <div className="toolbar-group toolbar-end">
          <button className="toolbar-button" aria-label="Canvas only" aria-pressed={canvasFocused}
            title={canvasFocused ? "Restore panels (Escape)" : "Hide panels to focus on the image"}
            onClick={() => setCanvasFocused(!canvasFocused)}>
            {canvasFocused ? <Minimize2 size={14} /> : <Maximize2 size={14} />}<span>Canvas only</span>
          </button>
          <button className="toolbar-button" title="Workflow and keyboard shortcuts"
            onClick={() => { setCanvasFocused(false); setSettingsOpen(true); setTab("Help"); }}>
            <Info size={14} /><span>Help</span>
          </button>
        </div>
      </div>
      <aside className="sidebar" id="settings-panel" aria-label="Query and display settings">
        <PanelResizer panel="settings" />
        <nav className="panel-tabs" aria-label="Settings navigation">
          {["Settings", "Surveys", "Links", "Help", "About"].map((value) => (
            <button
              key={value}
              onClick={() => setTab(tab === value ? "" : value)}
              aria-pressed={tab === value}
              className={tab === value ? "active" : ""}
            >
              {value}
            </button>
          ))}
        </nav>
        <div className="settings-scroll">
          <div hidden={tab !== "Settings"}>
            <details className="sidebar-section" open>
              <summary><span className="workflow-step" aria-hidden="true">01</span><span>Search</span></summary>
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
                <SearchBands query={field} draft={bandDraft} change={setBandDraft} />
                <div className="sampling-options">
                  <label htmlFor="time-sampling">Time sampling</label>
                  <select id="time-sampling" value={minDays === null ? "auto" : "days"}
                    onChange={e => setMinDays(e.target.value === "auto" ? null : "30")}>
                    <option value="auto">Auto · one per cycle and wavelength</option>
                    <option value="days">Minimum separation in days</option>
                  </select>
                  {minDays !== null && <label>Minimum separation (days)
                    <input name="min_days" type="number" min="0" step="any" required value={minDays}
                      onChange={e => setMinDays(e.target.value)} /></label>}
                </div>
                <div className="query-actions">
                  <button
                    className="button primary"
                    type="submit"
                    disabled={(busy && !autoBusy) || !searchBands}
                  >
                    {busy ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <Search size={14} />
                    )}
                    {busy && !autoBusy ? "Searching" : "Search observations"}
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
                        automaticMap.current = true;
                        setDisplay(defaults);
                        setBandDraft({ D1: null });
                        setMinDays(null);
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
              <label className="prefetch-option">
                <input
                  type="checkbox"
                  checked={display.prefetchBands}
                  onChange={(e) => {
                    setAutoPaused(false);
                    update({ prefetchBands: e.target.checked });
                  }}
                />
                Load remaining selected bands in background
              </label>
            </details>
            <details className="sidebar-section" open>
              <summary><span className="workflow-step" aria-hidden="true">02</span><span>Spectrum</span></summary>
              <div className="control-section">
                <label htmlFor="viewing-preset">Viewing preset</label>
                <select id="viewing-preset"
                  value={viewingPresets.find(p => JSON.stringify(p.display.maps) === JSON.stringify(display.maps))?.id ?? ""}
                  onChange={e => {
                    const preset = viewingPresets.find(p => p.id === e.target.value);
                    if (!preset) return;
                    update(clonePresetDisplay(preset));
                    setBandDraft(draftBands(preset, fieldKey(field)));
                    setAutoPaused(false);
                    setNotice(preset.description + " Search observations to load these bands for the field.");
                  }}>
                  <option value="">Custom view</option>
                  {viewingPresets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              {frame?.previewScale ||
              (manifest?.frames.length && !science.numeric) ? (
                <p className="preview-note">
                  {frame?.quality || frame?.pixels
                    ? "Exposure PNG preview. Color and band controls use calibrated brightness when available."
                    : "Prepared PNG preview. Search observations to load calibrated brightness values for color and band controls."}
                </p>
              ) : null}
              <ImageControls
                s={display}
                manifest={manifest}
                update={(patch) => {
                  setAutoPaused(false);
                  update(patch);
                }}
              />
            </details>
            <details className="sidebar-section" ref={savedLocations}>
              <summary><span className="workflow-step" aria-hidden="true">03</span><span>Saved locations</span></summary>
              <WorkspacePanel
                backup={backup}
                saveEntries={setEntries}
                saveFieldNames={setFieldNames}
                selected={selectedEntry}
                consent={consent}
                setConsent={allowSave}
                restore={importBackup}
                reopen={(e) => restoreConfig(e.config, {...e.position, scope:e.scope})}
                onError={setError}
              />
            </details>
            <details className="sidebar-section">
              <summary><SlidersHorizontal size={12} aria-hidden="true" /><span>Playback and appearance</span></summary>
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
                {!frame?.canvas && (
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
                  {frame?.canvas ? "Invert colors" : "Invert grayscale"}
                </label>
              </section>
            </details>
          </div>
          {tab === "Surveys" ? (
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
          ) : tab && tab !== "Settings" ? (
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
                    magnifies the displayed pixels. Click a pixel or left-drag a
                    region with Select (V) for Details. Choose Pan (H) to move
                    the image, or right-drag with either tool. Use two fingers
                    to pan or zoom on touchscreens.
                  </p>
                  <p>
                    Play compares observing cycles at matched wavelengths.
                    Expand a cycle in Observations to choose its frames.
                    Use Space to play or pause and arrow keys to step.
                  </p>
                  <p>
                    Inversion changes the displayed colors. Compare matching
                    wavelengths before interpreting changes in brightness.
                  </p>
                  <p>
                    Use Locations to save a field or selection. Canvas only
                    hides the panels; press Escape to restore them. On the
                    image, + / − zooms, F fits, and 1 shows native pixels.
                  </p>
                </>
              ) : (
                <>
                  <h2>planetXplorer</h2>
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
          ) : null}
        </div>
      </aside>
      <main id="workspace">
        <div className="content">
          <h1 className="sr-only">planetXplorer</h1>
          <div className="feedback" aria-live="polite">
            {product && !product.layers.length && (
              <p><Info size={14} />No configured map inputs apply to this exposure. Choose matching spectra in the map’s Inputs.</p>
            )}
            {conflicts.length > 0 && (
              <Notification key={fieldJobId + conflicts.map(v => v.id).join("/")} label="visit warning">
              <details>
              <summary>Incomplete or conflicting visits ({conflicts.length})</summary>
              <ul>
                {conflicts.map((v) => (
                  <li key={v.id}>
                    <strong>{stamp(v.start_utc)}{v.start_utc !== v.end_utc && ` – ${stamp(v.end_utc)}`}</strong>
                    <ul>{v.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>
                  </li>
                ))}
              </ul>
              <p>
                Inspect individual exposures in the observation table.
              </p>
              </details>
              </Notification>
            )}
            {committed &&
              !busy &&
              (bandsEdited || (minDays === null ? undefined : Number(minDays)) !== committed.min_separation_days ||
                Number(ra) !== committed.ra_deg ||
                Number(dec) !== committed.dec_deg ||
                Number(fov) !== (committed.fov_arcsec ?? 300) ||
                start !== (committed.start_utc?.slice(0, 10) || "") ||
                end !== (committed.end_utc?.slice(0, 10) || "")) && (
                <Notification label="edited search notice">
                <p>
                  <Info size={14} />
                  Query edited. The viewer still shows the last searched field.
                  Search to apply changes.
                </p>
                </Notification>
              )}
            {!busy &&
              displayedQuery &&
              committed &&
              displayedQuery !== committed &&
              frames.length > 0 && (
                <Notification label="previous field notice">
                <p>
                  <Info size={14} />
                  Showing the previous field. The latest search has no result.
                </p>
                </Notification>
              )}
            {error && (
              <Notification key={error} label="search error" onDismiss={() => setError("")}>
              <p role="alert" className="error">
                <Info size={15} />
                {error}
              </p>
              </Notification>
            )}
            {science.failure && frames.length > 0 && (
              <Notification key={fieldJobId + science.failure} label="image data error">
                <p role="alert">{science.failure}</p>
              </Notification>
            )}
            {notice && (
              <Notification key={fieldJobId + notice} label="search notice" onDismiss={() => setNotice("")}>
              <p>
                <Info size={15} />
                {notice}
              </p>
              </Notification>
            )}
            {autoPaused && !busy && displayedQuery?.live && (
              <Notification label="paused downloads">
              <button
                className="button"
                onClick={() => {
                  attempted.current.clear();
                  setAutoPaused(false);
                }}
              >
                Resume band loading
              </button>
              </Notification>
            )}
          </div>
          <div
            className={
              "workspace-grid" + (inspectorOpen ? "" : " inspector-collapsed") +
              (knownOpen && displayedQuery ? " with-catalog" : "")
            }
          >
            {knownOpen && displayedQuery && <ObjectPanel query={displayedQuery} data={known}
              chosen={chosenObject} select={selectObject} moving={showMoving} toggleMoving={setShowMoving}
              times={epochs} epoch={epoch} changeEpoch={setPreferredEpoch} close={() => setKnownOpen(false)} />}
            <section className="viewer-section" aria-label="Observation viewer" aria-busy={busy}>
              <div className="section-heading">
                <span className="viewer-document-title"><Crosshair size={13} />Observation viewer</span>
                <span className="viewer-progress" role="status" aria-label="Cutout progress">
                  {busy || !science.settled ? <LoaderCircle size={13} className="spin" /> : null}
                  {busy ? `${stage} · ${allFrames.length} images available`
                    : !science.settled ? "Loading brightness and quality data…"
                    : `Ready · ${steps.length} observing epochs`}
                </span>
                <span className="field-readout mono">
                  {displayedQuery && frames.length
                    ? `RA ${displayedQuery.ra_deg.toFixed(6)}° · Dec ${displayedQuery.dec_deg.toFixed(6)}°`
                    : "No field loaded"}
                </span>
              </div>
              {allFrames.length > 0 && (
                <div className="sequence-toolbar">
                  {viewMode === "browse" && <button className="button" onClick={() => {
                    setMode(sequenceId ? "matched" : "visits");
                    restoreFrame.current = ""; setSelectedFrame("");
                  }}>Return to timeline</button>}
                  {sequence ? (
                    <MatchedPicker spectra={spectra} selected={sequence} currentId={frame?.observation_id}
                      allInputs={!matched} selectAll={() => {
                        setMode("visits"); setSequenceId(""); restoreFrame.current=""; setSelectedFrame("");
                      }}
                      stamp={stamp} select={(id, exposure) => {
                        setMode("matched");
                        setSequenceId(id);
                        restoreFrame.current = exposure;
                        setSelectedFrame(exposure);
                      }} />
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
                        : subtracting
                          ? "Cycle subtraction"
                        : derived && frame && !isVisitMap
                          ? "Cycle exposure · selected map inputs pending or unavailable"
                          : derived
                          ? `${frames.length} mapped visit${frames.length === 1 ? "" : "s"}`
                          : `${allFrames.length} loaded image${allFrames.length === 1 ? "" : "s"}`}
                      {isVisitMap && visit?.status === "pending" && " · Provisional"}
                    </span>
                  )}
                </div>
              )}
              {subtracting && science.difference && (
                <div className="sequence-toolbar" role="group" aria-label="Cycle subtraction">
                  <label>Reference cycle{" "}
                    <select value={referenceCycle ?? ""} onChange={e => {setPlaying(false); setReferenceCycle(e.target.value);}}>
                      <option value="">Earliest calibrated cycle</option>
                      {!!referenceCycle && !science.difference.options.some(v => v.id === referenceCycle) &&
                        <option value={referenceCycle}>Selected reference unavailable</option>}
                      {science.difference.options.map(v => <option key={v.id} value={v.id}>{stamp(v.start_utc)}</option>)}
                    </select>
                  </label>
                  <span className="browse-summary">
                    Displayed cycle − reference · MJy/sr · {invert ? "inverted map colors" : "configured map colors"}
                  </span>
                </div>
              )}
              <SkyViewer
                subtracting={subtracting}
                canSubtract={viewMode !== "browse" && steps.length > 1}
                onSubtract={(enabled) => {
                  setPlaying(false);
                  if (!enabled) {
                    const epoch = matchedSteps?.find(step => step.visit.id === frame?.visit_id);
                    const key = matched && epoch ? epoch.source.observation_id : frame?.visit_id ?? "";
                    restoreFrame.current = key;
                    setSelectedFrame(key);
                    setReferenceCycle(null);
                    return;
                  }
                  setReferenceCycle(steps[0]?.visit.id ?? "");
                  const epoch = steps[Math.min(Math.max(1,cycleIndex),steps.length-1)];
                  if (epoch) {
                    restoreFrame.current=epoch.visit.id;
                    setSelectedFrame(epoch.visit.id);
                  }
                }}
                cycleView={derived || matched}
                unmatchedFrames={unmatchedFrames}
                frames={frames}
                index={index}
                onReady={onReady}
                onPaint={onPaint}
                zoom={zoom}
                invert={invert}
                display={display}
                update={update}
                query={displayedQuery}
                bounds={
                  frame?.mapScales?.length
                    ? frame.mapScales[0].bounds
                    : [
                        manifest?.processing?.stretch?.vmin ?? 0,
                        manifest?.processing?.stretch?.vmax ?? 1,
                      ]
                }
                colors={science.colors}
                markers={known.markers}
                chosenObject={chosenObject}
                onMarker={selectObject}
                selection={selection}
                onSelect={(box) => {
                  setObjectKey("");
                  setSelection(box);
                  setInspectorOpen(true);
                }}
                message={science.message}
                searchError={error}
                onRetrySearch={displayedQuery ? () => { void load(displayedQuery); } : undefined}
                onInspectExposure={viewMode !== "browse" && !subtracting && allFrames.length ? () => {
                  const exposure = allFrames[0];
                  setMode("browse");
                  restoreFrame.current = exposure.observation_id;
                  setSelectedFrame(exposure.observation_id);
                } : undefined}
                grid={manifest?.grid}
                gridHeader={manifest?.processing?.grid_header}
              />
              <SurveyComparison query={displayedQuery} />
              <div className="playback">
                <div className="transport">
                  <button
                    aria-label="First cycle"
                    disabled={steps.length < 2}
                    onClick={() => jumpToCycle(0)}
                  >
                    <SkipBack size={15} />
                  </button>
                  <button
                    aria-label="Previous cycle"
                    disabled={previousCycle < 0}
                    onClick={() => jumpToCycle(previousCycle)}
                  >
                    <ChevronLeft size={17} />
                  </button>
                  <button
                    className="play"
                    aria-label={playing ? "Pause" : "Play"}
                    disabled={!canPlay && !playing}
                    onClick={toggleMotion}
                  >
                    {playing ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                  <button
                    aria-label="Next cycle"
                    disabled={nextCycle < 0 || nextCycle >= steps.length}
                    onClick={() => jumpToCycle(nextCycle)}
                  >
                    <ChevronRight size={17} />
                  </button>
                  <button
                    aria-label="Last cycle"
                    disabled={steps.length < 2}
                    onClick={() => jumpToCycle(steps.length - 1)}
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
                <span className="frame-counter" aria-label="Current cycle">
                  {cycleIndex >= 0 ? String(cycleIndex + 1).padStart(2, "0") : "—"}{" "}
                  <span>
                    /{" "}
                    {steps.length
                      ? String(steps.length).padStart(2, "0")
                      : "—"}
                  </span>
                </span>
              </div>
              <div className="timeline">
                <input
                  aria-label="Cycle timeline"
                  type="range"
                  min={0}
                  max={Math.max(1, steps.length - 1)}
                  value={Math.max(0, cycleIndex)}
                  disabled={steps.length < 2}
                  onChange={(e) => jumpToCycle(Number(e.target.value))}
                />
                <div>
                  <span>
                    {steps.length ? stamp(steps[0].visit.start_utc) : ""}
                  </span>
                  <span>
                    {steps.length
                      ? stamp(steps[steps.length - 1].visit.end_utc)
                      : ""}
                  </span>
                </div>
              </div>
              {allFrames.length > 0 && steps.length < 2 && (
                <div className="playback-guidance">
                  {matched
                    ? (steps.length ? "One matched epoch is available. Playback needs this spectrum at a second epoch."
                                    : "No included exposures are available for this spectrum.")
                    : <>{steps.length ? "One cycle available." : "No playable cycles."} Motion playback needs two cycles with matching wavelengths. Inspect individual exposures in Observations.</>}
                </div>
              )}
            </section>
            {inspectorOpen && (
              <aside className="inspector" id="inspector-panel" aria-label="Frame details">
                <PanelResizer panel="inspector" />
                <div className="inspector-scroll">
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
                {frame && (
                  <Spectrum
                    planes={detailPlanes}
                    pixel={pixel}
                    region={
                      selection &&
                      (selection[0] !== selection[2] ||
                        selection[1] !== selection[3])
                        ? selection
                        : null
                    }
                    width={science.width}
                    height={science.height}
                    pending={pendingSpectrumInputs.length > 0}
                  />
                )}
                {visit && (
                  <div className="detail-group">
                    <h3>{visit.kind === "supplemental" ? "Additional exposures" : "Observation cycle"}</h3>
                    <p>
                      {stamp(visit.start_utc)} – {stamp(visit.end_utc)}
                    </p>
                    <p>
                      {visit.kind === "supplemental" ? "Outside the identified cycles" : visit.status} · {detailPlanes.length} of{" "}
                      {visit.observation_ids.length} exposures loaded
                    </p>
                    {visit.issues.map((issue) => (
                      <p key={issue}>{issue}</p>
                    ))}
                    {pendingSpectrumInputs.some(o => o.status === "pending" && o.selection !== "unavailable") && (
                      <button
                        className="button"
                        disabled={busy && !autoBusy}
                        onClick={() => {
                          setSpectrumVisit(visit.id);
                          setAutoPaused(false);
                        }}
                      >
                        Load selected bands for this spectrum
                      </button>
                    )}
                  </div>
                )}
                {!frame ? (
                  <p className="inspector-empty">Load a field, then select a pixel or region to inspect its spectrum and source observations.</p>
                ) : (
                  <>
                    {product?.subtraction && (
                      <div className="detail-group">
                        <h3>Cycle difference</h3>
                        <p>{product.layers[0].map.name} · displayed cycle minus {stamp(product.subtraction.referenceDate)}</p>
                        {pixel && residual !== undefined && (
                          <p>Δ at pixel ({pixel[0]+1}, {pixel[1]+1}) · {Number.isFinite(residual) ? residual.toPrecision(5) + " MJy/sr" : "No paired measurement"}</p>
                        )}
                      </div>
                    )}
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
                      </div>
                    )}
                    <div className="detail-group">
                      <h3>Acquisition</h3>
                      <dl>
                        {displayedQuery && (
                          <>
                            <dt>Field center (ICRS)</dt>
                            <dd>
                              {displayedQuery.ra_deg.toFixed(6)}°,{" "}
                              {displayedQuery.dec_deg.toFixed(6)}°
                            </dd>
                            <dt>Field width</dt>
                            <dd>{displayedQuery.fov_arcsec ?? 300}″</dd>
                          </>
                        )}
                        {science.width > 0 && (
                          <>
                            <dt>Image dimensions</dt>
                            <dd>
                              {science.width} × {science.height} pixels
                            </dd>
                          </>
                        )}
                        {product && (isVisitMap || product.matchedMap) && !product.subtraction && (
                          <>
                            <dt>Map layers</dt>
                            <dd>
                              {product.layers.length} of {display.maps.length}{" "}
                              available
                            </dd>
                          </>
                        )}
                        <dt>Observed at</dt>
                        <dd>
                          {isVisitMap && visit
                            ? `${stamp(visit.start_utc)} – ${stamp(visit.end_utc)}`
                            : stamp(frame?.observed_at)}
                        </dd>
                        <dt>Detector</dt>
                        <dd>
                          {isVisitMap && product
                            ? [
                                ...new Set(
                                  product.inputs.map((f) => f.detector),
                                ),
                              ].join(", ")
                            : frame?.detector || "—"}
                        </dd>
                        <dt>Release</dt>
                        <dd>
                          {isVisitMap && product
                            ? [
                                ...new Set(
                                  product.inputs.map((f) => f.release),
                                ),
                              ].join(", ")
                            : frame?.release || "—"}
                        </dd>
                      </dl>
                    </div>
                    {!isVisitMap && (
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
                            {frame.mapScales?.[0]?.stretch ??
                              frame.previewScale?.stretch ??
                              manifest?.stretch ??
                              "—"}
                          </dd>
                        </dl>
                      </div>
                    )}
                    <div className="detail-group">
                      <h3>Provenance</h3>
                      <dl>
                        <dt>{isVisitMap ? "Visit ID" : "Observation ID"}</dt>
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
                      {!isVisitMap &&
                        frame?.source_url &&
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
                </div>
              </aside>
            )}
          </div>
          <section
            className={
              "observations-dock " +
              (!dockOpen ? "collapsed" : "") +
              (dockExpanded ? " expanded" : "")
            }
            id="observations-panel" aria-label="Observations"
          >
            {dockOpen && !dockExpanded && <PanelResizer panel="observations" />}
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
                  {catalogVisits?.length
                    ? `${cycleCount} cycle${cycleCount === 1 ? "" : "s"} · ${observations?.length ?? allFrames.length} exposures`
                    : observations?.length ?? allFrames.length}
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
                        disabled={busy || !nextPending.ids.length || !fieldJobId}
                        onClick={() => {
                          loadBatch({
                            detector: detectorFilter || undefined,
                            ...nextPending,
                          });
                        }}
                      >
                        {nextPending.ids.length
                          ? `${nextPending.metadataOnly ? "Check wavelengths for" : "Load next"} ${nextPending.ids.length}`
                          : "No pending images"}
                      </button>
                      <button
                        className="button"
                        disabled={busy || !nextPending.ids.length || !fieldJobId}
                        onClick={() => {
                          loadBatch({
                            detector: detectorFilter || undefined,
                            all: true,
                            ...nextPending,
                            recordIds: pendingRecords.map(o => o.id),
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
                      {nextFailed.ids.length > 0 && (
                        <button
                          className="button"
                          disabled={busy || !fieldJobId}
                          onClick={() => {
                            loadBatch({
                              ...nextFailed,
                            });
                          }}
                        >
                          Retry {nextFailed.ids.length}{" "}
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
                  {catalogVisits?.length ? (
                    <CycleCatalog key={fieldJobId} visits={catalogVisits} records={catalogRecords}
                      filtered={observations ? filteredObservations : catalogRecords} selectedId={frame?.observation_id}
                      selectedVisitId={frame ? visit?.id : undefined} visibleMaps={visibleMaps}
                      timeline={timelineChecklist} skipReasons={science.reasons}
                      openCycle={openCycle} busy={busy} canRequest={canRequest} inspect={inspectRecord} stamp={stamp} />
                  ) : observations ? (
                    <ExposureTable records={filteredObservations} selectedId={frame?.observation_id}
                      timeline={timelineChecklist} unavailable="Awaiting cycle assignment"
                      busy={busy} canRequest={canRequest} inspect={inspectRecord} stamp={stamp} />
                  ) : <table>
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
                      {frames.map((f, i) => (
                            <tr
                              key={f.id}
                              className={i === index ? "active" : ""}
                            >
                              <td>
                                <button
                                  aria-label={`Select frame ${i + 1}`}
                                  onClick={() => {
                                    setPlaying(false);
                                    restoreFrame.current = "";
                                    setSelectedFrame(f.observation_id);
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
                  </table>}
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
    </div></NotificationCenter>
  );
}
