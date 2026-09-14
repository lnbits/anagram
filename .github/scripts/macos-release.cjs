const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const credentialNames = [
  'BUILD_CERTIFICATE_BASE64',
  'P12_PASSWORD',
  'KEYCHAIN_PASSWORD',
  'APPLE_ID',
  'APPLE_TEAM_ID',
  'APPLE_APP_SPECIFIC_PASSWORD',
];

// Capture credential-bearing commands. Never include their arguments or output in errors.
function run(command, args, { inherit = false, env = process.env } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    env,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args[0]} failed (exit ${result.status ?? 'unknown'}).`);
  }
  return result.stdout ?? '';
}

function stateDirectory() {
  if (!process.env.RUNNER_TEMP) throw new Error('RUNNER_TEMP is required.');
  return path.join(process.env.RUNNER_TEMP, 'anagram-macos-release');
}

function selectIdentity(output, teamId) {
  if (!/^[A-Z0-9]{10}$/.test(teamId))
    throw new Error('APPLE_TEAM_ID must be a 10-character team ID.');
  const identities = [
    ...output.matchAll(/^\s*\d+\) ([A-Fa-f0-9]{40}) "Developer ID Application: ([^"\n]+)"\s*$/gm),
  ].filter((match) => match[2].endsWith(` (${teamId})`));
  if (identities.length !== 1) {
    throw new Error(
      'The P12 must contain exactly one valid Developer ID Application identity for APPLE_TEAM_ID.'
    );
  }
  return identities[0][1];
}

function cleanup() {
  const directory = stateDirectory();
  if (!fs.existsSync(directory)) return;
  const keychain = path.join(directory, 'signing.keychain-db');
  const searchList = path.join(directory, 'search-list.json');
  const errors = [];
  if (fs.existsSync(searchList)) {
    try {
      run('security', [
        'list-keychains',
        '-d',
        'user',
        '-s',
        ...JSON.parse(fs.readFileSync(searchList, 'utf8')),
      ]);
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (fs.existsSync(keychain)) {
    try {
      run('security', ['delete-keychain', keychain]);
    } catch (error) {
      errors.push(error.message);
    }
  }
  // Remove credential files even if a security command fails. Retain only the search
  // list on failure so the workflow's always() step can retry restoring it.
  for (const entry of fs.readdirSync(directory)) {
    if (entry !== 'search-list.json')
      fs.rmSync(path.join(directory, entry), { recursive: true, force: true });
  }
  if (errors.length) throw new Error(`macOS credential cleanup failed: ${errors.join(' ')}`);
  fs.rmSync(directory, { recursive: true, force: true });
}

function verifySignature(appPath) {
  const teamId = process.env.APPLE_TEAM_ID;
  if (!/^[A-Z0-9]{10}$/.test(teamId ?? ''))
    throw new Error('A valid APPLE_TEAM_ID is required for verification.');
  run(
    'codesign',
    [
      '--verify',
      '--deep',
      '--strict',
      '--verbose=2',
      '-R',
      `=anchor apple generic and certificate leaf[subject.OU] = "${teamId}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`,
      appPath,
    ],
    { inherit: true }
  );
}

// electron-builder invokes this after signing every nested component and the app,
// and before building the distributable ZIP. Built-in notarization is disabled.
function afterSign(context) {
  if (process.env.ANAGRAM_MACOS_RELEASE !== 'true') return;
  if (context.electronPlatformName !== 'darwin') throw new Error('Expected a macOS release build.');
  const { CSC_KEYCHAIN, ANAGRAM_MACOS_NOTARY_PROFILE } = process.env;
  if (!CSC_KEYCHAIN || !ANAGRAM_MACOS_NOTARY_PROFILE)
    throw new Error('Missing temporary notarization profile.');
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  verifySignature(appPath);
  const archive = path.join(stateDirectory(), 'notarization.zip');
  const credentials = [
    '--keychain',
    CSC_KEYCHAIN,
    '--keychain-profile',
    ANAGRAM_MACOS_NOTARY_PROFILE,
  ];
  try {
    run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, archive]);
    console.info('Submitting the signed app to Apple; waiting up to 30 minutes.');
    const submission = JSON.parse(
      run('xcrun', [
        'notarytool',
        'submit',
        archive,
        ...credentials,
        '--wait',
        '--timeout',
        '30m',
        '--output-format',
        'json',
      ])
    );
    if (submission.status !== 'Accepted') {
      throw new Error(
        `Notarization was not Accepted (status: ${submission.status ?? 'missing'}, submission: ${submission.id ?? 'missing'}).`
      );
    }
    console.info(`Notarization Accepted (submission: ${submission.id}).`);
    run('xcrun', ['stapler', 'staple', appPath], { inherit: true });
    run('xcrun', ['stapler', 'validate', appPath], { inherit: true });
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

