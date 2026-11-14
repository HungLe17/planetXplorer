import { test, expect, type Page } from "@playwright/test";
import { elapsedTime } from "../src/lib/observation-time";
import type { Frame, Observation } from "../src/lib/types";

// Test-only timelines and image; archive access and science are tested separately.
const dates = [
  "2025-01-01",
  "2025-01-02",
  "2025-03-05",
  "2025-06-01",
  "2025-12-31",
];
const ids = ["jan", "close", "mar", "jun", "dec"];
const makeFrame = (i: number): Frame => ({
  id: ids[i],
  observation_id: ids[i],
  url: `/test-timeline/${ids[i]}.png`,
  observed_at: dates[i] + "T00:00:00Z",
  detector: "D1",
  sequence_id: "s1",
  wavelength_um: 1,
});
async function setup(page: Page, pendingJune = false) {
  const frames = ids
    .map((_, i) => makeFrame(i))
    .filter(
      (f) => !pendingJune || !["jun", "close"].includes(f.observation_id),
    );
  const records: Observation[] = ids.map((id, i) => ({
    id,
    observed_at: dates[i] + "T00:00:00Z",
    detector: "D1",
    release: "DR1",
    source_url: "https://example.test/test-only",
    status: pendingJune && ["jun", "close"].includes(id) ? "pending" : "ready",
    time_sample: id !== "close",
  }));
  const initial = pendingJune
    ? ["jan", "mar", "dec"]
    : ["jan", "mar", "jun", "dec"];
  const state = {
    complete: true,
    requests: [] as string[][],
    submit: undefined as unknown,
    frames,
    records,
  };
  await page.route("**/api/presets", (r) =>
    r.fulfill({ json: { presets: [] } }),
  );
  await page.route("**/api/jobs", (r) => {
    state.submit = r.request().postDataJSON();
    return r.fulfill({ status: 202, json: { job_id: "timeline" } });
  });
  await page.route("**/api/jobs/timeline", (r) => {
    if (state.complete)
      for (const batch of state.requests)
        for (const id of batch) {
          records.find((o) => o.id === id)!.status = "ready";
          if (!frames.some((f) => f.observation_id === id))
            frames.push(makeFrame(ids.indexOf(id)));
        }
    return r.fulfill({
      json: {
        status: state.complete ? "complete" : "running",
        stage: "fetch:1/2",
        manifest: {
          frames,
          observations: records,
          processing: {
            initial_observation_ids: initial,
            initial_detector: "D1",
            min_interval_days: 60,
          },
          sequences: [
            {
              id: "s1",
              frame_ids: frames.map((f) => f.id),
              detector: "D1",
              wavelength_um: 1,
              stretch: {},
            },
          ],
        },
      },
    });
  });
  await page.route("**/api/jobs/timeline/load", (r) => {
    state.requests.push(r.request().postDataJSON().observation_ids);
    return r.fulfill({ status: 202, json: { job_id: "timeline" } });
  });
  await page.route("**/test-timeline/**", (r) =>
    r.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAI0lEQVR4nGNkYGAQYOAgHrEwCHAwMJCAWEY1MIyGEsMQSRoAt7gKFiOrcWUAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  return state;
}
const check = (page: Page, id: string) =>
  page.getByRole("checkbox", {
    name: `Include ${id} in timeline`,
    exact: true,
  });

test("only checked observations play; deselecting all preserves the catalog and zoom", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/explore?ra=330&dec=-50");
  await expect(page.locator(".frame-counter")).toHaveText("01 / 04");
  await expect(check(page, "close")).toHaveCount(0);
  await expect(page.getByLabel("Observation time separation")).toContainText(
    "Actual span: 364 days",
  );
  await page.getByRole("button", { name: "Next frame", exact: true }).click();
  await expect(page.getByLabel("Observation time separation")).toContainText(
    "63 days since previous",
  );
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await check(page, "mar").uncheck();
  await expect(
    page.getByRole("checkbox", {
      name: "Select all visible observations for timeline",
      exact: true,
    }),
  ).toHaveJSProperty("indeterminate", true);
  await expect(page.locator(".frame-counter")).toHaveText("01 / 03");
  await expect(page.getByLabel("Viewport zoom", { exact: true })).toHaveText(
    "125%",
  );
  await page.getByRole("button", { name: "Next frame", exact: true }).click();
  await expect(page.locator("canvas")).toHaveAttribute(
    "aria-label",
    /2025-06-01/,
  );
  await page
    .getByRole("button", { name: "Clear timeline", exact: true })
    .click();
  await expect(
    page.getByText("No observations selected", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeDisabled();
  await expect(check(page, "jan")).toBeVisible();
  await check(page, "jan").check();
  await check(page, "dec").check();
  await expect(page.locator(".frame-counter")).toHaveText("01 / 02");
  await expect(
    page.getByRole("button", { name: "Play", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Matched", exact: true }).click();
  await expect(page.locator(".frame-counter")).toHaveText("01 / 02");
  await page
    .getByRole("checkbox", { name: "All exposures", exact: true })
    .check();
  await expect(check(page, "close")).toBeVisible();
  await expect(check(page, "close")).not.toBeChecked();
  const all = page.getByRole("checkbox", {
    name: "Select all visible observations for timeline",
    exact: true,
  });
  await all.check();
  await expect(page.locator(".frame-counter")).toHaveText("01 / 05");
  await all.uncheck();
  await expect(
    page.getByText("No observations selected", { exact: true }),
  ).toBeVisible();
});

test("checking a pending observation waits for Load checked and selections survive streaming", async ({
  page,
}) => {
  const state = await setup(page, true);
  await page.goto("/explore?ra=330&dec=-50");
  await check(page, "jun").check();
  expect(state.requests).toHaveLength(0);
  state.complete = false;
  await page
    .getByRole("button", { name: "Load checked (1)", exact: true })
    .click();
  await expect.poll(() => state.requests).toEqual([["jun"]]);
  await check(page, "mar").uncheck();
  state.complete = true;
  await expect(page.locator(".frame-counter")).toHaveText("01 / 03");
  await expect(check(page, "mar")).not.toBeChecked();
  await expect(check(page, "jun")).toBeChecked();
  await page
    .getByRole("checkbox", { name: "All exposures", exact: true })
    .check();
  await check(page, "close").check();
  await page
    .getByRole("button", { name: "Load checked (1)", exact: true })
    .click();
  await expect.poll(() => state.requests).toEqual([["jun"], ["close"]]);
  await expect(page.locator(".frame-counter")).toHaveText("01 / 04");
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Expand observations", exact: true })
    .click();
  await check(page, "dec").uncheck();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("observation spacing is distinct from playback delay and survives a shared URL", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/explore?ra=330&dec=-50&spacing=180");
  await expect(
    page.getByLabel("Observation spacing", { exact: true }),
  ).toHaveValue("180");
  await expect
    .poll(() => state.submit)
    .toEqual({ ra_deg: 330, dec_deg: -50, min_interval_days: 180 });
  await page
    .getByLabel("Observation spacing", { exact: true })
    .selectOption("0");
  await page
    .getByRole("button", { name: "Search observations", exact: true })
    .click();
  await expect
    .poll(() => state.submit)
    .toEqual({ ra_deg: 330, dec_deg: -50, min_interval_days: 0 });
  await expect(page).toHaveURL(/spacing=0/);
  await page.reload();
  await expect(
    page.getByLabel("Observation spacing", { exact: true }),
  ).toHaveValue("0");
  expect(elapsedTime("2025-01-01T00:00:00Z", "2025-01-01T01:30:00Z")).toBe(
    "1.5 hours",
  );
});

test("Load checked advances through batches without retrying a failed image forever", async ({
  page,
}) => {
  await setup(page);
  const records: Observation[] = Array.from({ length: 10 }, (_, i) => ({
    id: `selected-${i}`,
    source_url: "https://example.test/test-only",
    detector: "D1",
    release: "DR1",
    status: "pending",
    observed_at: new Date(Date.UTC(2025, 0, 1 + i * 65)).toISOString(),
  }));
  const loaded: Frame[] = [];
  const requests: string[][] = [];
  await page.route("**/api/jobs/timeline", (r) =>
    r.fulfill({
      json: {
        status: "partial",
        manifest: {
          observations: records,
          frames: loaded,
          processing: {
            initial_observation_ids: records.map((o) => o.id),
            initial_detector: "D1",
          },
        },
      },
    }),
  );
  await page.route("**/api/jobs/timeline/load", (r) => {
    const batch: string[] = r.request().postDataJSON().observation_ids;
    requests.push(batch);
    for (const id of batch) {
      const o = records.find((o) => o.id === id)!;
      o.status = id === "selected-0" ? "failed" : "ready";
      if (o.status === "ready")
        loaded.push({
          id,
          observation_id: id,
          detector: o.detector,
          observed_at: o.observed_at,
          url: `/test-timeline/${id}.png`,
        });
    }
    return r.fulfill({ status: 202, json: { job_id: "timeline" } });
  });
  await page.goto("/explore?ra=330&dec=-50");
  await page
    .getByRole("button", { name: "Load checked (10)", exact: true })
    .click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests.map((r) => r.length)).toEqual([8, 2]);
  expect(requests.flat().filter((id) => id === "selected-0")).toHaveLength(1);
  await expect(
    page.getByRole("button", { name: "Load checked (1)", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".timeline-selection")).toContainText(
    "9 images in timeline",
  );
});
