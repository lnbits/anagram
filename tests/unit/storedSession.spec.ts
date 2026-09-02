import { createStoredSessionChecker } from 'src/router/storedSession';
import {
  AUTH_METHOD_STORAGE_KEY,
  PRIVATE_KEY_STORAGE_KEY,
  PUBLIC_KEY_STORAGE_KEY,
} from 'src/stores/nostr/constants';
import { describe, expect, it, vi } from 'vitest';

function createStorage(initialValues: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initialValues));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function createHarness(
  storage: Storage | null = createStorage({
    [PUBLIC_KEY_STORAGE_KEY]: 'a'.repeat(64),
    [AUTH_METHOD_STORAGE_KEY]: 'nsec',
    [PRIVATE_KEY_STORAGE_KEY]: 'private-key',
  })
) {
  const clearAndroidSessionMetadata = vi.fn();
  const clearElectronSessionMetadata = vi.fn();
  const hasUsableAndroidSession = vi.fn().mockResolvedValue(true);
  const hasUsableElectronSession = vi.fn().mockResolvedValue(true);
  const hasStoredSession = createStoredSessionChecker({
    clearAndroidSessionMetadata,
    clearElectronSessionMetadata,
    getLocalStorage: () => storage,
    hasUsableAndroidSession,
    hasUsableElectronSession,
  });

  return {
    clearAndroidSessionMetadata,
    clearElectronSessionMetadata,
    hasStoredSession,
    hasUsableAndroidSession,
    hasUsableElectronSession,
    storage,
  };
}

describe('storedSession', () => {
  it('reuses a successful secure-storage check during later navigation', async () => {
    const harness = createHarness();

    await expect(harness.hasStoredSession()).resolves.toBe(true);
    expect(harness.hasStoredSession()).toBe(true);

    expect(harness.hasUsableAndroidSession).toHaveBeenCalledTimes(1);
    expect(harness.hasUsableElectronSession).toHaveBeenCalledTimes(1);
  });

  it('shares an in-flight secure-storage check', async () => {
    let resolveAndroidCheck!: (value: boolean) => void;
    const androidCheck = new Promise<boolean>((resolve) => {
      resolveAndroidCheck = resolve;
    });
    const harness = createHarness();
    harness.hasUsableAndroidSession.mockReturnValue(androidCheck);

    const firstCheck = harness.hasStoredSession();
    const secondCheck = harness.hasStoredSession();
    resolveAndroidCheck(true);

    await expect(Promise.all([firstCheck, secondCheck])).resolves.toEqual([true, true]);
    expect(harness.hasUsableAndroidSession).toHaveBeenCalledTimes(1);
    expect(harness.hasUsableElectronSession).toHaveBeenCalledTimes(1);
  });

  it('revalidates when the stored identity changes', async () => {
    const harness = createHarness();

    await harness.hasStoredSession();
    harness.storage?.setItem(PUBLIC_KEY_STORAGE_KEY, 'b'.repeat(64));
    await harness.hasStoredSession();

    expect(harness.hasUsableAndroidSession).toHaveBeenCalledTimes(2);
    expect(harness.hasUsableElectronSession).toHaveBeenCalledTimes(2);
  });

  it('does not clear a replacement identity when an older check fails', async () => {
    let resolveAndroidCheck!: (value: boolean) => void;
    const androidCheck = new Promise<boolean>((resolve) => {
      resolveAndroidCheck = resolve;
    });
    const harness = createHarness();
    harness.hasUsableAndroidSession.mockReturnValueOnce(androidCheck).mockResolvedValueOnce(true);

    const firstCheck = harness.hasStoredSession();
    harness.storage?.setItem(PUBLIC_KEY_STORAGE_KEY, 'b'.repeat(64));
    resolveAndroidCheck(false);

    await expect(firstCheck).resolves.toBe(true);
    expect(harness.clearAndroidSessionMetadata).not.toHaveBeenCalled();
    expect(harness.hasUsableAndroidSession).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed secure-storage check', async () => {
    const harness = createHarness();
    harness.hasUsableAndroidSession.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await expect(harness.hasStoredSession()).resolves.toBe(false);
    await expect(harness.hasStoredSession()).resolves.toBe(true);

    expect(harness.clearAndroidSessionMetadata).toHaveBeenCalledTimes(1);
    expect(harness.hasUsableAndroidSession).toHaveBeenCalledTimes(2);
  });

  it('does not access secure storage without a stored public key', async () => {
    const harness = createHarness(createStorage());

    expect(harness.hasStoredSession()).toBe(false);
    expect(harness.hasUsableAndroidSession).not.toHaveBeenCalled();
    expect(harness.hasUsableElectronSession).not.toHaveBeenCalled();
  });
});
