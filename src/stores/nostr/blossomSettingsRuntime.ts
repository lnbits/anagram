import type { PrivatePreferences } from '#src/stores/nostr/types.ts';
import {
  DEFAULT_BLOSSOM_SERVER_URL,
  DEFAULT_PRIVATE_MEDIA_BLOSSOM_SERVER_URL,
  normalizeBlossomServerUrl,
  requireBlossomServerUrl,
} from '#src/utils/blossomServer.ts';

interface BlossomSettingsRuntimeDeps {
  ensurePrivatePreferences: () => Promise<PrivatePreferences>;
  publishPrivatePreferences: (preferences: PrivatePreferences) => Promise<void>;
  readPrivatePreferencesFromStorage: () => PrivatePreferences | null;
  writePrivatePreferencesToStorage: (preferences: PrivatePreferences) => void;
}

export function createBlossomSettingsRuntime({
  ensurePrivatePreferences,
  publishPrivatePreferences,
  readPrivatePreferencesFromStorage,
  writePrivatePreferencesToStorage,
}: BlossomSettingsRuntimeDeps) {
  type ServerPreferenceKey = 'blossomServerUrl' | 'privateMediaBlossomServerUrl';

  function readServerUrl(key: ServerPreferenceKey, defaultUrl: string): string {
    return normalizeBlossomServerUrl(readPrivatePreferencesFromStorage()?.[key]) ?? defaultUrl;
  }

  async function saveServerUrl(
    key: ServerPreferenceKey,
    defaultUrl: string,
    value: string
  ): Promise<string> {
    const serverUrl = requireBlossomServerUrl(value);
    const preferences = await ensurePrivatePreferences();
    const currentServerUrl = normalizeBlossomServerUrl(preferences[key]) ?? defaultUrl;
    if (currentServerUrl === serverUrl) {
      return serverUrl;
    }

    const nextPreferences: PrivatePreferences = { ...preferences };
    if (serverUrl === defaultUrl) {
      delete nextPreferences[key];
    } else {
      nextPreferences[key] = serverUrl;
    }

    await publishPrivatePreferences(nextPreferences);
    writePrivatePreferencesToStorage(nextPreferences);
    return serverUrl;
  }

  // Regular (plaintext) media, e.g. video and audio.
  function getBlossomServerUrl(): string {
    return readServerUrl('blossomServerUrl', DEFAULT_BLOSSOM_SERVER_URL);
  }

  function saveBlossomServerUrl(value: string): Promise<string> {
    return saveServerUrl('blossomServerUrl', DEFAULT_BLOSSOM_SERVER_URL, value);
  }

  // End-to-end encrypted private media. The server must preserve ciphertext bytes exactly.
  function getPrivateMediaBlossomServerUrl(): string {
    return readServerUrl('privateMediaBlossomServerUrl', DEFAULT_PRIVATE_MEDIA_BLOSSOM_SERVER_URL);
  }

  function savePrivateMediaBlossomServerUrl(value: string): Promise<string> {
    return saveServerUrl(
      'privateMediaBlossomServerUrl',
      DEFAULT_PRIVATE_MEDIA_BLOSSOM_SERVER_URL,
      value
    );
  }

  return {
    getBlossomServerUrl,
    getPrivateMediaBlossomServerUrl,
    saveBlossomServerUrl,
    savePrivateMediaBlossomServerUrl,
  };
}
