import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isNativePlatform: vi.fn<() => boolean>(),
  openUrl: vi.fn(),
}));

vi.mock('@capacitor/app-launcher', () => ({
  AppLauncher: {
    openUrl: mocks.openUrl,
  },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: mocks.isNativePlatform,
  },
}));

import { openExternalHttpUrl } from 'src/utils/externalLinks';

describe('external links', () => {
  const browserOpen = vi.fn();

  beforeEach(() => {
    mocks.isNativePlatform.mockReturnValue(false);
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
      'noopener,noreferrer'
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
      'Only HTTP(S) links can be opened.'
    );
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(browserOpen).not.toHaveBeenCalled();
  });
});
