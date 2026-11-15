import { expect, test, type Page } from "@playwright/test";

const source = "https://data.desi.lbl.gov/public/dr1/survey/catalogs/";

async function openSurveys(page: Page) {
  await page.route("**/api/presets", route => route.fulfill({ json: { presets: [] } }));
  await page.route("**/api/jobs", route => route.fulfill({ json: { job_id: "field" } }));
  await page.route("**/api/jobs/field", route => route.fulfill({
    json: { status: "complete", manifest: { frames: [] } },
  }));
  await page.route("**/api/surveys/neowise", route => route.fulfill({ json: { images: [] } }));
  await page.route("**/api/surveys/euclid", route => route.fulfill({ json: { bands: [], unavailable: [] } }));
  await page.goto("/explore?ra=5&dec=2");
  await page.getByRole("button", {name:"Surveys", exact:true}).click();
  return page.locator("section").filter({
    has: page.getByRole("heading", {name:"DESI", exact:true}),
  }).last();
}

test("an uninstalled DESI index explains how to install it", async ({page}) => {
  await page.route("**/api/surveys/desi", route => route.fulfill({
    status: 503,
    json: {detail: {code:"desi_index_missing", message:"The DESI DR1 galaxy index is not installed on this server."}},
  }));
  const desi = await openSurveys(page);
  await expect(desi.getByRole("status")).toContainText("not installed");
  await expect(desi.locator("code")).toHaveText("python scripts/prepare_desi.py");
  await expect(desi.getByRole("button", {name:"Retry"})).toHaveCount(0);
  await expect(desi).not.toContainText("0 matching galaxies");
});

test("a temporary DESI failure can retry and report a successful empty cone", async ({page}) => {
  let requests = 0, successful = 0, recovered = false;
  await page.route("**/api/surveys/desi", route => {
    requests++;
    expect(route.request().postDataJSON()).toEqual({ra_deg:5, dec_deg:2});
    if (!recovered) return route.fulfill({status:502, json:{detail:"DESI lookup unavailable"}});
    successful++;
    return route.fulfill({json:{galaxies:[], source_url:source}});
  });
  const desi = await openSurveys(page);
  await expect(desi.getByRole("status")).toContainText("Lookup unavailable");
  await expect(desi).not.toContainText("0 matching galaxies");
  recovered = true;
  await desi.getByRole("button", {name:"Retry"}).click();
  await expect(desi).toContainText("0 matching galaxies");
  await expect(desi.getByRole("status")).toHaveCount(0);
  await expect(desi.getByRole("link", {name:/Source catalogs/})).toHaveAttribute("href",source);
  expect(requests).toBeGreaterThanOrEqual(2);
  expect(successful).toBe(1);
});

test("a DESI DR1 match shows its tracer, redshift, identity and coordinates", async ({page}) => {
  await page.route("**/api/surveys/desi", route => route.fulfill({json:{
    galaxies:[{id:"test-742", ra_deg:5.0001, dec_deg:2.0002, redshift:.2323, tracers:["LRG"]}],
    source_url:source,
  }}));
  const desi = await openSurveys(page);
  await expect(desi).toContainText("1 matching galaxy");
  await expect(desi.locator(".survey-row")).toContainText("LRG");
  await expect(desi.locator(".survey-row")).toContainText("z 0.23230");
  await expect(desi.locator(".survey-row")).toContainText("test-742 · 5.00010°, 2.00020°");
  await expect(desi.getByRole("link", {name:/Source catalogs/})).toHaveAttribute("href",source);
});
