import { expect, test } from "@playwright/test";

test("subtract calibrated cycles through the viewer and inspect both signs", async ({page}) => {
  const visits = ["early", "late", "unmatched"].map((id, i) => ({
    id, kind:"cycle", status:"complete", issues:[], observation_ids:[id + "-d1"],
    start_utc:new Date(Date.UTC(2025, i * 6, 1)).toISOString(),
    end_utc:new Date(Date.UTC(2025, i * 6, 2)).toISOString(),
  }));
  const frames = visits.map(v => ({
    id:v.observation_ids[0], observation_id:v.observation_ids[0], visit_id:v.id,
    observed_at:v.start_utc, detector:"D1", channel:"D1 1.000 µm (v1)", processing_version:"v1",
    sequence_id:v.id === "unmatched" ? "other" : "shared", wavelength_um:1, bandwidth_um:0.02,
    url:"/api/assets/test/" + v.id + ".png", pixels:v.id + ".bin",
  }));
  await page.route("**/api/presets", r => r.fulfill({json:{presets:[]}}));
  await page.route("**/api/jobs", r => r.fulfill({json:{job_id:"signed"}}));
  await page.route("**/api/jobs/signed", r => r.fulfill({json:{status:"complete", manifest:{
    visits, frames, processing:{output_shape:[2,2]},
  }}}));
  await page.route("**/api/assets/test/*.bin", r => r.fulfill({body:Buffer.from(
    Float32Array.from(r.request().url().endsWith("/early.bin") ? [8,1,2,4] : [1,8,2,NaN]).buffer)}));
  await page.goto("/explore?ra=5&dec=4&fov=30");
  await expect(page.getByLabel("Displayed image")).toContainText("Visit composite");
  await page.getByRole("button", {name:"Subtract", exact:true}).click();
  const image = page.getByLabel("Displayed image");
  await expect(image).toContainText("Cycle difference · reference 2025-01-01");
  await expect(image.locator("time")).toHaveAttribute("datetime", frames[1].observed_at);
  const ref = page.getByLabel("Reference cycle");
  await expect(ref.locator("option[value=unmatched]")).toHaveCount(0);
  const canvas = page.locator("canvas");
  const box = (await canvas.boundingBox())!;
  const spacing = Math.min(box.width, box.height) * 0.94 / 4;
  for (const [side, delta] of [[-1, "-7.0000"], [1, "7.0000"]] as const) {
    await canvas.click({position:{x:box.width / 2 + side * spacing, y:box.height / 2 - spacing}});
    await expect(page.getByText(/Δ at pixel/)).toContainText(delta + " MJy/sr");
  }
  await ref.selectOption("late");
  await page.getByRole("button", {name:"First cycle", exact:true}).click();
  await expect(image).toContainText("Cycle difference · reference 2025-07-01");
  await expect(page.getByText(/Δ at pixel/)).toContainText("-7.0000 MJy/sr");
  await page.getByRole("button", {name:"Visits", exact:true}).click();
  await expect(image).toContainText("Visit composite");
});
