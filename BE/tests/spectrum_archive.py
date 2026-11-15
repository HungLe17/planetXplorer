"""Offline archive for browser tests of wavelength-first requests across survey cycles."""

import socket
import sys
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock

import httpx
import uvicorn
from astropy.io import fits
from astropy.time import Time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.archive import Archive, Observation
from app.config import Settings
from app.main import create_app
from app.pipeline import Pipeline, decode
from app.schemas import Query


class SpectrumArchive(Archive):
    def __init__(self, settings, fail):
        super().__init__(settings)
        self.fail = fail
        self.lock = Lock()
        self.events = []
        self.records = []
        self.payloads = {}
        self.calibrations = {}
        for epoch, date in (("may25", "2025-05-10"), ("nov25", "2025-11-10"), ("may26", "2026-05-10")):
            mjd = Time(date).mjd
            for i, (label, band) in enumerate([("a", "D6"), ("b", "D6")] + [(f"d{n}", f"D{n}") for n in range(1, 6)]):
                name = f"{label}-{epoch}"
                uri = f"https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/{name}.fits"
                self.records.append(Observation(name, uri, mjd + i / 100, band, "DR1"))
        fixture = Path(__file__).parent / "fixtures" / "wise-d6.fits"
        field = Query(ra_deg=133.795129, dec_deg=-7.245147, fov_arcsec=30)
        for key, shift, nominal_channel in (("a", -0.2, 11), ("b", 0, 16)):
            path = settings.cache_dir / f"{key}.fits"
            with fits.open(fixture, memmap=False) as hdus:
                hdus["WCS-WAVE"].data["VALUES"][..., 0] += shift
                if key == "a":
                    # Place the field center at native detector pixel (380, 779),
                    # within the mock first spectrum's D6-11 stripe.
                    hdus["IMAGE"].header["CRPIX2A"] = -754
                hdus.writeto(path)
            product = decode(path, self.records[0], field, "fixture")
            assert product.nominal_channel == nominal_channel
            self.calibrations[key] = dict(nominal_channel=product.nominal_channel, wavelength_um=product.wavelengths[0],
                                          bandwidth_um=product.bandwidths[0], processing_version=product.version)
            self.payloads[key] = path.read_bytes()
        self.client.close()
        self.client = httpx.Client(transport=httpx.MockTransport(self.cutout))

    def search(self, query, deadline, *, on_candidate=None, timing=None):
        return self.records, []

    def probe_spectral(self, obs, query, deadline):
        return self.spectral_at(obs.uri, query, deadline)

    def spectral_at(self, uri, query, deadline):
        key = Path(uri).stem.split("-")[0]
        info = self.calibrations.get(key)
        if info:
            with self.spectral_lock:
                self.spectral_index[(uri, query.ra_deg, query.dec_deg)] = info
        return info

    def cutout(self, request):
        assert "size" in request.url.params
        name = Path(request.url.path).stem
        status = 404 if self.fail and name == "a-may26" else 200
        with self.lock:
            self.events.append(("start", name))
        time.sleep(0.12)
        with self.lock:
            self.events.append(("done" if status == 200 else "failed", name))
        return httpx.Response(status, content=self.payloads.get(name.split("-")[0], b""))


def main():
    with TemporaryDirectory() as temp, socket.socket() as sock:
        settings = Settings(cache_dir=Path(temp), demo_dir=Path(temp), max_candidates=2, batch_size=2)
        archive = SpectrumArchive(settings, "--fail" in sys.argv)
        app = create_app(settings, Pipeline(settings, archive))
        server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))

        @app.get("/fixture")
        def state():
            with archive.lock:
                return {"events": list(archive.events)}

        @app.post("/fixture/stop")
        def stop():
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
