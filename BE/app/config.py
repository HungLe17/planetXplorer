import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    desi_dir: Path = ROOT / ".cache-surveys" / "desi-dr1-v1.5"
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
    max_frames: int = 512
    batch_size: int = 8
    metadata_limit: int = 2000
    spectral_tolerance: float = (
        0.5  # maximum separation as a fraction of narrower bandwidth
    )
    origins: tuple[str, ...] = ("http://127.0.0.1:3000", "http://localhost:3000")

    def __post_init__(self):
        if not 2 <= self.max_candidates <= 48 or self.max_candidates % 2:
            raise ValueError("Live candidate limit must be even and between 2 and 48")
        if not (1 <= self.max_frames <= 512 and 1 <= self.batch_size <= 8):
            raise ValueError("Frame memory limit must be 1-512; batch size must be 1-8")
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
            desi_dir=Path(os.environ.get("PLANETX_DESI_DIR", str(ROOT / ".cache-surveys" / "desi-dr1-v1.5"))).resolve(),
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
