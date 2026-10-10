import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: { src: fileURLToPath(new URL('./src', import.meta.url)) } },
  // Bound worker contention: the IndexedDB migration tests share the host CPU.
  test: { maxWorkers: 4, include: ['tests/unit/**/*.spec.ts'], setupFiles: ['tests/setup.ts'] },
});
