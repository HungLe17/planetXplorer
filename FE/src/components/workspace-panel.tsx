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
} from "@/lib/workspace";

type Props = {
  backup: Backup;
  saveEntries: (e: Entry[]) => void;
  reopen: (e: Entry) => void;
  restore: (b: Backup) => void;
  selected: Omit<Entry, "id" | "name" | "note" | "fields"> | null;
  consent: boolean | null;
  setConsent: (v: boolean) => void;
  onError: (s: string) => void;
};
export default function WorkspacePanel({
  backup,
  saveEntries,
  reopen,
  restore,
  selected,
  consent,
  setConsent,
  onError,
}: Props) {
  const entries = backup.locations ?? [];
  const [find, setFind] = useState(""),
    [draft, setDraft] = useState<Entry | null>(null);
  const [section, setSection] = useState("both"),
    [showPrompt, setShowPrompt] = useState(false);
  const [importDate, setImportDate] = useState(""),
    [checking, setChecking] = useState(false),
    [checks, setChecks] = useState<ArchiveCheck[]>([]);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  function add() {
    if (selected)
      setDraft({
        ...selected,
        id: crypto.randomUUID(),
        name: "",
        note: "",
        fields: [],
      });
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
    if (section !== "config") data.locations = entries;
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
      String(entry.position.ra_deg),
      String(entry.position.dec_deg),
      ...entry.fields.flatMap(({ name, value }) => [name, value]),
    ].some((text) => text.toLowerCase().includes(search)),
  );
  const saved = entries.find((entry) => entry.id === draft?.id);
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
        <button type="button" onClick={add} disabled={!selected}>
          Add location
        </button>
      </div>
      <div className="saved-split">
        <div className="saved-list">
          <label>
            Find locations
            <input
              type="search"
              value={find}
              onChange={(e) => setFind(e.target.value)}
            />
          </label>
          <ul aria-label="Saved location list">
            {visibleEntries.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="saved-choice"
                  aria-pressed={entry.id === draft?.id}
                  onClick={() => setDraft(entry)}
                >
                  <strong>{entry.name || "Sky location"}</strong>
                  <small>
                    {entry.position.ra_deg.toFixed(5)}°,{" "}
                    {entry.position.dec_deg.toFixed(5)}°
                  </small>
                </button>
              </li>
            ))}
          </ul>
          {visibleEntries.length === 0 && (
            <p>
              {entries.length
                ? "No matching locations."
                : "No saved locations."}
            </p>
          )}
        </div>
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
              RA {draft.position.ra_deg.toFixed(6)}° · Dec{" "}
              {draft.position.dec_deg.toFixed(6)}°
            </p>
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
        )}
      </details>
    </section>
  );
}
