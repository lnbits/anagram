import {
  raceWithTimeout,
  selectReadyRelayUrls,
  waitForFirstReadyOrTimeout,
} from 'src/stores/nostr/relayTimeoutUtils';
import { describe, expect, it } from 'vitest';

describe('relayTimeoutUtils', () => {
  it('returns the fallback when a promise hangs past the timeout', async () => {
    const startedAt = Date.now();
    const result = await raceWithTimeout(new Promise<string>(() => {}), 40, 'timeout');
    const elapsedMs = Date.now() - startedAt;

    expect(result).toBe('timeout');
    expect(elapsedMs).toBeLessThan(250);
  });

  it('returns the original value when it resolves before the timeout', async () => {
    const result = await raceWithTimeout(Promise.resolve('ok'), 200, 'timeout');
    expect(result).toBe('ok');
  });

  it('returns as soon as a relay becomes ready instead of waiting for the full timeout', async () => {
    let ready = false;
    globalThis.setTimeout(() => {
      ready = true;
    }, 25);

    const startedAt = Date.now();
    const outcome = await waitForFirstReadyOrTimeout({
      isReady: () => ready,
      timeoutMs: 400,
      pollIntervalMs: 10,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(outcome).toBe('ready');
    expect(elapsedMs).toBeLessThan(250);
  });

  it('times out when no relay becomes ready', async () => {
    const startedAt = Date.now();
    const outcome = await waitForFirstReadyOrTimeout({
      isReady: () => false,
      timeoutMs: 40,
      pollIntervalMs: 10,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(outcome).toBe('timeout');
    expect(elapsedMs).toBeLessThan(250);
  });

  it('prefers currently ready relays and falls back to the full list', () => {
    expect(
      selectReadyRelayUrls(
        ['wss://fast.example/', 'wss://slow.example/', 'wss://dead.example/'],
        (relayUrl) => relayUrl === 'wss://fast.example/'
      )
    ).toEqual(['wss://fast.example/']);

    expect(
      selectReadyRelayUrls(['wss://slow.example/', 'wss://dead.example/'], () => false)
    ).toEqual([]);
  });
});
