import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const script = fileURLToPath(new URL('../../.github/scripts/macos-release.cjs', import.meta.url));
const source = fs.readFileSync(script, 'utf8');
const require = createRequire(import.meta.url);
const { selectIdentity } = require(script) as {
  selectIdentity: (output: string, team: string) => string;
};
const team = 'ABCDE12345';
const fingerprint = 'A'.repeat(40);
const identity = `  1) ${fingerprint} "Developer ID Application: Anagram (${team})"`;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('macOS release identity selection', () => {
  it('selects the exact team and certificate type from valid identities', () => {
    const output = [
      `  1) ${'B'.repeat(40)} "Apple Development: Anagram (${team})"`,
      `  2) ${'C'.repeat(40)} "Developer ID Application: Other (OTHER12345)"`,
      identity,
      '  3 valid identities found',
    ].join('\n');
    expect(selectIdentity(output, team)).toBe(fingerprint);
  });

  it.each([
    '',
    `${identity} (CSSMERR_TP_CERT_EXPIRED)`,
    identity.replace(team, 'OTHER12345'),
    `${identity}\n${identity.replace(fingerprint, 'B'.repeat(40))}`,
    identity.replace('Developer ID Application', 'Developer ID Installer'),
  ])('rejects absent, invalid, wrong-team, or ambiguous application identities: %s', (output) => {
    expect(() => selectIdentity(output, team)).toThrow(
      /exactly one valid Developer ID Application/
    );
  });

  it('rejects a malformed team ID', () => {
    expect(() => selectIdentity(identity, 'bad"team')).toThrow(/10-character/);
  });
});

interface FixtureOptions {
  fail?: string;
  status?: string;
  missing?: string;
  identities?: string;
  malformedResponse?: boolean;
  duplicateZip?: boolean;
}

type ReleaseEnvironment = Record<string, string | undefined>;

