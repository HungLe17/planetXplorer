import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { zoomAt } from "../src/lib/view-transform";
const grid = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGNkYGAQYOAgHrEwCHAwMJCAWEY1MIyGEsMQSRoAt7gKFiOrcWUAAAAASUVORK5CYII=",
  "base64",
);
const frames = Array.from({ length: 3 }, (_, i) => ({
  id: `f${i}`,
  url: `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 3000}/test-frames/f${i}.png`,
  observation_id: `obs${i}`,
  observed_at: ["2025-07-01", "2026-01-02", "2026-07-03"][i] + "T00:00:00Z",
  detector: "D1",
  wavelength_um: 0.98,
  sequence_id: "D1-matched",
  processing_version: "v1",
}));
function visitsFor(catalog: typeof frames) {
  return catalog.map(f => ({
    id: "visit-" + f.observation_id, start_utc: f.observed_at, end_utc: f.observed_at,
    observation_ids: [f.observation_id], status: "pending", issues: [],
  }));
}
async function setup(page: Page, gridHeader?: Record<string, number>) {
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
          processing: {grid_header: gridHeader},
          visits: visitsFor(frames),
          sequences: [{id:"D1-matched", detector:"D1", wavelength_um:0.98,
            processing_version:"v1", frame_ids:frames.map(f => f.id), stretch:{}}],
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

test("Coordinates shows the saved sky grid at the cursor, selected pixel, and field center", async ({page}) => {
  await page.setViewportSize({width:1440,height:900});
  await setup(page, {CRVAL1:12, CRVAL2:0, CRPIX1:8, CRPIX2:8, CD1_1:0, CD1_2:-0.01, CD2_1:0.01, CD2_2:0});
  const readout = page.getByRole("group", {name:"Sky coordinates"});
  const toggle = page.getByRole("checkbox", {name:"Coordinates",exact:true});
  await toggle.check();
  await expect(readout).toHaveText("Field center · RA 11.995000° · Dec 0.005000° (ICRS)");
  const canvas = page.locator(".sky-canvas canvas");
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const scale = Math.min(box.width, box.height) * 0.94 / 16;
  const pixel = "Pixel (10, 9) · RA 12.000000° · Dec 0.020000° (ICRS)";
  await page.mouse.move(cx + 1.5*scale, cy + 0.5*scale);
  await expect(readout).toHaveText(pixel);
  await page.getByRole("button",{name:"Zoom in",exact:true}).click();
  const dx = box.width <= box.height ? 12 : 0, dy = box.height < box.width ? 12 : 0;
  await page.mouse.move(cx,cy);
  await page.mouse.down({button:"right"});
  await page.mouse.move(cx+dx,cy+dy,{steps:3});
  await page.mouse.up({button:"right"});
  await page.mouse.click(cx + dx + 1.5*scale*1.25, cy + dy + 0.5*scale*1.25);
  await toggle.hover();
  await expect(readout).toHaveText(pixel);
  await toggle.uncheck();
  await expect(readout).toHaveCount(0);
});

test("only a confirmed right-click on the selection retrieves its spectrum for all dates in a new tab", async ({page, context}) => {
  await page.setViewportSize({width: 1440, height: 900});
  let opens = 0, catalogReads = 0, measurements = 0;
  const records = [
    {id: "old-D1", detector: "D1", release: "DR1", observed_at: "2025-07-01T00:00:00Z"},
    {id: "new-D6", detector: "D6", release: "QR3", observed_at: "2026-07-01T00:00:00Z"},
  ];
  await context.route("**/api/region-spectra", route => {
    opens++;
    const body = route.request().postDataJSON();
    expect(body).toMatchObject({ra_deg: 330, dec_deg: -50, width: 16, height: 16});
    expect(body.box[0]).toBeLessThan(body.box[2]);
    expect(body.box[1]).toBeLessThan(body.box[3]);
    expect(Object.keys(body).sort()).toEqual(["box","dec_deg","fov_arcsec","height","ra_deg","width"]);
    return route.fulfill({status: 201, json: {id: "region"}});
  });
  await context.route("**/region/catalog", route => {
    catalogReads++;
    return route.fulfill({json: catalogReads === 1 ? {discovering: true, count: 1} :
      {discovering: false, count: 2, records, visits: records.map(r => ({
        id: r.id, start_utc: r.observed_at, end_utc: r.observed_at, observation_ids: [r.id], kind: "supplemental", status: "pending", issues: [],
      }))}});
  });
  await context.route("**/region/measure", route => {
    measurements++;
    expect(route.request().postDataJSON().ids).toEqual(measurements === 1 ? ["old-D1","new-D6"] : ["new-D6"]);
    const id = measurements === 1 ? "old-D1" : "new-D6";
    return route.fulfill({json: {measurements: [{id, bins: [{wave: measurements === 1 ? 1.1 : 4.4, mean: -3.2, finite: 1}], finite: 1, pixels: 4, covered: 4}],
      errors: measurements === 1 ? {"new-D6": "Archive busy"} : {}}});
  });
  await setup(page);
  const canvas = page.locator("canvas");
  const center = async () => {
    const r = (await canvas.boundingBox())!;
    return {x: r.x + r.width/2, y: r.y + r.height/2};
  };
  let p = await center();
  await page.mouse.move(p.x - 35, p.y - 35);
  await page.mouse.down();
  await page.mouse.move(p.x + 35, p.y + 35, {steps: 4});
  await page.mouse.up();
  await expect(page.getByRole("complementary", {name: "Frame details"})).toBeVisible();
  p = await center();
  await page.mouse.click(p.x + 120, p.y, {button: "right"});
  const menu = page.getByRole("dialog", {name: "Selected region spectrum"});
  await expect(menu).toHaveCount(0);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down({button: "right"});
  await page.mouse.move(p.x + 15, p.y, {steps: 3});
  await page.mouse.up({button: "right"});
  await expect(menu).toHaveCount(0);
  await page.mouse.click(p.x, p.y, {button: "right"});
  await expect(menu).toContainText("very long time");
  await menu.getByRole("button", {name: "Cancel"}).click();
  expect(opens).toBe(0);
  await page.mouse.click(p.x, p.y, {button: "right"});
  const opened = context.waitForEvent("page");
  await menu.getByRole("link", {name: "Open in new tab"}).click();
  const tab = await opened;
  await expect(tab.getByRole("heading", {name: "Region spectrum"})).toBeVisible();
  await expect(tab.getByRole("status")).toContainText("1 failed");
  await expect(tab.getByRole("cell", {name: "-3.2", exact: true})).toBeVisible();
  await tab.getByRole("combobox").selectOption("new-D6");
  await expect(tab.getByRole("cell", {name: "Archive busy"})).toBeVisible();
  await tab.getByRole("button", {name: "Retry lookup"}).click();
  await expect(tab.getByRole("status")).toContainText("2 of 2 exposures measured · complete");
  await expect(tab.getByRole("cell", {name: "4.4", exact: true})).toBeVisible();
  expect(opens).toBe(1);
  expect(measurements).toBe(2);
  await expect(canvas).toBeVisible();
});

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

test("cycle playback advances from a raw selection and stops at the last cycle with looping off", async ({
  page,
}) => {
  await setup(page);
  const firstCycle=page.getByRole("region",{name:"Cycle 1",exact:true});
  await firstCycle.locator(".cycle-disclosure").click();
  await firstCycle.getByRole("row").filter({has:page.getByText("obs0",{exact:true})})
    .getByRole("button",{name:"View",exact:true}).click();
  await expect(page.getByRole("button",{name:"Return to timeline",exact:true})).toBeVisible();
  await page.locator("#speed").selectOption("4");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(() => page.locator(".frame-counter").innerText())
    .not.toBe("01 / 03");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByLabel("Matched spectra",{exact:true}).click();
  await page.locator(".matched-options details details").first().getByRole("button").first().click();
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Loop playback", exact: true })
    .click();
  await page.getByRole("button", { name: "Last cycle", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".frame-counter")).toContainText("03 / 03");
});

test("keyboard resizing and sidebar disclosure keep the current cycle and playback state", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await setup(page);
  const counter = page.getByLabel("Current cycle", { exact: true });
  const cycle = await counter.innerText();
  const sidebar = page.locator("aside.sidebar");
  const width = (await sidebar.boundingBox())!.width;
  await page.getByRole("separator", { name: "Resize Query and display settings", exact: true })
    .press("ArrowRight");
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBeGreaterThan(width);
  await expect(counter).toHaveText(cycle);
  const appearance = page.locator(".sidebar-section > summary").filter({ hasText: "Playback and appearance" });
  await appearance.press("Space");
  await expect(appearance.locator("..")).toHaveAttribute("open", "");
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect(counter).toHaveText(cycle);
});

