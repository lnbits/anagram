// Optional interoperability check when this example is inside the Anagram repository.
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const port = Number(process.env.ANAGRAM_E2E_PORT || 5261);
export default defineConfig({
  testDir: './test',
  testMatch: 'anagram.spec.js',
  workers: 1,
  timeout: 120000,
  outputDir: './data/browser-results',
  reporter: 'list',
  expect: { timeout: 20000 },
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
