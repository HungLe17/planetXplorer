import { expect, test, type Page } from "@playwright/test";
import { newMap, type SpectralMap } from "../src/lib/imaging";
import type { Job, Manifest } from "../src/lib/types";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
function field(epochs = 2, supplemental = false) {
  const arrays: Record<string, number[]> = {};
  const frames = Array.from({ length: epochs }, (_, epoch) => [16, 17].map((channel, stripe) => {
    const id = `e${epoch}-s${channel}`;
    arrays[id] = [1, 2, 3, 4].map(v => v * (epoch + 1) * (stripe ? 10 : 1));
    return { id, observation_id: id, detector: "D6", nominal_channel: channel,
      channel: `D6 ${stripe ? "4.990000" : "4.960000"} µm (v1)`,
      observed_at: new Date(Date.UTC(2025, epoch * 6, 1)).toISOString(), visit_id: "epoch-" + epoch,
      processing_version: "v1", sequence_id: "stripe-" + channel,
      wavelength_um: stripe ? 4.99 : 4.96, bandwidth_um: 0.02,
      url: "/api/assets/map-modes/" + id + ".png", pixels: id + ".bin" };
  })).flat();
  const manifest: Manifest = { frames, processing: { output_shape: [2, 2] },
    visits: Array.from({ length: epochs }, (_, epoch) => ({ id: "epoch-" + epoch,
      kind: supplemental ? "supplemental" : "cycle", status: "complete", issues: [],
      start_utc: frames[epoch * 2].observed_at, end_utc: frames[epoch * 2].observed_at,
      observation_ids: frames.slice(epoch * 2, epoch * 2 + 2).map(f => f.id) })) };
  return { manifest, arrays };
}
async function open(page: Page, job: () => Job, arrays: Record<string, number[]>, maps?: SpectralMap[]) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/presets") return route.fulfill({ json: { presets: [] } });
    if (path === "/api/jobs") return route.fulfill({ json: { job_id: "map-modes" } });
    if (path === "/api/jobs/map-modes") return route.fulfill({ json: job() });
    if (path.endsWith(".bin")) {
      const id = path.split("/").at(-1)!.slice(0, -4);
      return route.fulfill({ body: Buffer.from(Float32Array.from(arrays[id]).buffer) });
    }
    if (path.endsWith(".png")) return route.fulfill({ body: png, contentType: "image/png" });
    return route.fulfill({ json: {} });
  });
  const params = new URLSearchParams({ ra: "5", dec: "2", fov: "30",
    bands: JSON.stringify({ detectors: ["D6"], channels: {} }) });
  if (maps) params.set("view", JSON.stringify({ maps }));
  await page.goto("/explore?" + params);
  await page.getByRole("checkbox", { name: "Color scale", exact: true }).check();
}
const legend = (page: Page) => page.getByRole("group", { name: "Displayed color scale", exact: true });

test("untouched default map sums every available spectrum as calibrated assets arrive", async ({ page }) => {
  const { manifest, arrays } = field();
  let complete = false;
  await open(page, () => ({ status: complete ? "complete" : "running", manifest: {
    ...manifest, frames: complete ? manifest.frames : manifest.frames.filter(f => f.nominal_channel === 16),
    processing: { ...manifest.processing, revision: complete ? 2 : 1 },
  } }), arrays);
  await expect(legend(page)).toContainText("Map 1 · 1.000 … 4.000 MJy/sr");
  complete = true;
  await expect(legend(page)).toContainText("Map 1 · 11.00 … 44.00 MJy/sr");
  const contributors = page.locator(".detail-group").filter({ has: page.getByRole("heading", { name: "Contributing exposures", exact: true }) });
  await expect(contributors).toContainText("4.960000");
  await expect(contributors).toContainText("4.990000");
});

