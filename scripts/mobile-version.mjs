import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { releaseVersion } from './set-release-version.mjs';

export function mobileVersion(tag, runNumber) {
  const version = releaseVersion(tag).split('-')[0];
  const build = Number(runNumber);
  if (!Number.isInteger(build) || build < 1 || build > 2100000000)
    throw new Error('Mobile build number must be a positive integer <= 2100000000');
  // Apple's marketing version is numeric; RC suffixes remain in artifact names.
  return {
    version,
    bundle: { android: { versionCode: build }, iOS: { bundleVersion: String(build) } },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  writeFileSync(
    'src-tauri/mobile-version.json',
    JSON.stringify(mobileVersion(version, process.env.GITHUB_RUN_NUMBER ?? '1')) + '\n',
  );
}
