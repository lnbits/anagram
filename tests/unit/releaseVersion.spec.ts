import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseVersion, setReleaseVersion } from '../../scripts/set-release-version.mjs';
describe('tagged release versions', () => {
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
  it('keeps frontend, Tauri, Cargo and lockfile versions aligned without changing dependency versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anagram-release-'));
    try {
      mkdirSync(join(dir, 'src-tauri'));
      for (const file of ['package.json', 'src-tauri/tauri.conf.json'])
        writeFileSync(join(dir, file), JSON.stringify({ name: 'anagram', version: '0.9.0' }));
      writeFileSync(
        join(dir, 'package-lock.json'),
        JSON.stringify({
          version: '0.9.0',
          packages: { '': { version: '0.9.0' }, 'node_modules/example': { version: '1.0.0' } },
        }),
      );
      for (const file of ['Cargo.toml', 'Cargo.lock'])
        writeFileSync(
          join(dir, 'src-tauri', file),
          '[[package]]\nname = "anagram"\nversion = "0.9.0"\n[[package]]\nname = "another"\nversion = "0.9.0"\n',
        );
      setReleaseVersion('v1.2.3', pathToFileURL(dir + '/'));
      expect(
        JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')).packages[''].version,
      ).toBe('1.2.3');
      expect(
        JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8')).packages[
          'node_modules/example'
        ].version,
      ).toBe('1.0.0');
      for (const file of ['Cargo.toml', 'Cargo.lock'])
        expect(readFileSync(join(dir, 'src-tauri', file), 'utf8')).toContain(
          'name = "anagram"\nversion = "1.2.3"\n[[package]]\nname = "another"\nversion = "0.9.0"',
        );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
