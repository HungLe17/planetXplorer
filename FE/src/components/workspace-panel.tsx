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
  selected: Omit<Entry, "id" | "name" | "note" | "flag"> | null;
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
        flag: "",
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
    setDraft(null);
    if (consent === null) setShowPrompt(true);
  }
  function exportJson() {
    const data: Backup = { version: 1, exported: new Date().toISOString() };
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
      setDraft(null);
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
  return (
    <section className="science-controls">
      <h3>Workspace</h3>
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
        <summary>Saved locations ({entries.length})</summary>
        <button onClick={add} disabled={!selected}>
          Add location
        </button>{" "}
        <button onClick={() => setDraft(null)}>Browse</button>
        {draft ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              saveEntry();
            }}
          >
            <p>
              {draft.position.ra_deg.toFixed(6)}°,{" "}
              {draft.position.dec_deg.toFixed(6)}°
            </p>
            <label>
              Name
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label>
              Personal flag
              <input
                value={draft.flag}
                onChange={(e) => setDraft({ ...draft, flag: e.target.value })}
              />
            </label>
            <label>
              Notes
              <textarea
                value={draft.note}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              />
            </label>
            <button type="submit">Save entry</button>{" "}
            <button type="button" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </form>
        ) : (
          <>
            <label>
              Find entries
              <input value={find} onChange={(e) => setFind(e.target.value)} />
            </label>
            {entries
              .filter((e) =>
                [
                  e.name,
                  e.note,
                  e.flag,
                  String(e.position.ra_deg),
                  String(e.position.dec_deg),
                ]
                  .join(" ")
                  .toLowerCase()
                  .includes(find.toLowerCase()),
              )
              .map((e) => (
                <article key={e.id}>
                  <strong>{e.name || "Sky location"}</strong> {e.flag}
                  <p>
                    {e.position.ra_deg.toFixed(5)}°,{" "}
                    {e.position.dec_deg.toFixed(5)}°
                  </p>
                  <p>{e.note}</p>
                  <button onClick={() => setDraft(e)}>Edit</button>{" "}
                  <button onClick={() => reopen(e)}>Open view</button>
                </article>
              ))}
          </>
        )}
      </details>
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
