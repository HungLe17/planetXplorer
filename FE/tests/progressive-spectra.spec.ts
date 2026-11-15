import { expect, test } from "@playwright/test";

test("all 102 published channels are available before entering a field and survive coordinate changes", async ({page}) => {
  const searches: {ra_deg:number; detectors:string[]; channels:Record<string, string[]>}[] = [];
  const archiveLookups: string[] = [];
  await page.route("**/api/archive/**", route => {
    archiveLookups.push(route.request().url());
    return route.fulfill({status:503, json:{detail:"Spectrum choices must be local"}});
  });
  await page.route("**/api/presets", route => route.fulfill({json:{presets:[]}}));
  await page.route("**/api/jobs", route => {
    searches.push(route.request().postDataJSON());
    return route.fulfill({status:202, json:{job_id:"spectrum-search"}});
  });
  await page.route("**/api/jobs/spectrum-search", route => route.fulfill({json:{
    status:"complete", manifest:{frames:[], observations:[], visits:[]},
  }}));
  await page.goto("/explore");
  const form = page.locator("form.search-panel");
  await form.locator(".search-bands summary").click();
  for (let band = 1; band <= 6; band++) {
    await form.getByRole("checkbox", {name:"D" + band + " detector"}).check();
    const choices = form.getByRole("checkbox", {name:new RegExp("^D" + band + "-")});
    await expect(choices).toHaveCount(17);
    for (const [i, box] of (await choices.all()).entries()) {
      const id = "D" + band + "-" + String(i + 1).padStart(2, "0");
      await expect(box).toHaveAccessibleName(new RegExp("^" + id + ".*[0-9].*µm"));
    }
  }
  for (const band of [2, 3, 4, 5]) await form.getByRole("checkbox", {name:"D" + band + " detector"}).uncheck();
  const d1 = form.getByRole("checkbox", {name:/^D1-03/});
  const d6 = form.getByRole("checkbox", {name:/^D6-17/});
  await d1.check();
  await d6.check();
  const ra = form.locator('[name="ra"]');
  await ra.fill("31");
  await form.locator('[name="dec"]').fill("5");
  await ra.fill("32");
  await expect(d1).toBeChecked();
  await expect(d6).toBeChecked();
  await expect(form.locator(".search-bands summary")).toContainText("D6-17");
  expect(archiveLookups).toEqual([]);
  expect(searches).toEqual([]);
  await form.getByRole("button", {name:"Search observations"}).click();
  await expect.poll(() => searches[0]).toMatchObject({ra_deg:32, detectors:["D1","D6"],
    channels:{D1:["D1-03"], D6:["D6-17"]}});
  expect(archiveLookups).toEqual([]);
});
