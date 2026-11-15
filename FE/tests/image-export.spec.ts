import { expect, test, type Page } from "@playwright/test";
import { newMap } from "../src/lib/imaging";

async function openMap(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const frames = ["2025-01-01", "2026-01-01"].map((date, i) => ({
    id: "export-" + i, observation_id: "export-" + i, detector: "D1",
    observed_at: date + "T00:00:00Z", nominal_channel: 13, wavelength_um: 1,
    processing_version: "v1", sequence_id: "matched", visit_id: "cycle-" + i,
    pixels: i + ".bin", url: "/api/assets/export/" + i + ".png",
  }));
  await page.route("**/api/presets", r => r.fulfill({ json: { presets: [] } }));
  await page.route("**/api/jobs", r => r.fulfill({ json: { job_id: "export" } }));
  await page.route("**/api/jobs/export", r => r.fulfill({ json: {
    status: "complete", manifest: {
      frames, processing: { output_shape: [8, 16] },
      visits: frames.map(f => ({ id: f.visit_id, kind: "cycle", status: "complete", issues: [],
        start_utc: f.observed_at, end_utc: f.observed_at, observation_ids: [f.observation_id] })),
      sequences: [{ id: "matched", detector: "D1", wavelength_um: 1,
        processing_version: "v1", frame_ids: frames.map(f => f.id), stretch: {} }],
    },
  } }));
  await page.route("**/api/assets/export/*.bin", r => r.fulfill({
    contentType: "application/octet-stream",
    body: Buffer.from(new Float32Array(128).fill(r.request().url().endsWith("0.bin") ? 100 : 50).buffer),
  }));
  await page.route("**/api/assets/export/*.png", r => r.fulfill({
    contentType: "image/png", body: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"),
  }));
  const maps = ["Red", "Blue"].map((name, i) => ({ ...newMap(name, name),
    operands: { D1: 1 }, stretch: "linear", low: "0", high: "100",
    stops: [{ at: 0, color: "#000000" }, { at: 1, color: i ? "#0000ff" : "#ff0000" }],
  }));
  await page.goto("/explore?ra=330&dec=-50&view=" + encodeURIComponent(JSON.stringify({ maps, legend: true, coords: true })));
  await expect(page.getByRole("group", { name: "Displayed color scale" }).locator(".scale-ramp")).toHaveCount(2);
  await expect.poll(() => page.locator("canvas").evaluate((canvas: HTMLCanvasElement) =>
    Array.from(canvas.getContext("2d")!.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data),
  )).toEqual([255, 0, 255, 255]);
}

async function downloadImage(page: Page, type: "PNG" | "GIF") {
  const [download] = await Promise.all([
    page.waitForEvent("download"), page.getByRole("button", { name: type, exact: true }).click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return { bytes: Buffer.concat(chunks), download };
}

async function inspectImage(page: Page, bytes: Buffer, type = "png") {
  return page.evaluate(async ({ encoded, type }) => {
    const image = new Image();
    image.src = `data:image/${type};base64,` + encoded;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    const { width, height } = canvas;
    const data = ctx.getImageData(0, 0, width, height).data;
    const pixel = (x: number, y: number) => Array.from(data.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
    const magenta = (p: number[]) => p[0] > 245 && p[1] < 10 && p[2] > 245 && p[3] === 255;
    let mapHeight = 0;
    while (mapHeight < height && magenta(pixel(0, mapHeight))) mapHeight++;
    const redRows: number[] = [], blueRows: number[] = [];
    for (let y = mapHeight; y < height; y++) {
      const p = pixel(width - 1, y);
      if (p[0] > 240 && p[1] < 10 && p[2] < 10) redRows.push(y);
      if (p[2] > 240 && p[0] < 10 && p[1] < 10) blueRows.push(y);
    }
    const firstRamp = Math.min(...redRows, ...blueRows, height);
    let coordinatePixels = 0;
    for (let y = mapHeight; y < firstRamp; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i] > 220 && data[i + 1] > 220 && data[i + 2] > 220) coordinatePixels++;
      }
    return { width, height, mapHeight, coordinatePixels, redRows: redRows.length, blueRows: blueRows.length,
      corners: [pixel(0, 0), pixel(width - 1, 0), pixel(0, mapHeight - 1), pixel(width - 1, mapHeight - 1)],
      rampStarts: [redRows[0], blueRows[0]].filter(y => y !== undefined).map(y => pixel(0, y)),
    };
  }, { encoded: bytes.toString("base64"), type });
}

test("PNG export enlarges the full map and places coordinates above image-width color scales", async ({ page }, info) => {
  await openMap(page);
  const { bytes, download } = await downloadImage(page, "PNG");
  await download.saveAs(info.outputPath("map-export.png"));
  const image = await inspectImage(page, bytes);
  expect(image.width).toBeGreaterThanOrEqual(1024);
  expect(image.mapHeight).toBe(image.width / 2);
  expect(image.corners).toEqual(Array(4).fill([255, 0, 255, 255]));
  expect(image.coordinatePixels).toBeGreaterThan(100);
  expect(image.redRows).toBeGreaterThan(10);
  expect(image.blueRows).toBeGreaterThan(10);
  expect(image.rampStarts).toEqual(Array(2).fill([0, 0, 0, 255]));
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.setViewportSize({ width: 1366, height: 768 });
  const resized = await inspectImage(page, (await downloadImage(page, "PNG")).bytes);
  expect(resized).toEqual(image);
});

test("PNG footer follows the coordinate and color-scale switches without covering the map", async ({ page }) => {
  await openMap(page);
  for (const [coords, legend] of [[true, false], [false, true], [false, false]]) {
    await page.getByRole("checkbox", { name: "Coordinates", exact: true }).setChecked(coords);
    await page.getByRole("checkbox", { name: "Color scale", exact: true }).setChecked(legend);
    const image = await inspectImage(page, (await downloadImage(page, "PNG")).bytes);
    expect(image.mapHeight).toBe(image.width / 2);
    expect(image.coordinatePixels > 100).toBe(coords);
    expect(image.redRows > 10 && image.blueRows > 10).toBe(legend);
    expect(image.height > image.mapHeight).toBe(coords || legend);
  }
});

test("GIF export shares the enlarged map and aligned annotation layout across two cycles", async ({ page }, info) => {
  await openMap(page);
  await expect(page.getByRole("button", { name: "GIF", exact: true })).toBeEnabled();
  const png = await inspectImage(page, (await downloadImage(page, "PNG")).bytes);
  const { bytes, download } = await downloadImage(page, "GIF");
  await download.saveAs(info.outputPath("map-export.gif"));
  expect(bytes.subarray(0, 6).toString()).toBe("GIF89a");
  const gif = await inspectImage(page, bytes, "gif");
  expect([gif.width, gif.height, gif.mapHeight]).toEqual([png.width, png.height, png.mapHeight]);
  expect(gif.coordinatePixels).toBeGreaterThan(100);
  expect(gif.redRows).toBeGreaterThan(10);
  expect(gif.blueRows).toBeGreaterThan(10);
});
