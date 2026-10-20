import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isNativePlatform: vi.fn<() => boolean>(),
  openUrl: vi.fn(),
  isTauri: vi.fn<() => boolean>(),
  tauriOpenUrl: vi.fn(),
}));

vi.mock('#src/lib/platform/legacyNative.ts', () => ({
  AppLauncher: { openUrl: mocks.openUrl },
  Capacitor: { isNativePlatform: mocks.isNativePlatform },
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: mocks.isTauri }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: mocks.tauriOpenUrl }));

import { openExternalHttpUrl, openExternalMagnetUrl } from '#src/utils/externalLinks.ts';

describe('external links', () => {
  const browserOpen = vi.fn();

  beforeEach(() => {
    mocks.isNativePlatform.mockReturnValue(false);
    mocks.isTauri.mockReturnValue(false);
    mocks.tauriOpenUrl.mockResolvedValue(undefined);
    mocks.openUrl.mockResolvedValue({ completed: true });
    browserOpen.mockReset();
    vi.stubGlobal('window', { open: browserOpen });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('opens web links in a new browser tab', async () => {
    await openExternalHttpUrl('https://example.com/docs');

    expect(browserOpen).toHaveBeenCalledWith(
      'https://example.com/docs',
      '_blank',
      'noopener,noreferrer',
    );
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it('delegates native links to the operating system', async () => {
    mocks.isNativePlatform.mockReturnValue(true);

    await openExternalHttpUrl('https://example.com/docs');

    expect(mocks.openUrl).toHaveBeenCalledWith({ url: 'https://example.com/docs' });
    expect(browserOpen).not.toHaveBeenCalled();
  });

  it('rejects non-HTTP schemes before invoking a platform opener', async () => {
    await expect(openExternalHttpUrl('javascript:alert(1)')).rejects.toThrow(
      'Only HTTP(S) links can be opened.',
    );
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(browserOpen).not.toHaveBeenCalled();
  });

  const magnet = 'magnet:?xt=urn:btih:' + 'a'.repeat(40);
  it('hands the magnet directly to the browser without a web-player redirect', async () => {
    await openExternalMagnetUrl(magnet);
    expect(browserOpen).toHaveBeenCalledWith(magnet, '_blank', 'noopener,noreferrer');
    expect(mocks.tauriOpenUrl).not.toHaveBeenCalled();
  });
  it('uses the Tauri system handler for magnets', async () => {
    mocks.isTauri.mockReturnValue(true);
    await openExternalMagnetUrl(magnet.replace('magnet:', 'MAGNET:'));
    expect(mocks.tauriOpenUrl).toHaveBeenCalledExactlyOnceWith(magnet);
    expect(browserOpen).not.toHaveBeenCalled();
  });
  it('surfaces a native magnet handler failure', async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.tauriOpenUrl.mockRejectedValueOnce(new Error('No associated application'));
    await expect(openExternalMagnetUrl(magnet)).rejects.toThrow('No associated application');
    expect(browserOpen).not.toHaveBeenCalled();
  });
  it('uses the legacy native launcher and reports incomplete launches', async () => {
    mocks.isNativePlatform.mockReturnValue(true);
    await openExternalMagnetUrl(magnet);
    expect(mocks.openUrl).toHaveBeenCalledWith({ url: magnet });
    mocks.openUrl.mockResolvedValueOnce({ completed: false });
    await expect(openExternalMagnetUrl(magnet)).rejects.toThrow('No torrent app');
  });
  it('validates magnets before any platform call and keeps HTTP-only callers restricted', async () => {
    for (const url of [
      'intent://torrent',
      'javascript:alert(1)',
      'https://example.org',
      'magnet:?xt=bad',
    ])
      await expect(openExternalMagnetUrl(url)).rejects.toThrow('Invalid magnet link');
    await expect(openExternalHttpUrl(magnet)).rejects.toThrow('Only HTTP(S)');
    expect(browserOpen).not.toHaveBeenCalled();
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(mocks.tauriOpenUrl).not.toHaveBeenCalled();
  });
});
