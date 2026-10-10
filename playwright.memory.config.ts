import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Keep the E2E module bridge, but compile Svelte without development/HMR graphs.
// This measures production rendering; it is not a substitute for built-PWA tests.
const port = Number(process.env.ANAGRAM_E2E_PORT ?? 5192);
const servers = Array.isArray(base.webServer) ? base.webServer : [base.webServer!];
export default defineConfig({
  ...base,
  testIgnore: [],
  testMatch: '**/memory-lifetime.spec.ts',
  use: { ...base.use, baseURL: `http://127.0.0.1:${port}`, trace: 'off' },
  webServer: [
    {
      ...servers[0],
      command: `npm run dev -- --port ${port}`,
      url: `http://127.0.0.1:${port}`,
      env: { NODE_ENV: 'production' },
      reuseExistingServer: false,
    },
    ...servers.slice(1),
  ],
});
