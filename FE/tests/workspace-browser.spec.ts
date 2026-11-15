import { test, expect } from "@playwright/test";
import { defaults } from "../src/lib/imaging";
import {
  storageKey,
  type Backup,
  type Config,
  type Entry,
} from "../src/lib/workspace";
const config: Config = {
  query: { ra_deg: 15, dec_deg: -2, fov_arcsec: 480 },
  frame: "demo",
  fov: 480,
  display: { ...defaults, zoom: 2 },
};
const entry: Entry = {
  id: "one",
  name: "East field",
  note: "Check again",
  fields: [{ name: "Candidate", value: "red" }],
  position: { ra_deg: 15.01, dec_deg: -2.01 },
  snapshotComplete: true,
  sources: ["demo"],
  snapshot: { demo: "original" },
  config,
  metadata: {},
};
const epoch = "2026-10-01T00:00:00Z";
function jsonFile(parts: Partial<Backup>) {
  return {
    name: "workspace.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({ version: 2, exported: epoch, ...parts }),
    ),
  };
}

test("save the Details rectangle or full frame, reuse field names and update flags immediately", async ({page}) => {
  await page.setViewportSize({width:1440,height:900});
  const id = "saved-frame", date = "2025-06-01T00:00:00Z";
  const frame = {id, observation_id:id, observed_at:date, detector:"D1", pixels:"frame.bin",
    url:"/api/assets/saved/frame.png", wavelength_um:1, channel:"D1 1 µm (v1)", processing_version:"v1", sequence_id:"one"};
  await page.route("**/api/presets", r=>r.fulfill({json:{presets:[]}}));
  await page.route("**/api/jobs", r=>r.fulfill({json:{job_id:"saved"}}));
  await page.route("**/api/jobs/saved", r=>r.fulfill({json:{status:"complete",manifest:{
    processing:{output_shape:[5,5]},frames:[frame],
  }}}));
  await page.route("**/api/assets/saved/frame.bin", r=>r.fulfill({body:Buffer.from(new Float32Array(25).fill(3).buffer)}));
  await Promise.all([page.waitForResponse("**/api/jobs/saved"),
    page.goto("/explore?ra=7&dec=2&fov=30", {waitUntil:"domcontentloaded"})]);
  await expect(page.getByLabel("Displayed image")).toContainText("Calibrated exposure");
  const canvas = page.locator("canvas"), rect = (await canvas.boundingBox())!;
  const s = Math.min(rect.width,rect.height) * 0.94 / 5;
  const center = {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
  await page.mouse.move(center.x-s, center.y-s);
  await page.mouse.down();
  await page.mouse.move(center.x+s, center.y, {steps:4});
  await page.mouse.up();
  const area = page.getByText(/Region \(2, 2\).*\(4, 3\)/);
  await expect(area).toBeVisible();
  await page.getByText("Saved locations", {exact:true}).click();
  await page.getByRole("button",{name:"Default fields for new locations",exact:true}).click();
  const fields = page.getByRole("dialog",{name:"Default fields for new locations",exact:true});
  await fields.getByLabel("Default field name 1", {exact:true}).fill("Candidate class");
  await fields.getByLabel("Default field name 2", {exact:true}).fill("Review");
  await fields.getByRole("button",{name:"Add default field"}).click();
  await fields.getByRole("button",{name:"Delete default field 3"}).click();
  await fields.getByRole("button",{name:"Save default fields"}).click();
  await page.getByRole("button",{name:"Save on this device"}).click();
  const add = page.getByRole("button",{name:"Add location",exact:true});
  await add.click();
  await expect(page.getByLabel("Field name 1", {exact:true})).toHaveValue("Candidate class");
  await expect(page.getByLabel("Color flag", {exact:true})).toHaveValue("");
  await expect(page.locator(".saved-editor .saved-color-circle")).toHaveAttribute("data-color","none");
  await page.getByLabel("Location name").fill("Region candidate");
  await page.getByRole("button",{name:"Save entry"}).click();
  const browse = page.getByRole("button",{name:"Browse saved locations",exact:true});
  await browse.click();
  const browser = page.getByRole("dialog",{name:"Browse saved locations",exact:true});
  await browser.getByLabel("Color flag for Region candidate").selectOption("cyan");
  await expect(browser.locator(".saved-color-circle")).toHaveCSS("background-color","rgb(0, 255, 255)");
  await browser.getByRole("button",{name:"Close",exact:true}).click();
  await expect(page.locator(".saved-editor .saved-color-circle")).toHaveCSS("background-color","rgb(0, 255, 255)");
  await page.getByLabel("Save area").selectOption("frame");
  await add.click();
  await expect(page.getByLabel("Field name 2", {exact:true})).toHaveValue("Review");
  await expect(page.getByLabel("Color flag", {exact:true})).toHaveValue("");
  await page.getByLabel("Location name").fill("Entire field");
  await page.getByRole("button",{name:"Save entry"}).click();
  await page.getByRole("button",{name:"Open view"}).click();
  await expect(page.getByLabel("Selected region spectrum",{exact:true})).toHaveCount(0);
  await browse.click();
  await browser.getByRole("button",{name:"Open Region candidate",exact:true}).click();
  await expect(page.getByLabel("Selected region spectrum",{exact:true})).toBeVisible();
  await expect(page.getByText(/Region \(2, 2\).*\(4, 3\)/).last()).toBeVisible();
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey);
  expect(saved.locations.map((e:Entry) => [e.scope,e.color])).toEqual([
    [{kind:"region",box:[1,1,3,2],width:5,height:5},"cyan"], [{kind:"frame"},null],
  ]);
  await browse.click();
  await expect(browser.getByRole("columnheader",{name:"Candidate class",exact:true})).toBeVisible();
  page.once("dialog",dialog => dialog.accept());
  await browser.getByRole("button",{name:"Delete Entire field",exact:true}).click();
  await expect(browser.getByRole("row")).toHaveCount(2);
  await browser.getByRole("button",{name:"Close",exact:true}).click();
});

