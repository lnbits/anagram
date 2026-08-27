const fs = require('node:fs');
const path = require('node:path');

const projectRoot = process.env.VERSION_BUMP_PROJECT_ROOT
  ? path.resolve(process.env.VERSION_BUMP_PROJECT_ROOT)
  : path.resolve(__dirname, '..');

const files = {
  rootPackage: path.resolve(projectRoot, 'package.json'),
  rootLock: path.resolve(projectRoot, 'package-lock.json'),
  capacitorPackage: path.resolve(projectRoot, 'src-capacitor/package.json'),
  capacitorLock: path.resolve(projectRoot, 'src-capacitor/package-lock.json'),
};

const args = parseArgs(process.argv.slice(2));
const rootPackage = readJson(files.rootPackage);
const capacitorPackage = readJson(files.capacitorPackage);
const currentVersion = parseVersion(rootPackage.version, 'package.json version');
const targetVersion = resolveTargetVersion(currentVersion, args.target);
const currentAndroidVersionCode = resolveCurrentAndroidVersionCode(capacitorPackage);
const androidVersionCode = resolveAndroidVersionCode(
  currentAndroidVersionCode,
  args.androidVersionCode
);

if (
  formatVersion(targetVersion) === formatVersion(currentVersion) &&
  args.androidVersionCode == null
) {
  fail(`Version is already ${formatVersion(targetVersion)}. Provide a higher version or use --android-version-code.`);
}

updatePackageJson(files.rootPackage, json => {
  json.version = formatVersion(targetVersion);
});

updateLockfile(files.rootLock, formatVersion(targetVersion));

updatePackageJson(files.capacitorPackage, json => {
  json.version = formatVersion(targetVersion);
  json.androidVersionCode = androidVersionCode;
});

updateLockfile(files.capacitorLock, formatVersion(targetVersion));

console.log(`Updated app version to ${formatVersion(targetVersion)}.`);
console.log(`Updated Android versionCode to ${androidVersionCode}.`);

function parseArgs(argv) {
  let target = 'patch';
  let sawTarget = false;
  let androidVersionCode = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--android-version-code') {
      const value = argv[index + 1];
      if (!value) {
        fail('Missing value for --android-version-code.');
      }

      androidVersionCode = parsePositiveInteger(value, '--android-version-code');
      index += 1;
      continue;
    }

    if (arg.startsWith('--android-version-code=')) {
      androidVersionCode = parsePositiveInteger(
        arg.slice('--android-version-code='.length),
        '--android-version-code'
      );
      continue;
    }

    if (arg.startsWith('-')) {
      fail(`Unknown option: ${arg}`);
    }

    if (sawTarget) {
      fail(`Unexpected extra argument: ${arg}`);
    }

    target = arg;
    sawTarget = true;
  }

  return { target, androidVersionCode };
}

function resolveTargetVersion(current, target) {
  if (target === 'major') {
    return { major: current.major + 1, minor: 0, patch: 0 };
  }

  if (target === 'minor') {
    return { major: current.major, minor: current.minor + 1, patch: 0 };
  }

  if (target === 'patch') {
    return { major: current.major, minor: current.minor, patch: current.patch + 1 };
  }

  return parseVersion(target, 'target version');
}

function resolveCurrentAndroidVersionCode(capacitorPackageJson) {
  if (capacitorPackageJson.androidVersionCode == null) {
    return 1;
  }

  return parsePositiveInteger(
    String(capacitorPackageJson.androidVersionCode),
    'src-capacitor/package.json androidVersionCode'
  );
}

function resolveAndroidVersionCode(current, explicit) {
  const next = explicit ?? current + 1;

  if (next <= current && explicit != null) {
    fail(`Android versionCode must be greater than the current value ${current}.`);
  }

  return next;
}

function parseVersion(value, label) {
  const text = String(value || '').trim().replace(/^v/, '');
  const match = text.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);

  if (!match) {
    fail(`${label} must be a semver version like 1.2.3.`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function formatVersion(version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

function parsePositiveInteger(value, label) {
  if (!/^[1-9]\d*$/.test(value)) {
    fail(`${label} must be a positive integer.`);
  }

  return Number(value);
}

function updatePackageJson(filePath, update) {
  const json = readJson(filePath);
  update(json);
  writeJson(filePath, json);
}

function updateLockfile(filePath, version) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  updatePackageJson(filePath, json => {
    json.version = version;

    if (json.packages?.['']) {
      json.packages[''].version = version;
    }
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
