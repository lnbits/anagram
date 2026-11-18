import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createBuildConfig, probeSettings, probeUrl } from './build-config.mjs';

// The runner must use the same authenticated URL that Tauri embeds at build time.
const path = process.env.ANAGRAM_CALL_TEST_BUILD_CONFIG;
if (!path) throw new Error('Set ANAGRAM_CALL_TEST_BUILD_CONFIG to a temporary JSON file');
await rm(path, { force: true });
const config = createBuildConfig(probeSettings());
const artifacts = resolve('.artifacts/native-calls', process.platform);
await mkdir(artifacts, { recursive: true });
const log = createWriteStream(join(artifacts, 'build.log'));
const build = spawn('cargo', ['build', '--locked', '--manifest-path', 'src-tauri/Cargo.toml'], {
  env: { ...process.env, TAURI_CONFIG: JSON.stringify({ build: { devUrl: probeUrl(config) } }) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
build.stdout.pipe(log, { end: false });
build.stderr.pipe(log, { end: false });
build.stdout.pipe(process.stdout);
build.stderr.pipe(process.stderr);
const timer = setTimeout(() => build.kill(), 20 * 60 * 1000);
try {
  const [code] = await once(build, 'close');
  if (code !== 0) throw new Error(`Native build failed (${code}); see build.log`);
  // Never leave a reusable configuration behind after a failed build.
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
} finally {
  clearTimeout(timer);
  log.end();
}
