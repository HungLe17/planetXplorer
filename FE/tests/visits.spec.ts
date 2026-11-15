import { test, expect } from "@playwright/test";
import { defaults } from "../src/lib/imaging";

test("background map loads pass unknown wavelengths through the map subband filter", async ({page}) => {
  const label = "D1 1.020000 µm (v1)";
  const view = {...defaults, maps: [{...defaults.maps[0], operands: {[label]: 1}}]};
  const date = "2026-06-01T00:00:00Z";
  const record = {id:"unknown", detector:"D1", observed_at:date, release:"DR1", status:"pending"};
  const visit = {id:"cycle", kind:"cycle", start_utc:date, end_utc:date,
    observation_ids:[record.id], status:"pending", issues:[]};
  const batches: {channels?: Record<string, string[]>}[] = [];
  await page.route("**/api/presets", r => r.fulfill({json:{presets:[]}}));
  await page.route("**/api/jobs", r => r.fulfill({json:{job_id:"map-filter"}}));
  await page.route("**/api/jobs/map-filter", r => r.fulfill({json:{status:"complete", manifest:{
    observations:[record], visits:[visit], frames:[],
  }}}));
  await page.route("**/api/jobs/map-filter/load", r => {
    batches.push(r.request().postDataJSON());
    return r.fulfill({json:{job_id:"map-filter"}});
  });
  const params = new URLSearchParams({ra:"5", dec:"4", bands:JSON.stringify({detectors:["D1"]}), view:JSON.stringify(view)});
  await page.goto("/explore?" + params);
  await expect.poll(() => batches[0]?.channels).toEqual({D1:[label]});
  await page.getByLabel(/in background/i).check();
  await expect.poll(() => batches.length).toBe(2);
  expect(batches[1].channels).toBeUndefined();
});

