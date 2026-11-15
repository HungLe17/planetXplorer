import { expect, test, type Locator, type Page } from "@playwright/test";
import { catalogPosition, projectMarker, type CatalogObject } from "../src/lib/known-objects";

const field = {ra_deg: 0, dec_deg: 0, fov_arcsec: 30};
const pixelDegrees = 6.14 / 3600;
const onePixelEast = Math.atan(pixelDegrees * Math.PI / 180) * 180 / Math.PI;
const grid = {CRVAL1: 0, CRVAL2: 0, CRPIX1: 3, CRPIX2: 3, CDELT1: -pixelDegrees, CDELT2: pixelDegrees};
const star: CatalogObject = {
  id: "test-star-18", name: "Test star", type: "Star", source: "Gaia DR3", sources: ["Gaia DR3"],
  ra_deg: onePixelEast, dec_deg: 0, epoch_jyear: 2016, pmra_masyr: null, pmdec_masyr: null, aliases: [],
};

test("catalog projection uses FITS pixel centers, wraps around RA zero, and honors a rotated grid", () => {
  const west = projectMarker(field, grid, 5, 5, 360 - onePixelEast, 0)!;
  expect(west.u).toBeCloseTo(0.7, 9);
  expect(west.v).toBeCloseTo(0.5, 9);
  const north = projectMarker(field, grid, 5, 5, 0, onePixelEast)!;
  expect(north.v).toBeCloseTo(0.3, 9);
  const rotation = {...grid, CD1_1: 0, CD1_2: pixelDegrees, CD2_1: pixelDegrees, CD2_2: 0};
  expect(projectMarker(field, rotation, 5, 5, onePixelEast, 0)!.v).toBeCloseTo(0.3, 9);
  expect(projectMarker(field, {...grid, CRPIX1: 2}, 5, 5, 0, 0)!.u).toBeCloseTo(0.3, 9);
  expect(projectMarker(field, grid, 5, 5, 180, 0)).toBeNull();
  expect(projectMarker(field, grid, 5, 5, 5 * onePixelEast, 0)).toBeNull();
});

test("Barnard’s Star agrees with two independent Astropy epochs, while missing proper motion preserves the catalog epoch", () => {
  // Gaia DR3 4472832130942575872, J2016.0. Reference positions from Astropy
  // SkyCoord.apply_space_motion with pm_ra_cosdec and without radial velocity.
  const barnard = {...star, ra_deg: 269.448502525, dec_deg: 4.7394200511,
    pmra_masyr: -801.55098, pmdec_masyr: 10362.39421};
  const epochs = [
    ["2025-08-15T00:00:00Z", 269.44635329261456, 4.767109056446654],
    ["2026-08-15T00:00:00Z", 269.44613000975176, 4.769985527619913],
  ] as const;
  for (const [date, ra, dec] of epochs) {
    const actual = catalogPosition(barnard, date);
    expect(actual.ra_deg).toBeCloseTo(ra, 6);
    expect(actual.dec_deg).toBeCloseTo(dec, 6);
  }
  expect(catalogPosition(star, epochs[0][0])).toMatchObject({
    ra_deg: star.ra_deg, dec_deg: star.dec_deg, epoch: "Catalog position · J2016",
  });
});

const dates = ["2025-07-01", "2025-07-02", "2026-01-02"];
const starts = dates.map(d => d + "T00:00:00Z");
const midpoints = dates.map(d => d + "T00:00:50Z");

async function openField(page: Page) {
  await page.setViewportSize({width: 1600, height: 950});
  const frames = dates.map((_, i) => ({
    id: "f" + i, observation_id: "o" + i, observed_at: starts[i], midpoint_utc: midpoints[i],
    detector: "D1", wavelength_um: 0.96 + i * 0.01, visit_id: i < 2 ? "first" : "last",
    url: "/api/assets/objects/f" + i + ".png", pixels: "f" + i + ".bin",
  }));
  const visits = [
    {id: "first", start_utc: starts[0], end_utc: starts[1], observation_ids: ["o0", "o1"]},
    {id: "last", start_utc: starts[2], end_utc: starts[2], observation_ids: ["o2"]},
  ].map(item => ({...item, status: "complete", issues: []}));
  const observations = frames.map(f => ({...f, id: f.observation_id, release: "DR1", status: "ready", frame_id: f.id}));
  await page.route("**/api/presets", r => r.fulfill({json: {presets: []}}));
  await page.route("**/api/jobs", r => r.fulfill({status: 202, json: {job_id: "objects"}}));
  await page.route("**/api/jobs/objects", r => r.fulfill({json: {status: "complete", manifest: {
    frames, visits, observations, processing: {output_shape: [5, 5], grid_header: grid},
  }}}));
  await page.route("**/api/assets/objects/*.bin", r => r.fulfill({
    body: Buffer.from(Float32Array.from({length: 25}, (_, i) => 1 + i).buffer),
  }));
  // The hosted atlas is external. The test checks its public embed URL and field.
  await page.route("https://aladin.cds.unistra.fr/AladinLite/**", r =>
    r.fulfill({contentType: "text/html", body: "<title>Aladin fixture</title>"}));
  const bands = encodeURIComponent(JSON.stringify({detectors: ["D1"]}));
  await page.goto("/explore?ra=0&dec=0&fov=30&bands=" + bands);
  await expect(page.locator(".image-readout")).toContainText("Visit composite");
}

const fetched = "2026-01-02T12:00:00Z";
function catalog() {
  return {objects: [star, {...star, id: "off-field", ra_deg: 11}], fetched_at: fetched, warnings: []};
}

