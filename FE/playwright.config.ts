import { defineConfig } from "@playwright/test";
const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error("Invalid PLAYWRIGHT_PORT");
const origin = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./tests",
  use: {
    baseURL: origin,
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL,
  },
  webServer: {
    command: "node node_modules/next/dist/bin/next " +
      (process.env.PLAYWRIGHT_PRODUCTION === "1" ? "start" : "dev --webpack") +
      ` --hostname 127.0.0.1 --port ${port}`,
    url: origin,
    reuseExistingServer: true,
    timeout: 120000,
  },
});
