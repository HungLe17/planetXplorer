import { useMemo, useState } from "react";
import type { Observation, Visit } from "@/lib/types";
import { ChevronRight } from "./icons";

type ExposureTableProps = {
  records: Observation[];
  selectedId?: string;
  busy: boolean;
  canRequest: (record: Observation) => boolean;
  inspect: (record: Observation) => void;
  stamp: (date: string) => string;
};

export function ExposureTable({ records, selectedId, busy, canRequest, inspect, stamp }: ExposureTableProps) {
  return (
    <table aria-label="Detector exposures">
      <thead>
        <tr><th>Frame</th><th>Acquired · UTC</th><th>Detector</th><th>Release</th><th>Observation ID</th></tr>
      </thead>
      <tbody>
        {records.map(record => (
          <tr key={record.id} className={record.id === selectedId ? "active" : ""}>
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
            <td>{record.detector}</td>
            <td>{record.release}</td>
            <td>
              <span className="observation-status" title={record.reason}>
                {record.status}{record.reason && `: ${record.reason}`}
              </span>
              <span className="mono">{record.id}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

type Group = { id: string; label: string; visit?: Visit; members: Observation[]; matches: Observation[] };

function CycleRow({ group, active, canView, openCycle, ...table }: {
  group: Group;
  active: boolean;
  canView: boolean;
  openCycle: (id: string) => void;
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
          <span><strong>{group.label}</strong><small>{dates}</small></span>
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
      {expanded && <ExposureTable {...table} records={matches} />}
    </section>
  );
}

export function CycleCatalog({ visits, records, filtered, selectedVisitId, visibleMaps, openCycle, ...table }: {
  visits: Visit[];
  records: Observation[];
  filtered: Observation[];
  selectedVisitId?: string;
  visibleMaps?: Set<string>;
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
          openCycle={openCycle} {...table} />
      ))}
    </div>
  );
}
