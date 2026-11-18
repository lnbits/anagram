import { afterEach, describe, expect, it, vi } from 'vitest';
import NostrClient, { ClientEvent, NostrRelaySet } from '#src/lib/nostr/client.ts';
import {
  fetchEventsWithRelayTimeout,
  RelayQueryTimeoutError,
  retainStartupQueryFilters,
} from '#src/stores/nostr/relayQueryUtils.ts';
import {
  resetStartupRelayTracking,
  startupRelayObserver,
  startupRelayStatuses,
  needsStartupRelayRetry,
} from '#src/stores/nostr/startupRelayTracking.ts';
import { createStartupRuntime } from '#src/stores/nostr/startupRuntime.ts';
import {
  createInitialStartupStepSnapshots,
  type StartupDisplaySnapshot,
} from '#src/stores/nostr/startupState.ts';

const good = 'wss://healthy.example/';
const slow = 'wss://slow.example/';
const clients: NostrClient[] = [];
function setup() {
  vi.useFakeTimers();
  const client = new NostrClient({ authenticate: false });
  clients.push(client);
  const handlers = new Map<string, any>();
  const starts = new Map<string, number>();
  const closes = new Map<string, ReturnType<typeof vi.fn>>();
  for (const url of [good, slow]) {
    vi.spyOn(client.pool.getRelay(url, false), 'connect').mockResolvedValue();
    closes.set(url, vi.fn());
  }
  vi.spyOn(client.transport, 'getExistingRelay').mockImplementation(
    (url) =>
      ({
        connected: true,
        subscribe: (_filters: unknown, options: unknown) => {
          starts.set(url, (starts.get(url) ?? 0) + 1);
          handlers.set(url, options);
          return { close: closes.get(url) };
        },
      }) as never,
  );
  const query = () =>
    fetchEventsWithRelayTimeout(
      client,
      { kinds: [30078], authors: ['a'.repeat(64)] },
      { startupTrackId: 'private-preferences' },
      NostrRelaySet.fromRelayUrls([good, slow], client, false),
      100,
    );
  const event = (id: string, created_at: number) =>
    new ClientEvent(client, {
      id,
      created_at,
      kind: 30078,
      pubkey: 'a'.repeat(64),
      tags: [['d', '1']],
      content: 'encrypted',
    });
  return { client, handlers, starts, closes, query, event };
}
afterEach(() => {
  clients.splice(0).forEach(resetStartupRelayTracking);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startup snapshots across unreliable relays', () => {
  it('retains healthy data and retries only the unfinished replica, with live status updates', async () => {
    const { client, handlers, starts, query, event } = setup();
    const first = query();
    await vi.advanceTimersByTimeAsync(0);
    handlers.get(good).onevent(event('newer', 20));
    handlers.get(good).oneose();
    await vi.advanceTimersByTimeAsync(100);
    expect([...(await first)].map((event) => event.id)).toEqual(['newer']);
    expect(startupRelayStatuses(client, 'private-preferences')).toEqual([
      { relayUrl: good, status: 'success' },
      { relayUrl: slow, status: 'error', reason: 'timeout' },
    ]);
    const second = query();
    expect(
      startupRelayStatuses(client, 'private-preferences').find((r) => r.relayUrl === slow)?.status,
    ).toBe('retrying');
    await vi.advanceTimersByTimeAsync(0);
    handlers.get(slow).onevent(event('older', 10));
    handlers.get(slow).oneose();
    expect([...(await second)].map((event) => event.id)).toEqual(['newer']);
    expect(starts.get(good)).toBe(1);
    expect(starts.get(slow)).toBe(2);
    expect(
      startupRelayStatuses(client, 'private-preferences').every((r) => r.status === 'success'),
    ).toBe(true);
  });

  it('keeps events received before a timeout without inventing completion', async () => {
    const { client, handlers, query, event } = setup();
    const pending = query();
    await vi.advanceTimersByTimeAsync(0);
    handlers.get(good).onevent(event('partial', 20));
    await vi.advanceTimersByTimeAsync(100);
    expect([...(await pending)].map((event) => event.id)).toEqual(['partial']);
    expect(
      startupRelayStatuses(client, 'private-preferences').every((r) => r.status === 'error'),
    ).toBe(true);
  });

  it('requires real EOSE for an empty successful snapshot', async () => {
    const { client, handlers, query } = setup();
    const pending = query();
    const rejected = expect(pending).rejects.toBeInstanceOf(RelayQueryTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    const retry = query();
    await vi.advanceTimersByTimeAsync(0);
    handlers.get(good).oneose();
    handlers.get(slow).oneose();
    expect((await retry).size).toBe(0);
    expect(
      startupRelayStatuses(client, 'private-preferences').every((r) => r.status === 'success'),
    ).toBe(true);
  });

  it('cancels queries and ignores old callbacks after logout/account reset', async () => {
    const { client, handlers, closes, query, event } = setup();
    const pending = query();
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    const old = handlers.get(good);
    resetStartupRelayTracking(client);
    await rejected;
    old.onevent(event('old-account', 20));
    old.oneose();
    expect(startupRelayStatuses(client, 'private-preferences')).toEqual([]);
    expect(closes.get(good)).toHaveBeenCalled();
    const next = query();
    await vi.advanceTimersByTimeAsync(0);
    handlers.get(good).oneose();
    handlers.get(slow).oneose();
    expect((await next).size).toBe(0);
  });

  it('keeps failures visible across batches and ignores replaced-operation callbacks', () => {
    const client = {};
    const first = startupRelayObserver(client, ['contact-cursor-data'], 'batch-a', [good]);
    const second = startupRelayObserver(client, ['contact-cursor-data'], 'batch-b', [good]);
    first({ relayUrl: good, status: 'success' });
    second({ relayUrl: good, status: 'error', reason: 'timeout' });
    expect(startupRelayStatuses(client, 'contact-cursor-state')[0]?.status).toBe('error');
    const retry = startupRelayObserver(client, ['contact-cursor-data'], 'batch-b', [good]);
    second({ relayUrl: good, status: 'success' });
    expect(startupRelayStatuses(client, 'contact-cursor-state')[0]?.status).toBe('retrying');
    retry({ relayUrl: good, status: 'success' });
    expect(startupRelayStatuses(client, 'contact-cursor-state')[0]?.status).toBe('success');
  });

  it('retires failed cursor batches when the recovered secret changes their filters', () => {
    const client = {};
    const previous = { kinds: [30078], '#d': ['old-secret-derived-tag'] };
    const report = startupRelayObserver(
      client,
      ['contact-cursor-data'],
      JSON.stringify(['contact-cursor-data', previous]),
      [slow],
      { snapshot: true },
    );
    report({ relayUrl: slow, status: 'error', reason: 'timeout' });
    expect(needsStartupRelayRetry(client, 'contact-cursor-state')).toBe(true);
    retainStartupQueryFilters(client, 'contact-cursor-data', [
      { kinds: [30078], '#d': ['new-secret-derived-tag'] },
    ]);
    report({ relayUrl: slow, status: 'error', reason: 'timeout' });
    expect(needsStartupRelayRetry(client, 'contact-cursor-state')).toBe(false);
    expect(startupRelayStatuses(client, 'contact-cursor-state')).toEqual([]);
  });

  it('shows partial results, follows late EOSE and preserves a local apply error', () => {
    const client = {};
    const state = {
      relayClient: client,
      startupSteps: createInitialStartupStepSnapshots(),
      startupDisplay: {
        stepId: null,
        label: null,
        status: null,
        showProgress: false,
      } as StartupDisplaySnapshot,
      startupState: { startupDisplayShownAt: 0, startupDisplayTimer: null, startupDisplayToken: 0 },
      startupStepMinProgressMs: 0,
    };
    const runtime = createStartupRuntime(state);
    runtime.beginStartupStep('private-preferences');
    const report = startupRelayObserver(client, ['private-preferences'], 'preferences', [
      good,
      slow,
    ]);
    report({ relayUrl: good, status: 'success' });
    report({ relayUrl: slow, status: 'error', reason: 'timeout' });
    runtime.completeStartupStep('private-preferences');
    expect(runtime.getStartupStepSnapshot('private-preferences').status).toBe('partial');
    expect(state.startupDisplay.status).toBe('partial');
    report({ relayUrl: slow, status: 'success' });
    expect(runtime.getStartupStepSnapshot('private-preferences').status).toBe('success');
    runtime.resetStartupStepTracking();
    runtime.beginStartupStep('private-preferences');
    expect(runtime.getStartupStepSnapshot('private-preferences').relays).toHaveLength(2);
    runtime.failStartupStep('private-preferences', new Error('local apply error'));
    report({ relayUrl: slow, status: 'success' });
    expect(runtime.getStartupStepSnapshot('private-preferences').status).toBe('error');
  });
});
