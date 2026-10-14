import type { PrivatePreferences } from '#src/stores/nostr/types.ts';
import {
  DEFAULT_BLOSSOM_SERVER_URL,
  normalizeBlossomServerUrl,
  requireBlossomServerUrl,
} from '#src/utils/blossomServer.ts';

// Where the server used for new uploads came from, so Settings can say so.
export type BlossomServerOrigin = 'preference' | 'published' | 'default';

interface BlossomSettingsRuntimeDeps {
  ensurePrivatePreferences: () => Promise<PrivatePreferences>;
  publishPrivatePreferences: (preferences: PrivatePreferences) => Promise<void>;
  readPrivatePreferencesFromStorage: () => PrivatePreferences | null;
  // The Blossom server list the account publishes to its relays, newest first.
  readPublishedBlossomServerUrls: () => string[];
  writePrivatePreferencesToStorage: (preferences: PrivatePreferences) => void;
}

export function createBlossomSettingsRuntime({
  ensurePrivatePreferences,
  publishPrivatePreferences,
  readPrivatePreferencesFromStorage,
  readPublishedBlossomServerUrls,
  writePrivatePreferencesToStorage,
}: BlossomSettingsRuntimeDeps) {
  function firstPublishedBlossomServerUrl(): string | null {
    for (const value of readPublishedBlossomServerUrls()) {
      const serverUrl = normalizeBlossomServerUrl(value);
      if (serverUrl) {
        return serverUrl;
      }
    }

    return null;
  }

  // An explicit choice in Settings wins; otherwise the account's published list (BUD-03)
  // decides; otherwise the built-in default. The default stays overridable, and restoring
  // it simply removes the preference so the published list takes over again.
  function resolveBlossomServer(): { url: string; origin: BlossomServerOrigin } {
    const preferredServerUrl = normalizeBlossomServerUrl(
      readPrivatePreferencesFromStorage()?.blossomServerUrl,
    );
    if (preferredServerUrl) {
      return { url: preferredServerUrl, origin: 'preference' };
    }

    const publishedServerUrl = firstPublishedBlossomServerUrl();
    if (publishedServerUrl) {
      return { url: publishedServerUrl, origin: 'published' };
    }

    return { url: DEFAULT_BLOSSOM_SERVER_URL, origin: 'default' };
  }

  function getBlossomServerUrl(): string {
    return resolveBlossomServer().url;
  }

  function getBlossomServerOrigin(): BlossomServerOrigin {
    return resolveBlossomServer().origin;
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
    getBlossomServerOrigin,
    getBlossomServerUrl,
    saveBlossomServerUrl,
  };
}
