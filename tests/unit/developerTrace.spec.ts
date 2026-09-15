import { developerTraceDataService } from 'src/services/developerTraceDataService';
import { createDeveloperTraceRuntime } from 'src/stores/nostr/developerTrace';
import { afterEach, expect, it, vi } from 'vitest';
import { ref } from 'vue';

vi.mock('src/services/developerTraceDataService', () => ({
  developerTraceDataService: {
    appendEntries: vi.fn(async () => {}),
    listEntries: vi.fn(async () => []),
    clearEntries: vi.fn(async () => {}),
  },
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
function fixture() {
  let owner: string | null = 'fixture';
  const version = ref(0);
  const runtime = createDeveloperTraceRuntime({
    developerDiagnosticsEnabled: ref(true),
    developerDiagnosticsVersion: ref(0),
    developerTraceState: { developerTraceCounter: 0 },
    developerTraceVersion: version,
    developerDiagnosticsStorageKey: 'fixture',
    getLoggedInPublicKeyHex: () => owner,
  });
  return {
    runtime,
    version,
    setOwner: (next: string | null) => {
      owner = next;
    },
  };
}
it('coalesces 1300 repeated auth failures into one useful count and one persistence batch', async () => {
  vi.useFakeTimers();
  const { runtime, version } = fixture();
  for (let i = 0; i < 1300; i++)
    runtime.logDeveloperTrace('warn', 'relay', 'auth-failed', {
      url: 'wss://fixture.example/',
      error: new Error('Missing AUTH configuration'),
      attempts: i,
    });
  expect(developerTraceDataService.appendEntries).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(250);
  expect(developerTraceDataService.appendEntries).toHaveBeenCalledTimes(1);
  expect(developerTraceDataService.appendEntries).toHaveBeenCalledWith([
    expect.objectContaining({
      details: expect.objectContaining({
        repeatCount: 1300,
        attempts: 0,
        lastSeenAt: expect.any(String),
        error: expect.objectContaining({ message: 'Missing AUTH configuration' }),
      }),
    }),
  ]);
  expect(version.value).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('flushes exact counts on inspection and discards pending entries on logout', async () => {
  vi.useFakeTimers();
  const { runtime, setOwner } = fixture();
  runtime.logDeveloperTrace('warn', 'relay', 'auth-failed', { url: 'wss://a.example/' });
  await runtime.listDeveloperTraceEntries();
  expect(developerTraceDataService.appendEntries).toHaveBeenCalledTimes(1);
  runtime.logDeveloperTrace('warn', 'relay', 'auth-failed', { url: 'wss://b.example/' });
  setOwner(null);
  await runtime.clearDeveloperTraceEntries();
  await vi.runAllTimersAsync();
  expect(developerTraceDataService.appendEntries).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
