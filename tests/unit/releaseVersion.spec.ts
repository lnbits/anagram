import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  checkReleaseVersion,
  releaseVersion,
  setReleaseVersion,
} from '../../scripts/set-release-version.mjs';

const fixtureFiles = {
  'package.json': JSON.stringify({ name: 'anagram', version: '0.9.0' }),
  'package-lock.json': JSON.stringify({
    version: '0.9.0',
    packages: { '': { version: '0.9.0' }, 'node_modules/example': { version: '1.0.0' } },
  }),
  'src-tauri/tauri.conf.json': JSON.stringify({ version: '0.9.0' }),
  'src-tauri/Cargo.toml': '[package]\nname = "anagram"\nversion = "0.9.0"\n',
  'src-tauri/Cargo.lock':
    '[[package]]\nname = "anagram"\nversion = "0.9.0"\n[[package]]\nname = "another"\nversion = "0.9.0"\n',
};

describe('tagged release versions', () => {
  let dir: string;
  let root: URL;
  const read = (file: string) => readFileSync(join(dir, file), 'utf8');
  const snapshot = () =>
    Object.fromEntries(Object.keys(fixtureFiles).map((file) => [file, read(file)]));
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'anagram-release-'));
    root = pathToFileURL(dir + '/');
    for (const [file, source] of Object.entries(fixtureFiles)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), source);
    }
    mkdirSync(join(dir, 'scripts'));
    cpSync(
      new URL('../../scripts/set-release-version.mjs', import.meta.url),
      join(dir, 'scripts/set-release-version.mjs'),
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each(['v1.2.3', '1.2.3', 'v1.2.3-beta.1'])('accepts %s', (tag) =>
    expect(releaseVersion(tag)).toBe(tag.replace(/^v/, '')),
  );
  it.each([
    'main',
    'v1.2',
    'v01.2.3',
    'v1.2.3+meta',
    'v99999.2.3',
    'v1.2.3-beta.01',
    'v1.2.3; rm -rf /',
  ])('rejects %s', (tag) => expect(() => releaseVersion(tag)).toThrow());
  it.each(['1.2.3', '1.2.3-rc.1'])(
    'updates every app version to %s without changing dependencies',
    (version) => {
      setReleaseVersion(`v${version}`, root);
      for (const file of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json'])
        expect(JSON.parse(read(file)).version).toBe(version);
      const lock = JSON.parse(read('package-lock.json'));
      expect(lock.packages[''].version).toBe(version);
      expect(lock.packages['node_modules/example'].version).toBe('1.0.0');
      for (const file of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'])
        expect(read(file)).toContain(`name = "anagram"\nversion = "${version}"`);
      expect(read('src-tauri/Cargo.lock')).toContain('name = "another"\nversion = "0.9.0"');
      expect(checkReleaseVersion(`v${version}`, root)).toBe(version);
    },
  );

  it('checks consistency against package.json when no tag is supplied', () => {
    const before = snapshot();
    expect(checkReleaseVersion(undefined, root)).toBe('0.9.0');
    expect(snapshot()).toEqual(before);
  });

  it.each([
    ['package.json', 'version'],
    ['package-lock.json', 'version'],
    ['package-lock.json', 'packages[""].version'],
    ['src-tauri/tauri.conf.json', 'version'],
    ['src-tauri/Cargo.toml', 'anagram.version'],
    ['src-tauri/Cargo.lock', 'anagram.version'],
  ])('rejects a stale %s %s without repairing it', (file, field) => {
    if (file.endsWith('.json')) {
      const value = JSON.parse(read(file));
      if (field === 'packages[""].version') value.packages[''].version = '0.8.0';
      else value.version = '0.8.0';
      writeFileSync(join(dir, file), JSON.stringify(value));
    } else {
      writeFileSync(join(dir, file), read(file).replace('version = "0.9.0"', 'version = "0.8.0"'));
    }
    const before = snapshot();
    expect(() => checkReleaseVersion('v0.9.0', root)).toThrow(
      `${file} (${field}): expected 0.9.0, found 0.8.0`,
    );
    expect(snapshot()).toEqual(before);
  });

  it('requires the full prerelease version in committed files', () => {
    expect(() => checkReleaseVersion('v0.9.0-rc1', root)).toThrow(
      'expected 0.9.0-rc1, found 0.9.0',
    );
  });

  it('updates and checks an existing mobile override while preserving build numbers', () => {
    const file = 'src-tauri/mobile-version.json';
    const bundle = { android: { versionCode: 123 }, iOS: { bundleVersion: '123' } };
    writeFileSync(join(dir, file), JSON.stringify({ version: '0.8.0', bundle }));
    expect(() => checkReleaseVersion('v0.9.0', root)).toThrow(file);
    setReleaseVersion('v1.2.3-beta.1', root);
    expect(JSON.parse(read(file))).toEqual({ version: '1.2.3', bundle });
    expect(checkReleaseVersion('v1.2.3-beta.1', root)).toBe('1.2.3-beta.1');
  });

  it('preserves CRLF Cargo files and permits an unchanged version', () => {
    for (const file of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock'])
      writeFileSync(join(dir, file), read(file).replaceAll('\n', '\r\n'));
    setReleaseVersion('v1.2.3', root);
    const before = snapshot();
    setReleaseVersion('v1.2.3', root);
    expect(snapshot()).toEqual(before);
    expect(read('src-tauri/Cargo.toml')).toContain('name = "anagram"\r\nversion = "1.2.3"\r\n');
    expect(checkReleaseVersion('v1.2.3', root)).toBe('1.2.3');
  });

  it('does not partially bump versions when a Cargo app entry is missing', () => {
    writeFileSync(
      join(dir, 'src-tauri/Cargo.lock'),
      '[[package]]\nname = "another"\nversion = "1.0.0"\n',
    );
    const before = snapshot();
    expect(() => setReleaseVersion('v1.2.3', root)).toThrow(
      'Cannot locate app version in src-tauri/Cargo.lock',
    );
    expect(snapshot()).toEqual(before);
  });

  it.each([
    ['v0.9.0', 0],
    ['v0.9.1', 1],
    ['v0.9.0-rc1', 1],
    ['invalid', 1],
  ])('CI check exits with %s => %s and leaves the checkout unchanged', (tag, status) => {
    const before = snapshot();
    const result = spawnSync(process.execPath, ['scripts/set-release-version.mjs', '--check'], {
      cwd: dir,
      env: { ...process.env, RELEASE_TAG: tag },
      encoding: 'utf8',
    });
    expect(result.status).toBe(status);
    if (tag === 'v0.9.1') {
      for (const file of Object.keys(fixtureFiles)) expect(result.stderr).toContain(file);
      expect(result.stderr).toContain('packages[""].version');
    }
    expect(snapshot()).toEqual(before);
  });

  it('allows an explicit version argument to override an inherited RELEASE_TAG', () => {
    const result = spawnSync(process.execPath, ['scripts/set-release-version.mjs', 'v1.2.3'], {
      cwd: dir,
      env: { ...process.env, RELEASE_TAG: 'v9.9.9' },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(checkReleaseVersion('v1.2.3', root)).toBe('1.2.3');
  });

  it('builds a tagged RC from older checkout versions, including numeric mobile versions', () => {
    cpSync(
      new URL('../../scripts/mobile-version.mjs', import.meta.url),
      join(dir, 'scripts/mobile-version.mjs'),
    );
    const env = { ...process.env, RELEASE_TAG: 'v0.9.7-rc3', GITHUB_RUN_NUMBER: '42' };
    for (const args of [
      ['scripts/set-release-version.mjs'],
      ['scripts/set-release-version.mjs', '--check'],
      ['scripts/mobile-version.mjs'],
      ['scripts/set-release-version.mjs', '--check'],
    ]) {
      const result = spawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    }
    expect(checkReleaseVersion(env.RELEASE_TAG, root)).toBe('0.9.7-rc3');
    expect(JSON.parse(read('src-tauri/mobile-version.json'))).toEqual({
      version: '0.9.7',
      bundle: { android: { versionCode: 42 }, iOS: { bundleVersion: '42' } },
    });
  });
});
