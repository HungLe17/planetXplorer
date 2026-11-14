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
        center = (height // 2) * width + width // 2
        expected_centers = {
            "2025W34_2B_0030_4D6": 1661.5427,
            "2026W12_1A_0610_1D6": 1544.3727,
        }
        assert {f["observation_id"] for f in published["frames"]} == set(expected_centers)
        for frame in published["frames"]:
            prefix = f"/api/assets/{job_id}/"
            quality = client.get(prefix + frame["quality"])
            assert quality.status_code == 200
            assert len(quality.content) == 9 * n
            archived = np.frombuffer(quality.content, "<f4", n)
            flags = np.frombuffer(quality.content, "<u4", n, 4 * n)
            states = np.frombuffer(quality.content, "u1", n, 8 * n) & 0x7F
            assert states[center] == 2
            assert flags[center] == (1 << 1) | (1 << 21) | (1 << 26)
            np.testing.assert_allclose(archived[center], expected_centers[frame["observation_id"]])
            science = np.frombuffer(client.get(prefix + frame["pixels"]).content, "<f4")
            assert np.isnan(science[center])
            with Image.open(BytesIO(client.get(frame["url"]).content)) as image:
                rgba = np.asarray(image).reshape(n, 4)
                assert rgba[center, 3] == 255
                assert np.array_equal(rgba[:, 3] > 0, np.isin(states, (1, 2, 3)))
