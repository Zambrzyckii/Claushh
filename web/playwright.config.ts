import { defineConfig, devices } from '@playwright/test';

/**
 * E2e tests: the built app (dist/) in Chromium on the mock backend from e2e/mock-api/server.mjs.
 * Running: `npm run e2e` (build + tests). The mock has shared state, so the tests run one after another.
 * CHROMIUM_PATH lets you use a browser installed on the system instead of `npx playwright install chromium`.
 */
const PORT = 4400;

export default defineConfig({
  testDir: 'e2e/tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 30_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    launchOptions: process.env['CHROMIUM_PATH'] ? { executablePath: process.env['CHROMIUM_PATH'] } : {}
  },
  webServer: {
    command: 'node e2e/mock-api/server.mjs',
    url: `http://localhost:${PORT}/__test/state`,
    reuseExistingServer: false,
    env: { MOCK_PORT: String(PORT) }
  }
});
