import { defineConfig } from '@playwright/test';
const liveCalls = process.env.ANAGRAM_LIVE_CALL_TEST === '1';
const port = Number(process.env.ANAGRAM_E2E_PORT ?? (liveCalls ? 5187 : 5173));
export default defineConfig({
  testDir: './e2e',
  testIgnore: ['**/pwa/**', '**/memory-lifetime.spec.ts'],
  timeout: 90000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: liveCalls
        ? `APP_IROH_RELAY_URL=https://127.0.0.1:7004/ npm run dev -- --port ${port}`
        : `npm run dev -- --port ${port}`,
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: !liveCalls && !process.env.ANAGRAM_E2E_PORT,
    },
    ...(liveCalls
      ? [{ command: 'node scripts/iroh-test-proxy.cjs', port: 7004, reuseExistingServer: false }]
      : []),
    { command: 'node scripts/test-relay.mjs', port: 7777, reuseExistingServer: true },
    {
      command: 'TEST_RELAY_PORT=7778 node scripts/test-relay.mjs',
      port: 7778,
      reuseExistingServer: true,
    },
  ],
});