test("cycle navigation and selection preserve the whole spectrum; explicit spectrum and background loads honor scope", async ({
  page,
}) => {
  const visits = ["winter", "summer"].map((id, i) => ({
    id,
    start_utc: i ? "2026-07-01T00:00:00Z" : "2026-01-01T00:00:00Z",
    end_utc: i ? "2026-07-02T00:00:00Z" : "2026-01-02T00:00:00Z",
    observation_ids: ["D1", "D4", "D6"].map((d) => id + d),
    status: "pending",
    issues: [],
  }));
  const observations = visits.flatMap((v) =>
    v.observation_ids.map((id, i) => ({
      id,
      visit_id: v.id,
      detector: ["D1", "D4", "D6"][i],
      release: "DR1",
      wavelength_um: [1, 3, 4.5][i],
      observed_at: v.start_utc,
      source_url: "https://example.test/fixture",
      status: i === 0 ? "ready" : "pending",
    })),
  );
  let query: { detectors?: string[] };
  const batches: string[][] = [];
  await page.route("**/api/presets", (r) =>
    r.fulfill({ json: { presets: [] } }),
  );
  await page.route("**/api/jobs", (r) => {
    query = r.request().postDataJSON();
    return r.fulfill({ json: { job_id: "schedule" } });
  });
  await page.route("**/api/jobs/schedule", (r) =>
    r.fulfill({
      json: {
        status: "complete",
        manifest: {
          visits,
          observations,
          processing: { output_shape: [5, 5] },
          frames: observations
            .filter((o) => o.status === "ready")
            .map((o) => ({
              ...o,
              observation_id: o.id,
              pixels: o.id + ".bin",
              url: "/api/assets/test/" + o.id + ".png",
            })),
        },
      },
    }),
  );
  await page.route("**/api/jobs/schedule/load", (r) => {
    const ids = r.request().postDataJSON().observation_ids as string[];
    batches.push(ids);
    observations
      .filter((o) => ids.includes(o.id))
      .forEach((o) => (o.status = "ready"));
    return r.fulfill({ json: { job_id: "schedule" } });
  });
  await page.route("**/api/assets/test/*.bin", (r) =>
    r.fulfill({
      body: Buffer.from(
        Float32Array.from({ length: 25 }, (_, i) => i - 3).buffer,
      ),
    }),
  );
  const detectors = ["D1", "D4", "D6"];
  const bands = encodeURIComponent(JSON.stringify({ detectors, channels: {} }));
  await page.goto("/explore?ra=5&dec=2&fov=30&bands=" + bands);
  const canvas = page.locator("canvas");
  await expect(canvas).toHaveAttribute("aria-label", /Observation 1 of 2/);
  await expect(
    page.getByLabel(/in background/i),
  ).not.toBeChecked();
  expect(query!.detectors).toEqual(detectors);
  expect(batches).toEqual([]);
  const dock = page.getByRole("region", { name: "Observations", exact: true });
  await expect(dock.locator(".count-badge")).toHaveText("2 cycles · 6 exposures");
  await expect(dock.getByRole("table")).toHaveCount(0);
  const second = dock.getByRole("region", { name: "Cycle 2", exact: true });
  await second.getByRole("button", { name: "View Cycle 2" }).click();
  await expect(canvas).toHaveAttribute("aria-label", /Observation 2 of 2/);
  await second.locator(".cycle-disclosure").click();
  await expect(second.getByText("summerD4", { exact: true })).toBeVisible();
  await dock.getByLabel("Find observation").fill("summerD4");
  await expect(dock.getByRole("region", { name: "Cycle 1", exact: true })).toHaveCount(0);
  await expect(second.getByText("summerD1", { exact: true })).toHaveCount(0);
  await expect(second).toContainText("1/3 loaded · 1 matching");
  await dock.getByLabel("Find observation").fill("");
  await second.locator(".cycle-disclosure").click();
  await dock.getByRole("button", { name: "View Cycle 1" }).click();
  await expect(canvas).toHaveAttribute("aria-label", /Observation 1 of 2/);
  expect(batches).toEqual([]);
  const whole = page.getByLabel("Whole field spectrum", { exact: true });
  await expect(whole.locator("circle")).toHaveCount(1);
  const wholeBefore = await whole.innerHTML();
  await expect(whole.locator('text[x="45"]').first()).toHaveText("0");
  const rect = (await canvas.boundingBox())!;
  const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const step = (Math.min(rect.width, rect.height) * 0.94) / 5;
  await page.mouse.move(center.x - step, center.y - step);
  await page.mouse.down();
  await page.mouse.move(center.x + step, center.y, { steps: 5 });
  await page.mouse.up();
  await expect(
    page.getByLabel("Selected region spectrum", { exact: true }),
  ).toHaveCount(1);
  expect(await whole.innerHTML()).toEqual(wholeBefore);
  expect(batches).toEqual([]);
  await page.getByRole("button", { name: /load .* spectrum/i }).click();
  await expect(
    page.getByLabel("Whole field spectrum", { exact: true }).locator("circle"),
  ).toHaveCount(3);
  expect(batches.flat()).toEqual(["winterD4", "winterD6"]);
  const region = page.getByText(/Region \(2, 2\).*\(4, 3\)/);
  await expect(region).toBeVisible();
  await page.mouse.down({ button: "right" });
  await page.mouse.move(center.x, center.y + step);
  await page.mouse.up({ button: "right" });
  await expect(region).toBeVisible();
  await page.getByLabel(/in background/i).check();
  await expect
    .poll(() => batches.flat())
    .toEqual(["winterD4", "winterD6", "summerD4", "summerD6"]);
  await expect(whole.locator("polyline")).toHaveAttribute("stroke-width", "1");
  await second.locator(".cycle-disclosure").click();
  await second.getByRole("row").filter({hasText:"summerD4"}).getByRole("button",{name:"View",exact:true}).click();
  await expect(page.locator(".image-readout")).toContainText("Calibrated exposure");
  await expect(page.getByRole("button",{name:"GIF",exact:true})).toBeDisabled();
  await expect(page.getByLabel("Cycle timeline")).toHaveAttribute("max","1");
  await page.getByRole("button",{name:"Previous cycle"}).click();
  await expect(page.locator(".image-readout")).toContainText("Visit composite");
  await expect(page.getByRole("button",{name:"GIF",exact:true})).toBeEnabled();
  await expect(canvas).toHaveAttribute("aria-label", /Observation 1 of 2/);
});

