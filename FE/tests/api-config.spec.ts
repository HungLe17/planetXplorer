import { test, expect } from "@playwright/test";
import { normalizeApiBase } from "../src/lib/api-config";

test("a Render hostname becomes an absolute HTTPS origin", () => {
  expect(normalizeApiBase("planetxplorer.onrender.com/")).toBe(
    "https://planetxplorer.onrender.com",
  );
  expect(normalizeApiBase("  https://planetxplorer.onrender.com/  ")).toBe(
    "https://planetxplorer.onrender.com",
  );
  expect(normalizeApiBase("127.0.0.1:8000/")).toBe("http://127.0.0.1:8000");
  expect(normalizeApiBase("https://example.com/backend/")).toBe(
    "https://example.com/backend",
  );
});

test("documentation URLs and invalid settings explain the configuration error", () => {
  for (const path of ["/api", "/docs", "/redoc", "/openapi.json"]) {
    expect(() =>
      normalizeApiBase("https://planetxplorer.onrender.com" + path),
    ).toThrow("without /api");
  }
  for (const value of [
    "",
    "https://",
    "file:///tmp/backend",
    "https://example.com?api=1",
  ]) {
    expect(() => normalizeApiBase(value)).toThrow(/NEXT_PUBLIC_API_BASE_URL/);
  }
});
