import { expect, test } from "@playwright/test";
import { matchedSpectra } from "../src/lib/matched-spectra";

test("published detector channel groups different measured centers and separates adjacent stripes", () => {
  const frames = [4.960624,4.968150,4.975530].map((w,i) => ({
    id:"f"+i, observation_id:"o"+i, detector:"D6", nominal_channel:i === 2 ? 17 : 16,
    sequence_id:"old-"+i, processing_version:i ? "7.0.5" : "7.0.4", wavelength_um:w, url:"",
    observed_at:["2025-09-11","2026-09-13","2026-02-27"][i] + "T00:00:00Z",
  }));
  const groups = matchedSpectra({frames}, {});
  expect(groups.map(g => [g.id,g.epochs.map(e => e.source.wavelength_um)])).toEqual([
    ["D6-16",[4.960624,4.968150]], ["D6-17",[4.975530]]]);
});

test("Matched groups the two June and December D6 exposures despite different missing corners", async ({page}) => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const colors = [[5.00359155,5.00604479,4.99751876,null,5.00114249],
    [5.00370663,5.00125650,null,4.99763320,5.00616092]];
  const frames = ["june","repeat","dec","incompatible"].map((id,i) => {
    const wave = [...colors[i === 2 ? 1 : 0]];
    if (i === 3) wave[1] = 5.2;
    return { id, observation_id:id, detector:"D6", observed_at:["2025-06-27","2025-06-28","2025-12-16","2025-12-17"][i]+"T00:00:00Z",
      sequence_id:i < 2 ? "june" : id, processing_version:"7.0.5", wavelength_um:wave[0]!, bandwidth_um:0.037,
      match_wavelengths:wave, match_bandwidths:wave.map(w => w === null ? null : .037),
      url:"/api/assets/field/"+id+".png", pixels:id+".bin" };
  });
  const visits = [[0,1],[2,3]].map((pos,i) => ({id:"pass"+i, kind:"supplemental", status:"pending",
    start_utc:frames[pos[0]].observed_at, end_utc:frames[pos[1]].observed_at,
    observation_ids:pos.map(p => frames[p].id), issues:[]}));
  const sequences = ["june","dec","incompatible"].map(id => ({id,detector:"D6",processing_version:"7.0.5",
    wavelength_um:frames.find(f => f.id===id)!.wavelength_um, frame_ids:frames.filter(f => f.sequence_id===id).map(f => f.id), stretch:{}}));
  await page.route("**/api/presets", r => r.fulfill({json:{presets:[]}}));
  await page.route("**/api/jobs", r => r.fulfill({json:{job_id:"field"}}));
  await page.route("**/api/jobs/field", r => r.fulfill({json:{status:"complete",manifest:{frames,visits,sequences,processing:{output_shape:[2,2]}}}}));
  await page.route("**/api/assets/field/*.png", r => r.fulfill({body:Buffer.from(png,"base64"),contentType:"image/png"}));
  await page.route("**/api/assets/field/*.bin", r => r.fulfill({body:Buffer.from(new Float32Array([0,1,2,4]).buffer),contentType:"application/octet-stream"}));
  await page.goto("/explore?ra=150&dec=5");
  const mode = page.getByRole("button",{name:"Matched",exact:true});
  await mode.click();
  const picker = page.getByLabel("Matched spectra",{exact:true});
  await expect(picker).toContainText("2 epochs · partial coverage");
  await picker.click();
  const band = page.locator(".matched-options").getByLabel("D6 spectra",{exact:true}).locator("..");
  await expect(band.locator("details")).toHaveCount(2);
  const track = band.getByLabel(/D6 5\.003592 µm · 2 epochs/).locator("..");
  await expect(track.getByRole("button")).toHaveCount(2);
  await track.getByRole("button",{name:/16 Dec/}).click();
  await expect(page.locator(".frame-counter")).toHaveText(/02\s*\/\s*02/);
  await page.getByRole("button",{name:"Previous cycle",exact:true}).click();
  await expect(page.locator(".frame-counter")).toHaveText(/01\s*\/\s*02/);
  const stretch = page.locator(".map-stretch select").first();
  await page.getByRole("checkbox",{name:"Color scale",exact:true}).check();
  for (const value of ["sqrt","log"]) {
    await stretch.selectOption(value);
    await expect(page.getByRole("group",{name:"Displayed color scale"})).toContainText(value);
    await expect(mode).toHaveAttribute("aria-pressed","true");
  }
  await page.getByRole("button",{name:"Loop playback",exact:true}).click();
  await page.locator("#speed").selectOption("4");
  await page.getByRole("button",{name:"Play",exact:true}).click();
  await expect(page.locator(".frame-counter")).toHaveText(/02\s*\/\s*02/);
  await expect(mode).toHaveAttribute("aria-pressed","true");
});