// Run the real wrapper and hook against an isolated filesystem. Only the macOS
// tools and npm are simulated, so failure gating and cleanup run on every OS.
function releaseFixture(options: FixtureOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anagram-release-test-'));
  directories.push(root);
  const resolve = (file: string) => path.resolve(root, file);
  const packaged = resolve('dist/electron/Packaged');
  const app = path.join(packaged, 'mac/Anagram.app');
  fs.mkdirSync(app, { recursive: true });
  const env: ReleaseEnvironment = {
    RUNNER_TEMP: root,
    BUILD_CERTIFICATE_BASE64: Buffer.from('test certificate').toString('base64'),
    P12_PASSWORD: 'private-p12-password',
    KEYCHAIN_PASSWORD: 'private-keychain-password',
    APPLE_ID: 'private-apple-id@example.test',
    APPLE_TEAM_ID: team,
    APPLE_APP_SPECIFIC_PASSWORD: 'private-notary-password',
  };
  if (options.missing) delete env[options.missing];
  const fakeProcess = {
    env,
    platform: 'darwin',
    argv: ['node', script, 'build'],
    once: vi.fn(),
    exitCode: 0,
  };
  const calls: { command: string; args: string[]; env: ReleaseEnvironment }[] = [];
  const messages: string[] = [];
  const fakeModule = { exports: null as unknown as (context: unknown) => void };
  const spawnSync = (
    command: string,
    args: string[],
    spawnOptions: { env: ReleaseEnvironment }
  ) => {
    calls.push({ command, args, env: spawnOptions.env });
    const operation = `${command} ${args[0]}${command === 'xcrun' ? ` ${args[1]}` : ''}`;
    if (
      operation === options.fail ||
      (`final ${operation}` === options.fail && args.at(-1)?.includes('/extracted/'))
    ) {
      return { status: 1, stdout: env.P12_PASSWORD, stderr: env.APPLE_APP_SPECIFIC_PASSWORD };
    }
    let stdout = '';
    if (command === 'security') {
      if (args[0] === 'list-keychains' && !args.includes('-s'))
        stdout = '    "/original/login.keychain-db"\n';
      if (args[0] === 'create-keychain') fs.writeFileSync(args.at(-1) as string, 'private key');
      if (args[0] === 'delete-keychain') fs.rmSync(args[1]);
      if (args[0] === 'find-identity') stdout = options.identities ?? identity;
    } else if (command === 'npm') {
      const previousEnv = fakeProcess.env;
      fakeProcess.env = spawnOptions.env;
      try {
        fakeModule.exports({
          electronPlatformName: 'darwin',
          appOutDir: path.dirname(app),
          packager: { appInfo: { productFilename: 'Anagram' } },
        });
        // Simulate the builder archive only after its afterSign hook returns.
        fs.writeFileSync(
          path.join(packaged, 'Anagram.zip'),
          fs.readFileSync(path.join(app, 'ticket'))
        );
        if (options.duplicateZip) fs.writeFileSync(path.join(packaged, 'stale.zip'), 'stale');
        calls.push({ command: 'archive', args: [], env: spawnOptions.env });
      } catch (error) {
        messages.push((error as Error).message);
        return { status: 1, stdout: '', stderr: '' };
      } finally {
        fakeProcess.env = previousEnv;
      }
    } else if (command === 'ditto') {
      if (args[0] === '-c') fs.writeFileSync(args.at(-1) as string, 'submission archive');
      else {
        const extractedApp = path.join(args[3], 'Anagram.app');
        fs.mkdirSync(extractedApp, { recursive: true });
        fs.writeFileSync(path.join(extractedApp, 'ticket'), fs.readFileSync(args[2]));
      }
    } else if (command === 'xcrun') {
      if (args[1] === 'submit')
        stdout = options.malformedResponse
          ? 'not-json'
          : JSON.stringify({ status: options.status ?? 'Accepted', id: 'submission-id' });
      if (args[1] === 'staple') fs.writeFileSync(path.join(args[2], 'ticket'), 'accepted ticket');
      if (args[1] === 'validate' && !fs.existsSync(path.join(args[2], 'ticket')))
        return { status: 1 };
    }
    return { status: 0, stdout, stderr: '' };
  };
  const isolatedFs = {
    ...fs,
    existsSync: (file: string) => fs.existsSync(resolve(file)),
    readdirSync: (file: string, opts: any) => fs.readdirSync(resolve(file), opts),
    copyFileSync: (from: string, to: string) => fs.copyFileSync(resolve(from), resolve(to)),
  };
  const fakeRequire = Object.assign(
    (name: string) => {
      if (name === 'node:child_process') return { spawnSync };
      if (name === 'node:fs') return isolatedFs;
      if (name === 'node:path')
        return { ...path, resolve: (...parts: string[]) => path.resolve(root, ...parts) };
      throw new Error(`Unexpected require: ${name}`);
    },
    { main: fakeModule }
  );
  const execute = (mode = 'build') => {
    fakeProcess.argv[2] = mode;
    fakeProcess.exitCode = 0;
    runInNewContext(source, {
      require: fakeRequire,
      module: fakeModule,
      process: fakeProcess,
      Buffer,
      console: {
        info: (message: string) => messages.push(message),
        error: (message: string) => messages.push(message),
      },
    });
  };
  execute();
  return {
    root,
    calls,
    messages,
    fakeProcess,
    execute,
    asset: resolve('release-assets/anagram-macos.zip'),
  };
}