test("supplemental windows share one expandable shelf and preserve exposure actions", async ({page}) => {
  const date = "2026-04-01T00:00:00Z";
  const records = [
    { id: "main", status: "pending", detector: "D6" },
    { id: "first-extra", status: "failed", detector: "D4" },
    { id: "second-extra", status: "pending", detector: "D3" },
  ].map(o => ({...o, release: "DR1", source_url: "https://example.test/fixture", observed_at: date}));
  const visits = records.map((r, i) => ({
    id: "visit-" + r.id, start_utc: date, end_utc: date, observation_ids: [r.id],
    kind: i ? "supplemental" : "cycle", status: "pending", issues: [],
  }));
  let requested: unknown;
  await page.route("**/api/presets", r => r.fulfill({ json: { presets: [] } }));
  await page.route("**/api/jobs", r => r.fulfill({ json: { job_id: "visits" } }));
  await page.route("**/api/jobs/visits", r => r.fulfill({ json: {
    status: "complete", manifest: { visits, observations: records, frames: [] },
  }}));
  await page.route("**/api/jobs/visits/priority/*", r => {
    requested = r.request().url().split("/").pop();
    return r.fulfill({ json: { job_id: "visits" } });
  });
  await page.goto("/explore?ra=5&dec=2&bands=" + encodeURIComponent(JSON.stringify({detectors:["D4","D6"]})));
  const dock = page.getByRole("region", { name: "Observations", exact: true });
  await expect(dock.locator(".count-badge")).toHaveText("1 cycle · 3 exposures");
  const extra = dock.getByRole("region", { name: "Additional exposures" });
  await expect(extra).toContainText("0/2 loaded · 1 failed");
  await expect(extra.getByRole("table")).toHaveCount(0);
  await extra.locator(".cycle-disclosure").click();
  await expect(extra.getByText("second-extra", { exact: true })).toBeVisible();
  await extra.getByRole("button", { name: "Retry", exact: true }).click();
  await expect.poll(() => requested).toBe("first-extra");
});

test("a late terminal poll cannot hide an accepted priority request", async ({page}) => {
  const obs = {id:"clicked", observed_at:"2025-01-01T00:00:00Z", detector:"D1", release:"DR1",
    source_url:"https://example.test/fixture", selection:"matched", status:"pending"};
  let polls = 0, releaseOld!: () => void, acknowledged = false;
  const oldResponse = new Promise<void>(resolve => { releaseOld = resolve; });
  await page.route("**/api/presets", r => r.fulfill({json:{presets:[]}}));
  await page.route("**/api/jobs", r => r.fulfill({json:{job_id:"race"}}));
  await page.route("**/api/jobs/race", async r => {
    const number = ++polls;
    if (number === 2) await oldResponse;
    const hasImage = number > 2 && acknowledged;
    return r.fulfill({json:{status:number === 1 ? "running" : "complete",manifest:{
      observations:[{...obs,status:hasImage ? "ready" : "pending"}], frames:hasImage ?
        [{...obs,observation_id:"clicked",url:"/api/assets/race/clicked.png"}] : [],
    }}});
  });
  await page.route("**/api/jobs/race/priority/clicked", r => {
    acknowledged = true;
    return r.fulfill({status:202,json:{job_id:"race"}});
  });
  await page.goto("/explore?ra=5&dec=2");
  await expect.poll(() => polls).toBe(2);
  await page.getByRole("row").filter({hasText:"clicked"}).getByRole("button",{name:"Load next"}).click();
  await expect.poll(() => acknowledged).toBe(true);
  releaseOld();
  await expect(page.getByRole("row").filter({hasText:"clicked"}).getByRole("button",{name:"View"})).toBeVisible();
  expect(polls).toBeGreaterThan(2);
});

