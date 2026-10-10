import { HistoryPager } from '#src/stores/nostr/historyPager.ts';
import { hydrateTimeWindows } from '#src/stores/nostr/timeWindowHydrator.ts';
import { uncoveredHistoryWindows } from '#src/stores/nostr/historyCoverage.ts';

const WEEK = 7 * 86400;
const WRAP_SKEW = 2 * 86400;
type Range = { since: number; until: number };
export interface ThreadHistoryContext {
  routes: Array<{ publicKey: string; relayUrls: string[] }>;
  timestamps: number[];
}
export interface ThreadHistoryQuery extends Range {
  owner: string;
  publicKey: string;
  relayUrl: string;
  signal: AbortSignal;
  pager?: HistoryPager;
  probe?: boolean;
}

// NIP-17 hides the sender: a DM's priority fetch is still an account-inbox
// query. Group epochs can be scoped directly. Reserve a bounded foreground lane
// so a deep background scan cannot delay the conversation the user opened.
export function createThreadHistoryRuntime(deps: {
  owner: () => string | null;
  context: (chat: string) => Promise<ThreadHistoryContext>;
  query: (query: ThreadHistoryQuery) => Promise<{ eventCount: number; oldest: number }>;
  onError: (error: unknown) => void;
}) {
  let selected: string | null = null;
  let controller: AbortController | undefined;
  function stop() {
    controller?.abort();
    controller = undefined;
    selected = null;
  }
  function select(chat: string | null, refresh = false): void {
    if (chat === selected && !refresh) return;
    stop();
    const owner = deps.owner();
    if (!chat || !owner) return;
    selected = chat;
    const abort = (controller = new AbortController());
    const cancelled = () => abort.signal.aborted || deps.owner() !== owner;
    const now = Math.floor(Date.now() / 1000);
    type Target = {
      key: string;
      publicKey: string;
      relayUrl: string;
      priority: Range[];
      covered: Range[];
      until: number;
      window?: Range & { pager: HistoryPager; count: number };
    };
    void (async () => {
      let context: ThreadHistoryContext | undefined;
      await hydrateTimeWindows<Target>({
        signal: abort.signal,
        cancelled,
        concurrency: 2,
        concurrencyKey: (target) => target.relayUrl,
        onDiscoveryError: deps.onError,
        discover: async () => {
          context ??= await deps.context(chat);
          const periods = [
            ...new Set(
              context.timestamps
                .filter(Number.isFinite)
                .filter((at) => at >= 0 && at <= now)
                .map((at) => Math.floor(at / WEEK) * WEEK),
            ),
          ]
            .sort((a, b) => b - a)
            .map((at) => ({
              since: Math.max(0, at - WRAP_SKEW),
              until: Math.min(now, at + WEEK + WRAP_SKEW),
            }));
          // Check cached conversation periods first, including randomized wrapper
          // dates, then the latest week and all older inbox history.
          return context.routes.flatMap((route) =>
            route.relayUrls.map((relayUrl) => ({
              key: `${route.publicKey}:${relayUrl}`,
              publicKey: route.publicKey,
              relayUrl,
              priority: [...periods],
              covered: [],
              until: now,
            })),
          );
        },
        step: async (target) => {
          if (cancelled()) return true;
          const range =
            target.priority[0] ??
            uncoveredHistoryWindows({ since: 0, until: target.until }, target.covered).at(-1);
          if (!range) return true;
          target.window ??= {
            since: target.priority.length
              ? range.since
              : Math.max(range.since, range.until - WEEK + 1),
            until: range.until,
            pager: new HistoryPager(
              target.priority.length ? range.since : Math.max(range.since, range.until - WEEK + 1),
              range.until,
              true,
            ),
            count: 0,
          };
          const window = target.window;
          const query = {
            owner,
            publicKey: target.publicKey,
            relayUrl: target.relayUrl,
            signal: abort.signal,
          };
          const result = await deps.query({
            ...query,
            since: window.since,
            until: window.until,
            pager: window.pager,
          });
          if (cancelled()) return true;
          window.count += result.eventCount;
          if (!window.pager.done) return false;
          target.covered.push({ since: window.since, until: window.until });
          target.window = undefined;
          if (target.priority.length) {
            target.priority.shift();
            return false;
          }
          target.until = window.since - 1;
          if (!window.count && target.until >= 0) {
            const probe = await deps.query({
              ...query,
              since: 0,
              until: target.until,
              probe: true,
            });
            if (cancelled()) return true;
            target.until = probe.eventCount ? probe.oldest : -1;
          }
          return target.until < 0;
        },
        onError: (_target, error) => deps.onError(error),
      });
    })().catch((error) => {
      if (!cancelled()) deps.onError(error);
    });
  }
  return { select, stop };
}
