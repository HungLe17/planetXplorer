"""Check the shipped Barnard's Star images through the same asset API as the viewer."""

import json
from io import BytesIO

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from app.config import ROOT, Settings
from app.main import create_app


def test_prepared_barnard_quality_matches_preview_and_science(tmp_path):
    directory = ROOT / "demos" / "barnard"
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    settings = Settings(cache_dir=tmp_path / "cache")
    with TestClient(create_app(settings)) as client:
        response = client.post("/api/jobs", json=manifest["query"])
        assert response.status_code == 202
        job_id = response.json()["job_id"]
        published = client.get(f"/api/assets/{job_id}/manifest.json").json()
        assert published["cached"]
        height, width = published["processing"]["output_shape"]
        n = height * width
        saw_marker = False
        for frame in published["frames"]:
            prefix = f"/api/assets/{job_id}/"
            quality = client.get(prefix + frame["quality"])
            assert quality.status_code == 200
            assert len(quality.content) == 9 * n
            archived = np.frombuffer(quality.content, "<f4", n)
            flags = np.frombuffer(quality.content, "<u4", n, 4 * n)
            states = np.frombuffer(quality.content, "u1", n, 8 * n) & 0x7F
            markers = states == 3
            saw_marker |= bool(markers.any())
            assert np.all(np.isnan(archived[markers]))
            assert np.all((flags[markers] & (1 << 1)) != 0)
            science = np.frombuffer(client.get(prefix + frame["pixels"]).content, "<f4")
            assert np.all(np.isnan(science[markers]))
            preview = np.asarray(Image.open(BytesIO(client.get(frame["url"]).content)))
            assert np.all(preview.reshape(n, 4)[markers] == 255)
            assert np.all(preview.reshape(n, 4)[states == 0, 3] == 0)
        assert saw_marker
