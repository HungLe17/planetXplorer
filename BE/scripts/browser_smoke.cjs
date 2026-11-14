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
      page.getByRole("button", { name: "Play", exact: true }),
    ).toBeEnabled({ timeout: 60000 });
    const acquisition = page
      .locator(".detail-group")
      .first()
      .locator("dd")
      .first();
    const first = await acquisition.innerText();
    await page.getByRole("button", { name: "Next frame", exact: true }).click();
    const second = await acquisition.innerText();
    if (first === second)
      throw new Error("Displayed acquisition time did not advance");
    const job = await (
      await fetch("http://127.0.0.1:8000/api/jobs/" + job_id)
    ).json();
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
