import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    cache_dir: Path = ROOT / ".cache"
    demo_dir: Path = ROOT / "demos"
    max_jobs: int = 3
    ttl_seconds: int = 7200
    job_seconds: int = 120
    metadata_seconds: int = 30
    request_seconds: int = 15
    cutout_workers: int = 4
    max_download_bytes: int = 64 * 1024 * 1024
    max_cache_bytes: int = 1024 * 1024 * 1024
    max_candidates: int = 24
    max_frames: int = 12
    metadata_limit: int = 100
    spectral_tolerance: float = (
        0.5  # maximum separation as a fraction of narrower bandwidth
    )
    origins: tuple[str, ...] = ("http://127.0.0.1:3000", "http://localhost:3000")

    def __post_init__(self):
        if not (
            1 <= self.max_frames <= 12
            and 2 <= self.max_candidates <= 48
            and self.max_candidates % 2 == 0
        ):
            raise ValueError(
                "Frame limit must be 1–12; candidate count must be even and 2–48"
            )
        if (
            min(
                self.max_jobs,
                self.ttl_seconds,
                self.job_seconds,
                self.metadata_seconds,
                self.request_seconds,
                self.cutout_workers,
                self.max_download_bytes,
                self.max_cache_bytes,
            )
            <= 0
        ):
            raise ValueError("Resource limits must be positive")
        if (
            self.max_cache_bytes < self.max_download_bytes
            or not 0 < self.spectral_tolerance <= 0.5
        ):
            raise ValueError("Invalid storage or spectral tolerance limit")

    @classmethod
    def from_env(cls):
        return cls(
            cache_dir=Path(
                os.environ.get("PLANETX_CACHE_DIR", str(ROOT / ".cache"))
            ).resolve(),
            origins=tuple(
                s.strip()
                for s in os.environ.get(
                    "PLANETX_CORS_ORIGINS",
                    "http://127.0.0.1:3000,http://localhost:3000",
                ).split(",")
                if s.strip()
            ),
        )
