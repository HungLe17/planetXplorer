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
  await expect(page.getByText(/East field.*1 additional/)).toBeVisible();
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
  await page.getByRole("button", { name: /East field/ }).click();
  await page.getByRole("button", { name: "+ Add field", exact: true }).click();
  await page.getByLabel("Field name 2", { exact: true }).fill("Follow up?");
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Updated note");
  await page.getByRole("button", { name: "Save entry", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Find locations" })
    .fill("Follow up");
  await expect(page.getByRole("button", { name: /East field/ })).toBeVisible();
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
  await page.getByRole("button", { name: /East field/ }).click();
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
