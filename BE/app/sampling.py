"""Choose initial and automatic downloads. Playback verifies the full five-point response."""

from collections import defaultdict
from datetime import datetime
from itertools import islice, zip_longest

from .schemas import Manifest, ObservationRecord, channel_parameters, nominal_parameters


def calibrated_tracks(records: list[ObservationRecord], labels, tolerance):
    """Partition by selected channel/version and pairwise-compatible center response."""
    requested = [p for label in labels if (p := channel_parameters(label))]
    requested_numbers = {p[1] for label in labels if (p := nominal_parameters(label))}
    groups = defaultdict(list)
    geometry = defaultdict(list)
    unknown = []
    for row in records:
        number = row.nominal_channel
        if number is not None and 1 <= number <= 17 and (number in requested_numbers or not labels):
            geometry[number].append(row)
            continue
        if requested_numbers and not requested:
            if number is None:
                unknown.append(row)
            continue
        parsed = channel_parameters(row.channel or "")
        if not parsed or parsed[2] == "unknown" or not row.wavelength_um or not row.bandwidth_um:
            unknown.append(row)
            continue
        target = None
        if requested:
            matches = [p[1] for p in requested if p[2] == parsed[2]
                       and abs(p[1] - row.wavelength_um) <= row.bandwidth_um / 2 + .0000005]
            if not matches:
                continue
            target = min(matches, key=lambda center: (abs(center - row.wavelength_um), center))
        groups[(parsed[2], target)].append(row)
    # The published geometrical channel is independent of small wavelength
    # and version differences. Playback still verifies the calibrated response.
    tracks = [(f"{members[0].detector}-{number:02}", sorted(members, key=lambda r: (r.wavelength_um or 0, r.id)))
              for number, members in geometry.items()]
    for (_, target), members in groups.items():
        members.sort(key=lambda r: (r.wavelength_um, r.id))
        track = []
        upper = 0.
        for row in members:
            wave, radius = row.wavelength_um, tolerance * row.bandwidth_um
            # The new (highest) wavelength must lie within every previous
            # half-bandwidth. Its own interval must reach the lowest center.
            if track and (wave > upper or wave - track[0].wavelength_um > radius):
                tracks.append((target, track))
                track = []
            upper = min(upper, wave + radius) if track else wave + radius
            track.append(row)
        tracks.append((target, track))
    return tracks, unknown


def spaced(rows, minimum_days):
    """Reserve both temporal endpoints, then fill the interior in chronological order."""
    ordered = sorted(rows, key=lambda r: (r.observed_at, r.id))
    if len(ordered) < 2:
        return ordered
    gap = (minimum_days or 0) * 86400
    first, last = ordered[0], ordered[-1]
    first_time, last_time = (datetime.fromisoformat(r.observed_at).timestamp() for r in (first, last))
    if last_time - first_time < gap:
        return [first]
    result = [first, last]
    previous = first_time
    for row in ordered[1:-1]:
        stamp = datetime.fromisoformat(row.observed_at).timestamp()
        if stamp - previous >= gap and last_time - stamp >= gap:
            result.append(row)
            previous = stamp
    return result


def candidate_cycles(manifest):
    # Repeats can invalidate a combined map without erasing the time of the
    # visit. Rank their raw exposures as a cycle only for download scheduling.
    return {v.id for v in manifest.visits if v.kind == "cycle" and (
        v.status != "invalid" or v.issues and all("has overlapping exposures" in s for s in v.issues)
    )}


def metadata_candidates(manifest: Manifest, limit: int):
    """Interleave a bounded field-center metadata sample across cycles and detectors."""
    core = candidate_cycles(manifest)
    by_band = defaultdict(lambda: defaultdict(list))
    for row in manifest.observations:
        if row.selection in ("unknown", "matched"):
            by_band[row.detector][row.visit_id].append(row)
    groups = []
    for detector, visits in by_band.items():
        compared = [members for key, members in visits.items() if key in core]
        if len(compared) >= 2:
            by_visit = {members[0].visit_id: members for members in compared}
            groups.extend([r for r in by_visit[first.visit_id] if r.needs_spectral(manifest.query)]
                          for first in spaced([members[0] for members in compared], None))
        elif manifest.query.channels.get(detector) and not any(
            row.selection == "matched" for members in visits.values() for row in members
        ):
            groups.extend([r for r in members if r.needs_spectral(manifest.query)] for members in visits.values())
    return list(islice((r for wave in zip_longest(*groups) for r in wave if r is not None), limit))


