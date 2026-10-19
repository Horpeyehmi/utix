import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

/** Run with: npx playwright test --config=features/multisig-analyzer/playwright.config.ts */
export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../test-results/multisig-analyzer",
  workers: 1,
  timeout: 60_000,
  use: { baseURL: "http://localhost:3000", browserName: "chromium", headless: true },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } }
  ],
  webServer: {
    command: "npm run dev",
    cwd: resolve(__dirname, "../.."),
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