async function coloredPixels(canvas: Locator, x: number, y: number) {
  return canvas.evaluate((element, p) => {
    const canvas = element as HTMLCanvasElement, box = canvas.getBoundingClientRect();
    const ratio = canvas.width / box.width;
    const pixels = canvas.getContext("2d")!.getImageData(
      Math.round((p.x - box.x - 9) * ratio), Math.round((p.y - box.y - 9) * ratio),
      Math.ceil(18 * ratio), Math.ceil(18 * ratio),
    ).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      // The intensity image is greyscale. Only a stellar marker is cyan.
      if (pixels[i + 1] > pixels[i] + 35 && pixels[i + 2] > pixels[i] + 45) count++;
    }
    return count;
  }, {x, y});
}

test("Aladin and known objects are opt-in, and circles remain selectable after zoom and right-drag pan", async ({page}) => {
  const calls: unknown[] = [];
  await page.route("**/api/known-objects/catalog", r => {
    calls.push(r.request().postDataJSON());
    return r.fulfill({json: catalog()});
  });
  await page.route("**/api/known-objects/moving", r =>
    r.fulfill({json: {objects: [], fetched_at: fetched, warnings: []}}));
  await openField(page);
  const panel = page.getByRole("complementary", {name: "Aladin and known objects"});
  const toggle = page.getByRole("button", {name: "Known objects", exact: true});
  await expect(panel).toHaveCount(0);
  expect(calls).toEqual([]);
  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(/1 positions? on image/);
  expect(calls).toEqual([{...field, start_utc: starts[0], end_utc: starts[2]}]);
  const atlas = new URL((await panel.locator("iframe").getAttribute("src"))!);
  expect(atlas.origin).toBe("https://aladin.cds.unistra.fr");
  expect(atlas.searchParams.get("ra")).toBe("0");
  expect(atlas.searchParams.get("dec")).toBe("0");
  expect(Number(atlas.searchParams.get("fov"))).toBeCloseTo(30 / 3600, 9);
  const canvas = page.locator("canvas").first();
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const size = Math.min(box.width, box.height) * 0.94;
  const x = cx - 0.2 * size;
  await expect.poll(() => coloredPixels(canvas, x, cy)).toBeGreaterThan(8);
  await page.mouse.click(x, cy);
  const selector = panel.getByLabel("Object on image");
  await expect(selector).toHaveValue(star.id);
  await expect(panel.locator(".object-info")).toContainText("Catalog position · J2016");
  await selector.selectOption("");
  await page.getByRole("button", {name: "Zoom in", exact: true}).click();
  await expect(page.getByLabel("Viewport zoom", {exact: true})).toHaveText("125%");
  // Pan the narrower axis, which has unambiguously positive travel at this scale.
  const dx = box.width < box.height ? 12 : 0, dy = box.width < box.height ? 0 : 12;
  await page.mouse.move(cx, cy);
  await page.mouse.down({button: "right"});
  await page.mouse.move(cx + dx, cy + dy, {steps: 4});
  await page.mouse.up({button: "right"});
  const scaledX = cx - 0.2 * size * 1.25 + dx, scaledY = cy + dy;
  await expect.poll(() => coloredPixels(canvas, scaledX, scaledY)).toBeGreaterThan(8);
  await page.mouse.click(scaledX, scaledY);
  await expect(selector).toHaveValue(star.id);
  await page.mouse.click(cx + dx, scaledY + 0.2 * size * 1.25);
  await expect(page.getByText("Pixel (3, 4)", {exact: true})).toBeVisible();
  await panel.getByRole("button", {name: "Close known objects"}).click();
  await expect(panel).toHaveCount(0);
});

test("composites use distinct exposure midpoints and a late prior cycle cannot add stale moving circles", async ({page}) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requests: string[] = [];
  await page.route("**/api/known-objects/catalog", r => r.fulfill({json: catalog()}));
  await page.route("**/api/known-objects/moving", async r => {
    const {midpoint_utc} = r.request().postDataJSON();
    requests.push(midpoint_utc);
    if (midpoint_utc === midpoints[1] && requests.filter(t => t === midpoint_utc).length === 1) await held;
    await r.fulfill({json: {
      midpoint_utc, objects: [{id: "asteroid42", name: "Tracking target", type: "Asteroid", ra_deg: 0, dec_deg: 0}],
      warnings: [], fetched_at: fetched,
    }});
  });
  await openField(page);
  await page.getByRole("button", {name: "Known objects", exact: true}).click();
  const panel = page.getByRole("complementary", {name: "Aladin and known objects"});
  await panel.getByRole("checkbox", {name: "Asteroids and comets"}).check();
  await expect.poll(() => requests).toEqual(midpoints.slice(0, 2));
  const options = panel.getByLabel("Object on image").locator("option");
  await expect(options.filter({hasText: midpoints[0]})).toHaveCount(1);
  await page.getByRole("button", {name: "Next cycle", exact: true}).click();
  await expect(options.filter({hasText: midpoints[2]})).toHaveCount(1);
  release();
  await expect(options.filter({hasText: midpoints[0]})).toHaveCount(0);
  await expect(options.filter({hasText: midpoints[1]})).toHaveCount(0);
  await page.getByRole("button", {name: "Previous cycle", exact: true}).click();
  await expect(options.filter({hasText: midpoints[0]})).toHaveCount(1);
  await expect(options.filter({hasText: midpoints[1]})).toHaveCount(1);
  await expect(options.filter({hasText: midpoints[2]})).toHaveCount(0);
  expect(requests.filter(t => t === midpoints[0])).toHaveLength(1);
  expect(requests.filter(t => t === midpoints[2])).toHaveLength(1);
});
