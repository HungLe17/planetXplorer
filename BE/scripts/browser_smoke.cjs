// Requires the frontend on 3000 and backend on 8000; no mocked responses.
const { chromium, expect } = require("../../FE/node_modules/@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const submitted = page.waitForResponse(
      (r) => r.url().endsWith("/api/jobs") && r.request().method() === "POST",
    );
    await page.goto("http://127.0.0.1:3000");
    // The initial field must come from the backend's available archive sequences.
    const response = await submitted;
    if (response.status() !== 202)
      throw new Error("Submission failed: " + (await response.text()));
    const { job_id } = await response.json();
    await expect(
      page.getByRole("button", { name: "Zoom in", exact: true }),
    ).toBeEnabled({ timeout: 180000 });
    let job;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      job = await (
        await fetch("http://127.0.0.1:8000/api/jobs/" + job_id)
      ).json();
      if (["complete", "partial", "failed"].includes(job.status)) break;
      await page.waitForTimeout(1000);
    }
    if (!job.manifest?.frames?.length)
      throw new Error(job.error || "No archive-backed image was loaded");
    const best = [...(job.manifest.sequences || [])].sort(
      (a, b) => b.frame_ids.length - a.frame_ids.length,
    )[0];
    let first, second;
    if (best?.frame_ids.length > 1) {
      await page.getByRole("button", { name: "Matched", exact: true }).click();
      await page.getByLabel("Wavelength sequence").selectOption(best.id);
    }
    if (best?.frame_ids.length > 1 || job.manifest.frames.length > 1) {
      await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
      const acquisition = page.locator(".detail-group").filter({
        has: page.getByRole("heading", { name: "Acquisition", exact: true }),
      }).locator("dd").first();
      first = await acquisition.innerText();
      await page.getByRole("button", { name: "Next frame", exact: true }).click();
      await expect(acquisition).not.toHaveText(first);
      second = await acquisition.innerText();
    }
    const destination = path.join(__dirname, "..", ".cache", "integration");
    fs.mkdirSync(destination, { recursive: true });
    await page.screenshot({
      path: path.join(destination, "frontend-backend.png"),
      caret: "initial",
    });
    const report = {
      job_id,
      status: job.status,
      cached: job.manifest.cached,
      observations: job.manifest.observations.length,
      sequences: job.manifest.sequences.length,
      largest_sequence: best?.frame_ids.length || 0,
      frames: job.manifest.frames.length,
      first,
      second,
      browser_errors: errors,
    };
    fs.writeFileSync(
      path.join(destination, "report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
    if (errors.length) throw new Error("Browser errors: " + errors.join("; "));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
