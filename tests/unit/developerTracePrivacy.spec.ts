import { describe, expect, it, vi } from 'vitest';
import { generateSecretKey, nip19 } from 'nostr-tools';
import { ref } from '#src/lib/state/reactivity.ts';
import {
  createDeveloperTraceRuntime,
  readDeveloperDiagnosticsEnabledFromStorage,
} from '#src/stores/nostr/developerTrace.ts';
const append = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('#src/services/developerTraceDataService.ts', () => ({
  developerTraceDataService: { appendEntry: append },
}));

function runtime(enabled: boolean) {
  return createDeveloperTraceRuntime({
    developerDiagnosticsEnabled: ref(enabled),
    developerDiagnosticsVersion: ref(0),
    developerTraceState: { developerTraceCounter: 0 },
    developerTraceVersion: ref(0),
    developerDiagnosticsStorageKey: 'diagnostics',
    getLoggedInPublicKeyHex: () => 'a'.repeat(64),
  });
}
describe('private diagnostic data', () => {
  it('redacts nested keys, decrypted content, binary keys and secrets inside errors', () => {
    const key = generateSecretKey(),
      nsec = nip19.nsecEncode(key);
    const hex = Buffer.from(key).toString('hex');
    const result = JSON.stringify(
      runtime(true).normalizeDeveloperTraceDetails({
        rumor: { content: 'private conversation', tags: [['secret', hex]] },
        privateKey: hex,
        binary: key,
        error: new Error(`failed ${nsec} ${hex}`),
        count: 12,
      }),
    );
    expect([nsec, hex, 'private conversation'].some((value) => result.includes(value))).toBe(false);
    expect(JSON.parse(result).count).toBe(12);
  });
  it('does not echo or persist diagnostics when disabled', () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    append.mockClear();
    runtime(false).logDeveloperTrace('info', 'inbound', 'private-message-received', {
      content: 'private',
    });
    expect(consoleInfo).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
    consoleInfo.mockRestore();
  });
  it('requires opt-in without browser storage', () => {
    expect(readDeveloperDiagnosticsEnabledFromStorage('diagnostics')).toBe(false);
  });
});

it('redacts credentials and sensitive field names before persisting or echoing traces', async () => {
  const secret = nip19.nsecEncode(generateSecretKey());
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  append.mockClear();
  try {
    runtime(true).logDeveloperTrace('info', 'subscription:test', 'start', {
      [secret]: 'field',
      relay: 'wss://name:password@relay.test/?token=relay-access-token',
      credentials: 'raw-credentials',
      error: new SyntaxError('decrypted-message-fragment'),
    });
    const output = JSON.stringify([append.mock.calls, info.mock.calls]);
    for (const value of [
      secret,
      'name:password',
      'relay-access-token',
      'raw-credentials',
      'decrypted-message-fragment',
    ])
      expect(output).not.toContain(value);
    expect(append).toHaveBeenCalledOnce();
  } finally {
    info.mockRestore();
  }
});

it('bounds pending diagnostics and console echoes during a relay event flood', async () => {
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  append.mockClear().mockImplementation(() => stalled);
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const trace = runtime(true);
  try {
    for (let i = 0; i < 5000; i++)
      trace.logDeveloperTrace('info', 'inbound', 'private-message-received', { index: i });
    expect(append).toHaveBeenCalledTimes(200);
    expect(info).toHaveBeenCalledTimes(20);
    expect(info.mock.calls.every((args) => args.length === 1 && typeof args[0] === 'string')).toBe(
      true,
    );
    release();
    await stalled;
    await Promise.resolve();
    await Promise.resolve();
    trace.logDeveloperTrace('info', 'queue', 'drained');
    expect(append.mock.calls.at(-1)?.[0].details.droppedTraceEntries).toBe(4800);
  } finally {
    release();
    append.mockResolvedValue(undefined);
    info.mockRestore();
  }
});
