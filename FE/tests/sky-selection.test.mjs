import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { customSkyTarget } from "../src/lib/sky-selection.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./imaging" && context.parentURL?.endsWith("/exploration-presets.ts"))
      return nextResolve(new URL("./imaging.ts", context.parentURL).href, context);
    return nextResolve(specifier, context);
  },
});
const { explorerHref, viewingPresets } = await import("../src/lib/exploration-presets.ts");

test("any valid picked position opens the exact sky field and chosen view", () => {
  const target = customSkyTarget({ ra: 117.1234567, dec: -34.7654321 });
  assert.ok(target);
  for (const preset of viewingPresets) {
    const link = new URL(explorerHref(target, preset.id), "https://example.test");
    assert.equal(Number(link.searchParams.get("ra")), 117.1234567);
    assert.equal(Number(link.searchParams.get("dec")), -34.7654321);
    assert.equal(Number(link.searchParams.get("fov")), 900);
    assert.deepEqual(JSON.parse(link.searchParams.get("view")), preset.display);
  }
});

test("dragging and positions outside the sky cannot select a new field", () => {
  for (const position of [null, undefined, { ra: 10, dec: 20, isDragging: true },
    { ra: NaN, dec: 0 }, { ra: 0, dec: Infinity }, { ra: 0, dec: 90.001 },
    { ra: 0, dec: -90.001 }]) assert.equal(customSkyTarget(position), null);
});

test("coordinates wrap at the meridian and accept both celestial poles", () => {
  assert.equal(customSkyTarget({ ra: -0.25, dec: 90 }).ra_deg, 359.75);
  assert.equal(customSkyTarget({ ra: 720, dec: -90 }).ra_deg, 0);
  assert.equal(customSkyTarget({ ra: 0, dec: -90 }).dec_deg, -90);
});
