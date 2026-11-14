import { test, expect } from "@playwright/test";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
test.beforeEach(async ({ page }) => {
  await page.route("**/api/presets", (r) =>
    r.fulfill({ json: { presets: [] } }),
  );
});
test("validates coordinates and handles an unavailable backend", async ({
  page,
}) => {
  await page.route("**/api/jobs", (r) => r.abort());
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Planet X home", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Search observations" }).click();
  await expect(page.locator(".error[role=alert]")).toContainText("Enter both");
  await page.getByRole("textbox", { name: "Right ascension" }).fill("360");
  await page.getByRole("textbox", { name: "Declination" }).fill("0");
  await page.getByRole("button", { name: "Search observations" }).click();
  await expect(page.locator(".error[role=alert]")).toContainText("360");
  await page
    .getByRole("textbox", { name: "Right ascension" })
    .fill("133.795129");
  await page.getByRole("button", { name: "Search observations" }).click();
  await expect(page.locator(".error[role=alert]")).toContainText("unavailable");
});
test("loads frames in timestamp order, steps, and restores a shared field", async ({
  page,
}) => {
  await page.route("**/api/jobs", (r) =>
    r.fulfill({ status: 202, json: { job_id: "test-job" } }),
  );
  await page.route("**/api/jobs/test-job", (r) =>
    r.fulfill({
      json: {
        status: "complete",
        manifest: {
          stretch: "asinh",
          frames: [
            {
              id: "b",
              url: "/api/assets/test-job/b.png",
              observation_id: "second-observation",
              observed_at: "2026-02-01T00:00:00Z",
              detector: "D2",
            },
            {
              id: "a",
              url: "/api/assets/test-job/a.png",
              observation_id: "first-observation",
              observed_at: "2026-01-01T00:00:00Z",
              detector: "D2",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/assets/**", (r) =>
    r.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") }),
  );
  await page.goto("/explore?ra=133.795129&dec=-7.245147");
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("Frame details", { exact: true })).toContainText(
    "first-observation",
  );
  await page.getByRole("button", { name: "Next frame", exact: true }).click();
  await expect(page.getByLabel("Frame details", { exact: true })).toContainText(
    "second-observation",
  );
  await expect(
    page.getByRole("button", { name: "Select frame 1", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Select frame 1", exact: true })
    .click();
  await expect(page.getByLabel("Frame details", { exact: true })).toContainText(
    "first-observation",
  );
  await page.getByLabel("Blink interval").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#speed option:checked")).toHaveText("300 ms");
  await page.getByLabel("Invert grayscale").check();
  await expect
    .poll(() =>
      page
        .locator("canvas")
        .evaluate((el) => (el as HTMLCanvasElement).getContext("2d")?.filter),
    )
    .toBe("invert(1)");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(page.locator(".zoom-buttons")).toContainText("125%");
  await page
    .getByRole("button", { name: "Reset viewport", exact: true })
    .click();
  await expect(page.locator(".zoom-buttons")).toContainText("100%");
  await page.getByRole("textbox", { name: "Right ascension" }).fill("12");
  await expect(page.getByText("Query edited.", { exact: false })).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("Frame details", { exact: true })).toContainText(
    "first-observation",
  );
});
test("mobile layout fits without page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByLabel("Reference target", { exact: true }),
  ).toBeVisible();
  await page.waitForFunction(
    () => (document.querySelector("canvas")?.width || 0) > 100,
  );
  await expect(
    page.getByRole("heading", { name: "No observation loaded" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= innerHeight,
    ),
  ).toBeTruthy();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: "test-results/mobile.png",
    fullPage: true,
    caret: "initial",
  });
});

test("desktop visual review and zoom reflow", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.waitForFunction(
    () => (document.querySelector("canvas")?.width || 0) > 100,
  );
  await page.evaluate(() => document.fonts.ready);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= innerHeight,
    ),
  ).toBeTruthy();
  expect(
    await page
      .locator(".sky-shell")
      .evaluate((el) => el.getBoundingClientRect().height),
  ).toBeGreaterThan(450);
  await page.screenshot({
    path: "test-results/desktop.png",
    fullPage: true,
    caret: "initial",
  });
  await page.setViewportSize({ width: 720, height: 525 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
});

test("laptop workspace fits and the inspector can collapse", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/");
  const viewer = page.locator(".sky-shell");
  await page.waitForFunction(
    () => (document.querySelector("canvas")?.width || 0) > 100,
  );
  const width = (await viewer.boundingBox())!.width;
  await page.getByRole("button", { name: "Toggle frame details" }).click();
  await expect(page.getByLabel("Frame details", { exact: true })).toHaveCount(
    0,
  );
  expect((await viewer.boundingBox())!.width).toBeGreaterThan(width + 200);
  await page.getByRole("button", { name: "Dates", exact: true }).click();
  await expect(page.locator("input[name=start]")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= innerHeight,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "test-results/laptop.png",
    fullPage: true,
    caret: "initial",
  });
});

test("mobile metadata opens on demand and closes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByLabel("Frame details", { exact: true })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Toggle frame details" }).click();
  await expect(page.getByLabel("Frame details", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close frame details" }).click();
  await expect(page.getByLabel("Frame details", { exact: true })).toHaveCount(
    0,
  );
});

test("no coverage keeps playback disabled and explains the result", async ({
  page,
}) => {
  await page.route("**/api/jobs", (r) =>
    r.fulfill({ status: 202, json: { job_id: "empty" } }),
  );
  await page.route("**/api/jobs/empty", (r) =>
    r.fulfill({ json: { status: "complete", manifest: { frames: [] } } }),
  );
  await page.goto("/explore?ra=1&dec=2");
  await expect(
    page.getByText("No comparable observations were found", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeDisabled();
});

test("settings tabs expose resources and preserve the query", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("textbox", { name: "Right ascension" }).fill("20");
  await page.getByRole("button", { name: "Links", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "SPHEREx archive", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Settings navigation" })
    .getByRole("button", { name: "Help", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Inspecting a field" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "About", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Planet X", exact: true, level: 2 }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Right ascension" }),
  ).toHaveValue("20");
  await page
    .getByRole("button", { name: "Reset defaults", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Right ascension" }),
  ).toHaveValue("");
  await expect(
    page.getByRole("spinbutton", { name: "Field of view (arcsec)" }),
  ).toHaveValue("300");
});

test("opens an available archive field on startup and honors shared coordinates", async ({
  page,
}) => {
  await page.route("**/api/presets", (r) =>
    r.fulfill({
      json: {
        presets: [
          {
            id: "barnard",
            ra_deg: 269.4462685,
            dec_deg: 4.7682045,
            cached_manifest_available: true,
          },
        ],
      },
    }),
  );
  const submitted: unknown[] = [];
  await page.route("**/api/jobs", (r) => {
    submitted.push(r.request().postDataJSON());
    return r.fulfill({ status: 202, json: { job_id: "startup" } });
  });
  await page.route("**/api/jobs/startup", (r) =>
    r.fulfill({
      json: {
        status: "complete",
        manifest: {
          frames: [
            {
              id: "startup-frame",
              url: "/api/assets/startup/frame.png",
              observation_id: "test-only-observation",
              observed_at: "2026-01-01T00:00:00Z",
              detector: "D6",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/assets/**", (r) =>
    r.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") }),
  );
  await page.goto("/");
  await expect(
    page.getByLabel("Reference target", { exact: true }),
  ).toHaveValue("barnard");
  await expect(page.locator("canvas")).toHaveAttribute(
    "aria-label",
    /Observation 1 of 1/,
  );
  await expect(
    page.getByRole("button", { name: "Zoom in", exact: true }),
  ).toBeEnabled();
  expect(submitted).toEqual([{ ra_deg: 269.4462685, dec_deg: 4.7682045 }]);
  await page.goto("/explore?ra=12&dec=-4");
  await expect(
    page.getByRole("textbox", { name: "Right ascension" }),
  ).toHaveValue("12");
  await expect(
    page.getByRole("button", { name: "Zoom in", exact: true }),
  ).toBeEnabled();
  expect(submitted).toEqual([
    { ra_deg: 269.4462685, dec_deg: 4.7682045 },
    { ra_deg: 12, dec_deg: -4, fov_arcsec: 300, live: true },
  ]);
});

test("search progress is cancellable and preserves the previous field", async ({
  page,
}) => {
  let submission = 0,
    cancellations = 0;
  await page.route("**/api/jobs", (r) =>
    r.fulfill({
      status: 202,
      json: { job_id: ++submission === 1 ? "loaded" : "slow" },
    }),
  );
  await page.route("**/api/jobs/loaded", (r) =>
    r.fulfill({
      json: {
        status: "complete",
        manifest: {
          frames: [
            {
              id: "original",
              url: "/api/assets/loaded/frame.png",
              observation_id: "test-only-original",
              observed_at: "2026-01-01T00:00:00Z",
              detector: "D2",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/assets/**", (r) =>
    r.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") }),
  );
  await page.route("**/api/jobs/slow", (r) =>
    r.fulfill({ json: { status: "running", stage: "fetch:4/24" } }),
  );
  await page.route("**/api/jobs/slow/cancel", (r) => {
    cancellations++;
    return r.fulfill({ json: { status: "cancelling" } });
  });
  await page.goto("/explore?ra=1&dec=2");
  await expect(
    page.getByRole("button", { name: "Zoom in", exact: true }),
  ).toBeEnabled();
  await page.getByRole("textbox", { name: "Right ascension" }).fill("330");
  await page.getByRole("textbox", { name: "Declination" }).fill("-50");
  await page
    .getByRole("button", { name: "Search observations", exact: true })
    .click();
  await expect(
    page.getByText("Checked 4 of 24 cutouts.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Searching", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("canvas")).toHaveAttribute(
    "aria-label",
    /Observation 1 of 1/,
  );
  await expect(page.locator(".field-readout")).toHaveText("1.000000, 2.000000");
  await page
    .getByRole("button", { name: "Cancel search", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Search observations", exact: true }),
  ).toBeEnabled();
  await expect.poll(() => cancellations).toBe(1);
  await expect(
    page.getByText("Showing the previous field.", { exact: false }),
  ).toBeVisible();
});

test("a missing submit endpoint is not reported as an expired job", async ({
  page,
}) => {
  await page.route("**/api/jobs", (r) =>
    r.fulfill({ status: 404, json: { detail: "Not Found" } }),
  );
  await page.goto("/explore?ra=331.09664385226796&dec=-7.2451472222");
  await expect(page.locator(".error[role=alert]")).toContainText(
    "Backend endpoint not found: /api/jobs",
  );
  await expect(page.locator(".error[role=alert]")).not.toContainText("expired");
});

test("a missing job reports a possible restart or expiry", async ({ page }) => {
  await page.route("**/api/jobs", (r) =>
    r.fulfill({ status: 202, json: { job_id: "lost-job" } }),
  );
  await page.route("**/api/jobs/lost-job", (r) =>
    r.fulfill({ status: 404, json: { detail: "Unknown job" } }),
  );
  await page.goto("/explore?ra=1&dec=2");
  await expect(page.locator(".error[role=alert]")).toContainText(
    "backend may have restarted",
  );
});
