import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { defaults, readMaps } from "../src/lib/imaging.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./imaging" && context.parentURL?.endsWith("/exploration-presets.ts"))
      return nextResolve(new URL("./imaging.ts", context.parentURL).href, context);
    return nextResolve(specifier, context);
  },
});
const { skyTargets, viewingPresets, explorerHref, clonePresetDisplay } =
  await import("../src/lib/exploration-presets.ts");

test("target links preserve backend coordinates and provide valid bounded fields", () => {
  const source = JSON.parse(readFileSync(new URL("../../BE/presets.json", import.meta.url), "utf8"));
  assert.equal(skyTargets.length, 7);
  assert.equal(new Set(skyTargets.map((target) => target.id)).size, 7);
  for (const original of source) {
    const target = skyTargets.find((item) => item.id === original.id);
    assert.ok(target, original.id);
    assert.equal(target.ra_deg, original.ra_deg);
    assert.equal(target.dec_deg, original.dec_deg);
  }
  for (const target of skyTargets) {
    assert.ok(target.ra_deg >= 0 && target.ra_deg < 360);
    assert.ok(target.dec_deg >= -90 && target.dec_deg <= 90);
    assert.ok(target.fov_arcsec >= 30 && target.fov_arcsec <= 1800);
    const link = new URL(explorerHref(target), "https://example.test");
    assert.equal(link.pathname, "/explore");
    assert.equal(Number(link.searchParams.get("ra")), target.ra_deg);
    assert.equal(Number(link.searchParams.get("dec")), target.dec_deg);
    assert.equal(Number(link.searchParams.get("fov")), target.fov_arcsec);
  }
});

test("each target and view combination round-trips the intended bands and map settings", () => {
  for (const target of skyTargets) {
    for (const preset of viewingPresets) {
      const link = new URL(explorerHref(target, preset.id), "https://example.test");
      assert.deepEqual(JSON.parse(link.searchParams.get("bands")), {
        detectors: preset.detectors,
        channels: preset.channels,
      });
      const display = JSON.parse(link.searchParams.get("view"));
      assert.deepEqual(display, preset.display);
      assert.deepEqual(readMaps(display.maps, defaults), preset.display.maps);
      assert.ok(!link.searchParams.has("frame"));
      assert.ok(!link.href.includes("snapshot"));
      assert.ok(!link.href.includes("fits"));
    }
  }
});

test("the imported preset preserves the requested nominal channels and transparent RGB maps", () => {
  const preset = viewingPresets[0];
  assert.deepEqual(preset.detectors, ["D1", "D3", "D6"]);
  assert.deepEqual(preset.channels, { D1: ["D1-01"], D3: ["D3-17"], D6: ["D6-17"] });
  assert.deepEqual(preset.display.maps.map((map) => map.operands), [{ D1: 1 }, { D3: 1 }, { D6: 1 }]);
  assert.deepEqual(preset.display.maps.map((map) => map.stretch), ["sqrt", "sqrt", "sqrt"]);
  assert.deepEqual(preset.display.maps.map((map) => map.stops[0].color), Array(3).fill("#00000000"));
  assert.deepEqual(preset.display.maps.map((map) => map.stops[1].color), ["#0000ff", "#00ff00", "#ff0000"]);
});

test("applying a view cannot mutate a preset or another view", () => {
  for (const preset of viewingPresets) {
    const original = JSON.stringify(preset.display);
    const display = clonePresetDisplay(preset);
    display.maps[0].operands.D1 = -1;
    display.maps[0].stops[0].color = "#ffffff";
    display.stops[0].color = "#ffffff";
    display.rgb[0] = "changed";
    assert.equal(JSON.stringify(preset.display), original);
  }
  assert.deepEqual(viewingPresets[1].channels, {});
  assert.deepEqual(viewingPresets[2].channels, {});
  assert.deepEqual(viewingPresets[1].display.maps.map((map) => map.stretch), Array(3).fill("asinh"));
  assert.deepEqual(viewingPresets[2].display.maps.map((map) => map.stretch), Array(3).fill("asinh"));
});
