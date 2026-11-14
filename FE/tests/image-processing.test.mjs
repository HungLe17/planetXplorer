import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import gifenc from "gifenc";
import {
  defaults,
  products,
  displayBounds,
  intensityByte,
  palette,
  thermal,
  skyPosition,
  skyPixel,
  previewScale,
  fillImageData,
  exportName,
  grey,
} from "../src/lib/imaging.ts";

function exposure(detector, wavelength, date, values) {
  const id = detector + "-" + wavelength + "-" + date;
  return {
    frame: {
      id,
      url: id + ".png",
      observation_id: id,
      observed_at: date,
      detector,
      wavelength_um: wavelength,
      channel: detector + " " + wavelength + " µm",
    },
    values: Float32Array.from(values),
  };
}
const a = exposure("D2", 1.1, "2026-01-01", [2, NaN]);
const b = exposure("D2", 1.2, "2026-06-01", [8, 12]);
const c = exposure("D3", 2.2, "2026-11-10", [3, 4]);

test("detector selection averages wavelengths equally rather than weighting by exposure counts", () => {
  const later = exposure("D2", 1.1, "2026-12-10", [6, 8]);
  const images = products([a, b, c, later], {
    ...defaults,
    windowDays: 0,
    operands: { D2: 1, [c.frame.channel]: -1 },
  });
  assert.equal(images.length, 1);
  assert.deepEqual([...images[0].planes[0]], [3, 6]);
  assert.equal(images[0].inputs.length, 4);
});

test("static RGB uses the selected exposures regardless of date window", () => {
  const s = {
    ...defaults,
    mode: "rgb",
    rgb: [c, a, b].map((p) => p.frame.observation_id),
    difference: true,
    windowDays: 0,
  };
  const [p] = products([a, b, c], s);
  assert.deepEqual(p.planes, [c.values, a.values, b.values]);
  assert.deepEqual(p.inputs, [c.frame, a.frame, b.frame]);
  assert.deepEqual(products([a, b], s), []);
});

test("WiseView subtraction sums inside-window values and excludes nearby reference epochs", () => {
  const frames = [
    exposure("D2", 1, "2026-01-01", [9, NaN]),
    exposure("D2", 1, "2026-01-02", [10, NaN]),
    exposure("D2", 1, "2026-01-04", [999, 10]),
    exposure("D2", 1, "2026-01-20", [2, 12]),
    exposure("D2", 1, "2026-01-30", [4, 12]),
    b,
  ];
  const [p] = products(frames, {
    ...defaults,
    operands: { [frames[0].frame.channel]: 1 },
    windowDays: 4,
    exclusionDays: 8,
    difference: true,
  });
  assert.deepEqual([...p.planes[0]], [13, NaN]);
  assert.deepEqual(
    p.inputs.map((f) => f.id),
    frames.slice(0, 2).map((p) => p.frame.id),
  );
  assert.deepEqual(
    p.reference.map((f) => f.id),
    frames.slice(3, 5).map((p) => p.frame.id),
  );
  assert.deepEqual(
    products(frames.slice(0, 2), { ...defaults, difference: true }),
    [],
  );
});

test("stretch shares physical bounds and preserves negative data and missing values", () => {
  const e = exposure("D4", 2.5, "2026-01-02", [-10, NaN, 15, 90]);
  const images = products([e], defaults);
  const bounds = displayBounds(images, defaults);
  assert.deepEqual(bounds, [-10, 90]);
  for (const stretch of ["linear", "sqrt", "log", "asinh"]) {
    assert.equal(intensityByte(-10, bounds, stretch), 0);
    assert.equal(intensityByte(90, bounds, stretch), 255);
    assert.equal(intensityByte(12, [12, 12], stretch), 128);
  }
  assert.equal(intensityByte(15, bounds, "sqrt"), 128);
  assert.equal(intensityByte(15, bounds, "linear"), 64);
  assert.deepEqual(palette(thermal)[255], [255, 255, 200]);
  assert.deepEqual([...e.values], [-10, NaN, 15, 90]);
});

