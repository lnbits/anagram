import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

interface AppBuildIdentityModule {
  resolveAppGitSha: (options: {
    appGitSha?: string;
    isProduction: boolean;
    readFallbackSha?: () => string | null;
  }) => string;
}

const require = createRequire(import.meta.url);
const { resolveAppGitSha } =
  require('../../scripts/app-build-identity.cjs') as AppBuildIdentityModule;

describe('app build identity', () => {
  it('normalizes a full APP_GIT_SHA to 12 lowercase hexadecimal characters', () => {
    expect(
      resolveAppGitSha({
        appGitSha: 'ABCDEF1234567890ABCDEF1234567890ABCDEF12',
        isProduction: true,
        readFallbackSha: () => {
          throw new Error('Git fallback must not run when APP_GIT_SHA is supplied.');
        },
      })
    ).toBe('abcdef123456');
  });

  it('preserves an already-short APP_GIT_SHA after lowercasing it', () => {
    expect(
      resolveAppGitSha({
        appGitSha: 'ABCDEF123456',
        isProduction: true,
      })
    ).toBe('abcdef123456');
  });

  it('normalizes the source Git SHA for production when APP_GIT_SHA is missing', () => {
    expect(
      resolveAppGitSha({
        isProduction: true,
        readFallbackSha: () => 'FEDCBA6543217890FEDCBA6543217890FEDCBA65',
      })
    ).toBe('fedcba654321');
  });

  it('rejects a missing or invalid SHA in production', () => {
    expect(() =>
      resolveAppGitSha({
        isProduction: true,
        readFallbackSha: () => null,
      })
    ).toThrow(/refusing to use "unknown"/);

    expect(() =>
      resolveAppGitSha({
        appGitSha: 'not-a-git-sha',
        isProduction: true,
        readFallbackSha: () => 'fedcba6543217890fedcba6543217890fedcba65',
      })
    ).toThrow(/APP_GIT_SHA/);
  });

  it('uses Git when available and unknown otherwise for development', () => {
    expect(
      resolveAppGitSha({
        isProduction: false,
        readFallbackSha: () => 'FEDCBA6543217890FEDCBA6543217890FEDCBA65',
      })
    ).toBe('fedcba654321');

    expect(
      resolveAppGitSha({
        appGitSha: 'invalid',
        isProduction: false,
        readFallbackSha: () => null,
      })
    ).toBe('unknown');
  });
});
