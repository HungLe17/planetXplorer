import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { zoomAt } from "../src/lib/view-transform";
const grid = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGNkYGAQYOAgHrEwCHAwMJCAWEY1MIyGEsMQSRoAt7gKFiOrcWUAAAAASUVORK5CYII=",
  "base64",
);
const frames = Array.from({ length: 3 }, (_, i) => ({
  id: `f${i}`,
  url: `http://127.0.0.1:3000/test-frames/f${i}.png`,
  observation_id: `obs${i}`,
  observed_at: `2026-01-0${i + 1}T00:00:00Z`,
  detector: `D${i + 1}`,
  wavelength_um: i + 1,
  sequence_id: `s${i}`,
}));
async function setup(page: Page) {
  await page.route("**/api/presets", (r) =>
    r.fulfill({ json: { presets: [] } }),
  );
  await page.route("**/api/jobs", (r) =>
    r.fulfill({ status: 202, json: { job_id: "viewer" } }),
  );
  await page.route("**/api/jobs/viewer", (r) =>
    r.fulfill({
      json: {
        status: "complete",
        manifest: {
          frames,
          sequences: frames.map((f, i) => ({
            id: f.sequence_id,
            detector: f.detector,
            wavelength_um: i + 1,
            frame_ids: [f.id],
            stretch: {},
          })),
        },
      },
    }),
  );
  await page.route("**/test-frames/**", (r) =>
    r.fulfill({ contentType: "image/png", body: grid }),
  );
  await page.goto("/explore?ra=330&dec=-50");
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeEnabled();
}
const zoomValue = (page: Page) =>
  page
    .getByLabel("Viewport zoom", { exact: true })
    .innerText()
    .then((v) => Number.parseInt(v));

test("zoom geometry preserves the anchored image coordinate during pinch translation", () => {
  const before = { scale: 2, x: 30, y: -10 },
    from = { x: 120, y: 80 },
    to = { x: 135, y: 100 };
  const after = zoomAt(before, 4, from, to);
  expect((to.x - after.x) / after.scale).toBe(
    (from.x - before.x) / before.scale,
  );
  expect((to.y - after.y) / after.scale).toBe(
    (from.y - before.y) / before.scale,
  );
  expect(zoomAt(before, 1e6, from).scale).toBe(32);
});

test("browse plays single-frame wavelength groups; matched mode explains why it cannot", async ({
  page,
}) => {
  await setup(page);
  await expect(
    page.getByText(
      "Unmatched observations; brightness is not directly comparable.",
    ),
  ).toBeVisible();
  await page.locator("#speed").selectOption("4");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(() => page.locator(".frame-counter").innerText())
    .not.toBe("01 / 03");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Matched", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("One checked frame in this matched group."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Browse all 3 images", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Loop playback", exact: true })
    .click();
  await page.getByRole("button", { name: "Last frame", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".frame-counter")).toContainText("03 / 03");
});

test("wheel, drag, native scale, fit, and fullscreen work without changing frame selection", async ({
  page,
}) => {
  await setup(page);
  const canvas = page.locator("canvas"),
    r = (await canvas.boundingBox())!;
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.wheel(0, -277);
  await expect.poll(() => zoomValue(page)).toBeGreaterThan(190);
  const pixel = () =>
    canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      return Array.from(
        c.getContext("2d")!.getImageData(c.width / 2, c.height / 2, 1, 1).data,
      );
    });
  const before = await pixel();
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2 + 65, {
    steps: 8,
  });
  await page.mouse.up();
  await expect.poll(pixel).not.toEqual(before);
  const scale = await zoomValue(page);
  await page.setViewportSize({ width: 720, height: 600 });
  await expect.poll(async () => (await pixel())[3]).toBe(255);
  await page.getByRole("button", { name: "Next frame", exact: true }).click();
  await expect(page.getByLabel("Viewport zoom", { exact: true })).toHaveText(
    `${scale}%`,
  );
  await page
    .getByRole("button", { name: "Native pixel scale", exact: true })
    .click();
  await expect.poll(() => zoomValue(page)).toBeLessThan(100);
  await page
    .getByRole("button", { name: "Reset viewport", exact: true })
    .click();
  await expect(page.getByLabel("Viewport zoom", { exact: true })).toHaveText(
    "100%",
  );
  await page
    .getByRole("button", { name: "Enter fullscreen", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(true);
  await page
    .getByRole("button", { name: "Exit fullscreen", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(false);
  await expect(page.locator(".frame-counter")).toContainText("02 / 03");
});

test("two-finger pinch and double tap zoom the image, not the page", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 2,
  });
  const r = (await page.locator("canvas").boundingBox())!,
    x = r.x + r.width / 2,
    y = r.y + r.height / 2;
  const contacts = (distance: number) => [
    { x: x - distance, y, id: 1 },
    { x: x + distance, y, id: 2 },
  ];
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: contacts(25),
  });
  for (const d of [30, 35, 40, 45, 50])
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: contacts(d),
    });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect.poll(() => zoomValue(page)).toBeGreaterThan(190);
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  await page
    .getByRole("button", { name: "Reset viewport", exact: true })
    .click();
  for (let i = 0; i < 2; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y, id: 3 }],
    });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
  }
  await expect.poll(() => zoomValue(page)).toBe(200);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("one failed image does not block other frames, and can be retried", async ({
  page,
}) => {
  await setup(page);
  let fail = true;
  await page.route("**/test-frames/f1.png*", (r) =>
    fail
      ? r.fulfill({ status: 404 })
      : r.fulfill({ contentType: "image/png", body: grid }),
  );
  // The initial neighbor may already be cached: exercise a previously unseen failing URL.
  await page.route("**/api/jobs/viewer", (r) =>
    r.fulfill({
      json: {
        status: "complete",
        manifest: {
          frames: frames.map((f, i) =>
            i === 1 ? { ...f, url: f.url + "?fresh=1" } : f,
          ),
        },
      },
    }),
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Next frame", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Next frame", exact: true }).click();
  await expect(page.getByText("This image could not be loaded.")).toBeVisible();
  await page.getByRole("button", { name: "Next frame", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Zoom in", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Previous frame", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry image", exact: true }),
  ).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Retry image", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Zoom in", exact: true }),
  ).toBeEnabled();
});

