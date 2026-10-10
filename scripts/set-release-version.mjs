import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export function releaseVersion(tag) {
  const version = String(tag ?? '').replace(/^v/, '');
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      version,
    )
  )
    throw new Error(
      'Release tag must be vMAJOR.MINOR.PATCH (optionally -beta.1), without build metadata.',
    );
  const [core, ...prerelease] = version.split('-');
  if (
    core.split('.').some((part) => Number(part) > 65535) ||
    prerelease
      .join('-')
      .split('.')
      .some((part) => /^0\d+$/.test(part))
  )
    throw new Error('Version is not compatible with desktop installers.');
  return version;
}
export function setReleaseVersion(tag, root = new URL('../', import.meta.url)) {
  const version = releaseVersion(tag);
  for (const file of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']) {
    const url = new URL(file, root),
      value = JSON.parse(readFileSync(url, 'utf8'));
    value.version = version;
    if (file === 'package-lock.json') value.packages[''].version = version;
    writeFileSync(url, JSON.stringify(value, null, 2) + '\n');
  }
  for (const file of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
    const url = new URL(file, root),
      source = readFileSync(url, 'utf8');
    const updated = source.replace(
      /(name = "anagram"\r?\nversion = ")[^"]+(")/,
      (_match, prefix, suffix) => prefix + version + suffix,
    );
    if (updated === source && !source.includes(`name = "anagram"\nversion = "${version}"`))
      throw new Error(`Cannot locate app version in ${file}`);
    writeFileSync(url, updated);
  }
  console.log(`Release version: ${version}`);
  return version;
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  setReleaseVersion(process.env.RELEASE_TAG ?? process.argv[2]);
