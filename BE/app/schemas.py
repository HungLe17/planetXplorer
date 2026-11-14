from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Query(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    fov_arcsec: float = Field(default=300, ge=60, le=1800)
    live: bool = False
    ra_deg: float = Field(ge=0, lt=360)
    dec_deg: float = Field(ge=-90, le=90)
    start_utc: datetime | None = None
    end_utc: datetime | None = None

    @field_validator("start_utc", "end_utc")
    @classmethod
    def utc(cls, value):
        if value is not None:
            if value.tzinfo is None:
                raise ValueError("Dates must include a timezone, preferably UTC (Z)")
            if not 1900 <= value.year <= 2200:
                raise ValueError("Date must be between 1900 and 2200")
            return value.astimezone(UTC)
        return value

    @model_validator(mode="after")
    def ordered(self):
        if self.start_utc and self.end_utc and self.start_utc > self.end_utc:
            raise ValueError("start_utc must not follow end_utc")
        return self


class Frame(BaseModel):
    id: str
    url: str
    observation_id: str
    observed_at: str
    detector: str
    wavelength_um: float
    bandwidth_um: float
    release: str
    source_url: str
    warnings: list[str] = Field(default_factory=list)
    units: str = "MJy/sr"
    processing_version: str = ""
    pixels: str | None = None
    channel: str = ""
    exposure_flags: dict[str, str | int | float] = Field(default_factory=dict)
    flag_names: dict[int, str] = Field(default_factory=dict)
    mask_fraction: float = 0


class Manifest(BaseModel):
    frames: list[Frame] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    retrieved_at: str
    cached: bool = False
    grid: str = "ICRS TAN; north up, east left; 6.14 arcsec/pixel"
    stretch: str = "asinh (one shared intensity scale)"
    query: Query
    processing: dict = Field(default_factory=dict)
    omissions: list[dict] = Field(default_factory=list)


class Job(BaseModel):
    job_id: str
    status: Literal[
        "queued", "running", "complete", "partial", "failed", "cancelling", "cancelled"
    ] = "queued"
    stage: str = "queued"
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None
    manifest: Manifest | None = None
    created_at: str
    expires_at: str


class Submitted(BaseModel):
    job_id: str