test("editing default inputs freezes automatic choices when more spectra arrive", async ({ page }) => {
  const { manifest, arrays } = field();
  let complete = false;
  await open(page, () => ({ status: complete ? "complete" : "running", manifest: {
    ...manifest, frames: complete ? manifest.frames : manifest.frames.filter(f => f.nominal_channel === 16),
    processing: { ...manifest.processing, revision: complete ? 2 : 1 },
  } }), arrays);
  await expect(legend(page)).toContainText("1.000 … 4.000");
  await page.getByRole("button", { name: "Inputs", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Inputs for Map 1", exact: true });
  await editor.locator(".map-detector").nth(5).locator("summary").click();
  await editor.getByRole("button", { name: "Add D6-16", exact: true }).click();
  complete = true;
  await expect(editor.getByRole("button", { name: "Add D6-17", exact: true })).toBeVisible();
  await expect(editor.getByRole("button", { name: "Add D6-16", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(editor.getByRole("button", { name: "Add D6", exact: true })).toHaveAttribute("aria-pressed", "false");
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await expect(legend(page)).toContainText("Map 1 · 1.000 … 4.000 MJy/sr");
});

test("configured layers, colors, and stretches survive Visits Browse Matched and Subtract", async ({ page }) => {
  const { manifest, arrays } = field();
  const maps = ["Red layer", "Blue layer"].map((name, i) => ({ ...newMap(name, name),
    operands: { D6: 1 }, low: "0", high: "50", stretch: i ? "log" : "sqrt",
    stops: [{ at: 0, color: "#000000" }, { at: 1, color: i ? "#0000ff" : "#ff0000" }] }));
  await open(page, () => ({ status: "complete", manifest }), arrays, maps);
  for (const mode of ["Visits", "Browse", "Matched", "Subtract"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    await expect(page.getByRole("button", { name: mode, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(legend(page)).toContainText("Red layer");
    await expect(legend(page)).toContainText("Blue layer");
    await expect(legend(page)).toContainText("sqrt");
    await expect(legend(page)).toContainText("log");
    await expect.poll(() => page.locator(".sky-canvas canvas").evaluate((canvas: HTMLCanvasElement) => {
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i] > 20 && pixels[i + 1] === 0 && pixels[i + 2] > 20) return true;
      return false;
    })).toBe(true);
  }
  await page.getByRole("button", { name: "Browse", exact: true }).click();
  await page.locator(".map-stretch select").first().selectOption("linear");
  await expect(page.getByRole("button", { name: "Browse", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(legend(page)).toContainText("linear");
});

test("a numeric exposure excluded by every map stays blank instead of showing its raw PNG", async ({ page }) => {
  const { manifest, arrays } = field();
  await open(page, () => ({ status: "complete", manifest }), arrays,
    [{ ...newMap("other", "Other detector"), operands: { D1: 1 } }]);
  await page.getByRole("button", { name: "Browse", exact: true }).click();
  await expect(page.getByText("No configured map inputs apply to this exposure. Choose matching spectra in the map’s Inputs.", { exact: true })).toBeVisible();
  await expect(legend(page)).toHaveCount(0);
  await expect.poll(() => page.locator(".sky-canvas canvas").evaluate((canvas: HTMLCanvasElement) => {
    const rgba = canvas.getContext("2d")!.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    return Math.max(rgba[0], rgba[1], rgba[2]);
  })).toBeLessThan(40);
  await expect(page.getByRole("group", { name: "Displayed image", exact: true })).not.toContainText("PNG preview");
});

test("three supplemental Matched epochs can subtract without a formal observing cycle", async ({ page }) => {
  const { manifest, arrays } = field(3, true);
  await open(page, () => ({ status: "complete", manifest }), arrays);
  await page.getByRole("button", { name: "Matched", exact: true }).click();
  await expect(page.locator(".frame-counter")).toHaveText(/01\s*\/\s*03/);
  await page.getByRole("button", { name: "Subtract", exact: true }).click();
  await expect(page.getByRole("button", { name: "Subtract", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "Displayed image", exact: true })).toContainText("Cycle difference");
  await expect(page.getByLabel("Reference cycle").locator("option[value^=epoch-]")).toHaveCount(3);
  await expect(legend(page)).toContainText("Δ Map 1");
});

test("Matched maps omit unchecked peer spectra while keeping the selected spectrum", async ({ page }) => {
  const { manifest, arrays } = field();
  await open(page, () => ({ status: "complete", manifest }), arrays);
  await page.getByRole("button", { name: "Matched", exact: true }).click();
  await expect(legend(page)).toContainText("11.00 … 44.00");
  const cycle = page.getByRole("region", { name: "Cycle 1", exact: true });
  await cycle.locator(".cycle-disclosure").click();
  await cycle.getByRole("checkbox", { name: "Include e0-s17 in timeline", exact: true }).uncheck();
  await expect(legend(page)).toContainText("Map 1 · 1.000 … 4.000 MJy/sr");
  await expect(page.getByRole("button", { name: "Matched", exact: true })).toHaveAttribute("aria-pressed", "true");
});
