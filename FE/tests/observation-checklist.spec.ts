import { expect, test } from "@playwright/test";

test("cycle checklist groups measured wavelengths and keeps an explicit exclusion through a catalog refresh", async ({page}) => {
  const field = {ra_deg: 5, dec_deg: 2, fov_arcsec: 30, live: true, detectors: ["D1"]};
  const days = ["2025-05-11", "2025-11-13"];
  const frames = days.map((day, i) => ({
    id: "frame-" + i, observation_id: "star-" + i, visit_id: "pass-" + i,
    observed_at: day + "T00:00:00Z", detector: "D1", channel: "D1 1.000000 µm (v1)",
    wavelength_um: 1.0, nominal_channel:13, bandwidth_um: 0.03, processing_version: "v1", sequence_id: "matched-D1",
    match_wavelengths: Array(5).fill(1.0), match_bandwidths: Array(5).fill(0.03),
    release: "DR1", url: "/api/assets/field/frame-" + i + ".png", pixels: "frame-" + i + ".bin",
  }));
  const observations = frames.map(f => ({...f, id: f.observation_id, status: "ready", selection: "matched"}));
  const pending = {id: "infrared", detector: "D2", release: "DR1", observed_at: frames[0].observed_at,
    visit_id: "pass-0", status: "pending", selection: "excluded"};
  const redder = {...pending, id: "redder", detector: "D1", channel: "D1 1.065000 µm (v1)",
    wavelength_um: 1.065, nominal_channel:16, status: "failed", selection: "matched"};
  const visits = days.map((day, i) => ({id: "pass-" + i, kind: "cycle", status: "pending", issues: [],
    start_utc: day + "T00:00:00Z", end_utc: day + "T01:00:00Z",
    observation_ids: i === 0 ? ["star-0", redder.id, pending.id] : ["star-1"],
  }));
  let finish!: () => void;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  let polls = 0;
  await page.route("**/api/presets", r => r.fulfill({json: {presets: []}}));
  await page.route("**/api/jobs", r => r.fulfill({json: {job_id: "field"}}));
  await page.route("**/api/jobs/field", async r => {
    const revision = ++polls;
    if (revision > 1) await hold;
    const infrared = revision === 1 ? pending : {...pending, channel: "D2 1.450000 µm (v1)", wavelength_um: 1.45, nominal_channel:12};
    await r.fulfill({json: {status: revision === 1 ? "running" : "complete", manifest: {
      query: field, frames, observations: [...observations, redder, infrared], visits,
      processing: {output_shape: [5, 5], revision},
      sequences: [{id: "matched-D1", detector: "D1", wavelength_um: 1, processing_version: "v1",
        frame_ids: frames.map(f => f.id), stretch: {}}],
    }}});
  });
  await page.route("**/api/assets/field/*.bin", r => r.fulfill({
    body: Buffer.from(Float32Array.from({length: 25}, (_, i) => i + 1).buffer),
  }));
  try {
    await page.goto("/explore?ra=5&dec=2&fov=30&bands=" + encodeURIComponent(JSON.stringify({detectors: ["D1"]})));
    const dock = page.getByRole("region", {name: "Observations", exact: true});
    const cycle = dock.getByRole("region", {name: "Cycle 1", exact: true});
    await cycle.locator(".cycle-disclosure").click();
    const d1 = cycle.getByRole("table", {name: "D1 exposures"});
    const d2 = cycle.getByRole("table", {name: "D2 exposures"});
    const pick = d1.getByRole("checkbox", {name: "Include star-0 in timeline"});
    await expect(d1.getByRole("rowgroup", {name: "D1-13 · 1.001 µm"})).toContainText("star-0");
    const red = d1.getByRole("rowgroup", {name: "D1-16 · 1.075 µm"});
    await expect(red).toContainText(redder.id);
    await expect(red).toContainText("1.065000");
    await expect(d2.getByRole("rowgroup", {name: /nominal spectrum unverified/i})).toContainText("infrared");
    await expect(d2.getByRole("checkbox")).toBeDisabled();
    await expect(pick).toBeChecked();
    await pick.uncheck();
    await expect(pick).not.toBeChecked();
    finish();
    await expect(d2.getByRole("rowgroup", {name: "D2-12 · 1.446 µm"})).toBeVisible();
    await expect(pick).not.toBeChecked();
    await pick.check();
    await expect(pick).toBeChecked();
    await d1.getByRole("button", {name: "View", exact: true}).click();
    await expect(pick).toBeChecked();
  } finally {
    finish();
  }
});
