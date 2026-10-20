import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('The iOS simulator requires macOS');
const target = { x64: 'x86_64', arm64: 'aarch64-sim' }[process.arch];
if (!target) throw new Error(`Unsupported simulator host: ${process.arch}`);

// Tauri's archive command can select a device destination even with a simulator
// SDK. Its subprocess environment drops XCODE_XCCONFIG_FILE, so supply an explicit
// archive destination through a wrapper scoped to this one command's PATH.
const temporary = mkdtempSync(join(tmpdir(), 'anagram-simulator-tools-'));
try {
  writeFileSync(
    join(temporary, 'xcodebuild'),
    `#!/bin/bash
set -euo pipefail
archive=false
for arg in "$@"; do
  if [[ "$arg" == archive ]]; then archive=true; fi
done
if "$archive"; then
  args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -sdk|-destination) shift 2 ;;
      *) args+=("$1"); shift ;;
    esac
  done
  exec /usr/bin/xcodebuild "\${args[@]}" -sdk iphonesimulator -destination 'generic/platform=iOS Simulator'
fi
exec /usr/bin/xcodebuild "$@"
`,
    { mode: 0o755 },
  );
  execFileSync(
    'npm',
    [
      'run',
      'tauri',
      '--',
      'ios',
      'build',
      '--ci',
      '--target',
      target,
      '--no-sign',
      '--archive-only',
      '--config',
      'src-tauri/mobile-version.json',
      '--',
      '--locked',
    ],
    {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: { ...process.env, PATH: `${temporary}:${process.env.PATH}` },
      stdio: 'inherit',
    },
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
