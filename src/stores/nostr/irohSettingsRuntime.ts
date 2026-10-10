import type { PrivatePreferences } from '#src/stores/nostr/types.ts';
import {
  type IrohRelaySettings,
  normalizeIrohRelaySettings,
  resolveIrohRelays,
} from '#src/utils/irohRelays.ts';

interface Deps {
  ensurePrivatePreferences(): Promise<PrivatePreferences>;
  publishPrivatePreferences(preferences: PrivatePreferences): Promise<void>;
  readPrivatePreferencesFromStorage(): PrivatePreferences | null;
  writePrivatePreferencesToStorage(preferences: PrivatePreferences): void;
  getOwnPubkey(): string | null;
}
export function createIrohSettingsRuntime(deps: Deps) {
  function getIrohRelaySettings(): IrohRelaySettings {
    const preferences = deps.readPrivatePreferencesFromStorage();
    return (
      normalizeIrohRelaySettings(preferences?.irohRelaySettings) ?? {
        mode: 'pool',
        customRelays: [],
      }
    );
  }
  function getIrohRelays() {
    return resolveIrohRelays(getIrohRelaySettings());
  }
  async function saveIrohRelaySettings(value: IrohRelaySettings): Promise<IrohRelaySettings> {
    const settings = normalizeIrohRelaySettings(value);
    if (!settings)
      throw new Error(
        'Choose the shared pool or at least one custom HTTPS relay. Built-in relays cannot be selected individually.'
      );
    const own = deps.getOwnPubkey();
    if (!own) throw new Error('Sign in to save call relays.');
    const preferences = await deps.ensurePrivatePreferences();
    if (deps.getOwnPubkey() !== own) throw new Error('Session changed.');
    const next = { ...preferences, irohRelaySettings: settings };
    await deps.publishPrivatePreferences(next);
    if (deps.getOwnPubkey() !== own) throw new Error('Session changed.');
    // Keep unrelated preferences that may have changed while publication was in flight.
    deps.writePrivatePreferencesToStorage({
      ...(deps.readPrivatePreferencesFromStorage() ?? preferences),
      irohRelaySettings: settings,
    });
    return settings;
  }
  return { getIrohRelays, getIrohRelaySettings, saveIrohRelaySettings };
}