describe('macOS release lifecycle', () => {
  it.runIf(process.platform === 'darwin')(
    'compiles the actual verification requirement with Apple tools',
    () => {
      const result = releaseFixture();
      const args = result.calls.find(({ command }) => command === 'codesign')?.args ?? [];
      const requirement = args[args.indexOf('-R') + 1];
      const compiled = path.join(result.root, 'requirement.bin');
      execFileSync('csreq', ['-r', requirement, '-b', compiled]);
      expect(fs.statSync(compiled).size).toBeGreaterThan(0);
    }
  );

  it('staples before archiving and verifies the extracted final ZIP before retaining the asset', () => {
    const result = releaseFixture();
    expect(result.fakeProcess.exitCode, result.messages.join('\n')).toBe(0);
    expect(fs.readFileSync(result.asset, 'utf8')).toBe('accepted ticket');
    const operations = result.calls.map(({ command, args }) =>
      `${command} ${args.slice(0, 2).join(' ')}`.trim()
    );
    expect(operations.indexOf('xcrun stapler staple')).toBeLessThan(operations.indexOf('archive'));
    expect(operations.filter((operation) => operation === 'xcrun notarytool submit')).toHaveLength(
      1
    );
    const assessment = result.calls.find(({ command }) => command === 'spctl');
    expect(assessment?.args.at(-1)).toBe(
      path.join(result.root, 'anagram-macos-release/extracted/Anagram.app')
    );
    const buildEnv = result.calls.find(({ command }) => command === 'npm')?.env;
    expect(buildEnv?.CSC_NAME).toBe(fingerprint);
    expect(buildEnv?.CSC_IDENTITY_AUTO_DISCOVERY).toBe('true');
    for (const name of [
      'BUILD_CERTIFICATE_BASE64',
      'P12_PASSWORD',
      'KEYCHAIN_PASSWORD',
      'APPLE_ID',
      'APPLE_APP_SPECIFIC_PASSWORD',
    ])
      expect(buildEnv?.[name]).toBeUndefined();
    expect(result.calls.at(-2)?.args).toEqual([
      'list-keychains',
      '-d',
      'user',
      '-s',
      '/original/login.keychain-db',
    ]);
    expect(fs.existsSync(path.join(result.root, 'anagram-macos-release'))).toBe(false);
    result.execute('cleanup');
    expect(result.fakeProcess.exitCode).toBe(0);
  });

  it.each([
    'BUILD_CERTIFICATE_BASE64',
    'P12_PASSWORD',
    'KEYCHAIN_PASSWORD',
    'APPLE_ID',
    'APPLE_TEAM_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
  ])('fails before importing or building when %s is missing', (missing) => {
    const result = releaseFixture({ missing });
    expect(result.fakeProcess.exitCode).toBe(1);
    expect(result.calls).toHaveLength(0);
    expect(result.messages.join('\n')).toContain(missing);
  });

  it.each([
    'Invalid',
    'Rejected',
    'In Progress',
    '',
  ])('never staples or stages notarization status %s', (status) => {
    const result = releaseFixture({ status });
    expect(result.fakeProcess.exitCode).toBe(1);
    expect(result.calls.some(({ args }) => args[1] === 'staple')).toBe(false);
    expect(fs.existsSync(result.asset)).toBe(false);
    expect(fs.existsSync(path.join(result.root, 'anagram-macos-release'))).toBe(false);
  });

  it('rejects malformed notarization JSON', () => {
    const result = releaseFixture({ malformedResponse: true });
    expect(result.fakeProcess.exitCode).toBe(1);
    expect(result.calls.some(({ args }) => args[1] === 'staple')).toBe(false);
    expect(fs.existsSync(result.asset)).toBe(false);
  });

  it.each([
    'security import',
    'security set-key-partition-list',
    'xcrun notarytool store-credentials',
    'npm run',
    'codesign --verify',
    'xcrun notarytool submit',
    'xcrun stapler staple',
    'xcrun stapler validate',
    'ditto -x',
    'spctl --assess',
    'final codesign --verify',
    'final xcrun stapler validate',
  ])('fails and removes credentials/artifacts when %s fails', (fail) => {
    const result = releaseFixture({ fail });
    expect(result.fakeProcess.exitCode).toBe(1);
    expect(fs.existsSync(result.asset)).toBe(false);
    expect(fs.existsSync(path.join(result.root, 'anagram-macos-release'))).toBe(false);
    expect(result.messages.join('\n')).not.toContain('private-');
    expect(result.calls.some(({ args }) => args[0] === 'delete-keychain')).toBe(true);
  });

  it('does not build with an identity from another team', () => {
    const result = releaseFixture({ identities: identity.replace(team, 'OTHER12345') });
    expect(result.fakeProcess.exitCode).toBe(1);
    expect(result.calls.some(({ command }) => command === 'npm')).toBe(false);
    expect(fs.existsSync(path.join(result.root, 'anagram-macos-release'))).toBe(false);
  });

  it('refuses to choose arbitrarily between multiple builder ZIPs', () => {
    const result = releaseFixture({ duplicateZip: true });
    expect(result.fakeProcess.exitCode).toBe(1);
    expect(fs.existsSync(result.asset)).toBe(false);
  });

  it('removes credentials even when deleting the keychain fails, then allows cleanup to retry', () => {
    const result = releaseFixture({ fail: 'security delete-keychain' });
    expect(result.fakeProcess.exitCode).toBe(1);
    expect(fs.readdirSync(path.join(result.root, 'anagram-macos-release'))).toEqual([
      'search-list.json',
    ]);
    result.execute('cleanup');
    expect(result.fakeProcess.exitCode).toBe(0);
    expect(fs.existsSync(path.join(result.root, 'anagram-macos-release'))).toBe(false);
  });
});
