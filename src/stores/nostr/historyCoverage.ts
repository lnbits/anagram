import { normalizeRelayStatusUrlsValue } from 'src/stores/nostr/valueUtils';
export function historyCoverageScope(recipient: string, relayUrls: string[]): string {
  return `${recipient}:${normalizeRelayStatusUrlsValue(relayUrls).sort().join('|')}`;
}

export interface HistoryWindow {
  since: number;
  until: number;
}

export function uncoveredHistoryWindows(
  window: HistoryWindow,
  covered: HistoryWindow[]
): HistoryWindow[] {
  let gaps = [window];
  for (const coverage of covered) {
    gaps = gaps.flatMap((gap) => {
      if (coverage.until < gap.since || coverage.since > gap.until) return [gap];
      return [
        ...(gap.since < coverage.since ? [{ since: gap.since, until: coverage.since - 1 }] : []),
        ...(gap.until > coverage.until ? [{ since: coverage.until + 1, until: gap.until }] : []),
      ];
    });
  }
  return gaps.filter((gap) => gap.since <= gap.until);
}
