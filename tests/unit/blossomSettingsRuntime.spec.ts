import { createBlossomSettingsRuntime } from '#src/stores/nostr/blossomSettingsRuntime.ts';
import type { PrivatePreferences } from '#src/stores/nostr/types.ts';
import {
  DEFAULT_BLOSSOM_SERVER_URL,
  DEFAULT_PRIVATE_MEDIA_BLOSSOM_SERVER_URL,
} from '#src/utils/blossomServer.ts';
import { describe, expect, it, vi } from 'vitest';

const CONTACT_SECRET = 'a'.repeat(64);

function createHarness(storedPreferences: PrivatePreferences | null = null) {
  let stored = storedPreferences;
  const ensurePrivatePreferences = vi.fn(async () => stored ?? { contactSecret: CONTACT_SECRET });
  const publishPrivatePreferences = vi.fn(async () => undefined);
  const readPrivatePreferencesFromStorage = vi.fn(() => stored);
  const writePrivatePreferencesToStorage = vi.fn((preferences: PrivatePreferences) => {
    stored = preferences;
  });
  const runtime = createBlossomSettingsRuntime({
    ensurePrivatePreferences,
    publishPrivatePreferences,
    readPrivatePreferencesFromStorage,
    writePrivatePreferencesToStorage,
  });

  return {
    ensurePrivatePreferences,
    publishPrivatePreferences,
    runtime,
    writePrivatePreferencesToStorage,
  };
}

describe('Blossom settings runtime', () => {
  it('uses the default when no encrypted preference exists', () => {
    const { runtime } = createHarness();

    expect(runtime.getBlossomServerUrl()).toBe(DEFAULT_BLOSSOM_SERVER_URL);
  });

  it('publishes and caches a normalized server in private preferences', async () => {
    const { publishPrivatePreferences, runtime, writePrivatePreferencesToStorage } = createHarness({
      contactSecret: CONTACT_SECRET,
      notifications: true,
    });

    await expect(runtime.saveBlossomServerUrl(' HTTPS://Media.Example.com/ ')).resolves.toBe(
      'https://media.example.com'
    );
    const expectedPreferences = {
      contactSecret: CONTACT_SECRET,
      notifications: true,
      blossomServerUrl: 'https://media.example.com',
    };
    expect(publishPrivatePreferences).toHaveBeenCalledWith(expectedPreferences);
    expect(writePrivatePreferencesToStorage).toHaveBeenCalledWith(expectedPreferences);
    expect(runtime.getBlossomServerUrl()).toBe('https://media.example.com');
  });

  it('removes the override when restoring the default server', async () => {
    const { publishPrivatePreferences, runtime, writePrivatePreferencesToStorage } = createHarness({
      contactSecret: CONTACT_SECRET,
      blossomServerUrl: 'https://media.example.com',
    });

    await runtime.saveBlossomServerUrl(DEFAULT_BLOSSOM_SERVER_URL);

    expect(publishPrivatePreferences).toHaveBeenCalledWith({ contactSecret: CONTACT_SECRET });
    expect(writePrivatePreferencesToStorage).toHaveBeenCalledWith({
      contactSecret: CONTACT_SECRET,
    });
    expect(runtime.getBlossomServerUrl()).toBe(DEFAULT_BLOSSOM_SERVER_URL);
  });

  it('does not cache a change when encrypted publication fails', async () => {
    const { publishPrivatePreferences, runtime, writePrivatePreferencesToStorage } = createHarness({
      contactSecret: CONTACT_SECRET,
    });
    publishPrivatePreferences.mockRejectedValueOnce(new Error('relay unavailable'));

    await expect(runtime.saveBlossomServerUrl('https://media.example.com')).rejects.toThrow(
      'relay unavailable'
    );
    expect(writePrivatePreferencesToStorage).not.toHaveBeenCalled();
    expect(runtime.getBlossomServerUrl()).toBe(DEFAULT_BLOSSOM_SERVER_URL);
  });

  describe('private media server', () => {
    it('defaults to the compatible private-media server, separate from regular media', () => {
      const { runtime } = createHarness();

      expect(runtime.getPrivateMediaBlossomServerUrl()).toBe(
        DEFAULT_PRIVATE_MEDIA_BLOSSOM_SERVER_URL
      );
      expect(runtime.getBlossomServerUrl()).toBe(DEFAULT_BLOSSOM_SERVER_URL);
      expect(DEFAULT_PRIVATE_MEDIA_BLOSSOM_SERVER_URL).toBe('https://blossom.ditto.pub');
      expect(DEFAULT_PRIVATE_MEDIA_BLOSSOM_SERVER_URL).not.toBe(DEFAULT_BLOSSOM_SERVER_URL);
    });

    it('overrides only the private default when a compatible server is configured', async () => {
      const { publishPrivatePreferences, runtime } = createHarness({
        contactSecret: CONTACT_SECRET,
        blossomServerUrl: 'https://regular.example.com',
      });

      await runtime.savePrivateMediaBlossomServerUrl('https://Private.Example.com/');

      expect(publishPrivatePreferences).toHaveBeenCalledWith({
        contactSecret: CONTACT_SECRET,
        blossomServerUrl: 'https://regular.example.com',
        privateMediaBlossomServerUrl: 'https://private.example.com',
      });
      expect(runtime.getPrivateMediaBlossomServerUrl()).toBe('https://private.example.com');
      expect(runtime.getBlossomServerUrl()).toBe('https://regular.example.com');
    });

    it('saving the regular server leaves the private-media server untouched', async () => {
      const { runtime } = createHarness({
        contactSecret: CONTACT_SECRET,
        privateMediaBlossomServerUrl: 'https://private.example.com',
      });

      await runtime.saveBlossomServerUrl('https://regular.example.com');

      expect(runtime.getPrivateMediaBlossomServerUrl()).toBe('https://private.example.com');
      expect(runtime.getBlossomServerUrl()).toBe('https://regular.example.com');
    });

    it('removes the override when restoring the private default', async () => {
      const { publishPrivatePreferences, runtime } = createHarness({
        contactSecret: CONTACT_SECRET,
        privateMediaBlossomServerUrl: 'https://private.example.com',
      });

      await runtime.savePrivateMediaBlossomServerUrl(DEFAULT_PRIVATE_MEDIA_BLOSSOM_SERVER_URL);

      expect(publishPrivatePreferences).toHaveBeenCalledWith({ contactSecret: CONTACT_SECRET });
      expect(runtime.getPrivateMediaBlossomServerUrl()).toBe(
        DEFAULT_PRIVATE_MEDIA_BLOSSOM_SERVER_URL
      );
    });

    it('rejects insecure private-media servers', async () => {
      const { publishPrivatePreferences, runtime } = createHarness();

      await expect(
        runtime.savePrivateMediaBlossomServerUrl('http://private.example.com')
      ).rejects.toThrow('Enter a valid HTTPS Blossom server URL');
      expect(publishPrivatePreferences).not.toHaveBeenCalled();
    });
  });
});
