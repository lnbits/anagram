import { HistoryPager } from '#src/stores/nostr/historyPager.ts';

export interface GroupHistoryContext {
  routes: Array<{ publicKey: string; relayUrls: string[] }>;
  discoveryRelays: string[];
}
export interface GroupHistoryQuery {
  owner: string;
  recipients: string[];
  relayUrl: string;
  pager: HistoryPager;
  signal: AbortSignal;
  discovery: boolean;
}

// One user action has a fixed network budget. Cursors advance only after the
// caller has received real EOSE and committed the page. No background scan.
export function createGroupHistoryRuntime(deps: {
  owner: () => string | null;
  context: (chat: string) => Promise<GroupHistoryContext | null>;
  query: (query: GroupHistoryQuery) => Promise<{ eventCount: number }>;
  onError: (error: unknown) => void;
}) {
  const state = $state({
    chat: '',
    loading: false,
    hasOlder: true,
    phase: 'messages',
    failed: false,
  });
  type Cursor = { pager: HistoryPager; retryAt: number; failures: number };
  let selected = '';
  let abort = new AbortController();
  let active: Promise<void> | undefined;
  let cursors = new Map<string, Cursor>();
  let generation = 0;
  let relayOffset = 0;
  let initialUntil: number | undefined;
  function stop() {
    generation++;
    abort.abort();
    abort = new AbortController();
    selected = '';
    initialUntil = undefined;
    relayOffset = 0;
    cursors = new Map();
    active = undefined;
    Object.assign(state, {
      chat: '',
      loading: false,
      hasOlder: true,
      phase: 'messages',
      failed: false,
    });
  }
  function load(chat: string, before?: number): Promise<void> {
    if (chat !== selected) {
      stop();
      selected = chat;
      state.chat = chat;
    }
    if (active) return active;
    // Exhaustion is a snapshot of the relay, not a permanent ban on pulling.
    // An explicit pull can recheck archives that have since become available.
    if (before !== undefined && !state.hasOlder) {
      cursors.clear();
      initialUntil = undefined;
      state.hasOlder = true;
    }
    const owner = deps.owner();
    if (!owner) return Promise.resolve();
    const token = generation,
      signal = abort.signal,
      saved = cursors;
    const cancelled = () => signal.aborted || generation !== token || deps.owner() !== owner;
    const now = Math.floor(Date.now() / 1000);
    const until = Number.isFinite(before)
      ? Math.min(now, Math.floor(before!) + 2 * 86400)
      : now;
    // Newly discovered keys can change a batch after earlier pages were read.
    // Seed every new batch from the session boundary, never from an old visible
    // ticket row: otherwise unread messages in the previous batch can be skipped.
    initialUntil ??= until;
    const cursor = (key: string, discovery: boolean) => {
      let value = saved.get(key);
      if (!value) {
        value = {
          pager: new HistoryPager(0, discovery ? now : initialUntil!, true),
          retryAt: 0,
          failures: 0,
        };
        saved.set(key, value);
      }
      return value;
    };
    state.loading = true;
    state.failed = false;
    const work = (async () => {
      let context = await deps.context(chat);
      if (!context || cancelled()) return;
      async function request(
        recipients: string[],
        relayUrl: string,
        discovery: boolean,
        budget: { remaining: number },
      ) {
        const progress = cursor(
          `${discovery ? 'keys' : 'messages'}:${relayUrl}:${recipients.join(',')}`,
          discovery,
        );
        if (
          progress.pager.done ||
          progress.retryAt > Date.now() ||
          cancelled() ||
          budget.remaining <= 0
        )
          return undefined;
        budget.remaining--;
        try {
          const result = await deps.query({
            owner: owner!,
            recipients,
            relayUrl,
            pager: progress.pager,
            signal,
            discovery,
          });
          if (cancelled()) return undefined;
          progress.failures = 0;
          progress.retryAt = 0;
          return result.eventCount;
        } catch (error) {
          if (cancelled()) return undefined;
          progress.retryAt =
            Date.now() + Math.min(30000, 1000 * 2 ** Math.min(progress.failures++, 5));
          state.failed = true;
          deps.onError(error);
          return undefined;
        }
      }
      const batches = (ctx: GroupHistoryContext, relay: string) => {
        const keys = ctx.routes
          .filter((route) => route.relayUrls.includes(relay))
          .map((route) => route.publicKey);
        // Each epoch needs its own authenticated socket and paging cursor.
        return keys.map((key) => [key]);
      };
      const relays = [
        ...new Set([
          ...context.routes.flatMap((route) => route.relayUrls),
          ...context.discoveryRelays,
        ]),
      ];
      const ordered = [...relays.slice(relayOffset), ...relays.slice(0, relayOffset)];
      relayOffset = relays.length ? (relayOffset + 1) % relays.length : 0;
      const scheduled = ordered.slice(0, 4);
      // Divide the six requests before starting concurrent work. A fast replica
      // must not spend another relay's message slot on its own inbox or epochs.
      // Rotating by one also rotates the extra key-discovery slots when the
      // relay count is a multiple of four. No archive scan runs between actions.
      await Promise.all(
        scheduled.map(async (relay, index) => {
          const budget = {
            remaining:
              Math.floor(6 / scheduled.length) + (index < 6 % scheduled.length ? 1 : 0),
          };
          if (
            (before !== undefined || !context!.routes.length) &&
            context!.discoveryRelays.includes(relay) &&
            (budget.remaining > 1 || !batches(context!, relay).length)
          ) {
            state.phase = 'keys';
            await request([owner!], relay, true, budget);
          }
          if (cancelled()) return;
          const updated = await deps.context(chat);
          if (!updated || cancelled()) return;
          state.phase = 'messages';
          for (const recipients of batches(updated, relay)) {
            const progress = cursor(`messages:${relay}:${recipients.join(',')}`, false);
            while (!progress.pager.done && budget.remaining > 0) {
              const count = await request(recipients, relay, false, budget);
              if (count === undefined) break;
              // A nonempty page may contain only cached messages. Spend this
              // action's remaining budget advancing it before trying older keys.
            }
            if (!progress.pager.done || budget.remaining <= 0) break;
          }
        }),
      );
      if (cancelled()) return;
      context = await deps.context(chat);
      if (!context || cancelled()) return;
      const messageRelays = new Set(context.routes.flatMap((route) => route.relayUrls));
      const messagesDone = [...messageRelays].every((relay) =>
        batches(context!, relay).every(
          (keys) => cursor(`messages:${relay}:${keys.join(',')}`, false).pager.done,
        ),
      );
      const keysDone = context.discoveryRelays.every(
        (relay) => cursor(`keys:${relay}:${owner}`, true).pager.done,
      );
      state.hasOlder = !messagesDone || !keysDone || state.failed;
    })()
      .catch((error) => {
        if (!cancelled()) {
          state.failed = true;
          deps.onError(error);
        }
      })
      .finally(() => {
        if (!cancelled()) state.loading = false;
        if (active === work) active = undefined;
      });
    active = work;
    return work;
  }
  function invalidate(chat: string) {
    if (selected === chat) state.hasOlder = true;
  }
  return { state, load, stop, invalidate };
}
