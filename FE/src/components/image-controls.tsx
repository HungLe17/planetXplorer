import { grey, thermal, type Display } from "@/lib/imaging";
import type { Frame } from "@/lib/types";

export default function ImageControls({
  s,
  update,
  frames,
  bounds,
}: {
  s: Display;
  update: (p: Partial<Display>) => void;
  frames: Frame[];
  bounds: number[];
}) {
  const channels = Array.from(
    new Set(frames.map((f) => f.channel).filter((v): v is string => !!v)),
  );
  function operand(key: string, sign: number) {
    const next = { ...s.operands };
    if (next[key] === sign) delete next[key];
    else {
      for (const name of Object.keys(next))
        if (name.startsWith(key + " ") || key.startsWith(name + " "))
          delete next[name];
      next[key] = sign;
    }
    update({ operands: next });
  }
  return (
    <section className="science-controls">
      <h3>Image processing</h3>
      {frames.some((f) => f.quality) && (
        <label>
          <input
            type="checkbox"
            checked={s.inspectFlagged}
            onChange={(e) => update({ inspectFlagged: e.target.checked })}
          />{" "}
          Inspect flagged pixels
        </label>
      )}
      <label>
        Display mode
        <select
          value={s.mode}
          onChange={(e) => update({ mode: e.target.value })}
        >
          <option value="single">Intensity / false color</option>
          <option value="rgb">Static RGB</option>
        </select>
      </label>
      {s.mode === "rgb" ? (
        ["Red", "Green", "Blue"].map((label, i) => (
          <label key={label}>
            {label} wavelength and exposure
            <select
              value={s.rgb[i]}
              onChange={(e) =>
                update({
                  rgb: s.rgb.map((v, j) => (i === j ? e.target.value : v)),
                })
              }
            >
              <option value="">Select exposure</option>
              {frames.map((f) => (
                <option
                  key={f.id}
                  value={f.observation_id}
                  disabled={s.rgb.some(
                    (id, j) =>
                      j !== i &&
                      frames.find((other) => other.observation_id === id)
                        ?.channel === f.channel,
                  )}
                >
                  {f.channel} · {f.observed_at.slice(0, 19)}
                </option>
              ))}
            </select>
          </label>
        ))
      ) : (
        <>
          <details open>
            <summary>Band expression</summary>
            {[1, 2, 3, 4, 5, 6].map((n) => {
              const det = "D" + n,
                options = channels.filter((c) => c.startsWith(det + " "));
              return (
                <div key={det}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={!options.length}
                      checked={!!s.operands[det]}
                      onChange={() => operand(det, s.operands[det] || 1)}
                    />{" "}
                    {det} · average ({options.length})
                  </label>
                  {options.length > 0 && (
                    <details>
                      <summary>Wavelengths</summary>
                      {[det, ...options].map((k) => (
                        <div key={k}>
                          {k === det ? (
                            "Whole detector"
                          ) : (
                            <button
                              type="button"
                              aria-label={"Select " + k}
                              onClick={() => update({ operands: { [k]: 1 } })}
                            >
                              {k}
                            </button>
                          )}{" "}
                          {[-1, 1].map((sign) => (
                            <button
                              type="button"
                              key={sign}
                              aria-label={
                                (sign === 1 ? "Add " : "Subtract ") + k
                              }
                              aria-pressed={s.operands[k] === sign}
                              onClick={() => operand(k, sign)}
                            >
                              {sign === 1 ? "+" : "−"}
                            </button>
                          ))}
                        </div>
                      ))}
                    </details>
                  )}
                </div>
              );
            })}
            <output>
              {Object.entries(s.operands)
                .map(([n, sign]) => (sign === 1 ? "+ " : "− ") + n)
                .join(" ") ||
                (s.difference
                  ? "Automatic · most observations"
                  : "All wavelengths")}
            </output>
          </details>
          <label>
            <input
              type="checkbox"
              checked={s.difference}
              onChange={(e) => update({ difference: e.target.checked })}
            />{" "}
            Difference imaging
          </label>
          {s.difference && (
            <label>
              Window width (days)
              <input
                type="number"
                min="0"
                value={s.windowDays}
                onChange={(e) =>
                  update({ windowDays: Math.max(0, Number(e.target.value)) })
                }
              />
            </label>
          )}
          {s.difference && (
            <label>
              Exclusion width (days)
              <input
                type="number"
                min="0"
                value={s.exclusionDays}
                onChange={(e) =>
                  update({ exclusionDays: Math.max(0, Number(e.target.value)) })
                }
              />
            </label>
          )}
        </>
      )}
      <label>
        Intensity stretch
        <select
          value={s.stretch}
          onChange={(e) => update({ stretch: e.target.value })}
        >
          {["linear", "sqrt", "log", "asinh"].map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </label>
      {(["low", "high"] as const).map((k, i) => (
        <label key={k}>
          {i ? "Maximum" : "Minimum"} (MJy/sr)
          <input
            type="number"
            step="any"
            placeholder={String(bounds[i])}
            value={s[k]}
            onChange={(e) => update({ [k]: e.target.value })}
          />
        </label>
      ))}
      {s.mode === "single" && (
        <details open>
          <summary>Color gradient</summary>
          <button onClick={() => update({ stops: grey })}>
            Grayscale
          </button>{" "}
          <button onClick={() => update({ stops: thermal })}>Thermal</button>
          <div
            style={{
              height: 14,
              background:
                "linear-gradient(to right," +
                [...s.stops]
                  .sort((a, b) => a.at - b.at)
                  .map((p) => p.color + " " + p.at * 100 + "%")
                  .join(",") +
                ")",
            }}
          />
          {s.stops.map((stop, i) => (
            <div key={i} className="color-stop">
              <input
                aria-label={"Stop color " + (i + 1)}
                type="color"
                value={stop.color}
                onChange={(e) =>
                  update({
                    stops: s.stops.map((v, j) =>
                      j === i ? { ...v, color: e.target.value } : v,
                    ),
                  })
                }
              />
              <input
                aria-label={"Stop position " + (i + 1)}
                type="range"
                min="0"
                max="1"
                step=".01"
                value={stop.at}
                onChange={(e) =>
                  update({
                    stops: s.stops.map((v, j) =>
                      j === i ? { ...v, at: Number(e.target.value) } : v,
                    ),
                  })
                }
              />
              <button
                aria-label={"Remove stop " + (i + 1)}
                disabled={s.stops.length <= 2}
                onClick={() =>
                  update({ stops: s.stops.filter((_, j) => i !== j) })
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            disabled={s.stops.length >= 32}
            onClick={() =>
              update({ stops: [...s.stops, { at: 0.5, color: "#ff8800" }] })
            }
          >
            Add color stop
          </button>
        </details>
      )}
    </section>
  );
}
