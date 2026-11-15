import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

test("selected spectrum bounds every real API download and a clicked image takes the next slot", async ({page, request}) => {
  const python = process.env.PLANETX_TEST_PYTHON;
  test.skip(!python, "Set PLANETX_TEST_PYTHON to a Python interpreter with the backend requirements.");
  test.setTimeout(65000);
  const backend = spawn(python!, [resolve("../BE/tests/delayed_archive.py")], {windowsHide:true});
  const exited = once(backend, "exit");
  backend.stderr.on("data", b => process.stderr.write(b));
  const port = await Promise.race([
    once(backend.stdout, "data").then(([b]) => /ARCHIVE_PORT=(\d+)/.exec(String(b))?.[1]),
    exited.then(() => { throw Error("Delayed archive exited during startup"); }),
  ]);
  const api = "http://127.0.0.1:" + port;
  let brightnessReady!: () => void, wavelengthReady!: () => void;
  const brightness = new Promise<void>(r => { brightnessReady = r; });
  const wavelengths = new Promise<void>(r => { wavelengthReady = r; });
  const state = async () => (await request.get(api + "/fixture")).json();
  const hookErrors: string[] = [];
  page.on("console", msg => { if (/order of Hooks|useEffect changed size|Rendered (more|fewer) hooks/.test(msg.text())) hookErrors.push(msg.text()); });
  let waveRequests = 0, archiveLookups = 0, lastJob = "", failedSelection = false;
  const priority: string[] = [];
  try {
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      const search = new URL(route.request().url()).search;
      if (path.startsWith("/api/archive/channels/")) archiveLookups++;
      if (path === "/api/presets") return route.fulfill({json:{presets:[]}});
      if (path.includes("/surveys/")) return route.fulfill({json:{}});
      if (/\/assets\//.test(path) && path.endsWith(".bin")) {
        if (/spectral/.test(path)) { waveRequests++; await wavelengths; }
        else await brightness;
      }
      const result = await route.fetch({url:api + path + search});
      if (path === "/api/jobs" && result.status() === 202) {
        const body = route.request().postDataJSON();
        expect(body.detectors).toEqual(["D6"]);
        expect(body.channels.D6).toEqual(["D6-16"]);
        lastJob = (await result.json()).job_id;
      }
      if (path.includes("/priority/")) {
        if (result.status() === 202) priority.push(path.split("/").pop()!);
        else failedSelection = true;
      }
      await route.fulfill({response:result,headers:{...result.headers(),"access-control-allow-origin":"*"}});
    });
    await page.goto("/explore");
    const form = page.locator("form.search-panel");
    await form.locator('[name="ra"]').fill("133.795129");
    await form.locator('[name="dec"]').fill("-7.245147");
    await form.locator("#fov").fill("30");
    await form.locator(".search-bands summary").click();
    await form.getByRole("checkbox", {name:"D1 detector"}).uncheck();
    await form.getByRole("checkbox", {name:"D6 detector"}).check();
    const channel = form.getByRole("checkbox", {name:/^D6-16/});
    await channel.check();
    expect((await state()).requests).toEqual([]);
    await form.locator('[name="ra"]').fill("133.8");
    await expect(channel).toBeChecked();
    await form.locator('[name="ra"]').fill("133.795129");
    await form.locator(".search-bands summary").click();
    await page.getByLabel("Load remaining selected bands in background").check();
    const details = page.getByRole("button", {name:"Toggle frame details"});
    if (await details.getAttribute("aria-expanded") === "true") await details.click();
    expect(archiveLookups).toBe(0);
    expect((await state()).probes).toEqual([]);
    await form.getByRole("button",{name:"Search observations"}).click();
    const image = page.getByRole("group", {name:"Displayed image"});
    await expect(image).toContainText("Exposure PNG preview");
    await expect.poll(() => page.evaluate(() => performance.getEntriesByType("measure")
      .some(e => e.name.endsWith(":first-canvas-draw")))).toBe(true);
    const firstImage = await page.evaluate(() => performance.getEntriesByType("measure")
      .find(e => e.name.endsWith(":first-canvas-draw"))!.duration);
    expect((await state()).catalog_done).toBe(false);
    await request.post(api + "/fixture/finish-discovery");
    brightnessReady();
    await expect(image).toContainText("Calibrated exposure");
    expect(waveRequests).toBe(0);
    await details.click();
    await expect.poll(() => waveRequests).toBeGreaterThan(0);
    await expect(image).toContainText("Calibrated exposure");
    const screen = page.getByRole("region", {name:"Observations",exact:true});
    await expect.poll(async () => (await state()).active).toBe(2);
    const prev = (await state()).requests as string[];
    const target = ["match-f","match-e","match-d","match-c"].find(id => !prev.includes(id))!;
    const extras = screen.getByRole("region", {name:"Additional exposures"});
    await extras.locator(".cycle-disclosure").click();
    const row = screen.getByRole("row").filter({has:page.getByText(target,{exact:true})});
    await row.getByRole("button").click();
    await row.getByRole("button").click();
    await expect.poll(() => priority.filter(id => id === target).length).toBeGreaterThan(0);
    await request.post(api + "/fixture/next-slot");
    await expect.poll(async () => (await state()).requests[prev.length]).toBe(target);
    await request.post(api + "/fixture/release");
    await expect.poll(async () => (await state()).requests.length).toBe(6);
    await expect.poll(async () => {
      const j = await (await request.get(api + "/api/jobs/" + lastJob)).json();
      return j.manifest.observations.filter((o: {status:string}) => o.status === "ready").length;
    }).toBe(6);
    const final = await state();
    expect(final.requests.slice().sort()).toEqual(["match-a","match-b","match-c","match-d","match-e","match-f"]);
    expect(final.probes).toEqual(expect.arrayContaining(["unknown","other-subband",...final.requests]));
    expect(final.probes).not.toContain("other-detector");
    expect(final.peak).toBe(2);
    expect(failedSelection).toBe(false);
    await expect(page.getByLabel("Frame details", {exact:true})).toContainText(target);
    await expect(screen.getByRole("row").filter({has:page.getByText("unknown",{exact:true})})
      .getByRole("button",{name:"Retry metadata"})).toBeVisible();
    await expect.poll(() => waveRequests).toBeGreaterThan(0);
    expect(hookErrors).toEqual([]);
    console.log(`Delayed cold live search: first canvas paint ${firstImage.toFixed(0)} ms, before final discovery; ${final.requests.length} selected cutouts, zero excluded; next slot ${target}.`);
  } finally {
    brightnessReady();
    wavelengthReady();
    await page.unrouteAll({behavior:"wait"});
    await page.close();
    if (backend.exitCode === null) {
      await request.post(api + "/fixture/stop").catch(() => backend.kill());
      await exited;
    }
  }
});
