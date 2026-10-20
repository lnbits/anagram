import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repositoryRoot = new URL('../', import.meta.url);
const mobileVersionFile = 'src-tauri/mobile-version.json';
const cargoVersionPattern = /(name = "anagram"\r?\nversion = ")([^"]+)(")/;

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
// Keep the updater and the read-only CI check on the same list of version fields.
function readReleaseFiles(root) {
  const jsonFiles = ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json'];
  if (existsSync(new URL(mobileVersionFile, root))) jsonFiles.push(mobileVersionFile);
  const files = jsonFiles.map((file) => {
    const value = JSON.parse(readFileSync(new URL(file, root), 'utf8'));
    const versions = [['version', value.version]];
    if (file === 'package-lock.json') {
      if (!value.packages?.['']) throw new Error(`Cannot locate root package in ${file}`);
      versions.push(['packages[""].version', value.packages[''].version]);
    }
    return {
      file,
      versions,
      serialize(version) {
        value.version = version;
        if (file === 'package-lock.json') value.packages[''].version = version;
        return JSON.stringify(value, null, 2) + '\n';
      },
    };
  });
  for (const file of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']) {
    const source = readFileSync(new URL(file, root), 'utf8');
    const match = source.match(cargoVersionPattern);
    if (!match) throw new Error(`Cannot locate app version in ${file}`);
    files.push({
      file,
      versions: [['anagram.version', match[2]]],
      serialize: (version) =>
        source.replace(
          cargoVersionPattern,
          (_match, prefix, _previous, suffix) => prefix + version + suffix,
        ),
    });
  }
  return files;
}

function fileVersion(version, file) {
  // Mobile marketing versions omit prerelease suffixes; build numbers stay separate.
  return file === mobileVersionFile ? version.split('-')[0] : version;
}

export function checkReleaseVersion(tag, root = repositoryRoot) {
  const files = readReleaseFiles(root);
  const version = releaseVersion(tag ?? files[0].versions[0][1]);
  const mismatches = files.flatMap(({ file, versions }) =>
    versions
      .filter(([, actual]) => actual !== fileVersion(version, file))
      .map(
        ([field, actual]) =>
          `${file} (${field}): expected ${fileVersion(version, file)}, found ${actual ?? '<missing>'}`,
      ),
  );
  if (mismatches.length)
    throw new Error(
      `Release version mismatch:\n${mismatches.join('\n')}\n` +
        `Run npm run release:version -- ${version} and commit the version files before tagging.`,
    );
  console.log(`Release versions match: ${version}`);
  return version;
}

export function setReleaseVersion(tag, root = repositoryRoot) {
  const version = releaseVersion(tag);
  // Read and prepare every file before writing, so malformed inputs cannot leave a partial bump.
  const updates = readReleaseFiles(root).map(({ file, serialize }) => ({
    file,
    source: serialize(fileVersion(version, file)),
  }));
  for (const { file, source } of updates) writeFileSync(new URL(file, root), source);
  console.log(`Release version: ${version}`);
  return version;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const check = args[0] === '--check';
    if (check) args.shift();
    if (args.length > 1) throw new Error('Usage: set-release-version.mjs [--check] [version]');
    const tag = args[0] ?? (process.env.RELEASE_TAG || undefined);
    if (check) checkReleaseVersion(tag);
    else setReleaseVersion(tag);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
