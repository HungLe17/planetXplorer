"""Run a real archive query/pipeline and optionally preserve it as a cached preset.

Run from BE: .venv/Scripts/python scripts/prove_data.py --all --bundle
"""

import argparse
import json
import shutil
import sys
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.archive import Archive
from app.config import Settings
from app.pipeline import Pipeline, atomic_json
from app.schemas import Query


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", default="wise")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--bundle", action="store_true")
    args = parser.parse_args()
    settings = Settings.from_env()
    archive = Archive(settings)
    presets = json.loads((ROOT / "presets.json").read_text())
    selected = [p for p in presets if args.all or p["id"] == args.target]
    if not selected:
        parser.error("Unknown preset")
    for preset in selected:
        query = Query(ra_deg=preset["ra_deg"], dec_deg=preset["dec_deg"])
        directory = settings.cache_dir / "validation" / preset["id"]
        directory.mkdir(parents=True, exist_ok=True)
        print(preset["id"], "starting", flush=True)
        try:
            result = Pipeline(settings, archive).run(
                query,
                directory,
                uuid4().hex,
                lambda s, name=preset["id"]: print(name, s, flush=True),
            )
            report = {
                "target": preset["id"],
                "checked_at": datetime.now(UTC).isoformat(),
                "query": query.model_dump(mode="json"),
                "observations": len(result.observations),
                "detectors": sorted({o.detector for o in result.observations}),
                "sequences": len(result.sequences),
                "largest_sequence": max(
                    (len(g.frame_ids) for g in result.sequences), default=0
                ),
                "frames": len(result.frames),
                "dates": [f.observed_at for f in result.frames],
                "sources": [f.source_url for f in result.frames],
                "mask_fractions": [f.mask_fraction for f in result.frames],
                "warnings": result.warnings,
                "omissions": result.omissions,
                "outcome": "playable sequence"
                if any(len(g.frame_ids) > 1 for g in result.sequences)
                else "images available; no compatible pair in the loaded batch"
                if result.frames
                else "no usable frames in the loaded batch",
                "detection_claim": "none; visual inspection is required",
            }
            if args.bundle and result.frames:
                dest = ROOT / "demos" / preset["id"]
                dest.mkdir(parents=True, exist_ok=True)
                for f in result.frames:
                    for asset in (f.id, f.pixels, f.quality):
                        if asset:
                            shutil.copyfile(directory / asset, dest / asset)
                atomic_json(dest / "manifest.json", result.model_dump(mode="json"))
        except Exception as exc:  # noqa: BLE001 -- record each target's independent failure
            report = {
                "target": preset["id"],
                "query": query.model_dump(mode="json"),
                "outcome": "failed",
                "error": str(exc),
            }
        atomic_json(directory / "report.json", report)
        print(
            preset["id"],
            report["outcome"],
            f"frames={report.get('frames', 0)}",
            flush=True,
        )
    archive.close()


if __name__ == "__main__":
    main()
