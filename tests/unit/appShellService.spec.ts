import {
  canReachAppServer,
  fetchServerBuildInfo,
  hasDifferentBundle,
  normalizeAppBuildInfo,
  resolveAppShellUrl,
} from 'src/services/appShellService';
import { describe, expect, it, vi } from 'vitest';

describe('appShellService', () => {
  it('normalizes build info payloads', () => {
    expect(
      normalizeAppBuildInfo({
        appVersion: ' 0.2.0 ',
        bundleId: ' abc123 ',
      })
    ).toEqual({
      appVersion: '0.2.0',
      bundleId: 'abc123',
    });

    expect(normalizeAppBuildInfo({ appVersion: '0.2.0', bundleId: '' })).toBeNull();
    expect(normalizeAppBuildInfo(null)).toBeNull();
  });

  it('detects different loaded and server bundles', () => {
    expect(
      hasDifferentBundle(
        { appVersion: '0.2.0', bundleId: 'loaded' },
        { appVersion: '0.2.0', bundleId: 'server' }
      )
    ).toBe(true);
    expect(
      hasDifferentBundle(
        { appVersion: '0.2.0', bundleId: 'loaded' },
        { appVersion: '0.2.0', bundleId: 'loaded' }
      )
    ).toBe(false);
    expect(hasDifferentBundle({ appVersion: '0.2.0', bundleId: 'loaded' }, null)).toBe(false);
  });

  it('resolves app shell URLs from hash-routed app URLs', () => {
    expect(resolveAppShellUrl('build-info.json', 'https://example.com/#/settings/developer')).toBe(
      'https://example.com/build-info.json'
    );
    expect(
      resolveAppShellUrl('build-info.json', 'https://example.com/app/#/settings/developer')
    ).toBe('https://example.com/app/build-info.json');
    expect(
      resolveAppShellUrl('service-worker.js', 'https://example.com/app/index.html#/settings')
    ).toBe('https://example.com/app/service-worker.js');
  });

  it('fetches server build info without using browser caches', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          appVersion: '0.2.0',
          bundleId: 'server-bundle',
        }),
        { status: 200 }
      );
    });

    const buildInfo = await fetchServerBuildInfo({
      currentHref: 'https://example.com/app/#/settings',
      fetchImpl: fetchMock as unknown as typeof fetch,
      timeoutMs: 1000,
    });

    expect(buildInfo?.bundleId).toBe('server-bundle');
    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error('Expected build info fetch to run.');
    }

    const [input, init] = firstCall as unknown as [unknown, RequestInit | undefined];
    expect(String(input)).toMatch(/^https:\/\/example\.com\/app\/build-info\.json\?_/);
    expect(init).toMatchObject({
      cache: 'no-store',
      credentials: 'same-origin',
    });
  });

  it('checks server reachability against index without using browser caches', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));

    await expect(
      canReachAppServer({
        currentHref: 'https://example.com/app/#/settings',
        fetchImpl: fetchMock as unknown as typeof fetch,
        timeoutMs: 1000,
      })
    ).resolves.toBe(true);

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error('Expected reachability fetch to run.');
    }

    const [input, init] = firstCall as unknown as [unknown, RequestInit | undefined];
    expect(String(input)).toMatch(
      /^https:\/\/example\.com\/app\/index\.html\?__nc_force_refresh_check=/
    );
    expect(init).toMatchObject({
      cache: 'no-store',
      credentials: 'same-origin',
    });
  });
});
