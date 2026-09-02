import { defineConfig } from '@playwright/test';

const appBaseUrl = process.env.APP_BASE_URL ?? 'http://127.0.0.1:4100';
const isCi = Boolean(process.env.CI);
const disablesNdkOutboxForE2E = process.env.APP_E2E_DISABLE_NDK_OUTBOX === 'true';
const configuredWorkers = Number.parseInt(process.env.PLAYWRIGHT_WORKERS ?? '', 10);
const webServerCommand = `${JSON.stringify(process.execPath)} ./scripts/quasar.cjs dev --port 4100 --hostname 127.0.0.1`;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  fullyParallel: false,
  forbidOnly: isCi,
  retries: isCi ? 1 : 0,
  workers:
    Number.isInteger(configuredWorkers) && configuredWorkers > 0 ? configuredWorkers : isCi ? 1 : 2,
  expect: {
    timeout: 15_000,
  },
  reporter: isCi
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: appBaseUrl,
    browserName: 'chromium',
    headless: true,
    viewport: {
      width: 1440,
      height: 960,
    },
    testIdAttribute: 'data-testid',
    trace: isCi ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: webServerCommand,
    url: appBaseUrl,
    reuseExistingServer: !isCi && !disablesNdkOutboxForE2E,
    timeout: 120_000,
    env: {
      ...process.env,
      ...(isCi && !disablesNdkOutboxForE2E ? { APP_E2E_DISABLE_NDK_OUTBOX: 'true' } : {}),
    },
  },
});
