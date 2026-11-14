import { test, expect } from "@playwright/test";
import { defaults } from "../src/lib/imaging";
import {
  checkImportedFields,
  changes,
  readBackup,
  type Entry,
  type Backup,
  type ArchiveCheck,
} from "../src/lib/workspace";

const config = {
  query: { ra_deg: 12, dec_deg: -7 },
  fov: 300,
  display: defaults,
  frame: "test",
};
const entry: Entry = {
  id: "location",
  name: "Star",
  note: "follow up",
  flag: "candidate",
  config,
  position: { ra_deg: 12.001, dec_deg: -7.01 },
  sources: ["test"],
  snapshot: { test: "archive/DR1/test.fits?size=0.1" },
  snapshotComplete: true,
  metadata: {},
};
const backup: Backup = {
  version: 1,
  exported: "2026-11-14T12:00:00Z",
  config,
  locations: [entry],
  snapshot: entry.snapshot,
  snapshotComplete: true,
};

test("round-trips each workspace export section, including picked position and private notes", () => {
  for (const fields of [
    { config },
    { locations: [entry] },
    { config, locations: [entry] },
  ]) {
    const data = readBackup(
      JSON.stringify({ version: 1, exported: backup.exported, ...fields }),
    );
    expect(!!data.config).toBe("config" in fields);
    expect(!!data.locations).toBe("locations" in fields);
    if (data.locations) expect(data.locations[0]).toMatchObject(entry);
  }
});
test("rejects invalid or duplicate entries and invalid settings before restoring", () => {
  for (const invalid of [
    { ...backup, locations: [entry, entry] },
    {
      ...backup,
      locations: [{ ...entry, position: { ra_deg: 360, dec_deg: 0 } }],
    },
    {
      ...backup,
      config: {
        ...config,
        query: { ...config.query, start_utc: "2026-02-30" },
      },
    },
    {
      ...backup,
      config: { ...config, display: { ...defaults, stops: [null, null] } },
    },
    {
      ...backup,
      config: { ...config, display: { ...defaults, operands: { D2: "yes" } } },
    },
  ])
    expect(() => readBackup(JSON.stringify(invalid))).toThrow();
});
test("comparing a legacy cutout to the same source product does not imply reprocessing", () => {
  expect(changes(entry.snapshot, { test: "archive/DR1/test.fits" }, true)).toBe(
    "",
  );
});
test("checks every saved field once, compares distinct baselines and reports partial or failed checks", async () => {
  const b: Backup = {
    ...backup,
    locations: [
      { ...entry, snapshot: {} },
      {
        ...entry,
        id: "second",
        name: "second",
        config: { ...config, query: { ra_deg: 33, dec_deg: 9 } },
      },
    ],
  };
  const queries: number[] = [],
    checks: ArchiveCheck[] = [];
  await checkImportedFields(
    b,
    new AbortController().signal,
    async (q) => {
      queries.push(q.ra_deg);
      if (q.ra_deg === 33) throw Error("Archive offline");
      return {
        products: {
          test: "archive/DR1/test.fits",
          other: "archive/QR3/other.fits",
        },
        complete: false,
        warnings: [],
      };
    },
    (c) => checks.push(c),
  );
  expect(queries).toEqual([12, 33]);
  expect(checks).toHaveLength(3);
  expect(checks[0].details).toContain("1 additional");
  expect(checks[1].details).toContain("2 additional");
  expect(checks[0].details).toContain("incomplete");
  expect(checks[2].details).toContain("Archive offline");
});

test("sampled older exports cannot establish that newly visible observations were newly published", () => {
  for (const snapshotComplete of [undefined, false]) {
    const loaded = readBackup(
      JSON.stringify({
        ...backup,
        snapshotComplete,
        locations: [{ ...entry, snapshotComplete }],
      }),
    );
    expect(loaded.snapshotComplete).toBe(false);
    expect(loaded.locations?.[0].snapshotComplete).toBe(false);
    const text = changes(
      loaded.snapshot!,
      { test: "archive/another-version.fits", b: "newly-visible" },
      loaded.snapshotComplete,
    );
    expect(text).toContain("1 currently visible observations were absent");
    expect(text).toContain("arrival since export cannot be confirmed");
    expect(text).toContain("different processing versions");
    expect(text).not.toContain("additional observations since the export");
  }
});
