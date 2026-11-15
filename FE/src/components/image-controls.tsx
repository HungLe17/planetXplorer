import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, X } from "./icons";
import { spectraTable, nominalLabel, spectrumId, isNominalSpectrum } from "@/lib/nominal-spectra";
import type { Manifest } from "@/lib/types";
import {
  detectors,
  grey,
  matchesChannel,
  newMap,
  stretches,
  thermal,
  type Display,
  type SpectralMap,
  type Stop,
} from "@/lib/imaging";

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
  manifest,
  update,
}: {
  s: Display;
  manifest: Manifest | null;
  update: (p: Partial<Display>, keepView?: boolean) => void;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const current = s.maps.find((m) => m.id === editor?.id);
  const availableInputs = new Set<string>();
  const availableRows = [
    ...(manifest?.frames ?? []),
    ...(manifest?.observations ?? []).filter(o => o.selection !== "unavailable"),
  ];
  for (const input of availableRows) {
    const det = detectors.find(d => d === input.detector);
    if (!det) continue;
    const channel = input.nominal_channel;
    if (channel != null && spectraTable[det].some(row => row.channel === channel))
      availableInputs.add(spectrumId(det, channel));
    else if (input.nominal_channel == null && input.channel?.startsWith(det + " "))
      availableInputs.add(input.channel);
  }
  for (const key of Object.keys(current?.operands ?? {}))
    if (detectors.some(det => key.startsWith(det + " ")) &&
        availableRows.some(row => matchesChannel(key, row)))
      availableInputs.add(key);
  const unavailableInputs = Object.keys(current?.operands ?? {}).filter(key =>
    (isNominalSpectrum(key) || detectors.some(det => key.startsWith(det + " "))) &&
    !availableInputs.has(key),
  );
  useEffect(() => {
    const d = dialog.current;
    if (editor && current && d && !d.open) d.showModal();
  }, [editor, current]);
  function patch(id: string, change: Partial<SpectralMap>) {
    update({
      maps: s.maps.map((m) => (m.id === id ? { ...m, ...change } : m)),
    }, "stretch" in change);
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
            ? other.startsWith(detector + " ") || (isNominalSpectrum(other) && other.startsWith(detector + "-"))
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
          <label className="map-stretch">
            Intensity stretch
            <select aria-label={"Intensity stretch for " + (map.name || "Map " + (i + 1))}
              value={map.stretch} onChange={e => patch(map.id, {stretch:e.target.value})}>
              {stretches.map(f => <option key={f}>{f}</option>)}
            </select>
          </label>
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
                  Select + or − for a whole detector or a spectrum available in this field.
                  Select the same sign again to remove it.
                </p>
                {!manifest && <p>Search a field to see its available spectra.</p>}
                {detectors.map((det) => {
                  const nominal = spectraTable[det].filter(({ channel }) =>
                    availableInputs.has(spectrumId(det, channel)),
                  );
                  const legacy = [...availableInputs].filter(key => key.startsWith(det + " ")).sort();
                  return (
                    <div key={det} className="map-detector">
                      <div className="map-detector-heading">
                        <strong>{det} · whole detector</strong>
                        {signButtons(det, det)}
                      </div>
                      <details>
                        <summary>Spectra ({nominal.length + legacy.length})</summary>
                        {!nominal.length && !legacy.length &&
                          <p>{manifest ? "No spectra available." : "Search a field first."}</p>}
                        {nominal.map(({channel}) => {
                          const id = spectrumId(det, channel);
                          return <div className="map-channel" key={id}>
                            <span>{nominalLabel(det, channel)}</span>{signButtons(id, det)}
                          </div>;
                        })}
                        {legacy.map(key => <div className="map-channel" key={key}>
                          <span>Field calibration · {key}</span>{signButtons(key, det)}
                        </div>)}
                      </details>
                    </div>
                  );
                })}
                {unavailableInputs.length > 0 && (
                  <section aria-label="Unavailable selected inputs">
                    <h4>Unavailable selected inputs</h4>
                    <p>These saved inputs are not available in this field. They remain selected until removed.</p>
                    {unavailableInputs.map(key => <div className="map-channel" key={key}>
                      <span>{key}</span>
                      <button type="button" aria-label={"Remove unavailable input " + key}
                        onClick={() => operand(key, 0, "")}>Remove</button>
                    </div>)}
                  </section>
                )}
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
                    {stretches.map((f) => (
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
