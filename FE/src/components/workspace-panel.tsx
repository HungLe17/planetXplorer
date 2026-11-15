import { useEffect, useRef, useState } from "react";
import { request } from "@/lib/api";
import {
  type Backup,
  type Entry,
  type ArchiveCheck,
  type ArchiveSnapshot,
  checkImportedFields,
  download,
  readBackup,
  defaultFieldNames,
  flagColors,
  type FlagColor,
} from "@/lib/workspace";

import Notification from "./notification";

type Props = {
  backup: Backup;
  saveEntries: (e: Entry[]) => void;
  saveFieldNames: (names: string[]) => void;
  reopen: (e: Entry) => void;
  restore: (b: Backup) => void;
  selected: Omit<Entry, "id" | "name" | "note" | "fields"> | null;
  consent: boolean | null;
  setConsent: (v: boolean) => void;
  onError: (s: string) => void;
};
function locationArea(target: NonNullable<Props["selected"]>, kind: "frame" | "region"): Pick<Entry,"scope" | "position"> {
  if (kind === "region" && target.scope?.kind === "region") return {scope:target.scope, position:target.position};
  const center = target.config.query ?? target.position;
  return {scope:{kind:"frame"}, position:{ra_deg:center.ra_deg, dec_deg:center.dec_deg}};
}
function ColorFlag({label, color, change}: {label:string; color?:FlagColor | null; change:(color:string) => void}) {
  return <label className="saved-color-picker">
    <span className="saved-color-circle" aria-hidden="true" data-color={color ?? "none"} style={{backgroundColor:color ?? "transparent"}} />
    <select aria-label={label} value={color ?? ""} onChange={e => change(e.target.value)}>
      <option value="">No color</option>
      {flagColors.map(c => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
    </select>
  </label>;
}
export default function WorkspacePanel({
  backup,
  saveEntries,
  saveFieldNames,
  reopen,
  restore,
  selected,
  consent,
  setConsent,
  onError,
}: Props) {
  const entries = backup.locations ?? [];
  const fieldNames = backup.fieldNames ?? defaultFieldNames;
  const [area, setArea] = useState<"frame" | "region">("region");
  const captured = useRef<Props["selected"]>(null);
  const [find, setFind] = useState(""),
    [draft, setDraft] = useState<Entry | null>(null);
  const [section, setSection] = useState("both"),
    [showPrompt, setShowPrompt] = useState(false);
  const [importDate, setImportDate] = useState(""),
    [checking, setChecking] = useState(false),
    [checks, setChecks] = useState<ArchiveCheck[]>([]);
  const pending = useRef<AbortController | null>(null);
  const locationsDialog = useRef<HTMLDialogElement>(null);
  const fieldsDialog = useRef<HTMLDialogElement>(null);
  const [fieldDraft, setFieldDraft] = useState<string[]>([]);
  useEffect(() => () => pending.current?.abort(), []);
  function add() {
    if (selected) {
      captured.current = selected;
      setDraft({
        ...selected,
        ...locationArea(selected, area),
        color:null,
        id: crypto.randomUUID(),
        name: "",
        note: "",
        fields: fieldNames.map(name => ({name, value:""})),
      });
    }
  }
  function saveEntry() {
    if (!draft) return;
    const exists = entries.some((e) => e.id === draft.id);
    saveEntries(
      exists
        ? entries.map((e) => (e.id === draft.id ? draft : e))
        : [...entries, draft],
    );
    setFind("");
    if (consent === null) setShowPrompt(true);
  }
  function exportJson() {
    const data: Backup = { version: 2, exported: new Date().toISOString() };
    if (section !== "locations") {
      data.config = backup.config;
      data.snapshot = backup.snapshot;
      data.snapshotComplete = backup.snapshotComplete;
    }
    if (section !== "config") { data.locations = entries; data.fieldNames = fieldNames; }
    download(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      "planetXplorer-workspace.json",
    );
  }
  async function importFile(file: File) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setChecks([]);
    setChecking(false);
    setImportDate("");
    try {
      if (file.size > 20e6) throw Error("Workspace file exceeds 20 MB.");
      const data = readBackup(await file.text());
      if (controller.signal.aborted) return;
      restore(data);
      if (data.locations) {
        setFind("");
        setDraft(data.locations[0] ?? null);
      }
      setImportDate(data.exported);
      setChecking(true);
      if (consent === null) setShowPrompt(true);
      await checkImportedFields(
        data,
        controller.signal,
        (q, s) =>
          request<ArchiveSnapshot>("/api/archive/snapshot", s, q, 60000),
        (item) => setChecks((prev) => [...prev, item]),
      );
    } catch (err) {
      if (!controller.signal.aborted) onError((err as Error).message);
    } finally {
      if (!controller.signal.aborted) setChecking(false);
    }
  }
  const search = find.trim().toLowerCase();
  const visibleEntries = entries.filter((entry) =>
    [
      entry.name,
      entry.note,
      entry.color ?? "",
      String(entry.position.ra_deg),
      String(entry.position.dec_deg),
      ...entry.fields.flatMap(({ name, value }) => [name, value]),
    ].some((text) => text.toLowerCase().includes(search)),
  );
  const saved = entries.find((entry) => entry.id === draft?.id);
  function flag(entry: Entry, value: string) {
    const color = value ? value as FlagColor : null;
    saveEntries(entries.map(e => e.id === entry.id ? {...e,color} : e));
    setDraft(d => d?.id === entry.id ? {...d, color} : d);
  }
  const columns = [...new Set(entries.flatMap(entry => entry.fields.map(field => field.name)))];
  function updateField(index: number, key: "name" | "value", text: string) {
    if (!draft) return;
    setDraft({
      ...draft,
      fields: draft.fields.map((field, i) =>
        i === index ? { ...field, [key]: text } : field,
      ),
    });
  }
  return (
    <section className="science-controls saved-workspace">
      <div className="saved-actions">
        <label>Save area
          <select aria-label="Save area" value={selected?.scope?.kind === "region" ? area : "frame"}
            onChange={e => {
              const kind = e.target.value as "frame" | "region";
              setArea(kind);
              if (draft && !saved && captured.current) setDraft({...draft, ...locationArea(captured.current, kind)});
            }}>
            <option value="frame">Whole frame</option>
            <option value="region" disabled={selected?.scope?.kind !== "region"}>Selected region in Details</option>
          </select>
        </label>
        <button type="button" onClick={add} disabled={!selected}>
          Add location
        </button>
      </div>
      <div className="saved-actions">
        <button type="button" onClick={() => {
          setFieldDraft([...fieldNames]);
          fieldsDialog.current?.showModal();
        }}>Default fields for new locations</button>
        <button type="button" onClick={() => locationsDialog.current?.showModal()}>Browse saved locations</button>
      </div>
      <dialog ref={fieldsDialog} className="saved-fields-dialog" aria-label="Default fields for new locations">
        <form onSubmit={e => {
          e.preventDefault();
          saveFieldNames([...new Set(fieldDraft.map(s => s.trim()).filter(Boolean))]);
          fieldsDialog.current?.close();
          if (consent === null) setShowPrompt(true);
        }}>
          <h2>Default fields for new locations</h2>
          {fieldDraft.map((name,i) => <div className="saved-default-field" key={i}>
            <label>Field name
              <input aria-label={"Default field name " + (i+1)} value={name}
                onChange={e => setFieldDraft(old => old.map((value,index) => index===i ? e.target.value : value))} />
            </label>
            <button type="button" aria-label={"Delete default field " + (i+1)}
              onClick={() => setFieldDraft(old => old.filter((_,index) => index!==i))}>Delete</button>
          </div>)}
          <button type="button" onClick={() => setFieldDraft(old => [...old,""])}>Add default field</button>
          <div className="saved-actions">
            <button type="submit">Save default fields</button>
            <button type="button" onClick={() => fieldsDialog.current?.close()}>Cancel</button>
          </div>
        </form>
      </dialog>
      <dialog ref={locationsDialog} className="saved-browser-dialog" aria-label="Browse saved locations">
        <div className="saved-browser-heading"><h2>Saved location browser</h2>
          <button type="button" onClick={() => locationsDialog.current?.close()}>Close</button>
        </div>
        <label>Filter saved locations
          <input type="search" value={find} onChange={e => setFind(e.target.value)} />
        </label>
        <div className="saved-sheet-scroll">
          <table className="saved-sheet">
            <thead><tr><th>Name</th><th>Color flag</th><th>RA (°)</th><th>Dec (°)</th><th>Area</th>
              {columns.map(name => <th key={name}>{name || "Unnamed field"}</th>)}<th>Notes</th><th>Actions</th></tr></thead>
            <tbody>{visibleEntries.map(entry => <tr key={entry.id}>
              <td>{entry.name || "Sky location"}</td>
              <td><ColorFlag label={"Color flag for " + (entry.name || "Sky location")} color={entry.color}
                change={value => flag(entry,value)} /></td>
              <td>{entry.position.ra_deg.toFixed(6)}</td><td>{entry.position.dec_deg.toFixed(6)}</td>
              <td>{entry.scope?.kind === "region" ? "Selected region" : entry.scope?.kind === "frame" ? "Whole frame" : "Point"}</td>
              {columns.map(name => <td key={name}>{entry.fields.filter(field => field.name===name).map(field => field.value).join(", ")}</td>)}
              <td>{entry.note}</td>
              <td><div className="saved-sheet-actions">
                <button type="button" aria-label={"Open " + (entry.name || "Sky location")} onClick={() => {
                  locationsDialog.current?.close(); reopen(entry);
                }}>Open view</button>
                <button type="button" aria-label={"Edit " + (entry.name || "Sky location")} onClick={() => {
                  setDraft(entry); locationsDialog.current?.close();
                }}>Edit</button>
                <button type="button" aria-label={"Delete " + (entry.name || "Sky location")} onClick={() => {
                  if (window.confirm("Delete " + (entry.name || "this location") + "?")) {
                    saveEntries(entries.filter(e => e.id!==entry.id));
                    if (draft?.id===entry.id) setDraft(null);
                  }
                }}>Delete</button>
              </div></td>
            </tr>)}</tbody>
          </table>
          {!visibleEntries.length && <p>{entries.length ? "No matching locations." : "No saved locations."}</p>}
        </div>
      </dialog>
      <div className="saved-split">
        {draft ? (
          <form
            className="saved-editor"
            onSubmit={(e) => {
              e.preventDefault();
              saveEntry();
            }}
          >
            <label>
              Location name
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <p>
              {draft.scope?.kind === "region"
                ? `Region (${draft.scope.box[0]+1}, ${draft.scope.box[1]+1})–(${draft.scope.box[2]+1}, ${draft.scope.box[3]+1}) · `
                : draft.scope?.kind === "frame" ? "Whole frame · " : ""}
              RA {draft.position.ra_deg.toFixed(6)}° · Dec{" "}
              {draft.position.dec_deg.toFixed(6)}°
            </p>
            <div>Color flag
              <ColorFlag label="Color flag" color={draft.color} change={value => {
                if (saved) flag(saved, value);
                else setDraft({...draft, color:value ? value as FlagColor : null});
              }} />
            </div>
            {draft.fields.map((field, i) => (
              <div className="saved-field-row" key={i}>
                <label>
                  Field name
                  <input
                    aria-label={`Field name ${i + 1}`}
                    value={field.name}
                    onChange={(e) => updateField(i, "name", e.target.value)}
                  />
                </label>
                <label>
                  Value
                  <input
                    aria-label={`Field value ${i + 1}`}
                    value={field.value}
                    onChange={(e) => updateField(i, "value", e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  aria-label={`Remove field ${i + 1}`}
                  onClick={() =>
                    setDraft({
                      ...draft,
                      fields: draft.fields.filter((_, index) => index !== i),
                    })
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setDraft({
                  ...draft,
                  fields: [...draft.fields, { name: "", value: "" }],
                })
              }
            >
              + Add field
            </button>
            <label>
              Notes
              <textarea
                value={draft.note}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              />
            </label>
            <div className="saved-actions">
              <button type="submit">Save entry</button>
              {saved && (
                <button type="button" onClick={() => reopen(saved)}>
                  Open view
                </button>
              )}
              <button type="button" onClick={() => setDraft(saved ?? null)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <p className="saved-editor">
            Select a location to edit or reopen it.
          </p>
        )}
      </div>
      <button type="button" onClick={() => setShowPrompt(true)}>
        {consent ? "Device saving settings" : "Save your work"}
      </button>
      {showPrompt && (
        <div
          role="dialog"
          aria-label="Save your work"
          className="workspace-save-prompt"
        >
          <strong>Save your work on this device?</strong>
          <p>
            Remember viewer settings, locations, and notes between visits.
            Session only clears the stored copy and keeps this session open.
          </p>
          <button
            onClick={() => {
              setConsent(true);
              setShowPrompt(false);
            }}
          >
            Save on this device
          </button>{" "}
          <button
            onClick={() => {
              setConsent(false);
              setShowPrompt(false);
            }}
          >
            Session only
          </button>
          <button
            aria-label="Dismiss save prompt"
            onClick={() => setShowPrompt(false)}
          >
            Close
          </button>
        </div>
      )}
      <details>
        <summary>Import / export JSON</summary>
        <label>
          Export contents
          <select value={section} onChange={(e) => setSection(e.target.value)}>
            <option value="both">Configuration and locations</option>
            <option value="config">Configuration only</option>
            <option value="locations">Locations and notes only</option>
          </select>
        </label>
        <button onClick={exportJson}>Export JSON</button>
        <label>
          Import JSON
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void importFile(f);
            }}
          />
        </label>
        {importDate && (
          <Notification key={importDate} label="workspace import notice" onDismiss={() => setImportDate("")}>
          <div role="status">
            <p>
              Imported workspace exported{" "}
              {new Date(importDate).toLocaleString()}.
            </p>
            {checking && <p>Checking saved fields for new data…</p>}
            {checks.length > 0 && (
              <ul>
                {checks.map((c, i) => (
                  <li key={i}>
                    <strong>{c.labels.join(", ")}</strong> — {c.details}
                  </li>
                ))}
              </ul>
            )}
          </div>
          </Notification>
        )}
      </details>
    </section>
  );
}
