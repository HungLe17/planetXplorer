# planetXplorer

Explore a sky field across SPHEREx observations. Start with a prepared target, search by coordinates and dates, inspect a wavelength-matched sequence, or combine measured images and save a location for later review.

## Run the prototype

1. From [BE](BE/readme.md), install the pinned Python dependencies and start FastAPI on port 8000 with one Uvicorn worker. The backend serves the prepared examples locally. Live searches require archive connectivity.
2. From [FE](FE/readme.md), install the locked Node dependencies with npm ci, set NEXT_PUBLIC_API_BASE_URL to the backend origin, and run npm run dev. Open http://127.0.0.1:3000/explore.
3. Open a preset for a prepared view, or submit a field for a fresh search. Use the observations dock to load more records. Use Browse for chronological inspection and Matched for comparable exposures. Numeric display tools and exports use the assets available for the selected field.

The optional DESI survey index has its own [installation instructions](BE/readme.md#api). SPHEREx searches and the other surveys work independently. The backend README also covers separate deployment, CORS and persistent cache configuration.
