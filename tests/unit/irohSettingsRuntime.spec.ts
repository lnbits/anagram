import { createIrohSettingsRuntime } from 'src/stores/nostr/irohSettingsRuntime';
import type { PrivatePreferences } from 'src/stores/nostr/types';
import {
  defaultIrohRelays,
  migrateIrohRelaySettings,
  normalizeIrohRelaySettings,
  normalizeIrohRelayUrl,
  resolveIrohRelays,
  SHARED_IROH_RELAYS,
} from 'src/utils/irohRelays';
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
    const custom = 'https://mine.example.com/';
    expect(defaultIrohRelays().map((entry) => entry.url)).toEqual(SHARED_IROH_RELAYS);
    expect(
      resolveIrohRelays({ mode: 'pool', customRelays: [custom] }).map((entry) => entry.url)
    ).toEqual(SHARED_IROH_RELAYS);
    expect(
      resolveIrohRelays({ mode: 'pool-custom', customRelays: [custom] }).map((entry) => entry.url)
    ).toEqual([...SHARED_IROH_RELAYS, custom]);
    expect(resolveIrohRelays({ mode: 'custom', customRelays: [custom] })).toEqual([
      { url: custom, enabled: true },
    ]);
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
  it('migrates a partial built-in selection to the full pool and preserves custom-only choices', () => {
    const custom = { url: 'https://mine.example.com/', enabled: true };
    expect(migrateIrohRelaySettings([{ url: 'https://iroh.nostr.com/', enabled: true }])).toEqual({
      mode: 'pool',
      customRelays: [],
    });
    expect(
      migrateIrohRelaySettings([{ url: SHARED_IROH_RELAYS[1], enabled: true }, custom])
    ).toEqual({ mode: 'pool-custom', customRelays: [custom.url] });
    expect(
      migrateIrohRelaySettings([
        { url: 'https://iroh.nostr.com/', enabled: false },
        custom,
        { url: 'https://unused.example.com', enabled: false },
      ])
    ).toEqual({ mode: 'custom', customRelays: [custom.url] });
    const old = harness({ irohRelays: [{ url: 'https://iroh.nostr.com/', enabled: true }] });
    expect(old.runtime.getIrohRelays()).toEqual(defaultIrohRelays());
  });
  it('saves mode privately, preserves unrelated preferences and keeps a compatible resolved list', async () => {
    const h = harness();
    const settings = { mode: 'custom' as const, customRelays: ['https://mine.example.com/'] };
    await h.runtime.saveIrohRelaySettings(settings);
    expect(h.publish).toHaveBeenCalledWith({
      contactSecret: 'a'.repeat(64),
      blossomServerUrl: 'https://media.example.com',
      irohRelaySettings: settings,
      irohRelays: [{ url: settings.customRelays[0], enabled: true }],
    });
    expect(h.runtime.getIrohRelaySettings()).toEqual(settings);
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
