import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { releasePolicy } from '../../scripts/release-policy.mjs';
import { mobileVersion } from '../../scripts/mobile-version.mjs';

describe('release visibility', () => {
  it.each(['v0.1.0-rc1', 'v0.1.0-rc.1', '0.1.0-rc', 'v0.1.0-rc1.2'])(
    '%s stays a draft prerelease',
    (tag) => {
      expect(releasePolicy(tag)).toMatchObject({ draft: true, prerelease: true });
    },
  );
  it('publishes stable versions and distinguishes non-RC prereleases', () => {
    expect(releasePolicy('v1.2.3')).toMatchObject({ draft: false, prerelease: false });
    expect(releasePolicy('v1.2.3-beta.1')).toMatchObject({ draft: false, prerelease: true });
    expect(() => releasePolicy('main')).toThrow();
  });
  it.each([false, true])('never publishes an RC, including existing=%s', (exists) => {
    const dir = mkdtempSync(join(tmpdir(), 'anagram-publish-'));
    try {
      mkdirSync(join(dir, 'release-assets'));
      writeFileSync(join(dir, 'release-assets', 'test.apk'), 'fixture');
      writeFileSync(
        join(dir, 'gh'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "$GH_LOG"\nif [ "$2" = view ]; then exit ${exists ? 0 : 1}; fi\n`,
        { mode: 0o755 },
      );
      execFileSync('bash', [resolve('scripts/publish-release.sh')], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GH_LOG: join(dir, 'calls'),
          RELEASE_TAG: 'v0.1.0-rc1',
          RELEASE_DRAFT: 'true',
          RELEASE_PRERELEASE: 'true',
        },
      });
      const calls = readFileSync(join(dir, 'calls'), 'utf8');
      expect(calls).not.toContain('--draft=false');
      expect(calls).toContain(
        exists ? '--draft=true --prerelease=true' : '--draft --prerelease=true',
      );
      if (exists)
        expect(calls.indexOf('release edit')).toBeLessThan(calls.indexOf('release upload'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('mobile version compatibility', () => {
  it('uses numeric Apple versions and increasing build IDs across RC/stable builds', () => {
    expect(mobileVersion('v0.1.0-rc1', '123')).toEqual({
      version: '0.1.0',
      bundle: { android: { versionCode: 123 }, iOS: { bundleVersion: '123' } },
    });
    expect(mobileVersion('v0.1.0', '124').bundle.android.versionCode).toBe(124);
  });
  it.each(['0', '-1', 'NaN', '1.5', '2100000001'])('rejects invalid build number %s', (value) => {
    expect(() => mobileVersion('v0.1.0', value)).toThrow();
  });
});
