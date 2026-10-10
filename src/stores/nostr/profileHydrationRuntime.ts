import type { ClientEvent, NostrFilter } from '#src/lib/nostr/client.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';

interface Target {
  publicKey: string;
  relayUrls: string[];
}
interface Route {
  due: number;
  attempts: number;
  completed: boolean;
}
interface Task {
  publicKey: string;
  routes: Map<string, Route>;
  profile: boolean;
  priority: boolean;
}
interface Dependencies {
  getOwnPublicKey?: () => string | null;
  onPrivateRelayList?: (event: ClientEvent) => void;
  subscribe: (
    filters: NostrFilter[],
    relayUrls: string[],
    onEvent: (event: ClientEvent) => void,
    onDone: (completed?: boolean) => void,
  ) => { stop(): void };
  onProfile: (event: ClientEvent) => void;
  onRelayList: (event: ClientEvent) => void;
  isBlocked: (publicKey: string) => boolean;
}

// A relay gets one bounded batch, with a separate limit for every author/kind.
// Slow inboxes cannot occupy every slot by repeating the same multi-relay lookup
// for each author. Fresh outbox hints run immediately, before the first EOSE.
export function createProfileHydrationRuntime({
  subscribe,
  getOwnPublicKey = () => null,
  onPrivateRelayList = () => {},
  onProfile,
  onRelayList,
  isBlocked,
}: Dependencies) {
  const tasks = new Map<string, Task>();
  const active = new Map<string, () => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const normalizeUrls = (urls: string[]) => [
    ...new Set(
      urls
        .map((url) => inputSanitizerService.normalizeRelayWs(url))
        .filter(Boolean)
        .map((url) => new URL(url).toString()),
    ),
  ];
  function schedule(delay = 0) {
    clearTimeout(timer);
    timer = setTimeout(pump, delay);
  }
  function addRoutes(task: Task, urls: string[]) {
    for (const url of normalizeUrls(urls))
      if (!task.routes.has(url)) task.routes.set(url, { due: 0, attempts: 0, completed: false });
  }
  function request(targets: Target[], priorityKeys: string[] = []) {
    const priority = new Set([getOwnPublicKey(), ...priorityKeys]);
    for (const target of targets) {
      if (!/^[a-f0-9]{64}$/.test(target.publicKey) || isBlocked(target.publicKey)) continue;
      let task = tasks.get(target.publicKey);
      if (!task) {
        task = { publicKey: target.publicKey, routes: new Map(), profile: false, priority: false };
        tasks.set(target.publicKey, task);
      }
      if (!task.priority && priority.has(target.publicKey) && !task.profile)
        for (const route of task.routes.values()) route.due = 0;
      task.priority = priority.has(target.publicKey);
      addRoutes(task, target.relayUrls);
    }
    schedule();
  }
  function pump() {
    timer = undefined;
    const now = Date.now();
    const batches = new Map<string, Array<{ task: Task; route: Route }>>();
    let nextDue = Infinity;
    const ordered = [...tasks.values()]
      .filter((task) => !isBlocked(task.publicKey))
      .sort((a, b) => Number(b.priority) - Number(a.priority));
    for (const task of ordered)
      for (const [url, route] of task.routes) {
        if (
          active.has(url) ||
          (task.profile &&
            route.attempts > 0 &&
            (task.publicKey !== getOwnPublicKey() || route.completed))
        )
          continue;
        if (route.due > now) {
          nextDue = Math.min(nextDue, route.due);
          continue;
        }
        const batch = batches.get(url) ?? [];
        // At most 13 filters (four authors, with an extra private-list filter for self).
        batch.push({ task, route });
        batches.set(url, batch);
      }
    for (const [url, batch] of batches) {
      if (active.size >= 4) break;
      // Untried authors must advance even while earlier missing profiles retry.
      batch.sort(
        (a, b) =>
          a.route.attempts - b.route.attempts || Number(b.task.priority) - Number(a.task.priority),
      );
      start(url, batch.slice(0, 4));
    }
    if (active.size < 4 && Number.isFinite(nextDue)) schedule(Math.max(10, nextDue - now));
  }
  function start(url: string, batch: Array<{ task: Task; route: Route }>) {
    const runGeneration = generation;
    let finished = false;
    let subscription: { stop(): void } | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (completed = true) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      subscription?.stop();
      active.delete(url);
      if (runGeneration !== generation) return;
      for (const { route } of batch) {
        route.attempts++;
        route.completed = completed;
        route.due = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(route.attempts - 1, 4));
      }
      schedule();
    };
    active.set(url, finish);
    // Connection establishment has its own five-second bound. Leave time for a
    // connected relay's response instead of cancelling at that same deadline.
    deadline = setTimeout(() => finish(false), 10000);
    const authors = new Map(batch.map(({ task }) => [task.publicKey, task]));
    try {
      subscription = subscribe(
        batch.flatMap(({ task }) =>
          [0, 10002, 10050, ...(task.publicKey === getOwnPublicKey() ? [10013] : [])].map(
            (kind) => ({ kinds: [kind], authors: [task.publicKey], limit: 1 }),
          ),
        ),
        [url],
        (event) => {
          const task = authors.get(event.pubkey);
          if (finished || runGeneration !== generation || !task || isBlocked(event.pubkey)) return;
          if (event.kind === 0) {
            try {
              const profile = JSON.parse(event.content);
              if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return;
            } catch {
              return;
            }
            task.profile = true;
            onProfile(event);
          } else if (event.kind === 10013 && event.pubkey === getOwnPublicKey()) {
            onPrivateRelayList(event);
          } else if (event.kind === 10002 || event.kind === 10050) {
            onRelayList(event);
            if (event.kind === 10002) {
              addRoutes(
                task,
                event.tags.flatMap((tag) =>
                  tag[0] === 'r' && tag[2] !== 'read' && typeof tag[1] === 'string' ? [tag[1]] : [],
                ),
              );
              schedule();
            }
          }
        },
        finish,
      );
      if (finished) subscription.stop();
    } catch {
      finish(false);
    }
  }
  function reset() {
    generation++;
    clearTimeout(timer);
    for (const stop of [...active.values()]) stop();
    active.clear();
    tasks.clear();
  }
  return { request, reset };
}
