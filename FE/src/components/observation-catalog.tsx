import { useMemo, useState } from "react";
import type { Observation, Visit } from "@/lib/types";
import { nominalLabel } from "@/lib/nominal-spectra";
import { ChevronRight } from "./icons";

type TimelineChecklist = {
  choices: Record<string, boolean>;
  includedIds: Set<string>;
  frameReasons: Map<string, string>;
  withinBands: (record: Observation) => boolean;
  setIncluded: (id: string, checked: boolean) => void;
};

type ExposureTableProps = {
  records: Observation[];
  selectedId?: string;
  busy: boolean;
  canRequest: (record: Observation) => boolean;
  inspect: (record: Observation) => void;
  stamp: (date: string) => string;
  timeline: TimelineChecklist;
  unavailable?: string;
  grouped?: boolean;
};

function channelLabel(detector: Observation["detector"], channel: number) {
  if (channel >= 1 && channel <= 17) return nominalLabel(detector, channel);
  if (channel === 0 || channel === 18) return `${detector} · detector edge ${channel}`;
  return `${detector} · nominal spectrum unverified`;
}

function ExposureRows({ records, selectedId, busy, canRequest, inspect, stamp, timeline, unavailable, grouped }: ExposureTableProps) {
  return records.map(record => {
    const reason = !timeline.withinBands(record) ? "Outside selected search bands" : unavailable;
    const included = timeline.includedIds.has(record.id);
    const checked = !reason && (timeline.choices[record.id] ?? included);
    const status = reason || timeline.frameReasons.get(record.id) ||
      (checked && !included ? "Waiting for compatible data" : "");
    const statusId = "timeline-reason-" + encodeURIComponent(record.id);
    return (
      <tr key={record.id} className={record.id === selectedId ? "active" : ""}>
        <td className="timeline-choice">
          <input type="checkbox" aria-label={`Include ${record.id} in timeline`}
            aria-describedby={status ? statusId : undefined}
            ref={input => { if (input) input.indeterminate = checked && !included; }}
            checked={checked} disabled={!!reason}
            onChange={event => timeline.setIncluded(record.id, event.target.checked)} />
          {status && <small id={statusId}>{status}</small>}
        </td>
        <td>
          <button
            disabled={record.status !== "ready" && !canRequest(record)}
            title={record.reason || (record.status === "ready" ? "Inspect observation" : "Load this observation")}
            onClick={() => inspect(record)}
          >
            {record.selection === "excluded" ? "Outside selection" : record.selection === "unavailable" ? "Retry metadata" :
              record.status === "pending" && busy ? "Load next" :
              { ready: "View", failed: "Retry", loading: "Loading", pending: "Load" }[record.status]}
          </button>
        </td>
        <td>{stamp(record.observed_at).replace(" UTC", "")}</td>
        <td>{!grouped && <div>{channelLabel(record.detector, record.nominal_channel ?? -1)}</div>}
          {record.wavelength_um?.toFixed(6) ?? "—"}</td>
        <td>{record.release}</td>
        <td>
          <span className="observation-status" title={record.reason}>
            {record.status}{record.reason && `: ${record.reason}`}
          </span>
          <span className="mono">{record.id}</span>
        </td>
      </tr>
    );
  });
}

function ExposureHeading({ grouped = false }: { grouped?: boolean }) {
  return <thead>
    <tr><th scope="col">Timeline</th><th scope="col">Frame</th><th scope="col">Acquired · UTC</th>
      <th scope="col">{grouped ? "Measured λ (µm)" : "Spectrum · measured λ (µm)"}</th><th scope="col">Release</th><th scope="col">Observation ID</th></tr>
  </thead>;
}

export function ExposureTable(props: ExposureTableProps) {
  return <table aria-label="Detector exposures">
    <ExposureHeading />
    <tbody><ExposureRows {...props} /></tbody>
  </table>;
}

