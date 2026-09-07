const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readGitSha, resolveAppGitSha } = require('./app-build-identity.cjs');

const projectRoot = path.resolve(__dirname, '..');
const composeFile = path.resolve(projectRoot, 'docker-compose.android.yml');
const validCommands = new Set([
  'sync',
  'apk-debug',
  'apk-release',
  'aab-release',
  'all-release',
]);
const releaseCommands = new Set(['apk-release', 'aab-release', 'all-release']);

const buildCommand = process.argv[2] || 'all-release';
if (!validCommands.has(buildCommand)) {
  const options = Array.from(validCommands).join(', ');
  console.error(`Unknown Android Docker build command "${buildCommand}". Expected one of: ${options}`);
  process.exit(1);
}

if (!fs.existsSync(composeFile)) {
  console.error(`Missing Docker Compose file at ${composeFile}`);
  process.exit(1);
}

const composeBin = detectComposeBinary();
if (!composeBin) {
  console.error('Docker Compose was not found. Install Docker Desktop or Docker Engine with Compose support.');
  process.exit(1);
}

const composeArgs = composeBin.concat(['-f', composeFile]);
const env = { ...process.env };
env.APP_GIT_SHA = resolveAppGitSha({
  appGitSha: process.env.APP_GIT_SHA,
  isProduction: releaseCommands.has(buildCommand),
  readFallbackSha: () => readGitSha(projectRoot),
});

run(composeArgs[0], composeArgs.slice(1).concat(['build', 'android-build']), env);
run(
  composeArgs[0],
  composeArgs.slice(1).concat(getRunArgs(buildCommand)),
  env
);

function detectComposeBinary() {
  const candidates = [
    ['docker', 'compose'],
    ['docker-compose'],
  ];

  for (const candidate of candidates) {
    const result = spawnSync(candidate[0], candidate.slice(1).concat('version'), {
      cwd: projectRoot,
      env: process.env,
      stdio: 'ignore',
    });

    if (result.error == null && result.status === 0) {
      return candidate;
    }
  }

  return null;
}

function getRunArgs(command) {
  const args = [
    'run',
    '--rm',
    '-T',
    '-e',
    `ANDROID_BUILD_COMMAND=${command}`,
    '-e',
    `APP_GIT_SHA=${env.APP_GIT_SHA}`,
  ];
  const keystore = process.env.ANDROID_KEYSTORE_PATH;

  if (keystore && path.isAbsolute(keystore)) {
    const hostPath = path.resolve(keystore);
    if (!fs.existsSync(hostPath)) {
      console.error(`ANDROID_KEYSTORE_PATH does not exist: ${hostPath}`);
      process.exit(1);
    }

    const containerPath = `/tmp/android-keystore/${path.basename(hostPath)}`;
    args.push('-e', `ANDROID_KEYSTORE_PATH=${containerPath}`);
    args.push('-v', `${hostPath}:${containerPath}:ro`);
  }

  args.push('android-build');
  return args;
}

function run(bin, args, env) {
  const result = spawnSync(bin, args, {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
