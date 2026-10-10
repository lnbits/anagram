import { createIrohSettingsRuntime } from '#src/stores/nostr/irohSettingsRuntime.ts';
import type { PrivatePreferences } from '#src/stores/nostr/types.ts';
import {
  defaultIrohRelays,
  normalizeIrohRelaySettings,
  normalizeIrohRelayUrl,
  resolveIrohRelays,
  SHARED_IROH_RELAYS,
} from '#src/utils/irohRelays.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

function harness(initial: Partial<PrivatePreferences> = {}) {
  let stored: PrivatePreferences = {
    contactSecret: 'a'.repeat(64),
    blossomServerUrl: 'https://media.example.com',
    ...initial,
  };
  let own = 'b'.repeat(64);
  const publish = vi.fn(async (_value: PrivatePreferences) => {});
  const write = vi.fn((value: PrivatePreferences) => {
    stored = value;
  });
  return {
    publish,
    write,
    changeAccount: () => {
      own = 'c'.repeat(64);
    },
    runtime: createIrohSettingsRuntime({
      ensurePrivatePreferences: async () => stored,
      readPrivatePreferencesFromStorage: () => stored,
      writePrivatePreferencesToStorage: write,
      publishPrivatePreferences: publish,
      getOwnPubkey: () => own,
    }),
  };
}
afterEach(() => vi.unstubAllEnvs());
describe('Iroh relay pool preferences', () => {
  it('defaults to all five built-in relays and resolves only the selected mode', () => {
    vi.stubEnv('APP_IROH_RELAY_URL', '');
    expect(harness().runtime.getIrohRelays()).toEqual(SHARED_IROH_RELAYS);
    const custom = 'https://mine.example.com/';
    expect(defaultIrohRelays()).toEqual(SHARED_IROH_RELAYS);
    expect(resolveIrohRelays({ mode: 'pool', customRelays: [custom] })).toEqual(SHARED_IROH_RELAYS);
    expect(resolveIrohRelays({ mode: 'pool-custom', customRelays: [custom] })).toEqual([
      ...SHARED_IROH_RELAYS,
      custom,
    ]);
    expect(resolveIrohRelays({ mode: 'custom', customRelays: [custom] })).toEqual([custom]);
  });
  it('rejects individual built-in servers, unsafe URLs, duplicates and empty custom mode', () => {
    expect(normalizeIrohRelayUrl(' HTTPS://EXAMPLE.COM:443/ ')).toBe('https://example.com/');
    for (const url of [
      'http://example.com',
      'wss://example.com',
      'https://user:pass@example.com',
      'https://example.com/path',
      'https://example.com/?x=1',
      'https://example.com/#x',
      'https://example.com./',
    ])
      expect(normalizeIrohRelayUrl(url)).toBeNull();
    for (const url of [
      ...SHARED_IROH_RELAYS,
      'https://IROH.NOSTR.COM:443',
      'https://iroh.nostr.com:8443',
    ])
      expect(normalizeIrohRelaySettings({ mode: 'custom', customRelays: [url] })).toBeNull();
    expect(normalizeIrohRelaySettings({ mode: 'custom', customRelays: [] })).toBeNull();
    expect(
      normalizeIrohRelaySettings({
        mode: 'custom',
        customRelays: ['https://mine.example.com', 'https://mine.example.com/'],
      })
    ).toBeNull();
    expect(
      normalizeIrohRelaySettings({
        mode: 'pool-custom',
        customRelays: Array.from({ length: 17 }, (_, i) => `https://relay${i}.example.com/`),
      })
    ).toBeNull();
  });
  it('saves mode privately, preserves unrelated preferences and resolves the selected relays', async () => {
    const h = harness();
    const settings = { mode: 'custom' as const, customRelays: ['https://mine.example.com/'] };
    await h.runtime.saveIrohRelaySettings(settings);
    expect(h.publish).toHaveBeenCalledWith({
      contactSecret: 'a'.repeat(64),
      blossomServerUrl: 'https://media.example.com',
      irohRelaySettings: settings,
    });
    expect(h.runtime.getIrohRelaySettings()).toEqual(settings);
    expect(h.runtime.getIrohRelays()).toEqual(settings.customRelays);
    await expect(
      h.runtime.saveIrohRelaySettings({ mode: 'custom', customRelays: ['https://iroh.nostr.com/'] })
    ).rejects.toThrow();
    expect(h.publish).toHaveBeenCalledOnce();
    await h.runtime.saveIrohRelaySettings({ mode: 'pool', customRelays: [] });
    expect(h.runtime.getIrohRelays()).toEqual(defaultIrohRelays());
  });
  it('keeps existing settings after failed publication or an account change', async () => {
    const h = harness();
    const settings = { mode: 'custom' as const, customRelays: ['https://mine.example.com/'] };
    h.publish.mockRejectedValueOnce(new Error('offline'));
    await expect(h.runtime.saveIrohRelaySettings(settings)).rejects.toThrow('offline');
    expect(h.write).not.toHaveBeenCalled();
    h.publish.mockImplementationOnce(async () => {
      h.changeAccount();
    });
    await expect(h.runtime.saveIrohRelaySettings(settings)).rejects.toThrow('Session changed');
    expect(h.write).not.toHaveBeenCalled();
  });
});