function DetectorGroups({records, ...table}: ExposureTableProps) {
  const detectors = useMemo(() => {
    const byDetector = new Map<Observation["detector"], Map<number, Observation[]>>();
    for (const row of records) {
      const byWavelength = byDetector.get(row.detector) ?? new Map<number, Observation[]>();
      byDetector.set(row.detector, byWavelength);
      const channel = row.nominal_channel ?? -1;
      const members = byWavelength.get(channel) ?? [];
      members.push(row);
      byWavelength.set(channel, members);
    }
    return [...byDetector].sort(([a], [b]) => a.localeCompare(b)).map(([detector, groups]) => ({
      detector,
      groups: [...groups].sort(([a], [b]) => (a < 0 ? Infinity : a) - (b < 0 ? Infinity : b))
        .map(([channel, members]) => ({
          members, label:channelLabel(detector, channel),
        })),
    }));
  }, [records]);
  return <div className="catalog-detectors">{detectors.map(({detector, groups}) =>
    <details key={detector} className="catalog-detector" open>
      <summary>{detector}</summary>
      <table aria-label={detector + " exposures"}>
        <ExposureHeading grouped />
        {groups.map(({label, members}) =>
          <tbody key={label} aria-label={label}>
            <tr><th scope="rowgroup" colSpan={6} className="catalog-wavelength">{label}</th></tr>
            <ExposureRows {...table} records={members} grouped />
          </tbody>)}
      </table>
    </details>)}</div>;
}

type Group = { id: string; label: string; visit?: Visit; members: Observation[]; matches: Observation[] };

function CycleRow({ group, active, canView, openCycle, skipReason, ...table }: {
  group: Group;
  active: boolean;
  canView: boolean;
  openCycle: (id: string) => void;
  skipReason?: string;
} & Omit<ExposureTableProps, "records">) {
  const [expanded, setExpanded] = useState(false);
  const { visit, members, matches } = group;
  const detectors = [...new Set(members.map(record => record.detector))].sort();
  const ready = members.filter(record => record.status === "ready").length;
  const failed = members.filter(record => record.status === "failed").length;
  const dates = visit
    ? [...new Set([visit.start_utc.slice(0, 10), visit.end_utc.slice(0, 10)])].join(" – ") + " UTC"
    : "Outside the assigned cycles";
  return (
    <section className={"catalog-group" + (active ? " active" : "")} aria-label={group.label}>
      <div className="cycle-heading">
        <button className="cycle-disclosure" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <ChevronRight size={13} />
          <span><strong>{group.label}</strong><small>{dates}</small>
            {skipReason && <small className="cycle-skip-reason">{skipReason}</small>}</span>
          <span>{detectors.join(" · ")}</span>
          <span>
            {ready}/{members.length} loaded{failed > 0 && ` · ${failed} failed`}
            {matches.length < members.length && ` · ${matches.length} matching`}
          </span>
          {visit && <span>{visit.status === "pending" ? "Provisional" : visit.status === "complete" ? "Verified" : "Coverage issue"}</span>}
        </button>
        {visit && (
          <button className="button cycle-view" disabled={!canView} aria-label={`View ${group.label}`}
            onClick={() => openCycle(visit.id)}>View cycle</button>
        )}
      </div>
      {expanded && <DetectorGroups {...table} records={matches}
        unavailable={!visit ? "Outside an assigned cycle" : visit.status === "invalid" ? "Conflicting or incomplete cycle" : undefined} />}
    </section>
  );
}

export function CycleCatalog({ visits, records, filtered, selectedVisitId, visibleMaps, openCycle, skipReasons, ...table }: {
  visits: Visit[];
  records: Observation[];
  filtered: Observation[];
  selectedVisitId?: string;
  visibleMaps?: Set<string>;
  skipReasons: Map<string, string>;
  openCycle: (id: string) => void;
} & Omit<ExposureTableProps, "records">) {
  const groups = useMemo(() => {
    const groups: Group[] = [];
    const byObservation = new Map<string, Group>();
    for (const visit of visits) {
      if (visit.kind === "supplemental") continue;
      const group = { id: visit.id, label: `Cycle ${groups.length + 1}`, visit, members: [], matches: [] };
      groups.push(group);
      for (const id of visit.observation_ids) byObservation.set(id, group);
    }
    const extra: Group = {id:"additional", label:"Additional exposures", members:[], matches:[]};
    const visibleIds = new Set(filtered.map(record => record.id));
    for (const record of records) {
      const group = byObservation.get(record.id) ?? extra;
      group.members.push(record);
      if (visibleIds.has(record.id)) group.matches.push(record);
    }
    return [...groups, extra].filter(group => group.matches.length);
  }, [visits, records, filtered]);
  return (
    <div className="cycle-catalog">
      {groups.map(group => (
        <CycleRow key={group.id} group={group}
          active={group.visit ? selectedVisitId === group.id : group.members.some(record => record.id === table.selectedId)}
          canView={group.visit?.status !== "invalid" && (visibleMaps?.has(group.id) ?? group.members.some(record => record.status === "ready"))}
          skipReason={group.visit && skipReasons.get(group.visit.id)}
          openCycle={openCycle} {...table} />
      ))}
    </div>
  );
}