test("new arrivals keep the selected observation and zoom, without reloading cached images", async ({
  page,
}) => {
  let finished = false;
  const list = [...frames];
  const requests = new Map<string, number>();
  await page.route("**/api/presets", (r) =>
    r.fulfill({ json: { presets: [] } }),
  );
  await page.route("**/api/jobs", (r) =>
    r.fulfill({ status: 202, json: { job_id: "stream" } }),
  );
  await page.route("**/api/jobs/stream", (r) =>
    r.fulfill({
      json: {
        status: finished ? "complete" : "running",
        stage: "fetch:3/8",
        manifest: { frames: list },
      },
    }),
  );
  await page.route("**/test-frames/**", (r) => {
    const url = r.request().url();
    requests.set(url, (requests.get(url) || 0) + 1);
    return r.fulfill({ contentType: "image/png", body: grid });
  });
  await page.goto("/explore?ra=330&dec=-50");
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Last frame", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  list.push({
    ...frames[0],
    id: "earlier",
    observation_id: "earlier",
    url: "http://127.0.0.1:3000/test-frames/earlier.png",
    observed_at: "2025-01-01T00:00:00Z",
  });
  finished = true;
  await expect(page.locator(".frame-counter")).toContainText("04 / 04");
  await expect(page.getByLabel("Frame details", { exact: true })).toContainText(
    "obs2",
  );
  await expect(page.getByLabel("Viewport zoom", { exact: true })).toHaveText(
    "125%",
  );
  expect(requests.get(frames[0].url)).toBe(1);
  expect(requests.get(frames[2].url)).toBe(1);
});

test("catalog filters govern bulk loading, CSV export, and mobile record management", async ({
  page,
}) => {
  await setup(page);
  const records = [
    { id: "alpha", status: "ready" },
    { id: "beta", status: "pending" },
    { id: "gamma", status: "failed" },
    { id: "delta", status: "pending" },
  ].map((o) => ({
    ...o,
    source_url: "https://example.test/test-only",
    observed_at: "2026-01-01T00:00:00Z",
    detector: "D1",
    release: "DR1",
  }));
  const loaded = [{ ...frames[0], observation_id: "alpha" }];
  let body: unknown;
  await page.route("**/api/jobs/viewer", (r) =>
    r.fulfill({
      json: {
        status: "complete",
        manifest: { frames: loaded, observations: records },
      },
    }),
  );
  await page.route("**/api/jobs/viewer/load", (r) => {
    body = r.request().postDataJSON();
    for (const id of (body as { observation_ids: string[] }).observation_ids) {
      records.find((o) => o.id === id)!.status = "ready";
    }
    return r.fulfill({ status: 202, json: { job_id: "viewer" } });
  });
  await page.reload();
  await expect(page.getByLabel("Find observation")).toBeVisible();
  await page.getByLabel("Find observation").fill("delta");
  await page.getByRole("button", { name: "Load next 1", exact: true }).click();
  await expect.poll(() => body).toEqual({ observation_ids: ["delta"] });
  await page.getByLabel("Find observation").fill("");
  await page.getByLabel("Observation status").selectOption("failed");
  await page
    .getByRole("button", { name: "Retry 1 failed", exact: true })
    .click();
  await expect.poll(() => body).toEqual({ observation_ids: ["gamma"] });
  await expect(
    page.getByText("No matching observations", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await page.getByLabel("Find observation").fill("beta");
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export observation catalog", exact: true })
    .click();
  const file = await download;
  await file.saveAs("test-results/catalog-export.csv");
  const csv = await readFile("test-results/catalog-export.csv", "utf8");
  expect(csv).toContain('"beta"');
  expect(csv).not.toContain('"alpha"');
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Expand observations", exact: true })
    .click();
  await expect(page.locator("canvas")).not.toBeVisible();
  await expect(page.getByText("beta", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Restore image view", exact: true })
    .click();
  await expect(page.locator("canvas")).toBeVisible();
  await page
    .getByRole("button", { name: "Toggle field settings", exact: true })
    .click();
  await expect(page.getByLabel("Query and display settings")).not.toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
