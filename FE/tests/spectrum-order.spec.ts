import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

for (const failFirst of [false, true]) {
  test(`Search finishes the first wavelength across three cycles before moving on (${failFirst ? "one failed" : "all successful"})`, async ({page, request}) => {
    const python = process.env.PLANETX_TEST_PYTHON;
    test.skip(!python, "Set PLANETX_TEST_PYTHON to the backend interpreter.");
    test.setTimeout(65000);
    const args = [resolve("../BE/tests/spectrum_archive.py"), ...(failFirst ? ["--fail"] : [])];
    const backend = spawn(python!, args, {windowsHide: true});
    const exited = once(backend, "exit");
    backend.stderr.on("data", data => process.stderr.write(data));
    const port = await Promise.race([
      once(backend.stdout, "data").then(([data]) => /ARCHIVE_PORT=(\d+)/.exec(String(data))?.[1]),
      exited.then(() => { throw Error("Spectrum archive exited before startup"); }),
    ]);
    const api = "http://127.0.0.1:" + port;
    const batches: string[][] = [];
    let job = "", pickerLookups = 0;
    try {
      await page.route("**/api/**", async route => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith("/api/archive/channels/")) pickerLookups++;
        if (url.pathname === "/api/presets") return route.fulfill({json:{presets:[]}});
        if (url.pathname.includes("/surveys/")) return route.fulfill({json:{}});
        const response = await route.fetch({url:api + url.pathname + url.search});
        if (url.pathname === "/api/jobs" && response.status() === 202) {
          expect(route.request().postDataJSON().channels).toEqual({D6:["D6-11","D6-16"]});
          job = (await response.json()).job_id;
        }
        if (url.pathname.endsWith("/load")) {
          expect(response.status()).toBe(202);
          const body = route.request().postDataJSON();
          if (!body.metadata_only) batches.push(body.observation_ids);
        }
        await route.fulfill({response, headers:{...response.headers(), "access-control-allow-origin":"*"}});
      });
      await page.goto("/explore");
      const form = page.locator("form.search-panel");
      await form.locator('[name="ra"]').fill("133.795129");
      await form.locator('[name="dec"]').fill("-7.245147");
      await form.locator("#fov").fill("30");
      await form.locator(".search-bands summary").click();
      await form.getByRole("checkbox", {name:"D1 detector"}).uncheck();
      await form.getByRole("checkbox", {name:"D6 detector"}).check();
      await form.getByRole("checkbox", {name:/^D6-11/}).check();
      await form.getByRole("checkbox", {name:/^D6-16/}).check();
      await form.locator(".search-bands summary").click();
      await page.getByLabel("Load remaining selected bands in background").check();
      expect(pickerLookups).toBe(0);
      await form.getByRole("button", {name:"Search observations"}).click();
      const events = async (): Promise<[string, string][]> => (await (await request.get(api + "/fixture")).json()).events;
      await expect.poll(async () => (await events()).filter(([kind]) => kind !== "start").length, {timeout:35000}).toBe(6);
      const history = await events();
      const first = ["a-may25", "a-nov25", "a-may26"];
      const second = ["b-may25", "b-nov25", "b-may26"];
      const opened = history.filter(([kind]) => kind === "start").map(([, id]) => id);
      expect(new Set(opened.slice(0, 3))).toEqual(new Set(first));
      expect(new Set(opened.slice(3))).toEqual(new Set(second));
      const firstB = history.findIndex(([, id]) => id.startsWith("b-"));
      expect(history.slice(0, firstB).filter(([kind]) => kind !== "start")).toHaveLength(3);
      expect(history.filter(([kind]) => kind === "failed").map(([, id]) => id)).toEqual(failFirst ? ["a-may26"] : []);
      const status = async () => (await (await request.get(api + "/api/jobs/" + job)).json()).manifest;
      await expect.poll(async () => (await status()).observations.filter((r: {status:string}) => r.status === "ready").length).toBe(failFirst ? 5 : 6);
      expect((await status()).visits.filter((v: {kind:string}) => v.kind === "cycle")).toHaveLength(3);
      expect(batches.flat().some(id => id.startsWith("a-"))).toBe(true);
      expect(batches.flat().filter(id => id.startsWith("b-")).sort()).toEqual(second.sort());
      for (const batch of batches) {
        expect(batch.length).toBeLessThanOrEqual(2);
        expect(new Set(batch.map(id => id[0])).size).toBe(1);
      }
    } finally {
      await page.unrouteAll({behavior:"wait"});
      await page.close();
      if (backend.exitCode === null) {
        await request.post(api + "/fixture/stop").catch(() => backend.kill());
        await exited;
      }
    }
  });
}
