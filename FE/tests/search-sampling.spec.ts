import { expect, test } from "@playwright/test";

test("Search sends time sampling and background loading follows the submitted bands across cycles", async ({page}) => {
  const date = "2025-05-01T00:00:00Z";
  const second = "2025-11-01T00:00:00Z";
  const rows = [
    {id:"may", observed_at:date}, {id:"may-repeat", observed_at:"2025-05-04T00:00:00Z"},
    {id:"nov", observed_at:second},
  ].map(o => ({...o, detector:"D6", release:"DR1", source_url:"", selection:"matched", status:"pending"}));
  const visits = [
    {id:"spring", observation_ids:["may","may-repeat"], start_utc:date, end_utc:rows[1].observed_at},
    {id:"fall", observation_ids:["nov"], start_utc:second, end_utc:second},
  ].map(v => ({...v, kind:"cycle", status:"pending", issues:[]}));
  const searches: Record<string, unknown>[] = [], batches: string[][] = [];
  await page.route("**/api/presets", route => route.fulfill({json:{presets:[]}}));
  await page.route("**/api/jobs", route => {
    searches.push(route.request().postDataJSON());
    return route.fulfill({json:{job_id:"sampling"}});
  });
  await page.route("**/api/jobs/sampling", route => route.fulfill({json:{
    status:"complete", manifest:{frames:[], observations:rows, visits, processing:{sampling_order:["may","nov"]}},
  }}));
  await page.route("**/api/jobs/sampling/load", route => {
    batches.push(route.request().postDataJSON().observation_ids);
    return route.fulfill({json:{job_id:"sampling"}});
  });
  await page.goto("/explore");
  await page.locator('[name="ra"]').fill("31");
  await page.locator('[name="dec"]').fill("5");
  await page.locator(".search-bands summary").click();
  await page.getByRole("checkbox",{name:"D1 detector"}).uncheck();
  await page.getByRole("checkbox",{name:"D6 detector"}).check();
  await page.getByLabel("Time sampling",{exact:true}).selectOption("days");
  await page.getByLabel("Minimum separation (days)").fill("90");
  await page.getByRole("button",{name:"Search observations"}).click();
  await expect.poll(() => searches[0]).toMatchObject({detectors:["D6"],min_separation_days:90});
  await expect.poll(() => batches.flat()).toEqual(["may","nov"]);
  await expect(page).toHaveURL(/[?&]min_days=90(?:&|$)/);
  await page.getByLabel("Load remaining selected bands in background").check();
  await expect.poll(() => batches.flat()).toEqual(["may","nov","may-repeat"]);
  await page.reload();
  await expect(page.getByLabel("Minimum separation (days)")).toHaveValue("90");
  await expect.poll(() => searches.length).toBe(2);
});