test("desktop recenter preserves zoom and the sidebar scrolls through simultaneously expanded settings", async ({page}) => {
  await page.setViewportSize({width:1440,height:900});
  await setup(page);
  const canvas=page.locator("canvas");
  await page.getByRole("button",{name:"Zoom in",exact:true}).click();
  const zoom=await zoomValue(page);
  const pixel=() => canvas.evaluate((el:HTMLCanvasElement) =>
    [...el.getContext("2d")!.getImageData(Math.floor(el.width/2),Math.floor(el.height/2),1,1).data]);
  const center=await pixel(), box=(await canvas.boundingBox())!;
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  await page.mouse.down({button:"right"});
  await page.mouse.move(box.x+box.width/2+120,box.y+box.height/2+75,{steps:5});
  await page.mouse.up({button:"right"});
  await page.getByRole("button",{name:"Recenter image",exact:true}).click();
  await expect.poll(pixel).toEqual(center);
  expect(await zoomValue(page)).toBe(zoom);
  const sidebar=page.getByRole("complementary",{name:"Query and display settings",exact:true});
  for (const summary of await sidebar.locator(".sidebar-section > summary").all()) {
    if (!await summary.evaluate(el=>el.parentElement!.hasAttribute("open"))) await summary.click();
  }
  await sidebar.locator(".search-bands > summary").click();
  for (const detector of ["D1","D2","D3","D4","D5","D6"])
    await sidebar.getByRole("checkbox",{name:detector+" detector",exact:true}).check();
  const scroller=sidebar.locator(".settings-scroll");
  await scroller.evaluate(el=>{el.scrollTop=0;});
  const bounds=(await scroller.boundingBox())!;
  await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
  await page.mouse.wheel(0,1000);
  await expect.poll(()=>scroller.evaluate(el=>el.scrollTop)).toBeGreaterThan(100);
  expect(await sidebar.locator(".band-options").first().evaluate(el=>el.scrollHeight<=el.clientHeight+1)).toBe(true);
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
  await page.mouse.down({ button: "right" });
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2 + 65, {
    steps: 8,
  });
  await page.mouse.up({ button: "right" });
  await expect.poll(pixel).not.toEqual(before);
  const scale = await zoomValue(page);
  await page.setViewportSize({ width: 720, height: 600 });
  await expect.poll(async () => (await pixel())[3]).toBe(255);
  await page.getByRole("button", { name: "Next cycle", exact: true }).click();
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
          visits: visitsFor(frames),
          frames: frames.map((f, i) =>
            i === 1 ? { ...f, url: f.url + "?fresh=1" } : f,
          ),
        },
      },
    }),
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Next cycle", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Next cycle", exact: true }).click();
  const bell = page.getByRole("button",{name:/^Notifications,/});
  await bell.click();
  await expect(page.getByText("This image could not be loaded.",{exact:true})).toBeVisible();
  await page.getByRole("button", { name: "Next cycle", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Zoom in", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Previous cycle", exact: true })
    .click();
  await bell.click();
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
        manifest: { frames: list, visits: visitsFor(list) },
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
  await page.getByRole("button", { name: "Last cycle", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  list.push({
    ...frames[0],
    id: "earlier",
    observation_id: "earlier",
    url: `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 3000}/test-frames/earlier.png`,
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
  await expect(page.getByRole("complementary", {name:"Query and display settings", exact:true})).not.toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
