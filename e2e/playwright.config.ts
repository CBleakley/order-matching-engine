import { defineConfig, devices } from '@playwright/test';

// Each test starts its own engine service, gateway and web server (see
// src/fixtures.ts), so there is no shared webServer here. Tests run one at a
// time: a stack is several processes, and the restart tests are timing
// sensitive.
export default defineConfig({
  testDir: 'tests',
  globalSetup: './src/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  reporter: process.env.CI === undefined ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