def pending_metadata(manifest):
    """List unclassified candidates across cycles before repeats and supplemental rows."""
    core = candidate_cycles(manifest)
    groups = defaultdict(list)
    for row in manifest.observations:
        if (row.status in ("pending", "ready") and row.needs_spectral(manifest.query) and row.selection not in ("excluded", "unavailable")
                and row.band_match(manifest.query) != "excluded"):
            groups[(row.visit_id not in core, row.detector, row.visit_id)].append(row.id)
    result = []
    for supplemental in (False, True):
        visits = [ids for (outside, _, _), ids in groups.items() if outside == supplemental]
        result.extend(key for wave in zip_longest(*visits) for key in wave if key)
    return result


def sampling_plan(manifest: Manifest, tolerance: float):
    query = manifest.query
    core = candidate_cycles(manifest)
    by_detector = defaultdict(list)
    for row in manifest.observations:
        if row.selection not in ("excluded", "unavailable"):
            by_detector[row.detector].append(row)
    ranked, fallbacks, extra, uncalibrated = [], [], [], []
    for detector, rows in sorted(by_detector.items()):
        labels = query.channels.get(detector, [])
        tracks, unknown = calibrated_tracks(rows, labels, tolerance)
        represented = set()
        raw = defaultdict(list)
        for target, members in tracks:
            started = any(r.status in ("ready", "loading", "failed") for r in members)
            center = target if isinstance(target, float) else members[len(members) // 2].wavelength_um or 0
            members = [r for r in members if r.status != "failed"]
            if not members:
                continue
            by_visit = defaultdict(list)
            for row in members:
                if row.visit_id in core:
                    by_visit[row.visit_id].append(row)
            def preference(r):
                return (r.status not in ("ready", "loading"), abs((r.wavelength_um or center) - center), r.observed_at, r.id)
            chosen = spaced([min(values, key=preference) for values in by_visit.values()], query.min_separation_days)
            if chosen:
                represented.add(target if labels else None)
                first = datetime.fromisoformat(chosen[0].observed_at)
                last = datetime.fromisoformat(chosen[1].observed_at) if len(chosen) > 1 else first
                span = (last - first).total_seconds()
                rank = (not started, -len(chosen), -span, detector, str(target or ""), center, members[0].id)
                ranked.append((rank, [r.id for r in chosen]))
            else:
                raw[target if labels else None].extend(members)
            chosen_ids = {r.id for r in chosen}
            extras = [r.id for r in spaced([r for r in members if r.id not in chosen_ids], None)]
            if extras:
                extra.append(extras)
        for target, members in raw.items():
            if target not in represented:
                row = min(members, key=lambda r: (r.status not in ("ready", "loading"), r.observed_at, r.id))
                fallbacks.append([row.id])
        unknown = [r for r in unknown if r.status != "failed"]
        if unknown:
            # Unclassified products cannot establish a motion comparison.
            # Expose a raw starting image when a band has no calibrated choice.
            if not tracks:
                fallback = min(unknown, key=lambda r: (r.status not in ("ready", "loading"),
                                                       r.visit_id not in core, r.observed_at, r.id))
                fallbacks.append([fallback.id])
            uncalibrated.append([r.id for r in spaced(unknown, None)])
    representatives = [ids for _, ids in sorted(ranked)] + fallbacks
    selected_ids = {key for group in representatives for key in group}
    background = [[key for key in group if key not in selected_ids] for group in extra + uncalibrated]
    return representatives, [group for group in background if group]
