import adapter from '@sveltejs/adapter-static';
import { readFileSync } from 'node:fs';
const appVersion = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version;
const buildId = `${appVersion}-${process.env.GITHUB_SHA || Date.now()}`;
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
export default defineConfig(({ command }) => ({
  plugins: [
    sveltekit({
      preprocess: vitePreprocess(),
      adapter: adapter({ fallback: 'index.html' }),
      serviceWorker: { register: false },
      ...(command === 'build'
        ? {
            csp: {
              mode: 'hash' as const,
              directives: {
                'default-src': ['self'],
                'script-src': ['self', 'wasm-unsafe-eval'],
                'style-src': ['self', 'unsafe-inline'],
                'img-src': ['self', 'https:', 'data:', 'blob:'],
                'media-src': ['self', 'https:', 'blob:', 'data:'],
                'connect-src': [
                  'self',
                  'https:',
                  'wss:',
                  'ws://localhost:*',
                  'ws://127.0.0.1:*',
                  'ipc:',
                  'http://ipc.localhost',
                ],
                'worker-src': ['self', 'blob:'],
                'font-src': ['self'],
                'object-src': ['none'],
                'base-uri': ['none'],
                'form-action': ['self'],
              },
            },
          }
        : {}),
      paths: { relative: false },
      version: { name: buildId },
    }),
    {
      name: 'anagram-build-info',
      generateBundle() {
        if (this.environment.name === 'client')
          this.emitFile({
            type: 'asset',
            fileName: 'build-info.json',
            source: JSON.stringify({ appVersion, bundleId: buildId }),
          });
      },
    },
  ],
  define: {
    'process.env': JSON.stringify({
      APP_VERSION: appVersion,
      APP_BUNDLE_ID: buildId,
      APP_ENABLE_APP_SHELL: command === 'build',
      APP_IROH_RELAY_URL: process.env.APP_IROH_RELAY_URL,
    }),
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**', '**/build/**', '**/test-results/**', '**/playwright-report/**'],
    },
  },
  clearScreen: false,
}));
