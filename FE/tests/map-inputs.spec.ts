import { expect, test, type Page } from "@playwright/test";
import { defaults } from "../src/lib/imaging";
import { storageKey } from "../src/lib/workspace";
import type { Detector, Frame, Job, Observation } from "../src/lib/types";

const date = "2025-07-01T00:00:00Z";
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGNkYGAQYOAgHrEwCHAwMJCAWEY1MIyGEsMQSRoAt7gKFiOrcWUAAAAASUVORK5CYII=",
  "base64",
);
function frame(id: string, detector: Detector, nominal_channel?: number): Frame {
  return { id, observation_id: id, observed_at: date, detector, nominal_channel,
    url: "/api/assets/maps/" + id + ".png" };
}
function observation(id: string, detector: Detector, nominal_channel?: number): Observation {
  return { id, detector, nominal_channel, observed_at: date, release: "DR1",
    source_url: "https://example.test/" + id, status: "pending", selection: "matched" };
}
async function setup(page: Page, job: () => Job, query = true) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/presets") return route.fulfill({ json: { presets: [] } });
    if (path === "/api/jobs") return route.fulfill({ status: 202, json: { job_id: "map-inputs" } });
    if (path === "/api/jobs/map-inputs") return route.fulfill({ json: job() });
    if (path.endsWith(".png")) return route.fulfill({ contentType: "image/png", body: image });
    return route.fulfill({ json: {} });
  });
  await page.goto(query ? "/explore?ra=5&dec=2&fov=30" : "/explore");
}
async function inputs(page: Page) {
  await page.getByRole("region", { name: "Spectrum maps", exact: true })
    .getByRole("button", { name: "Inputs", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Inputs for Map 1", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("map inputs show field spectra from ready frames and catalog metadata, with all six detector bands", async ({ page }) => {
  await setup(page, () => ({ status: "complete", manifest: {
    frames: [frame("ready", "D1", 13), frame("duplicate", "D1", 13), frame("far-red", "D6", 17)],
    observations: [observation("pending", "D1", 3),
      { ...observation("retryable", "D2", 12), status: "failed" },
      { ...observation("duplicate-catalog", "D1", 13), status: "ready" },
      { ...observation("unavailable", "D3", 1), selection: "unavailable" },
      { ...observation("unverified", "D4"), wavelength_um: 2.234 }],
  } }));
  const dialog = await inputs(page);
  await expect(dialog.locator(".map-detector")).toHaveCount(6);
  for (let band = 1; band <= 6; band++) {
    await expect(dialog.getByRole("button", { name: "Add D" + band, exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Subtract D" + band, exact: true })).toBeVisible();
  }
  for (const detail of await dialog.locator(".map-detector details").all())
    await detail.locator("summary").click();
  await expect(dialog.getByRole("button", { name: /^Add D[1-6]-/ }))
    .toHaveCount(4);
  expect(await dialog.getByRole("button", { name: /^Add D[1-6]-/ })
    .evaluateAll(buttons => buttons.map(button => button.getAttribute("aria-label"))))
    .toEqual(["Add D1-03", "Add D1-13", "Add D2-12", "Add D6-17"]);
  await expect(dialog.locator(".map-detector").nth(2)).toContainText("No spectra available.");
  await expect(dialog.getByRole("button", { name: "Add D3-01", exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /^Add D4-/ })).toHaveCount(0);
});

test("open input dialog follows late manifest metadata without dropping unavailable selected inputs", async ({ page }) => {
  let revised = false;
  const legacy = "D2 1.450000 µm (v1)";
  await setup(page, () => ({ status: revised ? "complete" : "running", manifest: {
    frames: [], processing: { revision: revised ? 2 : 1 },
    observations: revised ? [observation("late", "D6", 16)] : [
      observation("first", "D1", 3), { ...observation("legacy", "D2"), channel: legacy },
    ],
  } }));
  const dialog = await inputs(page);
  await dialog.locator(".map-detector").nth(0).locator("summary").click();
  await dialog.locator(".map-detector").nth(1).locator("summary").click();
  await dialog.getByRole("button", { name: "Add D1-03", exact: true }).click();
  await dialog.getByRole("button", { name: "Add " + legacy, exact: true }).click();
  revised = true;
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".map-detector").nth(5).locator("summary")).toHaveText("Spectra (1)");
  await dialog.locator(".map-detector").nth(5).locator("summary").click();
  await expect(dialog.getByRole("button", { name: "Add D6-16", exact: true })).toBeVisible();
  const unavailable = dialog.getByRole("region", { name: "Unavailable selected inputs", exact: true });
  await expect(unavailable).toContainText("D1-03");
  await expect(unavailable).toContainText(legacy);
  await expect(unavailable.getByRole("button")).toHaveCount(2);
  await expect(unavailable.getByRole("button", { name: /^(Add|Subtract) / })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Add D1-03", exact: true })).toHaveCount(0);
  await expect(dialog.locator("output")).toContainText("+ D1-03");
  await expect(dialog.locator("output")).toContainText("+ " + legacy);
  await unavailable.getByRole("button", { name: "Remove unavailable input D1-03", exact: true }).click();
  await expect(dialog.locator("output")).not.toContainText("D1-03");
  await expect(dialog.locator("output")).toContainText(legacy);
  await unavailable.getByRole("button", { name: "Remove unavailable input " + legacy, exact: true }).click();
  await expect(unavailable).toHaveCount(0);
  await expect(dialog.locator("output")).toHaveText("No inputs selected");
});

test("legacy maps offer actual field calibration keys without inferring nominal spectra", async ({ page }) => {
  const first = "D1 0.980000 µm (v1)", second = "D1 1.020000 µm (v2)";
  await setup(page, () => ({ status: "complete", manifest: {
    frames: [{ ...frame("legacy-frame", "D1"), channel: first, wavelength_um: 0.98 },
      { ...frame("no-channel", "D3"), wavelength_um: 2.1 }],
    observations: [{ ...observation("legacy-duplicate", "D1"), channel: first },
      { ...observation("legacy-catalog", "D1"), channel: second, status: "failed" }],
  } }));
  const dialog = await inputs(page);
  const detector = dialog.locator(".map-detector").first();
  await expect(detector.locator("summary")).toHaveText("Spectra (2)");
  await detector.locator("summary").click();
  await expect(detector.locator(".map-channel")).toHaveCount(2);
  await expect(detector.getByRole("button", { name: "Add " + first, exact: true })).toBeVisible();
  await expect(detector.getByRole("button", { name: "Add " + second, exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Add D[1-6]-/ })).toHaveCount(0);
  await expect(dialog.locator(".map-detector").nth(2).locator("summary")).toHaveText("Spectra (0)");
});

test("saved legacy inputs stay available when nominal metadata enriches a matching exposure", async ({ page }) => {
  const exact = "D1 0.980000 µm (v1)", inexact = "D2 1.450000 µm (v1)";
  await page.addInitScript(({ key, display }) => {
    localStorage.setItem(key, JSON.stringify({ version: 2, exported: "2026-01-01T00:00:00Z",
      config: { query: { ra_deg: 5, dec_deg: 2, fov_arcsec: 30 }, frame: "", fov: 30, display } }));
  }, { key: storageKey, display: { ...defaults,
    maps: [{ ...defaults.maps[0], operands: { [exact]: 1, [inexact]: -1 } }] } });
  await setup(page, () => ({ status: "complete", manifest: {
    frames: [{ ...frame("enriched-exact", "D1", 13), channel: exact },
      { ...frame("enriched-inexact", "D2", 12), channel: "D2 1.455000 µm (v1)",
        wavelength_um: 1.455, bandwidth_um: 0.02, processing_version: "v1" }],
  } }), false);
  const dialog = await inputs(page);
  for (const detector of await dialog.locator(".map-detector").all())
    await detector.locator("summary").click();
  await expect(dialog.getByRole("button", { name: "Add D1-13", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add D2-12", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add " + exact, exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("button", { name: "Subtract " + inexact, exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("region", { name: "Unavailable selected inputs", exact: true })).toHaveCount(0);
  await expect(dialog.locator("output")).toContainText("+ " + exact);
  await expect(dialog.locator("output")).toContainText("− " + inexact);
  await dialog.getByRole("button", { name: "Add " + inexact, exact: true }).click();
  await expect(dialog.locator("output")).toContainText("+ " + inexact);
});

test("before a field search maps explain missing spectra while Search Bands keeps every nominal choice", async ({ page }) => {
  await setup(page, () => ({ status: "complete", manifest: { frames: [] } }), false);
  const form = page.locator("form.search-panel");
  await form.locator(".search-bands summary").click();
  for (let band = 1; band <= 6; band++) {
    await form.getByRole("checkbox", { name: "D" + band + " detector", exact: true }).check();
    await expect(form.getByRole("checkbox", { name: new RegExp("^D" + band + "-") })).toHaveCount(17);
  }
  const dialog = await inputs(page);
  await expect(dialog).toContainText("Search a field to see its available spectra.");
  await expect(dialog.locator(".map-detector")).toHaveCount(6);
  await expect(dialog.getByRole("button", { name: /^Add D[1-6]$/ })).toHaveCount(6);
  await expect(dialog.getByRole("button", { name: /^Add D[1-6]-/ })).toHaveCount(0);
  await expect(dialog.locator(".map-detector summary")).toHaveText(Array(6).fill("Spectra (0)"));
});