function build() {
  for (const name of credentialNames) {
    if (!process.env[name]?.trim())
      throw new Error(`Missing required GitHub Actions secret: ${name}`);
  }
  if (process.platform !== 'darwin') throw new Error('macOS release signing requires macOS.');
  const directory = stateDirectory();
  const keychain = path.join(directory, 'signing.keychain-db');
  const certificate = path.join(directory, 'certificate.p12');
  const asset = path.resolve('release-assets/anagram-macos.zip');
  fs.mkdirSync(directory, { mode: 0o700 });
  let verified = false;
  try {
    const searchList = run('security', ['list-keychains', '-d', 'user'])
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const match = line.match(/^\s*"(.+)"\s*$/);
        if (!match) throw new Error('Could not read the keychain search list.');
        return match[1];
      });
    fs.writeFileSync(path.join(directory, 'search-list.json'), JSON.stringify(searchList), {
      mode: 0o600,
    });
    const encoded = process.env.BUILD_CERTIFICATE_BASE64.replace(/\s/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new Error('BUILD_CERTIFICATE_BASE64 is not valid base64.');
    }
    fs.writeFileSync(certificate, Buffer.from(encoded, 'base64'), { mode: 0o600 });
    run('security', ['create-keychain', '-p', process.env.KEYCHAIN_PASSWORD, keychain]);
    run('security', ['set-keychain-settings', '-lut', '21600', keychain]);
    run('security', ['unlock-keychain', '-p', process.env.KEYCHAIN_PASSWORD, keychain]);
    run('security', [
      'import',
      certificate,
      '-k',
      keychain,
      '-P',
      process.env.P12_PASSWORD,
      '-t',
      'cert',
      '-f',
      'pkcs12',
      '-T',
      '/usr/bin/codesign',
      '-T',
      '/usr/bin/security',
    ]);
    run('security', [
      'set-key-partition-list',
      '-S',
      'apple-tool:,apple:,codesign:',
      '-s',
      '-k',
      process.env.KEYCHAIN_PASSWORD,
      keychain,
    ]);
    run('security', ['list-keychains', '-d', 'user', '-s', keychain, ...searchList]);
    const identity = selectIdentity(
      run('security', ['find-identity', '-v', '-p', 'codesigning', keychain]),
      process.env.APPLE_TEAM_ID
    );
    fs.rmSync(certificate);
    const profile = 'anagram-release';
    run('xcrun', [
      'notarytool',
      'store-credentials',
      profile,
      '--keychain',
      keychain,
      '--apple-id',
      process.env.APPLE_ID,
      '--team-id',
      process.env.APPLE_TEAM_ID,
      '--password',
      process.env.APPLE_APP_SPECIFIC_PASSWORD,
    ]);

    const buildEnv = { ...process.env };
    for (const name of credentialNames) {
      if (name !== 'APPLE_TEAM_ID') delete buildEnv[name];
    }
    // The imported keychain is the only source of signing/notarization credentials.
    delete buildEnv.CSC_LINK;
    delete buildEnv.CSC_KEY_PASSWORD;
    Object.assign(buildEnv, {
      ANAGRAM_MACOS_RELEASE: 'true',
      CSC_IDENTITY_AUTO_DISCOVERY: 'true',
      CSC_NAME: identity,
      CSC_KEYCHAIN: keychain,
      ANAGRAM_MACOS_NOTARY_PROFILE: profile,
    });
    run('npm', ['run', 'build:electron:mac'], { inherit: true, env: buildEnv });
    const packaged = path.resolve('dist/electron/Packaged');
    const archives = fs
      .readdirSync(packaged, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.zip'))
      .map((entry) => path.join(packaged, entry.name));
    if (archives.length !== 1)
      throw new Error('Expected exactly one macOS ZIP from electron-builder.');
    fs.mkdirSync(path.dirname(asset), { recursive: true });
    fs.copyFileSync(archives[0], asset);
    const extracted = path.join(directory, 'extracted');
    run('ditto', ['-x', '-k', asset, extracted]);
    const apps = fs.readdirSync(extracted).filter((name) => name.endsWith('.app'));
    if (apps.length !== 1 || apps[0] !== 'Anagram.app')
      throw new Error('The final ZIP must contain Anagram.app at its root.');
    const appPath = path.join(extracted, 'Anagram.app');
    verifySignature(appPath);
    run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath], { inherit: true });
    run('xcrun', ['stapler', 'validate', appPath], { inherit: true });
    verified = true;
    console.info('Verified release-assets/anagram-macos.zip: signed, notarized, and stapled.');
  } finally {
    try {
      if (!verified) fs.rmSync(asset, { force: true });
    } finally {
      cleanup();
    }
  }
}

module.exports = afterSign;
module.exports.selectIdentity = selectIdentity;

if (require.main === module) {
  for (const [signal, exitCode] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    process.once(signal, () => {
      try {
        cleanup();
      } catch (error) {
        console.error(error.message);
      }
      process.exit(exitCode);
    });
  }
  try {
    if (process.argv[2] === 'build') build();
    else if (process.argv[2] === 'cleanup') cleanup();
    else throw new Error('Usage: node .github/scripts/macos-release.cjs <build|cleanup>');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
