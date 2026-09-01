import type { PrivatePreferences } from 'src/stores/nostr/types';
import {
  DEFAULT_BLOSSOM_SERVER_URL,
  normalizeBlossomServerUrl,
  requireBlossomServerUrl,
} from 'src/utils/blossomServer';

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
  function getBlossomServerUrl(): string {
    return (
      normalizeBlossomServerUrl(readPrivatePreferencesFromStorage()?.blossomServerUrl) ??
      DEFAULT_BLOSSOM_SERVER_URL
    );
  }

  async function saveBlossomServerUrl(value: string): Promise<string> {
    const serverUrl = requireBlossomServerUrl(value);
    const preferences = await ensurePrivatePreferences();
    const currentServerUrl =
      normalizeBlossomServerUrl(preferences.blossomServerUrl) ?? DEFAULT_BLOSSOM_SERVER_URL;
    if (currentServerUrl === serverUrl) {
      return serverUrl;
    }

    const nextPreferences: PrivatePreferences = { ...preferences };
    if (serverUrl === DEFAULT_BLOSSOM_SERVER_URL) {
      delete nextPreferences.blossomServerUrl;
    } else {
      nextPreferences.blossomServerUrl = serverUrl;
    }

    await publishPrivatePreferences(nextPreferences);
    writePrivatePreferencesToStorage(nextPreferences);
    return serverUrl;
  }

  return {
    getBlossomServerUrl,
    saveBlossomServerUrl,
  };
}
