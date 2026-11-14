"""Check a two-epoch SPHEREx candidate; use --fetch to inspect its two FITS cutouts."""

import argparse
import csv
import io
import json
import sys
import tempfile
import time
from pathlib import Path

import astropy.units as u
import numpy as np
from astropy.coordinates import SkyCoord, get_body_barycentric
from astropy.time import Time
from scipy.ndimage import maximum_filter
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.archive import Archive, Observation, checked_url
from app.config import ROOT, Settings
from app.pipeline import align, compatible, decode, target_grid
from app.schemas import Query
from app.surveys import read_small


def predicted(target, preset, epoch):
    if target == "wise":
        # HST apparent coordinates, Table 1, and section 3 of A&A 592 A80.
        base = SkyCoord("8h55m08.163s", "-7d14m39.34s")
        origin = Time(57123.166, format="mjd")
        mu_ra, mu_dec, parallax = -8.16, 0.66, 0.464
    else:
        base = SkyCoord(preset["original_ra_deg"], preset["original_dec_deg"], unit="deg")
        origin = Time("J2000.0")
        mu_ra = preset["pm_ra_cosdec_mas_yr"] / 1000
        mu_dec = preset["pm_dec_mas_yr"] / 1000
        parallax = 0.0  # Preset is a field-guiding solution without parallax.
    years = (epoch.tdb - origin.tdb).to_value(u.yr)
    ra, dec = base.ra.radian, base.dec.radian
    baseline = (get_body_barycentric("earth", epoch) - get_body_barycentric("earth", origin)).xyz.to_value(u.au)
    east = np.array([-np.sin(ra), np.cos(ra), 0])
    north = np.array([-np.cos(ra)*np.sin(dec), -np.sin(ra)*np.sin(dec), np.cos(dec)])
    return base.spherical_offsets_by((years*mu_ra-parallax*(baseline @ east))*u.arcsec,
                                     (years*mu_dec-parallax*(baseline @ north))*u.arcsec)


def peaks(image):
    yy, xx = np.indices(image.shape)
    finite = np.isfinite(image)
    filled = np.where(finite, image, -np.inf)
    med = np.median(image[finite])
    noise = 1.4826 * np.median(np.abs(image[finite] - med))
    candidates = (filled == maximum_filter(filled, size=5)) & (filled > med + 5*noise)
    points = []
    for y, x in np.argwhere(candidates):
        patch = image[y-2:y+3, x-2:x+3]
        if patch.shape != (5, 5) or not np.isfinite(patch).all():
            continue
        dist = np.hypot(xx-x, yy-y)
        sky = image[finite & (dist >= 4) & (dist <= 8)]
        if len(sky) < 30:
            continue
        level = np.median(sky)
        sigma = max(1.4826*np.median(np.abs(sky-level)), np.finfo(float).eps)
        if patch[2, 2] < level + 5*sigma:
            continue
        weights = np.maximum(patch-level, 0)
        dy, dx = np.indices(patch.shape)-2
        points.append([x+(weights*dx).sum()/weights.sum(), y+(weights*dy).sum()/weights.sum()])
    return np.asarray(points).reshape(-1, 2)


def assess(arrays, locations):
    stars, targets = [], []
    for image, pos in zip(arrays, locations):
        sources = peaks(image)
        distance = np.linalg.norm(sources-pos, axis=1)
        matches = sources[distance < 1.5]
        targets.append(matches[0].tolist() if len(matches) == 1 else None)
        stars.append(sources[distance > 5])
    shifts = []
    if all(len(group) for group in stars):
        left, right = map(cKDTree, stars)
        for i, point in enumerate(stars[0]):
            near = right.query_ball_point(point, 1.5)
            if len(near) == 1 and left.query_ball_point(stars[1][near[0]], 1.5) == [i]:
                shifts.append(stars[1][near[0]] - point)
    expected = locations[1]-locations[0]
    result = dict(status="unverified", expected_shift_px=float(np.linalg.norm(expected)),
                  reference_stars=len(shifts), target_centroids_px=targets)
    if len(shifts) >= 3:
        offset = np.median(shifts, axis=0)
        scatter = float(np.sqrt(np.mean(np.sum((shifts-offset)**2, axis=1))))
        result.update(registration_offset_px=offset.tolist(), registration_rms_px=scatter)
        if all(p is not None for p in targets):
            measured = np.subtract(targets[1], targets[0])-offset
            result.update(measured_vector_px=measured.tolist())
            if np.linalg.norm(measured) > max(0.5, 3*scatter) and np.linalg.norm(measured-expected) < max(0.4, 2*scatter):
                result["status"] = "candidate for visual review"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=["wise", "barnard"])
    parser.add_argument("--fetch", action="store_true")
    args = parser.parse_args()
    preset = next(p for p in json.loads((ROOT/"presets.json").read_text()) if p["id"] == args.target)
    frames = json.loads((ROOT/"demos"/args.target/"manifest.json").read_text())["frames"]
    pair = [frames[0], frames[-1]]
    epochs = [Time(f["observed_at"].split("+")[0], scale="utc") for f in pair]
    positions = [predicted(args.target, preset, epoch) for epoch in epochs]
    midpoint = positions[0].directional_offset_by(positions[0].position_angle(positions[1]),
                                                   positions[0].separation(positions[1])/2)
    field = Query(ra_deg=midpoint.ra.deg, dec_deg=midpoint.dec.deg)
    grid, shape = target_grid(field)
    settings = Settings.from_env()
    archive = Archive(settings)
    observations = []
    try:
        for frame, epoch, pos in zip(pair, epochs, positions):
            params = dict(COLLECTION="spherex_dr1", POS=f"CIRCLE {pos.ra.deg} {pos.dec.deg} 0",
                          TIME=f"{epoch.mjd-.001} {epoch.mjd+.001}", RESPONSEFORMAT="CSV", MAXREC=100)
            data = read_small(archive.client, "https://irsa.ipac.caltech.edu/SIA", params, 1_000_000)
            uri = checked_url(frame["source_url"].split("?")[0])
            row = next((r for r in csv.DictReader(io.StringIO(data.decode())) if r["access_url"] == uri), None)
            if row is None:
                raise ValueError("Candidate footprint did not cover the predicted position")
            observations.append(Observation(frame["observation_id"], uri, float(row["t_min"]), frame["detector"], frame["release"]))
        report = dict(observation_ids=[o.identity for o in observations],
                      positions_deg=[[p.ra.deg, p.dec.deg] for p in positions],
                      dates=[f["observed_at"] for f in pair], status="footprints confirmed")
        if args.fetch:
            cutouts = []
            with tempfile.TemporaryDirectory() as tmp:
                for i, (obs, pos) in enumerate(zip(observations, positions)):
                    path = Path(tmp)/f"{i}.fits"
                    source = archive.fetch(obs, field, path, time.monotonic()+60)
                    cutouts.append(decode(path, obs, Query(ra_deg=pos.ra.deg, dec_deg=pos.dec.deg), source))
            report["wavelength_um"] = [c.wavelengths[0] for c in cutouts]
            if compatible(*cutouts, settings.spectral_tolerance):
                arrays = [align(c, grid, shape) for c in cutouts]
                locations = np.array([grid.world_to_pixel(p) for p in positions])
                report.update(assess(arrays, locations))
            else:
                report["status"] = "incompatible wavelengths"
        print(json.dumps(report, indent=2, allow_nan=False))
    finally:
        archive.close()


if __name__ == "__main__":
    main()
