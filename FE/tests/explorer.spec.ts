import { test, expect } from "@playwright/test";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
test.beforeEach(async ({ page }) => {
  await page.route("**/api/presets", (r) =>
    r.fulfill({ json: { presets: [] } }),
  );
});
test("renders and inspects Barnard-like flagged bands and exports their display values", async ({ page }) => {
  const bands = [
    { id: "red", wave: 2.31, archived: NaN, flags: 69206022, status: 131 },
    { id: "green", wave: 4.72, archived: 50, flags: 69206018, status: 2 },
    { id: "blue", wave: 2.27, archived: NaN, flags: 69206022, status: 131 },
  ];
  const frames = bands.map((b, i) => ({
    id: b.id, observation_id: b.id, observed_at: `2026-01-0${i + 1}T00:00:00Z`,
    detector: "D3", channel: "D3 " + b.wave + " µm", wavelength_um: b.wave,
    url: "/api/assets/flags/" + b.id + ".png", pixels: b.id + ".bin", quality: b.id + "-quality.bin",
  }));
  await page.route("**/api/jobs", (r) => r.fulfill({ json: { job_id: "flags" } }));
  await page.route("**/api/jobs/flags", (r) => r.fulfill({ json: {
    status: "complete", manifest: { frames, processing: { output_shape: [3, 3] } },
  } }));
  await page.route("**/api/assets/flags/*.bin", (r) => {
    const name = new URL(r.request().url()).pathname.split("/").pop()!;
    const b = bands.find((v) => name.startsWith(v.id))!;
    const body = Buffer.alloc(9 * (name.endsWith("-quality.bin") ? 9 : 4));
    for (let i = 0; i < 9; i++) {
      const source = i === 4 ? b.archived : i === 0 ? 100 : 0;
      if (body.length === 36) body.writeFloatLE(i === 4 ? NaN : source, i * 4);
      else {
        body.writeFloatLE(source, i * 4);
        body.writeUInt32LE(i === 4 ? b.flags : 0, 36 + i * 4);
        body[72 + i] = i === 4 ? b.status : 1;
      }
    }
    return r.fulfill({ contentType: "application/octet-stream", body });
  });
  await page.goto("/explore?ra=269.4462685&dec=4.7682045");
  await expect(page.getByLabel("Selected pixel")).toContainText("Overflow · shown at maximum");
  await page.getByLabel("Display mode").selectOption("rgb");
  for (const [i, color] of ["Red", "Green", "Blue"].entries())
    await page.getByLabel(color + " wavelength and exposure").selectOption(bands[i].id);
  await page.getByLabel("Intensity stretch").selectOption("linear");
  const inspector = page.getByLabel("Selected pixel");
  await expect(inspector.getByText("Overflow · shown at maximum")).toHaveCount(2);
  await expect(inspector).toContainText("50.000 MJy/sr");
  await expect(inspector).toContainText("OVERFLOW, SUR_ERROR, SOURCE, BLOOM");
  await expect(inspector.locator("circle")).toHaveCount(0);
  await expect(page.getByLabel("Mark flagged pixels (1)")).toBeChecked();

  const canvas = page.locator("canvas");
  const expected = [255, 128, 255, 255];
  await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => {
    return [...c.getContext("2d")!.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data];
  })).toEqual(expected);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "PNG", exact: true }).click(),
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const pixel = await page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = "data:image/png;base64," + encoded;
    await image.decode();
    const out = document.createElement("canvas");
    out.width = image.width;
    out.height = image.height;
    const ctx = out.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    return [...ctx.getImageData(Math.floor(out.width / 2), Math.floor(out.height / 2), 1, 1).data];
  }, Buffer.concat(chunks).toString("base64"));
  expect(pixel).toEqual(expected);
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
test("draws a live cutout before a slow asset and preserves selection on earlier arrivals", async ({
  page,
}) => {
  const field = (id: string, day: string) => ({
    id,
    observation_id: id,
    observed_at: `2026-01-${day}T00:00:00Z`,
    detector: "D2",
    channel: `D2 ${day} µm`,
    url: `/api/assets/progressive/${id}-preview.png`,
    pixels: id + ".bin",
  });
  const late = field("late", "20"),
    early = field("early", "05"),
    slow = field("slow", "28");
  let includeEarly = false,
    complete = false;
  let releaseSlow!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const requests = new Map<string, number>();
  await page.route("**/api/jobs", (r) =>
    r.fulfill({ json: { job_id: "progressive" } }),
  );
  await page.route("**/api/jobs/progressive", (r) => {
    const frames = includeEarly ? [slow, late, early] : [slow, late];
    return r.fulfill({
      json: {
        status: complete ? "complete" : "running",
        stage: "fetch:3/4",
        manifest: {
          frames: complete
            ? frames.map((f) => ({ ...f, url: f.url.replace("-preview", "") }))
            : frames,
          processing: { output_shape: [2, 2] },
        },
      },
    });
  });
  await page.route("**/api/assets/progressive/*.bin", async (r) => {
    const url = r.request().url();
    requests.set(url, (requests.get(url) ?? 0) + 1);
    if (url.endsWith("slow.bin")) await gate;
    await r.fulfill({
      contentType: "application/octet-stream",
      body: Buffer.from(new Float32Array([1, 2, 3, 4]).buffer),
    });
  });
  try {
    await page.goto("/explore?ra=20&dec=2");
    const details = page.getByLabel("Frame details", { exact: true });
    await expect(details).toContainText("late");
    await expect(
      page.getByRole("button", { name: "PNG", exact: true }),
    ).toBeEnabled();
    await expect(page.locator("canvas")).toHaveAttribute(
      "aria-label",
      /Observation 1 of 1/,
    );
    expect(
      await page.evaluate(
        () =>
          performance.getEntriesByName("planetx:progressive:first-canvas-draw")
            .length,
      ),
    ).toBe(1);
    includeEarly = true;
    await expect(page.locator("canvas")).toHaveAttribute(
      "aria-label",
      /Observation 2 of 2/,
    );
    await expect(details).toContainText("late");
    await expect(
      page.getByRole("button", { name: "Play", exact: true }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Previous frame", exact: true })
      .click();
    await expect(details).toContainText("early");
    releaseSlow();
    complete = true;
    await expect(page.locator("canvas")).toHaveAttribute(
      "aria-label",
      /Observation 1 of 3/,
    );
    await expect(
      page.getByRole("button", { name: "Search observations" }),
    ).toBeEnabled();
    await expect(details).toContainText("early");
    expect([...requests.values()]).toEqual([1, 1, 1]);
  } finally {
    releaseSlow();
  }
});

test("shows cached pixels during refresh and replaces a revised exposure in place", async ({
  page,
}) => {
  let phase: "cached" | "verified" | "revised" = "cached";
  const loaded: string[] = [];
  await page.route("**/api/jobs", (route) =>
    route.fulfill({ json: { job_id: "warm" } }),
  );
  await page.route("**/api/jobs/warm", (route) => {
    const revision = phase === "revised" ? "r2" : "r1";
    return route.fulfill({
      json: {
        status: phase === "revised" ? "complete" : "running",
        stage: phase === "cached" ? "query" : "fetch:1/2",
        manifest: {
          frames: [
            {
              id: revision + ".png",
              pixels: revision + ".bin",
              url: "/api/assets/warm/" + revision + ".png",
              observation_id: "same-exposure",
              observed_at: "2025-07-03T00:00:00Z",
              detector: "D2",
              release: revision,
            },
          ],
          processing: {
            output_shape: [2, 2],
            refreshing_cache: phase === "cached",
          },
        },
      },
    });
  });
  await page.route("**/api/assets/warm/*.bin", (route) => {
    loaded.push(new URL(route.request().url()).pathname.split("/").pop()!);
    return route.fulfill({
      body: Buffer.from(new Float32Array([1, 2, 3, 4]).buffer),
    });
  });
  await page.goto("/explore?ra=20&dec=2");
  const status = page.getByText(/Showing cached observations while checking/);
  await expect(status).toBeVisible();
  await expect(
    page.getByRole("button", { name: "PNG", exact: true }),
  ).toBeEnabled();
  phase = "verified";
  await expect(status).toHaveCount(0);
  await expect(page.getByText(/Checked 1 of 2 cutouts/)).toBeVisible();
  phase = "revised";
  const inspector = page.getByLabel("Frame details", { exact: true });
  await expect(inspector).toContainText("r2");
  await expect(inspector).toContainText("same-exposure");
  await expect(
    page.getByRole("button", { name: "Observations 1" }),
  ).toBeVisible();
  expect(loaded).toEqual(["r1.bin", "r2.bin"]);
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

test("streams the catalog, separates wavelengths, and loads another detector", async ({
  page,
}) => {
  let complete = false;
  const frame = (id: string, detector: string, sequence_id: string) => ({
    id,
    url: `/api/assets/catalog/${id}.png`,
    observation_id: id,
    observed_at: "2026-01-01T00:00:00Z",
    detector,
    sequence_id,
  });
  const records = ["d1a", "d1b", "d2", "d3", "d4", "d5", "d6"].map((id, i) => ({
    id,
    source_url: "https://example.test/fixture",
    observed_at: "2026-01-01T00:00:00Z",
    detector: i < 2 ? "D1" : `D${i}`,
    release: "DR1",
    status: i < 3 ? "ready" : "pending",
  }));
  const frames = [
    frame("d1a", "D1", "s1"),
    frame("d1b", "D1", "s1"),
    frame("d2", "D2", "s2"),
  ];
  const sequences = [
    {
      id: "s1",
      detector: "D1",
      wavelength_um: 1,
      processing_version: "test",
      frame_ids: ["d1a", "d1b"],
      stretch: {},
    },
    {
      id: "s2",
      detector: "D2",
      wavelength_um: 2,
      processing_version: "test",
      frame_ids: ["d2"],
      stretch: {},
    },
  ];
  await page.route("**/api/jobs", (r) =>
    r.fulfill({ status: 202, json: { job_id: "catalog" } }),
  );
  await page.route("**/api/jobs/catalog", (r) =>
    r.fulfill({
      json: {
        status: complete ? "complete" : "running",
        stage: "fetch:1/8",
        manifest: {
          frames: complete ? frames : frames.slice(0, 1),
          observations: records,
          sequences: complete
            ? sequences
            : [{ ...sequences[0], frame_ids: ["d1a"] }],
        },
      },
    }),
  );
  await page.route("**/api/assets/**", (r) =>
    r.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") }),
  );
  let requested: unknown;
  await page.route("**/api/jobs/catalog/load", (r) => {
    requested = r.request().postDataJSON();
    records[6].status = "ready";
    frames.push(frame("d6", "D6", "s6"));
    sequences.push({
      id: "s6",
      detector: "D6",
      wavelength_um: 5,
      processing_version: "test",
      frame_ids: ["d6"],
      stretch: {},
    });
    return r.fulfill({ status: 202, json: { job_id: "catalog" } });
  });
  await page.goto("/explore?ra=330&dec=-50");
  await expect(
    page.getByRole("button", { name: "Zoom in", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Searching", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("Observations", { exact: true })).toContainText(
    "d6",
  );
  complete = true;
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Matched", exact: true }).click();
  await page.getByLabel("Wavelength sequence").selectOption("s2");
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("Frame details", { exact: true })).toContainText(
    "D2",
  );
  await page.getByLabel("Detector", { exact: true }).selectOption("D6");
  await page.getByRole("button", { name: "Load", exact: true }).click();
  await page.getByRole("button", { name: "Matched", exact: true }).click();
  await page.getByLabel("Wavelength sequence").selectOption("s6");
  expect(requested).toEqual({ observation_ids: ["d6"] });
  await expect(page.getByLabel("Frame details", { exact: true })).toContainText(
    "D6",
  );
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Wavelength sequence").selectOption("s1");
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: "test-results/catalog-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Frame details", { exact: true })).toHaveCount(
    0,
  );
  await page.screenshot({
    path: "test-results/catalog-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});

test("field size is submitted independently of image magnification", async ({
  page,
}) => {
  let query: unknown;
  await page.route("**/api/jobs", (r) => {
    query = r.request().postDataJSON();
    return r.fulfill({ status: 202, json: { job_id: "fov" } });
  });
  await page.route("**/api/jobs/fov", (r) =>
    r.fulfill({ json: { status: "complete", manifest: { frames: [] } } }),
  );
  await page.goto("/");
  await page.getByRole("textbox", { name: "Right ascension" }).fill("330");
  await page.getByRole("textbox", { name: "Declination" }).fill("-50");
  await page.getByRole("spinbutton", { name: "Field of view (arcsec)" }).fill("600");
  await page
    .getByRole("button", { name: "Search observations", exact: true })
    .click();
  await expect
    .poll(() => query)
    .toEqual({ ra_deg: 330, dec_deg: -50, fov_arcsec: 600, live: true });
  await expect(page).toHaveURL(/fov=600/);
});

test("load all continues through batches until the selected detector is exhausted", async ({
  page,
}) => {
  const records = Array.from({ length: 3 }, (_, i) => ({
    id: `record${i}`,
    source_url: "https://example.test/test-only",
    observed_at: "2026-01-01T00:00:00Z",
    detector: "D6",
    release: "DR1",
    status: "pending",
  }));
  let calls = 0;
  await page.route("**/api/jobs", (r) =>
    r.fulfill({ status: 202, json: { job_id: "loadall" } }),
  );
  await page.route("**/api/jobs/loadall", (r) =>
    r.fulfill({
      json: {
        status: "complete",
        manifest: { frames: [], observations: records, sequences: [] },
      },
    }),
  );
  await page.route("**/api/jobs/loadall/load", (r) => {
    records[calls++].status = "ready";
    return r.fulfill({ status: 202, json: { job_id: "loadall" } });
  });
  await page.goto("/explore?ra=330&dec=-50");
  await page.getByLabel("Detector", { exact: true }).selectOption("D6");
  await page.getByRole("button", { name: "Load all D6", exact: true }).click();
  await expect.poll(() => calls).toBe(3);
  await expect(
    page.getByRole("button", { name: "Load all D6", exact: true }),
  ).toBeDisabled();
});
