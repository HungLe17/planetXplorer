# planetXplorer

Explore a sky field across SPHEREx observations. Start with a prepared target, search by coordinates and dates, inspect a wavelength-matched sequence, or combine measured images and save a location for later review.

## Run the prototype

1. From [BE](BE/readme.md), install the pinned Python dependencies and start FastAPI on port 8000 with one Uvicorn worker. The backend serves the prepared examples locally. Live searches require archive connectivity.
2. From [FE](FE/readme.md), install the locked Node dependencies with npm ci, set NEXT_PUBLIC_API_BASE_URL to the backend origin, and run npm run dev. Open http://127.0.0.1:3000/explore.
3. Open a preset for a prepared view, or submit a field for a fresh search. Visits groups the field's exposures for map display. Browse shows individual exposures, and Matched filters the timeline to comparable exposures. Use the observations dock to inspect individual catalog records.

The optional DESI survey index has its own [installation instructions](BE/readme.md#api). SPHEREx searches and the other surveys work independently. The backend README also covers separate deployment, CORS and persistent cache configuration.

## Windows workspace launcher

For this checkout, install frontend packages once with `npm ci` in `FE`. Then follow the [backend installation](BE/readme.md#run-locally) using a Python environment that supports the pinned packages. The launcher checks `BE\.venv\Scripts\python.exe` first and the outer workspace's `.venv\Scripts\python.exe` second. To reuse an environment elsewhere, set `$env:PLANETX_PYTHON` to its Python executable. The launcher checks that this interpreter can import the backend before restarting any servers.

From the outer workspace, double-click `Open-PlanetXplorer.cmd` (or run `.\Open-PlanetXplorer.cmd`). It closes previous servers for this checkout, starts the UI on port 3000 and the API on port 8000, waits for readiness, and opens `http://localhost:3000/explore`. Run `Close-PlanetXplorer.cmd` to stop this checkout's servers. Unrelated processes occupying these ports are left running and reported as errors. Server logs are saved in the outer workspace's `.planetx-local` directory. The shared helper also supports `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\PlanetXplorer-local.ps1 -Action Open -NoBrowser` for starting without opening a browser.

For fast source inspection, scope searches to `FE/src`, `FE/tests`, `BE/app`, `BE/scripts` and `BE/tests`. A frontend-only build needs the `FE` source, its package manifest and lockfile, and the shared SPHEREx channel table at `BE/app/data/spherex-spectra.json` in the build context. Run `npm ci` to restore the dependencies. [Channel table and provenance](BE/app/data/README.md)
