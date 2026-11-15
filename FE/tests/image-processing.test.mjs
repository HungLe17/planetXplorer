import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import gifenc from "gifenc";
import {
  activeChannels,
  activeDetectors,
  archivedAt,
  defaults,
  exportName,
  fillComposite,
  frameAsset,
  grey,
  inspectBand,
  imageTimeline,
  intensityByte,
  mapBounds,
  measureSpectrum,
  newMap,
  palette,
  previewScale,
  products,
  readMaps,
  skyPixel,
  skyPosition,
  spectrumBins,
  thermal,
} from "../src/lib/imaging.ts";

function exposure(detector, wavelength, date, values, quality) {
  const id = detector + "-" + wavelength + "-" + date;
  return {
    frame: {
      id,
      observation_id: id,
      url: id + ".png",
      detector,
      observed_at: date,
      wavelength_um: wavelength,
      channel: detector + " " + wavelength + " µm",
    },
    values: Float32Array.from(values),
    quality,
  };
}
const a = exposure("D1", 1.0, "2026-01-01", [2, 8]),
  b = exposure("D2", 1.2, "2026-01-04", [5, 2]),
  c = exposure("D1", 1.0, "2026-06-02", [20, 10]);
function visit(id, planes, status = "complete") {
  return {
    id,
    observation_ids: planes.map((p) => p.frame.observation_id),
    start_utc: planes[0].frame.observed_at,
    end_utc: planes.at(-1).frame.observed_at,
    status,
    issues: [],
  };
}
function map(name, operands, extra = {}) {
  return { ...newMap(name, name), operands, ...extra };
}
function rgba(p) {
  const input = new Uint8ClampedArray(4 * p.layers[0].values.length);
  const scales = p.layers.map(({ map, values }) => ({
    ...map,
    bounds: mapBounds(values, map),
  }));
  fillComposite(input, p.layers, scales);
  return [...input];
}
test("visits combine signed channels only within the same valid visit; raw browsing retains each exposure", () => {
  const d = exposure("D1", 0.9, "2026-01-02", [7, 1]);
  const data = [a, d, b, c],
    visits = [visit("one", [a, d, b]), visit("two", [c], "invalid")];
  const display = {
    ...defaults,
    maps: [map("sum", { D1: 1, D2: -1 }), map("D2", { [b.frame.channel]: 1 })],
  };
  const [out] = products(data, display, visits);
  assert.equal(out.frame.observation_id, "one");
  assert.deepEqual([...out.layers[0].values], [4, 7]);
  assert.deepEqual([...out.layers[1].values], [5, 2]);
  assert.deepEqual(out.sourcePlanes, [a, d, b]);
  assert.equal(products(data, display, visits).length, 1);
  assert.deepEqual(
    products(data, display, visits, true).map((p) => p.frame),
    data.map((p) => p.frame),
  );
  assert.deepEqual(
    products(data, display).map((p) => p.frame),
    data.map((p) => p.frame),
  );
});
test("supplemental exposures remain browsable and do not enter cycle maps or difference references", () => {
  const extra = exposure("D1", 1.0, "2026-04-01", [500, 300]);
  const planes = [a, extra, c];
  const visits = [visit("jan", [a]), { ...visit("apr", [extra]), kind: "supplemental" }, visit("jun", [c])];
  const display = {
    ...defaults,
    maps: [map("diff", { D1: 1 }, { difference: true, windowDays: 1, exclusionDays: 3 })],
  };
  const grouped = products(planes, display, visits);
  assert.deepEqual(grouped.map(p => p.frame.observation_id), ["jan", "jun"]);
  assert.deepEqual([...grouped[1].layers[0].values], [18, 2]);
  assert.deepEqual(products(planes, defaults, visits, true).map(p => p.frame), planes.map(p => p.frame));
});
test("two rows add colors, saturate components at 255 and preserve alpha", () => {
  const e = exposure("D1", 1, "2026-01-01", [10, 5, NaN, -4]),
    other = exposure("D2", 1.2, "2026-01-01", [10, NaN, 8, -3]);
  const rows = [
    map(
      "R",
      { D1: 1 },
      {
        stops: [
          { at: 0, color: "#ff000000" },
          { at: 1, color: "#ff0000" },
        ],
        low: "0",
        high: "10",
        stretch: "linear",
      },
    ),
    map(
      "yellow",
      { D2: 1 },
      {
        stops: [
          { at: 0, color: "#ffff00" },
          { at: 1, color: "#ffff00" },
        ],
      },
    ),
  ];
  const [p] = products([e, other], { ...defaults, maps: rows }, [
    visit("v", [e, other]),
  ]);
  assert.deepEqual(
    rgba(p),
    [255, 255, 0, 255, 255, 0, 0, 128, 255, 255, 0, 255, 0, 0, 0, 0],
  );
});
test("pixel flags preserve finite archives, negatives remain available in Details and overflow uses field max before manual stretch", () => {
  const q = {
    archived: Float32Array.from([2, 8, NaN, -3, NaN, 999]),
    flags: Uint32Array.from([1 << 6, 1 << 21, 2, 1 << 31, 0, 0]),
    status: Uint8Array.from([5, 1, 131, 4, 5, 0]),
  };
  const e = exposure("D1", 1, "2026-01-01", [NaN, 7, NaN, NaN, NaN, NaN], q);
  const [p] = products(
    [e],
    {
      ...defaults,
      maps: [
        map("field", { D1: 1 }, { low: "0", high: "16", stretch: "linear" }),
      ],
    },
    [visit("v", [e])],
  );
  assert.deepEqual([...p.layers[0].values], [2, 8, 8, NaN, NaN, NaN]);
  assert.deepEqual(
    rgba(p).filter((_, i) => i % 4 === 0),
    [32, 128, 128, 0, 0, 0],
  );
  assert.ok(Number.isNaN(archivedAt(e, 2)));
  assert.equal(inspectBand(e, 3).archived, -3);
  assert.deepEqual(inspectBand(e, 3).flags, ["Bit 31"]);
  assert.ok(inspectBand(e, 2).uncertaintyUnavailable);
});
test("spectra retain an overflow-only archive as missing while the picture has a visible marker", () => {
  const e = exposure("D1", 1, "2026-01-01", [NaN], {
    archived: Float32Array.of(NaN),
    flags: Uint32Array.of(2),
    status: Uint8Array.of(3),
  });
  const [p] = products([e], defaults, [visit("v", [e])]);
  assert.deepEqual(rgba(p), [255, 255, 255, 255]);
  assert.ok(Number.isNaN(inspectBand(e, 0).archived));
});
test("pending channels never produce partial signed expressions; independent complete layers are visible", () => {
  const v = visit("pending", [a, b], "pending");
  const [p] = products(
    [a],
    {
      ...defaults,
      maps: [map("incomplete", { D1: 1, D2: -1 }), map("ready", { D1: 1 })],
    },
    [v],
  );
  assert.deepEqual(
    p.layers.map((l) => l.map.name),
    ["ready"],
  );
});
test("difference uses only matching channels in the configured windows; migration retains pinned RGB inputs", () => {
  const first = visit("jan", [a, b]),
    second = visit("jun", [c]);
  const display = {
    ...defaults,
    maps: [
      map(
        "diff",
        { D1: 1 },
        { difference: true, windowDays: 1, exclusionDays: 3 },
      ),
    ],
  };
  assert.deepEqual(
    [...products([a, b, c], display, [first, second])[1].layers[0].values],
    [18, 2],
  );
  const migrated = readMaps(undefined, {
    ...defaults,
    mode: "rgb",
    rgb: [a.frame.id, b.frame.id, c.frame.id],
  });
  assert.deepEqual(
    migrated.map((m) => m.name),
    ["Red", "Green", "Blue"],
  );
  assert.equal(Object.keys(migrated[0].operands)[0], "exposure:" + a.frame.id);
  assert.deepEqual(readMaps(migrated, defaults), migrated);
  assert.throws(() =>
    readMaps([{ ...migrated[0], stops: [null, null] }], defaults),
  );
});
test("detector demand unions channels across rows; whole detectors take precedence", () => {
  const key = "D4 3.100000 µm (7.0.5)";
  const s = {
    ...defaults,
    maps: [
      map("one", { D1: 1, [key]: -1 }),
      map("two", { "D1 0.811000 µm (7.0.5)": 1 }),
    ],
  };
  assert.deepEqual(activeDetectors(s), ["D1", "D4"]);
  assert.deepEqual(activeChannels(s), { D4: [key] });
  assert.deepEqual(activeDetectors({ ...defaults, maps: [] }), []);
  assert.deepEqual(activeDetectors({
    ...defaults, maps: [map("pinned", { "exposure:someD6": 1 })],
  }), []); // A pinned exposure is scheduled by catalog ID, independently of detector demand.
});
test("pixel wavelength, signed brightness and overflow share detector bins across field and rectangle spectra", () => {
  const first = exposure("D1", 0.9, "2026-01-01", [0, 0, 0], {
    archived: Float32Array.from([2, -4, NaN]),
    flags: Uint32Array.from([0, 1 << 21, 2]),
    status: Uint8Array.from([1, 1, 3]),
  });
  const second = exposure("D1", 1.0, "2026-01-02", [12, 6, 3]);
  first.wavelengths = Float32Array.from([0.89, 0.98, 0.94]);
  second.wavelengths = Float32Array.from([0.99, 0.96, NaN]);
  const planes = [first, second],
    centers = spectrumBins(planes);
  const field = measureSpectrum(planes, centers, 3, [0, 0, 2, 0], true);
  assert.deepEqual(
    field.bins.map((p) => p.finite),
    [1, 3],
  );
  assert.deepEqual(
    field.bins.map((p) => p.mean),
    [2, 14 / 3],
  );
  assert.equal(field.samples[0].overflow, 1);
  assert.deepEqual(
    [...field.samples[0].flags],
    [
      ["SOURCE", 1],
      ["OVERFLOW", 1],
    ],
  );
  const pixel = measureSpectrum(planes, centers, 3, [1, 0, 1, 0], true);
  assert.equal(pixel.bins.length, 1);
  assert.equal(pixel.bins[0].mean, 1);
  assert.ok(Math.abs(pixel.bins[0].wave - 0.97) < 1e-6);
  assert.equal(pixel.samples[0].mean, -4);
  assert.deepEqual(field.domain, [0.75, 5, 0, 12 * 1.04]);
  const waiting = { ...first, frame: { ...first.frame, spectral: "wave.bin" }, wavelengths: undefined };
  const unfinished = measureSpectrum([waiting], centers, 3, [0, 0, 0, 0], true);
  assert.equal(unfinished.samples[0].mean, 2);
  assert.deepEqual(unfinished.bins, []);
});
test("existing stretches and GIF export retain their calibrated intensity scales", () => {
  assert.equal(intensityByte(15, [-10, 90], "sqrt"), 128);
  assert.equal(intensityByte(15, [-10, 90], "linear"), 64);
  assert.equal(intensityByte(1, [1, 1], "asinh"), 128);
  assert.equal(intensityByte(4, [0, 4], "log"), 255);
  assert.deepEqual(palette(thermal)[255], [255, 255, 200, 255]);
  const animation = gifenc.GIFEncoder();
  for (const plane of [a, b]) {
    const [p] = products([plane], defaults, [], true),
      pixels = Uint8Array.from(rgba(p)),
      colors = gifenc.quantize(pixels, 256);
    animation.writeFrame(gifenc.applyPalette(pixels, colors), 2, 1, {
      palette: colors,
      repeat: 0,
      delay: 500,
    });
  }
  animation.finish();
  assert.equal(
    Buffer.from(animation.bytes()).subarray(0, 6).toString(),
    "GIF89a",
  );
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
    "2026-01-01T00-00-00Z_to_2026-06-02T00-00-00Z_N-up_E-left_RA1_Dec-2_FOV400arcsec_zoom2",
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

test("mixed manifests keep chronological raw PNGs and calibrated products with aligned lookup; grouped views omit PNGs", () => {
  const preview = {
    ...a.frame,
    id: "legacy",
    observation_id: "legacy",
    url: "/api/assets/job/legacy.png",
  };
  const numeric = {
    ...b.frame,
    pixels: "cal.bin",
    url: "/api/assets/job/cal.png",
  };
  const manifest = {
    frames: [preview, numeric],
    visits: [visit("jan", [a, b], "invalid")],
  };
  const [product] = products([{ ...b, frame: numeric }], defaults, [], true);
  for (const [m, raw] of [
    [manifest, true],
    [{ frames: manifest.frames }, false],
  ]) {
    const out = imageTimeline(m, [numeric], [product], raw);
    assert.deepEqual(
      out.frames.map((f) => f.id),
      ["legacy", numeric.id],
    );
    assert.equal(out.result[0], undefined);
    assert.equal(out.result[1], product);
    assert.equal(out.frames[0].previewScale.units, "display levels");
  }
  assert.deepEqual(imageTimeline(manifest, [], [], false), {
    frames: [],
    result: [],
  });
  assert.equal(
    frameAsset(numeric, "cal.bin", "https://example.invalid/"),
    "https://example.invalid/api/assets/job/cal.bin",
  );
});
