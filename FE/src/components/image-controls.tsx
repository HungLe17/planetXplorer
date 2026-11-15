import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, X } from "./icons";
import { request } from "@/lib/api";
import {
  detectors,
  grey,
  newMap,
  thermal,
  type Display,
  type SpectralMap,
  type Stop,
} from "@/lib/imaging";
import type { Frame, Observation } from "@/lib/types";

const swatches = [
  ["Transparent", "#00000000"],
  ["Black", "#000000"],
  ["White", "#ffffff"],
  ["Red", "#ff0000"],
  ["Green", "#00ff00"],
  ["Blue", "#0000ff"],
];
type Tool = "Inputs" | "Colors" | "Function";
type Editor = { id: string; tool: Tool };
type ChannelPage = {
  channels: string[];
  next_cursor: number | null;
  unavailable: number;
  total: number;
  catalog_complete: boolean;
};
type Lookup = { page?: ChannelPage; loading?: boolean; error?: string };
function ChannelDiscovery({
  lookup,
  discover,
}: {
  lookup?: Lookup;
  discover: () => void;
}) {
  const page = lookup?.page;
  let action = "Discover channels";
  if (lookup?.loading) action = "Checking wavelengths…";
  else if (page?.next_cursor != null) action = "Find more channels";
  else if (lookup?.error || page?.unavailable) action = "Retry wavelength lookup";
  else if (page) action = "Refresh channels";

  return (
    <>
      <button type="button" disabled={lookup?.loading} onClick={discover}>
        {action}
      </button>
      <div role="status">
        {lookup?.loading && <p>Reading calibration metadata…</p>}
        {lookup?.error && <p>{lookup.error}</p>}
        {page && !lookup?.loading && !lookup?.error && (
          <>
            {page.unavailable > 0 && (
              <p>
                Wavelength unavailable for {page.unavailable} exposure(s).
                You can select the whole detector.
              </p>
            )}
            {page.total === 0 && <p>No exposures in the current catalog.</p>}
            {!page.catalog_complete && <p>The field catalog is partial.</p>}
          </>
        )}
      </div>
    </>
  );
}
function gradient(stops: Stop[]) {
  return (
    "linear-gradient(to right," +
    [...stops]
      .sort((a, b) => a.at - b.at)
      .map((p) => p.color + " " + p.at * 100 + "%")
      .join(",") +
    ")"
  );
}
export default function ImageControls({
  s,
  update,
  frames,
  observations = [],
  fieldJobId,
}: {
  s: Display;
  update: (p: Partial<Display>) => void;
  frames: Frame[];
  bounds?: number[];
  observations?: Observation[];
  fieldJobId?: string;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [lookups, setLookups] = useState<Record<string, Lookup>>({});
  const channelRequests = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const requests = channelRequests.current;
    setLookups({});
    return () => {
      for (const pending of requests.values()) pending.abort();
      requests.clear();
    };
  }, [fieldJobId]);

  async function discover(det: string) {
    if (!fieldJobId || channelRequests.current.has(det)) return;
    const controller = new AbortController();
    channelRequests.current.set(det, controller);
    const previous = lookups[det]?.page;
    const cursor = previous?.next_cursor ?? 0;
    setLookups((all) => ({ ...all, [det]: { page: previous, loading: true } }));
    try {
      const page = await request<ChannelPage>(
        `/api/jobs/${encodeURIComponent(fieldJobId)}/channels/${det}?cursor=${cursor}`,
        controller.signal,
        undefined,
        45000,
      );
      if (controller.signal.aborted) return;
      if (cursor && previous)
        page.channels = [...new Set([...previous.channels, ...page.channels])];
      setLookups((all) => ({ ...all, [det]: { page } }));
    } catch {
      if (!controller.signal.aborted)
        setLookups((all) => ({
          ...all,
          [det]: {
            page: previous,
            error:
              "Wavelength lookup failed. Retry or select the whole detector.",
          },
        }));
    } finally {
      if (channelRequests.current.get(det) === controller)
        channelRequests.current.delete(det);
    }
  }
  const current = s.maps.find((m) => m.id === editor?.id);
  useEffect(() => {
    const d = dialog.current;
    if (editor && current && d && !d.open) d.showModal();
  }, [editor, current]);
  function patch(id: string, change: Partial<SpectralMap>) {
    update({
      maps: s.maps.map((m) => (m.id === id ? { ...m, ...change } : m)),
    });
  }
  function operand(key: string, sign: number, detector: string) {
    if (!current) return;
    const next = { ...current.operands };
    const previous = next[key];
    delete next[key];
    if (sign && previous !== sign) {
      for (const other of Object.keys(next))
        if (
          key === detector
            ? other.startsWith(detector + " ")
            : other === detector
        )
          delete next[other];
      next[key] = sign;
    }
    patch(current.id, { operands: next });
  }
  function stop(index: number, change: Partial<Stop>) {
    if (current)
      patch(current.id, {
        stops: current.stops.map((p, i) =>
          i === index ? { ...p, ...change } : p,
        ),
      });
  }
  function signButtons(key: string, det: string) {
    return (
      <span className="operand-signs">
        {[1, -1].map((v) => (
          <button
            type="button"
            key={v}
            aria-label={(v === 1 ? "Add " : "Subtract ") + key}
            aria-pressed={current?.operands[key] === v}
            onClick={() => operand(key, v, det)}
          >
            {v === 1 ? "+" : "−"}
          </button>
        ))}
      </span>
    );
  }
  const channels = [
    ...new Set([
      ...frames.map((f) => f.channel ?? ""),
      ...observations.map((o) => o.channel ?? ""),
      ...Object.values(lookups).flatMap((l) => l.page?.channels ?? []),
      ...s.maps.flatMap((m) => Object.keys(m.operands)),
    ]),
  ];
  return (
    <section className="science-controls map-rows" aria-label="Spectrum maps">
      {s.maps.map((map, i) => (
        <div className="map-row" key={map.id}>
          <div className="map-row-heading">
            <span
              className="map-swatch"
              style={{ background: gradient(map.stops) }}
            />
            <input
              aria-label={"Map name " + (i + 1)}
              value={map.name}
              onChange={(e) => patch(map.id, { name: e.target.value })}
            />
            <button
              type="button"
              title="Delete map"
              aria-label={"Delete " + (map.name || "map")}
              onClick={() => {
                if (window.confirm("Delete " + (map.name || "this map") + "?"))
                  update({ maps: s.maps.filter((m) => m.id !== map.id) });
              }}
            >
              <Trash2 size={15} />
            </button>
          </div>
          <div className="map-actions">
            {(["Inputs", "Colors", "Function"] as const).map((tool) => (
              <button
                key={tool}
                type="button"
                onClick={() => setEditor({ id: map.id, tool })}
              >
                {tool}
              </button>
            ))}
          </div>
        </div>
      ))}
      <button
        className="button"
        type="button"
        onClick={() =>
          update({
            maps: [
              ...s.maps,
              newMap(crypto.randomUUID(), "Map " + (s.maps.length + 1)),
            ],
          })
        }
      >
        <Plus size={14} /> Add map
      </button>
      {editor && current && (
        <dialog
          ref={dialog}
          className="map-dialog"
          aria-label={editor.tool + " for " + current.name}
          onClose={() => setEditor(null)}
          onClick={(e) => {
            if (e.target === dialog.current) dialog.current?.close();
          }}
        >
          <div className="science-controls map-dialog-body">
            <div className="section-heading">
              <h3>
                {current.name || "Map"} · {editor.tool}
              </h3>
              <button
                type="button"
                aria-label="Close editor"
                onClick={() => dialog.current?.close()}
              >
                <X size={16} />
              </button>
            </div>
            {editor.tool === "Inputs" && (
              <>
                <p>
                  Select + or − for a detector or any of its measured channels.
                  Select the same sign again to remove it.
                </p>
                {detectors.map((det) => {
                  const options = channels
                    .filter((c) => c.startsWith(det + " "))
                    .sort(
                      (a, b) => parseFloat(a.slice(3)) - parseFloat(b.slice(3)),
                    );
                  return (
                    <div key={det} className="map-detector">
                      <div className="map-detector-heading">
                        <strong>{det} · whole detector</strong>
                        {signButtons(det, det)}
                      </div>
                      <details>
                        <summary>Channels ({options.length})</summary>
                        {fieldJobId ? (
                          <ChannelDiscovery
                            lookup={lookups[det]}
                            discover={() => discover(det)}
                          />
                        ) : (
                          !options.length && (
                            <p>
                              Search this field to look up wavelengths, or
                              select the whole detector.
                            </p>
                          )
                        )}
                        {options.map((key) => (
                          <div className="map-channel" key={key}>
                            <span>{key}</span>
                            {signButtons(key, det)}
                          </div>
                        ))}
                      </details>
                    </div>
                  );
                })}
                {Object.keys(current.operands)
                  .filter((k) => k.startsWith("exposure:"))
                  .map((key) => (
                    <div key={key}>
                      Pinned exposure {key.slice(9)}{" "}
                      <button onClick={() => operand(key, 0, "")}>
                        Remove
                      </button>
                    </div>
                  ))}
                <output>
                  {Object.entries(current.operands)
                    .map(
                      ([k, v]) =>
                        (v === 1 ? "+ " : "− ") + k.replace("exposure:", ""),
                    )
                    .join(" ") || "No inputs selected"}
                </output>
              </>
            )}
            {editor.tool === "Colors" && (
              <div className="map-colors">
                <div
                  className="map-gradient"
                  style={{ height: 16, background: gradient(current.stops) }}
                />
                <div className="map-actions">
                  <button
                    type="button"
                    onClick={() => patch(current.id, { stops: grey })}
                  >
                    Grayscale
                  </button>
                  <button
                    type="button"
                    onClick={() => patch(current.id, { stops: thermal })}
                  >
                    Thermal
                  </button>
                </div>
                {current.stops.map((p, i) => (
                  <fieldset key={i} className="map-stop">
                    <legend>Stop {i + 1}</legend>
                    <div className="map-actions">
                      <input
                        type="color"
                        aria-label={"Stop color " + (i + 1)}
                        value={p.color.slice(0, 7)}
                        onChange={(e) => stop(i, { color: e.target.value })}
                      />
                      {swatches.map(([name, color]) => (
                        <button
                          type="button"
                          key={name}
                          title={name}
                          aria-label={name + " for stop " + (i + 1)}
                          className={
                            "color-swatch" +
                            (name === "Transparent" ? " transparent" : "")
                          }
                          aria-pressed={p.color.toLowerCase() === color}
                          style={{ backgroundColor: color }}
                          onClick={() => stop(i, { color })}
                        >
                          {name === "Transparent" ? "∅" : ""}
                        </button>
                      ))}
                    </div>
                    <label>
                      Position · {Math.round(p.at * 100)}%
                      <input
                        type="range"
                        aria-label={"Stop position " + (i + 1)}
                        min="0"
                        max="1"
                        step=".01"
                        value={p.at}
                        onChange={(e) =>
                          stop(i, { at: Number(e.target.value) })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      disabled={current.stops.length <= 2}
                      onClick={() =>
                        patch(current.id, {
                          stops: current.stops.filter((_, j) => j !== i),
                        })
                      }
                    >
                      Remove stop
                    </button>
                  </fieldset>
                ))}
                <button
                  type="button"
                  disabled={current.stops.length >= 32}
                  onClick={() =>
                    patch(current.id, {
                      stops: [...current.stops, { at: 0.5, color: "#ff8800" }],
                    })
                  }
                >
                  Add color stop
                </button>
              </div>
            )}
            {editor.tool === "Function" && (
              <>
                <label>
                  Intensity stretch
                  <select
                    value={current.stretch}
                    onChange={(e) =>
                      patch(current.id, { stretch: e.target.value })
                    }
                  >
                    {["linear", "sqrt", "log", "asinh"].map((f) => (
                      <option key={f}>{f}</option>
                    ))}
                  </select>
                </label>
                {(["low", "high"] as const).map((k, i) => (
                  <label key={k}>
                    {i ? "Maximum" : "Minimum"} (MJy/sr)
                    <input
                      type="number"
                      step="any"
                      placeholder="Automatic"
                      value={current[k]}
                      onChange={(e) =>
                        patch(current.id, { [k]: e.target.value })
                      }
                    />
                  </label>
                ))}
                {current.low !== "" &&
                  current.high !== "" &&
                  Number(current.low) > Number(current.high) && (
                    <p role="alert">Minimum exceeds maximum.</p>
                  )}
                <label>
                  <input
                    type="checkbox"
                    checked={current.difference}
                    onChange={(e) =>
                      patch(current.id, { difference: e.target.checked })
                    }
                  />{" "}
                  Difference imaging
                </label>
                {current.difference &&
                  (["windowDays", "exclusionDays"] as const).map((k, i) => (
                    <label key={k}>
                      {i ? "Exclusion width" : "Window width"} (days)
                      <input
                        type="number"
                        min="0"
                        max="1000000"
                        value={current[k]}
                        onChange={(e) =>
                          patch(current.id, {
                            [k]: Math.max(
                              0,
                              Math.min(1e6, Number(e.target.value)),
                            ),
                          })
                        }
                      />
                    </label>
                  ))}
              </>
            )}
            <button
              className="button primary"
              type="button"
              onClick={() => dialog.current?.close()}
            >
              Done
            </button>
          </div>
        </dialog>
      )}
    </section>
  );
}
