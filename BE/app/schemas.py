from datetime import UTC, datetime
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


Detector = Literal["D1", "D2", "D3", "D4", "D5", "D6"]
BandMatch = Literal["matched", "excluded", "unknown", "unavailable"]

def nominal_parameters(label: str):
    match = re.fullmatch(r"(D[1-6])-(0[1-9]|1[0-7])", label)
    return (match[1], int(match[2])) if match else None


def channel_parameters(channel: str):
    # Older saved views contain different encodings of the wavelength unit.
    match = re.fullmatch(r"(D[1-6])\s+([0-9]+(?:\.[0-9]+)?)\s+[^()]+\s+\(([^()]+)\)", channel)
    return (match[1], float(match[2]), match[3]) if match else None


def calibrated_channels(groups):
    for detector, channels in groups.items():
        if not channels or len(channels) > 512:
            raise ValueError("Channel selection must contain 1 to 512 entries")
        for channel in channels:
            if nominal := nominal_parameters(channel):
                if nominal[0] != detector:
                    raise ValueError("Nominal spectrum belongs to another detector")
                continue
            parsed = channel_parameters(channel) if len(channel) <= 160 else None
            if not parsed or parsed[0] != detector or not 0 < parsed[1] < 100:
                raise ValueError("Invalid calibrated detector channel")
    return groups


class Query(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    live: bool = False
    ra_deg: float = Field(ge=0, lt=360)
    dec_deg: float = Field(ge=-90, le=90)
    fov_arcsec: float = Field(default=300, ge=30, le=1800)
    start_utc: datetime | None = None
    end_utc: datetime | None = None
    min_separation_days: float | None = Field(default=None, gt=0)
    detectors: list[Detector] | None = Field(None, min_length=1, max_length=6)
    channels: dict[Detector, list[str]] = Field(default_factory=dict)

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
        if self.detectors is not None:
            self.detectors = sorted(set(self.detectors))
        elif self.channels:
            # A subband-only request explicitly names its detectors.
            self.detectors = sorted(self.channels)
        for detector in calibrated_channels(self.channels):
            if self.detectors is not None and detector not in self.detectors:
                raise ValueError("Channel selector belongs to an unrequested detector")
        return self

    def band_match(self, detector, wavelength=None, bandwidth=None, version=None, nominal_channel=None) -> BandMatch:
        if self.detectors is not None and detector not in self.detectors:
            return "excluded"
        if not self.channels.get(detector):
            return "excluded" if self.detectors and nominal_channel in (0, 18) else "matched"
        unresolved = False
        for label in self.channels[detector]:
            if nominal := nominal_parameters(label):
                if nominal_channel is None:
                    unresolved = True
                elif nominal[1] == nominal_channel:
                    return "matched"
            elif wavelength is None or not bandwidth or version is None:
                unresolved = True
            elif (empirical := channel_parameters(label)) and empirical[2] == version and abs(
                empirical[1] - wavelength
            ) <= bandwidth / 2 + 0.0000005:
                return "matched"
        return "unknown" if unresolved else "excluded"


class Frame(BaseModel):
    id: str
    url: str
    observation_id: str
    observed_at: str
    midpoint_utc: str | None = None
    detector: str
    nominal_channel: int | None = Field(default=None, ge=0, le=18)
    wavelength_um: float
    bandwidth_um: float
    release: str
    source_url: str
    warnings: list[str] = Field(default_factory=list)
    units: str = "MJy/sr"
    processing_version: str = ""
    pixels: str | None = None
    quality: str | None = None
    spectral: str | None = None
    visit_id: str = ""
    channel: str = ""
    exposure_flags: dict[str, str | int | float] = Field(default_factory=dict)
    flag_names: dict[int, str] = Field(default_factory=dict)
    mask_fraction: float = 0
    sequence_id: str = ""
    match_wavelengths: list[float | None] = Field(default_factory=list)
    match_bandwidths: list[float | None] = Field(default_factory=list)


class ObservationRecord(BaseModel):
    id: str
    source_url: str
    observed_at: str
    detector: str
    nominal_channel: int | None = Field(default=None, ge=0, le=18)
    geometry_checked: bool = False
    release: str
    status: Literal["pending", "loading", "ready", "failed"] = "pending"
    reason: str | None = None
    selection: BandMatch = "matched"
    frame_id: str | None = None
    visit_id: str = ""
    channel: str | None = None
    wavelength_um: float | None = None
    bandwidth_um: float | None = None

    def band_match(self, query: Query) -> BandMatch:
        parsed = channel_parameters(self.channel) if self.channel else None
        return query.band_match(self.detector, self.wavelength_um, self.bandwidth_um,
                                parsed[2] if parsed else None, self.nominal_channel)

    def needs_spectral(self, query: Query):
        if self.band_match(query) == "unknown":
            return True
        if self.nominal_channel is not None:
            return False
        return not self.channel or (not query.channels.get(self.detector) and not self.geometry_checked)

    def set_spectral(self, info):
        if info.get("nominal_channel") is not None:
            self.nominal_channel = info["nominal_channel"]
        if info.get("wavelength_um") is None:
            return
        self.wavelength_um = info["wavelength_um"]
        self.bandwidth_um = info["bandwidth_um"]
        self.channel = f"{self.detector} {self.wavelength_um:.6f} µm ({info['processing_version']})"


class Visit(BaseModel):
    id: str
    start_utc: str
    end_utc: str
    observation_ids: list[str]
    kind: Literal["cycle", "supplemental"] = "cycle"
    status: Literal["pending", "complete", "invalid"]
    issues: list[str] = Field(default_factory=list)


class Sequence(BaseModel):
    id: str
    detector: str
    wavelength_um: float
    processing_version: str
    frame_ids: list[str] = Field(default_factory=list)
    stretch: dict = Field(default_factory=dict)


class LoadRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    observation_ids: list[str] = Field(default_factory=list, max_length=8)
    metadata_only: bool = False
    detector: Literal["D1", "D2", "D3", "D4", "D5", "D6"] | None = None
    channels: dict[Detector, list[str]] = Field(default_factory=dict)

    _validate_channels = field_validator("channels")(calibrated_channels)


class Manifest(BaseModel):
    frames: list[Frame] = Field(default_factory=list)
    observations: list[ObservationRecord] = Field(default_factory=list)
    sequences: list[Sequence] = Field(default_factory=list)
    visits: list[Visit] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    retrieved_at: str
    cached: bool = False
    discovery_complete: bool = False
    grid: str = "ICRS TAN; north up, east left; 6.14 arcsec/pixel"
    stretch: str = "asinh (fixed within each wavelength sequence)"
    query: Query
    processing: dict = Field(default_factory=dict)
    omissions: list[dict] = Field(default_factory=list)


class JobTiming(BaseModel):
    stage: str
    elapsed_ms: float
    duration_ms: float
    observation_id: str | None = None
    outcome: str = "ok"


class Job(BaseModel):
    job_id: str
    status: Literal[
        "queued", "running", "complete", "partial", "failed", "cancelling", "cancelled"
    ] = "queued"
    stage: str = "queued"
    warnings: list[str] = Field(default_factory=list)
    error: str | None = None
    manifest: Manifest | None = None
    timings: list[JobTiming] = Field(default_factory=list)
    created_at: str
    expires_at: str


class Submitted(BaseModel):
    job_id: str
