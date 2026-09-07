import type { HistoryWindow } from 'src/stores/nostr/historyCoverage';

export function createHistoryCoverage(owner: () => string | null) {
  const key = () => `nostr-history-coverage:${owner() ?? ''}`;
  const memory = new Map<string, HistoryWindow[]>();
  function read(recipient: string): HistoryWindow[] {
    try {
      const stored = JSON.parse(window.localStorage.getItem(key()) ?? '{}') as Record<
        string,
        Array<{ since: string; until: string }>
      >;
      return (stored[recipient] ?? [])
        .map((entry) => ({
          since: Date.parse(entry.since) / 1000,
          until: Date.parse(entry.until) / 1000,
        }))
        .filter((entry) => Number.isFinite(entry.since) && Number.isFinite(entry.until));
    } catch {
      return memory.get(`${owner()}:${recipient}`) ?? [];
    }
  }
  function add(recipient: string, window: HistoryWindow): void {
    const ordered = [...read(recipient), window].sort((a, b) => a.since - b.since);
    const merged: HistoryWindow[] = [];
    for (const entry of ordered) {
      const last = merged.at(-1);
      if (last && entry.since <= last.until + 1) last.until = Math.max(last.until, entry.until);
      else merged.push({ ...entry });
    }
    memory.set(`${owner()}:${recipient}`, merged);
    try {
      const stored = JSON.parse(globalThis.window.localStorage.getItem(key()) ?? '{}');
      stored[recipient] = merged.map((entry) => ({
        since: new Date(entry.since * 1000).toISOString(),
        until: new Date(entry.until * 1000).toISOString(),
      }));
      globalThis.window.localStorage.setItem(key(), JSON.stringify(stored));
    } catch {
      /* Memory coverage is still valid when storage is unavailable. */
    }
  }
  return { read, add };
}