test("an invalid cycle explains the conflict and preserves access to its raw exposure", async ({
  page,
}) => {
  await page.route("**/api/presets", (r) =>
    r.fulfill({ json: { presets: [] } }),
  );
  await page.route("**/api/jobs", (r) =>
    r.fulfill({ json: { job_id: "conflict" } }),
  );
  const date = "2026-01-02T00:00:00Z";
  await page.route("**/api/jobs/conflict", (r) =>
    r.fulfill({
      json: {
        status: "complete",
        manifest: {
          visits: [
            {
              id: "bad",
              start_utc: date,
              end_utc: date,
              status: "invalid",
              observation_ids: ["obs"],
              issues: ["Missing detector coverage in this search: D3."],
            },
          ],
          frames: [
            {
              id: "obs",
              observation_id: "obs",
              visit_id: "bad",
              observed_at: date,
              detector: "D1",
              wavelength_um: 1,
              url: "/api/assets/conflict/obs.png",
              pixels: "obs.bin",
            },
          ],
          processing: { output_shape: [1, 1] },
        },
      },
    }),
  );
  await page.route("**/api/assets/conflict/obs.bin", (r) =>
    r.fulfill({ body: Buffer.from(new Float32Array([7]).buffer) }),
  );
  await page.goto("/explore?ra=4&dec=3");
  const dialog = page.getByRole("dialog", {
    name: "Incomplete or conflicting visits",
  });
  await expect(dialog).toContainText(
    "Missing detector coverage in this search: D3.",
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "PNG", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Browse", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "PNG", exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("Visit spectra")).toContainText("7 MJy/sr");
});

test("the sidebar discovers sub-band inputs on demand and supports transparent color stops", async ({page}) => {
  await page.route("**/api/presets", r => r.fulfill({json:{presets:[]}}));
  await page.route("**/api/jobs", r => r.fulfill({json:{job_id:"lookup"}}));
  await page.route("**/api/jobs/lookup", r => r.fulfill({json:{status:"complete", manifest:{frames:[]}}}));
  const found = "D6 4.500000 µm (7.0.5)";
  const requests: string[] = [];
  await page.route("**/api/jobs/lookup/channels/**", r => {
    requests.push(new URL(r.request().url()).pathname);
    return r.fulfill({json:{channels:[found],next_cursor:null,unavailable:0,total:1,catalog_complete:true}});
  });
  await page.goto("/explore?ra=4&dec=3");
  await expect(page.getByText("No comparable observations were found", {exact:false})).toBeVisible();
  await page.getByRole("button",{name:"Inputs",exact:true}).click();
  const inputs = page.getByRole("dialog",{name:"Inputs for Map 1",exact:true});
  const box=(await inputs.boundingBox())!;
  const sidebar=(await page.locator("aside.sidebar").boundingBox())!;
  expect(box.x+box.width).toBeLessThanOrEqual(sidebar.x+sidebar.width);
  const d6=inputs.locator(".map-detector").filter({hasText:"D6 · whole detector"});
  await d6.locator("summary").click();
  expect(requests).toEqual([]);
  await d6.getByRole("button",{name:"Discover channels"}).click();
  await d6.getByRole("button",{name:"Subtract "+found,exact:true}).click();
  await expect(inputs.locator("output")).toContainText("− "+found);
  expect(requests).toEqual(["/api/jobs/lookup/channels/D6"]);
  await inputs.getByRole("button",{name:"Close editor"}).click();
  await page.getByRole("button",{name:"Colors",exact:true}).click();
  const colors=page.getByRole("dialog",{name:"Colors for Map 1"});
  await colors.getByRole("button",{name:/Transparent/i}).first().click();
  await colors.getByRole("button",{name:"Close editor"}).click();
  await page.getByRole("button",{name:"Add map"}).click();
  await expect(page.getByLabel("Map name 2")).toBeVisible();
  page.once("dialog", d => d.dismiss());
  await page.getByRole("button",{name:"Delete Map 2"}).click();
  await expect(page.getByLabel("Map name 2")).toBeVisible();
  page.once("dialog", d => d.accept());
  await page.getByRole("button",{name:"Delete Map 2"}).click();
  await expect(page.getByLabel("Map name 2")).toHaveCount(0);
});
