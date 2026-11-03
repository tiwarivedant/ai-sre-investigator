import { defineConfig } from "@playwright/test";

// End-to-end tests against the real app in replay mode: no API key, no network,
// deterministic. The test server uses its own port, build folder and
// investigations folder, so it never touches a dev server you have running.
const PORT = 3210;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Playwright's bundled Chromium by default (`npx playwright install chromium` once).
    // PW_CHANNEL=chrome uses an installed Google Chrome instead.
    channel: process.env.PW_CHANNEL || undefined,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}/api/config`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      REPLAY: "1",
      REPLAY_DELAY_MS: "400",
      NEXT_DIST_DIR: ".next-e2e",
      INVESTIGATIONS_DIR: ".investigations-e2e",
    },
  },
});