test("north-up and east-left sky selection wraps RA at the meridian", () => {
  const q = { ra_deg: 0, dec_deg: 10 };
  assert.deepEqual(skyPosition(q, 1, 1, 3, 3), q);
  assert.ok(skyPosition(q, 0, 1, 3, 3).ra_deg > 0);
  assert.ok(skyPosition(q, 2, 1, 3, 3).ra_deg > 359);
  assert.ok(skyPosition(q, 1, 0, 3, 3).dec_deg > q.dec_deg);
});

test("saved selected sky coordinates restore to the same pixel around RA wrap and high declination", () => {
  for (const q of [
    { ra_deg: 359.999, dec_deg: 88 },
    { ra_deg: 13, dec_deg: -85 },
  ])
    for (const [x, y] of [
      [0, 0],
      [9, 12],
      [48, 48],
    ]) {
      assert.deepEqual(skyPixel(q, skyPosition(q, x, y, 49, 49), 49, 49), [
        x,
        y,
      ]);
      assert.equal(
        skyPixel(q, { ra_deg: 100, dec_deg: -q.dec_deg }, 49, 49),
        null,
      );
    }
});

test("rendering feeds measured RGB and transparent invalid pixels to image export", () => {
  const rgb = [a, c, b].map((p) => p.values);
  const rgba = new Uint8ClampedArray(8);
  fillImageData(rgba, rgb, [0, 10], "linear", palette(thermal));
  assert.deepEqual([...rgba], [51, 77, 204, 255, 0, 0, 0, 0]);
  const animation = gifenc.GIFEncoder();
  for (const e of [b, c]) {
    const pixels = new Uint8ClampedArray(8);
    fillImageData(pixels, [e.values], [0, 12], "sqrt", palette(grey));
    const colors = gifenc.quantize(pixels, 256);
    animation.writeFrame(gifenc.applyPalette(pixels, colors), 2, 1, {
      palette: colors,
      repeat: 0,
      delay: 500,
    });
  }
  animation.finish();
  const bytes = Buffer.from(animation.bytes());
  assert.equal(bytes.subarray(0, 6).toString("ascii"), "GIF89a");
  assert.equal(bytes.readUint16LE(6), 2);
  assert.equal(bytes.readUint16LE(8), 1);
  assert.ok(bytes.includes("NETSCAPE2.0"));
  assert.equal(bytes.at(-1), 0x3b);
  let i = bytes.indexOf(Buffer.from([0x21, 0xf9, 4])),
    frames = 0;
  while (i >= 0) {
    assert.equal(bytes.readUInt16LE(i + 4), 50);
    frames++;
    i = bytes.indexOf(Buffer.from([0x21, 0xf9, 4]), i + 1);
  }
  assert.equal(frames, 2);
});

test("export filenames retain provenance for static composites and animations", () => {
  const q = { ra_deg: 1, dec_deg: -2, fov_arcsec: 400 };
  const name = exportName(
    [
      {
        ...b.frame,
        sourceDates: [
          c.frame.observed_at,
          a.frame.observed_at,
          b.frame.observed_at,
        ],
      },
    ],
    q,
    2,
  );
  assert.equal(
    name,
    "2026-01-01T00-00-00Z_to_2026-11-10T00-00-00Z_N-up_E-left_RA1_Dec-2_FOV400arcsec_zoom2",
  );
});

test("prepared preview legends reuse their recorded grayscale stretch and units", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../BE/demos/barnard/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const scale = previewScale(fixture);
  assert.equal(scale.stretch, "asinh");
  assert.equal(scale.units, "MJy/sr");
  assert.deepEqual(scale.bounds, [
    fixture.processing.stretch.vmin,
    fixture.processing.stretch.vmax,
  ]);
  assert.deepEqual(previewScale({ frames: [], stretch: "asinh" }), {
    bounds: [0, 255],
    stretch: "linear",
    units: "display levels",
  });
});
