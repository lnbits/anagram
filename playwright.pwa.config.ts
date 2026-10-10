import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e/pwa',
  outputDir: '.artifacts/pwa-results',
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5189',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/pwa/static-server.mjs',
    url: 'http://127.0.0.1:5189',
    reuseExistingServer: false,
  },
});
