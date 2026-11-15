import { expect, test, type Page } from "@playwright/test";

async function openField(page: Page) {
  const observed = "2026-01-02T00:00:00Z";
  const frame = {
    id: "workflow-frame",
    observation_id: "workflow-frame",
    observed_at: observed,
    detector: "D1",
    wavelength_um: 1,
    processing_version: "v1",
    pixels: "frame.bin",
    url: "/api/assets/workflow/frame.png",
  };
  await page.route("**/api/presets", route => route.fulfill({ json: { presets: [] } }));
  await page.route("**/api/jobs", route => route.fulfill({ status: 202, json: { job_id: "workflow" } }));
  await page.route("**/api/jobs/workflow", route => route.fulfill({ json: {
    status: "complete",
    manifest: { frames: [frame], processing: { output_shape: [16, 16] } },
  } }));
  await page.route("**/api/assets/workflow/frame.bin", route => route.fulfill({
    contentType: "application/octet-stream",
    body: Buffer.from(Float32Array.from({ length: 256 }, (_, i) => i + 1).buffer),
  }));
  await page.route("**/api/known-objects/catalog", route => route.fulfill({ json: {
    objects: [], fetched_at: observed, warnings: [],
  } }));
  await page.route("https://aladin.cds.unistra.fr/AladinLite/**", route => route.fulfill({
    contentType: "text/html", body: "<title>Sky atlas fixture</title>",
  }));
  await page.goto("/explore?ra=330&dec=-50&fov=100");
  await expect(page.getByLabel("Displayed image", { exact: true })).toContainText("Calibrated exposure");
  await expect(page.getByRole("button", { name: "Zoom in", exact: true })).toBeEnabled();
}

test("workspace tools preserve panel choices through canvas-only mode and open saved locations", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openField(page);
  const toolbar = page.getByRole("toolbar", { name: "Workspace tools" });
  for (const name of ["Toggle field settings", "Toggle frame details", "Known objects", "Toggle observations", "Canvas only"]) {
    await expect(toolbar.getByRole("button", { name, exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name, exact: true })).toHaveCount(1);
  }
  const settings = page.getByRole("complementary", { name: "Query and display settings", exact: true });
  const inspector = page.getByRole("complementary", { name: "Frame details", exact: true });
  const known = page.getByRole("complementary", { name: "Aladin and known objects", exact: true });
  const observations = page.locator("#observations-panel");
  const canvasOnly = toolbar.getByRole("button", { name: "Canvas only", exact: true });
  await expect(inspector).toBeVisible();
  await toolbar.getByRole("button", { name: "Toggle field settings", exact: true }).click();
  await expect(settings).toBeHidden();
  await toolbar.getByRole("button", { name: "Toggle observations", exact: true }).click();
  await expect(observations.locator(".table-scroll")).toHaveCount(0);
  await toolbar.getByRole("button", { name: "Known objects", exact: true }).click();
  await expect(known).toBeVisible();

  await canvasOnly.click();
  await expect(canvasOnly).toHaveAttribute("aria-pressed", "true");
  await expect(settings).toBeHidden();
  await expect(inspector).toBeHidden();
  await expect(known).toBeHidden();
  await expect(observations).toBeHidden();
  await canvasOnly.click();
  await expect(canvasOnly).toHaveAttribute("aria-pressed", "false");
  await expect(settings).toBeHidden();
  await expect(inspector).toBeVisible();
  await expect(known).toBeVisible();
  await expect(observations).toBeVisible();
  await expect(observations.locator(".table-scroll")).toHaveCount(0);

  await canvasOnly.click();
  await page.keyboard.press("Escape");
  await expect(canvasOnly).toHaveAttribute("aria-pressed", "false");
  await expect(inspector).toBeVisible();
  await toolbar.getByRole("button", { name: "Open saved locations", exact: true }).click();
  await expect(settings).toBeVisible();
  await expect(page.getByText("Saved locations", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add location", exact: true })).toBeVisible();
});

test("canvas selection and pan tools keep the selected region and retain right-drag navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openField(page);
  const select = page.getByRole("button", { name: "Select region", exact: true });
  const pan = page.getByRole("button", { name: "Pan image", exact: true });
  await expect(select).toHaveAttribute("aria-pressed", "true");
  await expect(pan).toHaveAttribute("aria-pressed", "false");
  const canvas = page.locator(".sky-canvas canvas");
  const rect = (await canvas.boundingBox())!;
  const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
  const pixel = Math.min(rect.width, rect.height) * 0.94 / 16;
  await page.mouse.move(cx - 3 * pixel, cy - 3 * pixel);
  await page.mouse.down();
  await page.mouse.move(cx - pixel, cy - pixel, { steps: 4 });
  await page.mouse.up();
  const region = page.getByLabel("Visit spectra", { exact: true }).getByText(/^Region \(/);
  await expect(region).toBeVisible();
  const selection = await region.innerText();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await pan.click();
  await expect(pan).toHaveAttribute("aria-pressed", "true");
  await expect(select).toHaveAttribute("aria-pressed", "false");
  await page.mouse.click(cx - 2 * pixel * 1.5625, cy - 2 * pixel * 1.5625);
  await expect(page.getByRole("dialog", { name: "Selected region spectrum" })).toHaveCount(0);
  await expect(region).toHaveText(selection);

  const centerPixel = () => canvas.evaluate(element => {
    const image = element as HTMLCanvasElement;
    return Array.from(image.getContext("2d")!.getImageData(image.width / 2, image.height / 2, 1, 1).data);
  });
  const beforePan = await centerPixel();
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + 55, { steps: 5 });
  await page.mouse.up();
  await expect.poll(centerPixel).not.toEqual(beforePan);
  await expect(region).toHaveText(selection);
  await expect(page.getByRole("dialog", { name: "Selected region spectrum" })).toHaveCount(0);

  await canvas.focus();
  await page.keyboard.press("v");
  await expect(select).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("h");
  await expect(pan).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("v");
  const beforeRightDrag = await centerPixel();
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(cx, cy - 35, { steps: 4 });
  await page.mouse.up({ button: "right" });
  await expect.poll(centerPixel).not.toEqual(beforeRightDrag);
  await expect(region).toHaveText(selection);
});

test("mobile workspace tools stay reachable without document overflow and expose help", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openField(page);
  const toolbar = page.getByRole("toolbar", { name: "Workspace tools" });
  const canvasOnly = toolbar.getByRole("button", { name: "Canvas only", exact: true });
  await canvasOnly.scrollIntoViewIfNeeded();
  await canvasOnly.click();
  await expect(canvasOnly).toHaveAttribute("aria-pressed", "true");
  await canvasOnly.click();
  await expect(canvasOnly).toHaveAttribute("aria-pressed", "false");
  const help = toolbar.getByRole("button", { name: "Help", exact: true });
  await help.scrollIntoViewIfNeeded();
  await help.click();
  await expect(page.getByRole("heading", { name: "Inspecting a field", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
});