test("locations-only import preserves the current view, reports new data, and stores the workspace only on consent", async ({
  page,
}) => {
  test.slow();
  await page.route("**/api/presets", (route) =>
    route.fulfill({ json: { presets: [] } }),
  );
  await page.route("**/api/archive/snapshot", (route) =>
    route.fulfill({
      json: {
        products: { demo: "original", new: "recent" },
        complete: true,
        warnings: [],
      },
    }),
  );
  await page.route("**/api/jobs", (route) =>
    route.fulfill({ status: 202, json: { job_id: "demo" } }),
  );
  await page.route("**/api/jobs/demo", (route) =>
    route.fulfill({
      json: {
        status: "complete",
        manifest: {
          frames: [],
          processing: { archive_products: { demo: "original", new: "recent" } },
        },
      },
    }),
  );
  await Promise.all([
    page.waitForResponse("**/api/presets"),
    page.goto("/", {waitUntil:"domcontentloaded"}),
  ]);
  const ra = page.getByRole("textbox", { name: "Right ascension" });
  await ra.fill("22");
  await page.getByText("Saved locations", { exact: true }).click();
  await page.getByText("Import / export JSON", { exact: true }).click();
  await page
    .getByLabel("Import JSON", { exact: true })
    .setInputFiles(jsonFile({ locations: [entry] }));
  await expect(page.getByText(/East field.*1 additional/)).toBeAttached();
  await expect(ra).toHaveValue("22");
  await expect(
    page.getByRole("dialog", { name: "Save your work" }),
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), storageKey))
    .toBeNull();
  await page.getByRole("button", { name: "Session only", exact: true }).click();
  await page
    .getByLabel("Import JSON", { exact: true })
    .setInputFiles(jsonFile({ config, snapshot: entry.snapshot }));
  await expect(ra).toHaveValue("15");
  await expect(
    page.getByLabel("Field of view (arcsec)", { exact: true }),
  ).toHaveValue("480");
  const browse = page.getByRole("button",{name:"Browse saved locations",exact:true});
  const browser = page.getByRole("dialog",{name:"Browse saved locations",exact:true});
  await browse.click();
  await browser.getByRole("button",{name:"Edit East field",exact:true}).click();
  await page.getByRole("button", { name: "+ Add field", exact: true }).click();
  await page.getByLabel("Field name 2", { exact: true }).fill("Follow up?");
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Updated note");
  await page.getByRole("button", { name: "Save entry", exact: true }).click();
  await browse.click();
  await browser.getByRole("searchbox",{name:"Filter saved locations"}).fill("Follow up");
  await expect(browser.getByRole("button",{name:"Edit East field",exact:true})).toBeVisible();
  await browser.getByRole("button",{name:"Close",exact:true}).click();
  await page
    .getByRole("button", { name: "Save your work", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Save on this device", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          JSON.parse(localStorage.getItem(key) ?? "{}").locations?.[0].note,
        storageKey,
      ),
    )
    .toBe("Updated note");
  await page.goto("/", {waitUntil:"domcontentloaded"});
  await expect(ra).toHaveValue("15");
  await page.getByText("Saved locations", { exact: true }).click();
  await browse.click();
  await browser.getByRole("button",{name:"Edit East field",exact:true}).click();
  await expect(page.getByRole("textbox", { name: "Notes", exact: true })).toHaveValue(
    "Updated note",
  );
  await expect(page.getByLabel("Field name 2", { exact: true })).toHaveValue(
    "Follow up?",
  );
  await expect(page.getByLabel("Field value 2", { exact: true })).toHaveValue(
    "",
  );
});
