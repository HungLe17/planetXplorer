"""Conservative field-visit candidates from the catalog, validated with loaded FITS."""

from collections import defaultdict
from datetime import datetime, timedelta
from hashlib import sha256

from .archive import DETECTORS
from .schemas import Frame, Manifest, Visit


# SPHEREx's three co-pointed detector pairs take separate measurements of the field.
DETECTOR_PAIRS = ({"D1", "D4"}, {"D2", "D5"}, {"D3", "D6"})
PASS_GAP = timedelta(days=14)


def field_visits(manifest: Manifest, frames: list[Frame]) -> list[Visit]:
    by_id = {frame.observation_id: frame for frame in frames}
    groups = []
    previous = None
    phase = None
    # DR1 covers surveys 1/2 through 2026-05-15 (IRSA data releases).
    # A 14-day *gap* marks a new candidate; ordinary field spans can exceed 14 days.
    for record in sorted(manifest.observations, key=lambda row: (row.observed_at, row.id)):
        stamp = datetime.fromisoformat(record.observed_at)
        first_phase = record.observed_at[:10] < "2026-05-16"
        if previous is None or stamp - previous > PASS_GAP or first_phase != phase:
            groups.append([])
        groups[-1].append(record)
        previous, phase = stamp, first_phase

    visits = []
    for records in groups:
        first, last = records[0], records[-1]
        visit_id = "visit-" + sha256(first.id.encode()).hexdigest()[:16]
        detectors = {r.detector for r in records}
        members = []
        for record in records:
            record.visit_id = visit_id
            if frame := by_id.get(record.id):
                frame.visit_id = visit_id
                if frame.nominal_channel is not None:
                    record.nominal_channel = frame.nominal_channel
                elif record.nominal_channel is not None:
                    frame.nominal_channel = record.nominal_channel
                record.channel, record.bandwidth_um = frame.channel, frame.bandwidth_um
                record.wavelength_um = frame.wavelength_um
                members.append(frame)
        visit = Visit(
            id=visit_id, start_utc=first.observed_at, end_utc=last.observed_at,
            observation_ids=[r.id for r in records], status="pending",
        )
        visits.append(visit)
        # One co-pointed pair by itself does not establish a six-detector pass.
        # Preserve these observations without assigning them to the closest cycle.
        if any(detectors <= pair for pair in DETECTOR_PAIRS):
            visit.kind = "supplemental"
            continue
        orientations = set()
        signals = defaultdict(list)
        issues = []
        # Dense or repeatedly visited fields can bridge the ordinary scan window
        # without a gap. Keep those exposures raw until the pass is unambiguous.
        start, end = datetime.fromisoformat(first.observed_at), datetime.fromisoformat(last.observed_at)
        span = end - start
        if span > timedelta(days=28):
            issues.append("Observations span more than 28 days without a separating gap. "
                          "A single field visit cannot be established.")
        for frame in members:
            header = frame.exposure_flags
            non_survey = str(header.get("NON_SURVEY", "")).lower() in {"true", "t", "1"}
            mode = str(header.get("SPS_FLAGS", "")).lower()
            if non_survey or (mode and mode != "all_sky"):
                issues.append(f"{frame.observation_id} is not a verified wide-survey exposure ({mode or 'non-survey'}).")
            angle = header.get("SPS_EPA", header.get("SPS_PA_ECL"))
            if angle is not None:
                try:
                    angle = float(angle) % 360
                except (ValueError, TypeError):
                    angle = float("nan")
                if min(angle, 360 - angle) < 0.01:
                    orientations.add(0)
                elif abs(angle - 180) < 0.01:
                    orientations.add(180)
                else:
                    issues.append(f"{frame.observation_id} has an unclassified pointing angle of {angle:.2f}°.")
        nominal_samples = defaultdict(list)
        for record in records:
            if record.nominal_channel is not None and 1 <= record.nominal_channel <= 17:
                nominal_samples[record.detector, record.nominal_channel].append(record.id)
            if record.wavelength_um is not None and record.bandwidth_um is not None:
                signals[record.detector].append(record)
        missing = sorted(set(DETECTORS) - detectors)
        # A date boundary can hide measurements that would belong in this episode.
        query = manifest.query
        clipped = ((query.start_utc is not None and start - query.start_utc <= PASS_GAP)
                   or (query.end_utc is not None and query.end_utc - end <= PASS_GAP))
        if manifest.discovery_complete and missing and not clipped:
            issues.append(f"Missing detector coverage in this search: {', '.join(missing)}.")
        if len(orientations) > 1:
            issues.append("Opposite wide-survey pointing orientations overlap in this visit.")
        for (detector, number), ids in nominal_samples.items():
            if len(ids) > 1:
                issues.append(f"{detector}-{number:02} has overlapping exposures {ids[0]} and {ids[1]}.")
        # Compare actual spectral responses at the specified sky position. Similar
        # detectors with distinct center wavelengths are normal parts of one scan.
        for detector, samples in signals.items():
            ordered = sorted(samples, key=lambda f: f.wavelength_um)
            for index, sample in enumerate(ordered):
                for j in range(index + 1, len(ordered)):
                    other = ordered[j]
                    delta = other.wavelength_um - sample.wavelength_um
                    if delta > sample.bandwidth_um / 2:
                        break
                    if sample.nominal_channel is not None and other.nominal_channel is not None:
                        continue  # Their actual detector channels were compared above.
                    if delta <= min(other.bandwidth_um, sample.bandwidth_um) / 2:
                        issues.append(f"{detector} near {sample.wavelength_um:.4f} µm has overlapping "
                                      f"exposures {sample.id} and {other.id}.")
                        break
        decoded = len(members) == len(records)
        checked = decoded and manifest.discovery_complete and not missing
        if checked and not orientations:
            issues.append("No wide-survey pointing orientation could be verified from the FITS headers.")
        elif checked and any(f.exposure_flags.get("SPS_EPA", f.exposure_flags.get("SPS_PA_ECL")) is None
                             for f in members):
            issues.append("At least one exposure has no wide-survey pointing orientation.")
        unique_issues = list(dict.fromkeys(issues))
        if len(unique_issues) > 24:
            unique_issues = [*unique_issues[:24], f"{len(unique_issues) - 24} additional conflicts. Inspect the raw catalog."]
        visit.status = "invalid" if issues else "complete" if checked else "pending"
        visit.issues = unique_issues
        if missing and clipped and visit.status == "pending":
            visit.issues.append(f"Date limits may exclude measurements from {', '.join(missing)}.")
    return visits
