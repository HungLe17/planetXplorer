"""Local archive fixture for the live-search browser test. Full cutouts use Archive.fetch."""
import socket
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Lock

import httpx
import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.archive import Archive, Observation
from app.config import Settings
from app.main import create_app
from app.pipeline import Pipeline, decode
from app.schemas import Query


class DelayedArchive(Archive):
    def __init__(self, settings):
        super().__init__(settings)
        fixture = Path(__file__).parent / "fixtures" / "wise-d6.fits"
        self.fits = fixture.read_bytes()
        self.records = [
            Observation(name, f"https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/{name}.fits",
                        60800 + i * 17, "D3" if name == "other-detector" else "D6", "DR1")
            for i, name in enumerate(["match-a", "match-b", "match-c", "match-d", "match-e",
                                      "match-f", "other-subband", "other-detector", "unknown"])
        ]
        calibrated = decode(fixture, self.records[0], Query(ra_deg=133.795129, dec_deg=-7.245147), "fixture")
        assert calibrated.nominal_channel == 16
        self.calibration = dict(nominal_channel=calibrated.nominal_channel, wavelength_um=calibrated.wavelengths[0], bandwidth_um=calibrated.bandwidths[0],
                                processing_version=calibrated.version)
        self.lock = Lock()
        self.probes = []
        self.requests = []
        self.active = self.peak = 0
        self.release = Event()
        self.first_slot = Event()
        self.finish_discovery = Event()
        self.catalog_done = False
        self.client.close()
        self.client = httpx.Client(transport=httpx.MockTransport(self.cutout))

    def search(self, query, deadline, *, on_candidate=None, timing=None):
        if on_candidate:
            time.sleep(.10)
            on_candidate(self.records[0])
            self.finish_discovery.wait(12)
            self.catalog_done = True
        return self.records, []

    def probe_spectral(self, obs, query, deadline):
        return self.spectral_at(obs.uri, query, deadline)

    def spectral_at(self, uri, query, deadline):
        info = self.cached_spectral(uri, query)
        if info:
            return info
        with self.lock:
            self.probes.append(Path(uri).stem)
        time.sleep(.03)
        if uri.endswith("unknown.fits"):
            return None
        info = dict(self.calibration)
        if uri.endswith("other-subband.fits"):
            # Same measured wavelength in the D6-16/17 overlap, on a different
            # nominal detector stripe. A wavelength-only filter would leak it.
            info["nominal_channel"] = 17
        with self.spectral_lock:
            self.spectral_index[(uri, query.ra_deg, query.dec_deg)] = info
        return info

    def cutout(self, request):
        assert "size" in request.url.params
        identity = Path(request.url.path).stem
        with self.lock:
            self.requests.append(identity)
            second_request = len(self.requests) == 2
            self.active += 1
            self.peak = max(self.peak, self.active)
        try:
            if identity != "match-a":
                gate = self.first_slot if second_request else self.release
                assert gate.wait(35), "Browser did not release active transfers"
            time.sleep(.14)
            return httpx.Response(200, content=self.fits)
        finally:
            with self.lock:
                self.active -= 1


def main():
    with TemporaryDirectory() as temp, socket.socket() as sock:
        settings = Settings(cache_dir=Path(temp), demo_dir=Path(temp), max_candidates=4, batch_size=8)
        archive = DelayedArchive(settings)
        app = create_app(settings, Pipeline(settings, archive))
        server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))

        @app.get("/fixture")
        def state():
            with archive.lock:
                return dict(requests=list(archive.requests), probes=list(archive.probes), active=archive.active, peak=archive.peak,
                            catalog_done=archive.catalog_done, wavelength=archive.calibration["wavelength_um"])

        @app.post("/fixture/release")
        def release():
            archive.first_slot.set()
            archive.release.set()

        @app.post("/fixture/next-slot")
        def next_slot():
            archive.first_slot.set()

        @app.post("/fixture/finish-discovery")
        def finish_discovery():
            archive.finish_discovery.set()

        @app.post("/fixture/stop")
        def stop():
            archive.finish_discovery.set()
            archive.first_slot.set()
            archive.release.set()
            server.should_exit = True

        sock.bind(("127.0.0.1", 0))
        sock.listen()
        print(f"ARCHIVE_PORT={sock.getsockname()[1]}", flush=True)
        try:
            server.run(sockets=[sock])
        finally:
            archive.close()


if __name__ == "__main__":
    main()
