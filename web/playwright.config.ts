import { defineConfig, devices } from '@playwright/test';

/**
 * E2e tests: the built app (dist/) in Chromium on the mock backend, as a desktop (1440×900) and as a phone (Pixel 7,
 * only phone.spec.ts) from e2e/mock-api/server.mjs.
 * Running: `npm run e2e` (build + tests). The mock has shared state, so the tests run one after another.
 * CHROMIUM_PATH lets you use a browser installed on the system instead of `npx playwright install chromium`.
 */
const PORT = 4400;
/** The mock listens only on 127.0.0.1 (it has unsecured /__test/* endpoints). */
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: 'e2e/tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 30_000,
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    reducedMotion: 'reduce',
    launchOptions: process.env['CHROMIUM_PATH'] ? { executablePath: process.env['CHROMIUM_PATH'] } : {}
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
      testIgnore: /phone\.spec\.ts/
    },
    { name: 'phone', use: { ...devices['Pixel 7'] }, testMatch: /phone\.spec\.ts/ }
  ],
  webServer: {
    command: 'node e2e/mock-api/server.mjs',
    url: `${BASE_URL}/__test/state`,
    reuseExistingServer: false,
    env: { MOCK_PORT: String(PORT) }
  }
});
