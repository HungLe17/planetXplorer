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
  inspectBand,
  bandWarning,
  pixelVisible,
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

test("the unfiltered timeline includes each ready wavelength in acquisition order", () => {
  for (const ready of [[b], [a, b], [a, b, c]])
    assert.deepEqual(
      products(ready, defaults).map((p) => p.frame),
      ready.map((p) => p.frame),
    );
});

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

function qualityExposure(
  detector,
  wavelength,
  archived,
  flags,
  status,
  science = archived.map(() => NaN),
) {
  return {
    ...exposure(detector, wavelength, "2026-01-01", science),
    quality: {
      archived: Float32Array.from(archived),
      flags: Uint32Array.from(flags),
      status: Uint8Array.from(status),
    },
  };
}

function renderBytes(product, bounds, inspectFlagged = false, stops = grey) {
  const rgba = new Uint8ClampedArray(product.planes[0].length * 4);
  fillImageData(
    rgba,
    product.planes,
    bounds,
    "linear",
    palette(stops),
    product.sourcePlanes,
    inspectFlagged,
  );
  return [...rgba];
}

test("Barnard RGB marks two archived overflow NaNs and preserves the third band's measurement", () => {
  const source = 1 << 21,
    bloom = 1 << 26,
    overflow = 1 << 1,
    error = 1 << 2;
  const core = source | bloom | overflow | error;
  const red = qualityExposure(
    "D3",
    2.31,
    [NaN, 12, 99999],
    [core, bloom, 0],
    [131, 2, 1],
  );
  const green = qualityExposure(
    "D6",
    4.72,
    [1722.82, 10, NaN],
    [source | bloom | overflow, 0, 0],
    [2, 1, 0],
  );
  const blue = qualityExposure(
    "D3",
    2.27,
    [NaN, 8, NaN],
    [core, 0, 0],
    [131, 1, 0],
  );
  const bands = [red, green, blue];
  const [p] = products(bands, {
    ...defaults,
    mode: "rgb",
    rgb: bands.map((b) => b.frame.observation_id),
  });
  assert.deepEqual(
    renderBytes(p, [0, 2000]),
    [255, 220, 255, 255, 2, 1, 1, 255, 0, 0, 0, 0],
  );
  assert.deepEqual(displayBounds([p], defaults), [8, Math.fround(1722.82)]);
  assert.deepEqual(inspectBand(red, 0, false), {
    archived: NaN,
    flags: ["OVERFLOW", "SUR_ERROR", "SOURCE", "BLOOM"],
    treatment: "Overflow · shown at maximum",
    uncertaintyUnavailable: true,
    warning: true,
  });
  assert.equal(inspectBand(green, 0, false).archived, Math.fround(1722.82));
  assert.equal(pixelVisible(p, 0, false), true);
  assert.equal(pixelVisible(p, 2, true), false);
  for (const science of p.planes) assert.ok(Number.isNaN(science[0]));
});

test("single-band inspection admits flagged finite values while gaps and hard masks stay transparent", () => {
  const e = qualityExposure(
    "D6",
    4,
    [NaN, 5, 10, NaN, 999, 11, 12, NaN],
    [2, 1 << 10, 1 << 21, 2 | 512, 2 | 64, 0, 1 << 31, 0],
    [131, 4, 1, 133, 5, 130, 4, 0],
    [NaN, NaN, 8, NaN, NaN, NaN, NaN, NaN],
  );
  const [p] = products([e], {
    ...defaults,
    operands: { [e.frame.channel]: 1 },
  });
  assert.deepEqual(displayBounds([p], defaults), [8, 11]);
  assert.deepEqual(
    displayBounds([p], { ...defaults, inspectFlagged: true }),
    [5, 12],
  );
  assert.deepEqual(renderBytes(p, [0, 10], false, thermal).slice(0, 4), [
    ...palette(thermal)[255],
    255,
  ]);
  assert.deepEqual(
    renderBytes(p, [0, 10], false).filter((_, i) => i % 4 === 3),
    [255, 0, 255, 0, 0, 255, 0, 0],
  );
  assert.deepEqual(
    renderBytes(p, [0, 10], true).filter((_, i) => i % 4 === 3),
    [255, 255, 255, 0, 0, 255, 255, 0],
  );
  assert.equal(inspectBand(e, 2, false).archived, 10);
  assert.deepEqual(inspectBand(e, 6, true).flags, ["Bit 31"]);
  assert.ok(inspectBand(e, 5, false).uncertaintyUnavailable);
  assert.equal(bandWarning(e.quality, 1, false), false);
  assert.equal(bandWarning(e.quality, 1, true), true);
});

test("overflow and inspection-only brightness never contribute to detector averages or differences", () => {
  const e = qualityExposure(
    "D6",
    4,
    [NaN, 999, 2],
    [2, 1 << 10, 0],
    [131, 4, 1],
    [NaN, NaN, 2],
  );
  const anotherBand = exposure("D6", 4.1, "2026-01-02", [2, 3, 4]);
  const later = exposure("D6", 4, "2026-12-01", [1, 1, 1]);
  const settings = { ...defaults, inspectFlagged: true, operands: { D6: 1 } };
  const [average] = products([e, anotherBand], settings);
  assert.equal(average.sourcePlanes, undefined);
  assert.deepEqual([...average.planes[0]], [2, 3, 3]);
  const [difference] = products([e, later], {
    ...settings,
    operands: { [e.frame.channel]: 1 },
    difference: true,
    windowDays: 1,
    exclusionDays: 2,
  });
  assert.equal(difference.sourcePlanes, undefined);
  assert.deepEqual([...difference.planes[0]], [NaN, NaN, 1]);
  assert.deepEqual(
    renderBytes(difference, [0, 10], true).slice(0, 8),
    Array(8).fill(0),
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
