"""Install the six DR1 v1.5 galaxy catalog indices once per API deployment."""

import ssl
import sys
from pathlib import Path

import httpx
import truststore

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.config import Settings
from app.desi import CATALOGS, prepare_catalog

if __name__ == "__main__":
    folder = Settings.from_env().desi_dir
    with httpx.Client(verify=truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT), timeout=60) as client:
        for catalog in CATALOGS:
            print(catalog, flush=True)
            prepare_catalog(folder, catalog, client)
