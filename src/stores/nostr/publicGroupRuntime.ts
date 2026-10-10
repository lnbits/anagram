import { buildMessageEditTag } from '#src/utils/messageEdits.ts';
import {
  editTarget,
  editRoot,
  replyTarget,
  actionTargets,
  validPublicAction,
  publicMessageState,
  publicMessageRoots,
  publicMessageReference,
} from './publicMessageActions.ts';
import { normalizeMessageSearchText } from '#src/utils/messageSearch.ts';
import type { Message, MessageAttachmentMetadata, MessageRelayStatus } from '#src/types/chat.ts';
import { redactPublicLinks } from '#src/utils/publicMessage.ts';
import { previewUrl } from '#src/utils/linkPreview.ts';
import { writable, get, type Readable } from 'svelte/store';
import type NostrClient from '#src/lib/nostr/client.ts';
import {
  ClientEvent,
  type NostrEvent,
  type NostrFilter,
  type NostrSigner,
  type NostrSubscription,
} from '#src/lib/nostr/client.ts';
import {
  PublicGroupData,
  type SavedPublicRoom,
  type PublicGroupMessage,
} from '#src/services/publicGroupData.ts';
import {
  decodeRoomLink,
  encodeRoomLink,
  parsePublicRoom,
  publicRoomRelays,
  newerRoom,
  roomPolicy,
  roomTags,
  validRoomMessage,
  verifiedPublicEvent,
  ROOM_PAGE,
  ROOM_WINDOW,
  type PublicRoom,
  type RoomAddress,
} from './publicGroups.ts';

interface State {
  rooms: SavedPublicRoom[];
  room: PublicRoom | null;
  ancestors: PublicRoom[];
  history: string;
  messages: PublicGroupMessage[];
  loading: boolean;
  refreshing: boolean;
  hasNewer: boolean;
  error: string;
  stale: boolean;
  more: boolean;
}
interface Dependencies {
  starterRoom?: NostrEvent;
  client: NostrClient;
  account: () => string | null;
  signer: () => Promise<NostrSigner>;
  relays: () => Promise<string[]>;
  containsSecret: (value: string) => boolean;
}
export function createPublicGroupRuntime(deps: Dependencies) {
  const state = writable<State>({
    rooms: [],
    room: null,
    ancestors: [],
    history: '',
    messages: [],
    loading: false,
    refreshing: false,
    hasNewer: false,
    error: '',
    stale: false,
    more: true,
  });
  // Message hydration must not invalidate the entire application's chat list.
  const sidebar: Readable<{ rooms: SavedPublicRoom[]; address: string }> = {
    subscribe(run) {
      let rooms: SavedPublicRoom[] | undefined, address: string | undefined;
      return state.subscribe((s) => {
        const nextAddress = s.room?.address ?? '';
        if (rooms === s.rooms && address === nextAddress) return;
        rooms = s.rooms;
        address = nextAddress;
        run({ rooms, address });
      });
    },
  };
  let account = '',
    data: PublicGroupData | undefined,
    view = 0;
  let windowRevision = 0;
  let live: NostrSubscription | undefined;
  let stopActivity = () => {};
  let liveRevision = 0;
  let liveKey = '';
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  function stopLive() {
    stopActivity();
    stopActivity = () => {};
    liveRevision++;
    liveKey = '';
    clearTimeout(liveTimer);
    liveTimer = undefined;
    live?.stop();
    live = undefined;
  }
  const queries = new Set<() => void>();
  let writing = false;
  let requested = '';
  function assertSession(owner: string) {
    if (owner !== deps.account() || account !== owner)
      throw new Error('Account changed. Reopen the public group.');
  }
  function stopView() {
    view++;
    windowRevision++;
    stopLive();
    for (const stop of [...queries]) stop();
  }
  function stop() {
    stopView();
    void data?.close();
    data = undefined;
    account = '';
    state.set({
      rooms: [],
      room: null,
      ancestors: [],
      history: '',
      messages: [],
      loading: false,
      refreshing: false,
      hasNewer: false,
      error: '',
      stale: false,
      more: true,
    });
  }
  async function init() {
    const next = deps.account();
    if (!next) {
      stop();
      return;
    }
    if (account === next && data) return;
    stop();
    account = next;
    data = new PublicGroupData(next);
    if (deps.starterRoom) {
      await data.seed(parsePublicRoom(deps.starterRoom));
      assertSession(next);
    }
    await reloadRooms();
  }
  async function reloadRooms() {
    const owner = account;
    const rows = await data!.list();
    assertSession(owner);
    const valid = rows.flatMap((row) => {
      try {
        return [{ ...row, room: parsePublicRoom(row.room.event, row.address) }];
      } catch {
        return [];
      }
    });
    state.update((s) => ({
      ...s,
      rooms: valid.filter((r) => r.joined && !r.successor).sort((a, b) => b.updated - a.updated),
    }));
  }
  async function relayUrls(hints: string[]) {
    const configured = await deps.relays();
    // Normalize each list separately so eight preferred relays cannot crowd out app relays.
    const urls = [
      ...new Set([
        ...publicRoomRelays(hints, configured),
        ...publicRoomRelays(configured, configured),
      ]),
    ];
    if (!urls.length)
      throw new Error('No usable public group relays. Configure a relay or check the group link.');
    return urls;
  }
  async function selectedRelays(values: string[]) {
    if (!values.length || values.length > 8) throw new Error('Choose 1–8 public group relays.');
    const configured = await deps.relays();
    const normalized = values.map((value) => {
      const allowed = publicRoomRelays([value], configured);
      if (allowed.length !== 1)
        throw new Error(
          'Use public wss:// relay URLs, or local relays already configured in Settings.',
        );
      return allowed[0];
    });
    return [...new Set(normalized)];
  }
  // Public reads use real completed responses from available replicas. A
  // timeout is never EOSE evidence or proof of complete history coverage.
  function query(
    filters: NostrFilter[],
    urls: string[],
    max = 400,
    accept?: (events: ClientEvent[]) => boolean,
    allowPartial = true,
    acceptReceived?: (event: ClientEvent) => boolean,
  ): Promise<{ events: ClientEvent[]; complete: boolean }> {
    return new Promise((resolve, reject) => {
      const completed = new Map<string, ClientEvent>();
      const observed = new Map<string, ClientEvent>();
      const subscriptions: NostrSubscription[] = [];
      const pendingRelays = new Set(urls);
      const failedRelays = new Set<string>();
      const relayReadError = () =>
        new Error(
          `Public group relay checks did not complete: ${[...failedRelays, ...pendingRelays].join(', ')}. Check your connection or relay settings, then retry.`,
        );
      let partialTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false,
        remaining = urls.length,
        failed = false,
        completedRelays = 0;
      const finish = (error?: Error, received = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(partialTimer);
        queries.delete(cancel);
        subscriptions.forEach((sub) => sub.stop());
        error
          ? reject(error)
          : resolve({
              events: [...(received ? observed : completed).values()],
              complete: !received && remaining === 0 && !failed,
            });
      };
      const cancel = () => finish(new Error('Public group request cancelled.'));
      const timer = setTimeout(
        () => finish(allowPartial && completedRelays ? undefined : relayReadError()),
        10000,
      );
      queries.add(cancel);
      for (const url of urls) {
        const events = new Map<string, ClientEvent>();
        let ended = false;
        const end = (ok: boolean) => {
          if (settled || ended) return;
          ended = true;
          remaining--;
          pendingRelays.delete(url);
          if (!ok) failedRelays.add(url);
          if (ok) {
            completedRelays++;
            for (const [id, event] of events) completed.set(id, event);
          } else failed = true;
          if (completed.size > max) {
            finish(new Error('Too many public group events. Narrow the history request.'));
          } else if (ok && accept?.([...completed.values()])) finish();
          else if (!remaining) {
            finish(failed && !(allowPartial && completedRelays) ? relayReadError() : undefined);
          } else if (allowPartial && completedRelays && partialTimer === undefined) {
            // Collect nearby replies, but a silent replica must not hold up a
            // short page or missing-message lookup for the full network timeout.
            // Partial results never claim complete history coverage.
            partialTimer = setTimeout(() => finish(), 500);
          }
        };
        const subscription = deps.client.subscribe(filters, {
          relayUrls: [url],
          onEvent: (event) => {
            if (settled || ended) return;
            if (observed.size >= max && !observed.has(event.id))
              finish(new Error('Too many public group events. Narrow the history request.'));
            else {
              if (!observed.has(event.id)) observed.set(event.id, event);
              const observedEvent = observed.get(event.id)!;
              const relay = deps.client.pool.getRelay(url, false);
              if (!observedEvent.onRelays.some((item) => item.url === url))
                observedEvent.onRelays.push(relay);
              events.set(event.id, observedEvent);
              // Exact-message lookups can use a verified event immediately.
              // This never supplies EOSE evidence for history/policy queries.
              if (acceptReceived?.(observedEvent)) finish(undefined, true);
            }
          },
          onEose: () => end(true),
          onClose: () => end(false),
        });
        subscriptions.push(subscription);
        if (settled) {
          subscription.stop();
          break;
        }
      }
    });
  }
  async function readRoom(
    address: RoomAddress,
    hints: string[] = address.relays,
  ): Promise<PublicRoom> {
    const owner = account,
      db = data!;
    const urls = await relayUrls(hints);
    const baseline = await db.get(address.address);
    const cachedPolicy = baseline && parsePublicRoom(baseline.room.event, address.address);
    assertSession(owner);
    const { events } = await query(
      [{ kinds: [34550], authors: [address.owner], '#d': [address.slug], limit: 1 }],
      urls,
      32,
      (events) =>
        Boolean(cachedPolicy) ||
        events.some((event) => {
          try {
            parsePublicRoom(event.rawEvent(), address.address);
            return true;
          } catch {
            return false;
          }
        }),
      false, // Without a cached definition, wait for a relay holding the signed room.
    );
    const rooms = events.flatMap((e) => {
      try {
        return [parsePublicRoom(e.rawEvent(), address.address)];
      } catch {
        return [];
      }
    });
    assertSession(owner);
    const saved = await db.get(address.address);
    assertSession(owner);
    // Relays are replicas: an empty or older response does not revoke the
    // newest signed definition already saved on this device.
    if (saved) rooms.push(parsePublicRoom(saved.room.event, address.address));
    if (!rooms.length)
      throw new Error('Public group not found or its signed definition is invalid.');
    return rooms.reduce((a, b) => (newerRoom(a, b) ? a : b));
  }
  async function saveRoom(room: PublicRoom, joined = true, successor?: string, owner = account) {
    assertSession(owner);
    const db = data!;
    const previous = await db.get(room.address);
    assertSession(owner);
    const saved = await db.save({
      address: room.address,
      room,
      joined,
      successor: successor || previous?.successor,
      updated: Date.now(),
    });
    assertSession(owner);
    state.update((s) => ({
      ...s,
      rooms: [
        ...s.rooms.filter((row) => row.address !== room.address),
        ...(saved.joined && !saved.successor ? [saved] : []),
      ]
        .sort((a, b) => b.updated - a.updated)
        .slice(0, 200),
    }));
    return saved.room;
  }
  async function hydrate(
    address: string,
    events: PublicGroupMessage[],
    db = data!,
    includeReplies = true,
  ): Promise<PublicGroupMessage[]> {
    if (includeReplies) events = publicMessageRoots(events);
    const activity = await db.actionsFor(
      address,
      events.map((event) => event.id!),
      new Map(events.map((event) => [event.id!, event.pubkey])),
    );
    const related = activity.filter((event) => event.kind === 7 || event.kind === 9);
    const nested = await db.actionsFor(
      address,
      related.map((event) => event.id!),
      new Map(related.map((event) => [event.id!, event.pubkey])),
    );
    const byTarget = new Map<string, PublicGroupMessage[]>();
    for (const action of [
      ...new Map([...activity, ...nested].map((event) => [event.id!, event])).values(),
    ]) {
      for (const id of actionTargets(action))
        byTarget.set(id, [...(byTarget.get(id) ?? []), action]);
    }
    const decorated = events.map((event) => {
      const direct = byTarget.get(event.id!) ?? [];
      return {
        ...event,
        activity: [
          ...new Map(
            [...direct, ...direct.flatMap((action) => byTarget.get(action.id!) ?? [])].map(
              (action) => [action.id!, action],
            ),
          ).values(),
        ],
      };
    });
    if (!includeReplies) return decorated;
    const parents = [...new Set(events.map(replyTarget).filter(Boolean) as string[])].slice(
      0,
      ROOM_WINDOW,
    );
    if (!parents.length) return decorated;
    const references = new Map(
      await Promise.all(parents.map(async (id) => [id, await db.message(address, id)] as const)),
    );
    const replacements = await db.actionsFor(
      address,
      parents.filter((id) => !references.get(id)),
    );
    const resolved = decorated.map((event) => {
      const id = replyTarget(event);
      const original = id ? references.get(id) : undefined;
      const author = event.tags.find((tag) => tag[0] === 'q')?.[3];
      const parent = id
        ? publicMessageReference(
            original ? [original] : [...events, ...replacements],
            id,
            address,
            author,
          )
        : undefined;
      return { event, parent };
    });
    // Reuse normal edit/deletion hydration for previews, without recursively
    // loading the replies of their parents or issuing network/history reads.
    const hydrated = new Map(
      (
        await hydrate(
          address,
          [
            ...new Map(
              resolved.flatMap(({ parent }) => (parent ? [[parent.id!, parent] as const] : [])),
            ).values(),
          ],
          db,
          false,
        )
      ).map((parent) => [parent.id!, parent]),
    );
    return resolved.map(({ event, parent }) => ({
      ...event,
      replyEvent: parent ? hydrated.get(parent.id!) : undefined,
    }));
  }

  async function cacheEvents(address: string, events: PublicGroupMessage[], db = data!) {
    const roots = events.filter((event) => validRoomMessage(event, address) && !editTarget(event));
    const actions = events.filter((event) => validPublicAction(event, address));
    if (actions.length)
      await db.putActions(
        address,
        actions.map((event) => ({ event, targets: actionTargets(event) })),
      );
    const saved = await db.putMany(address, roots);
    return saved;
  }
  async function cacheTimelineEvents(
    address: string,
    batch: PublicGroupMessage[],
    urls: string[],
    db: PublicGroupData,
    active: () => boolean,
  ) {
    const saved = await cacheEvents(address, batch, db);
    const missing = [
      ...new Set(
        batch
          .filter((event) => validPublicAction(event, address) && event.kind === 9)
          .flatMap((event) => actionTargets(event)),
      ),
    ];
    for (const id of missing.slice(0, 16)) {
      if (await db.message(address, id)) continue;
      // The original may have been deleted from relays. Repair is optional:
      // relay outages must not prevent saving the verified replacement below.
      const fetched = await query(
        [{ kinds: [9], ids: [id], limit: 1 }],
        urls,
        8,
        (events) =>
          events.some((event) => event.id === id && validRoomMessage(event.rawEvent(), address)),
        true,
      ).catch(() => ({ events: [] as ClientEvent[], complete: false }));
      if (!active()) return [];
      saved.push(
        ...(await cacheEvents(
          address,
          fetched.events.map((event) => receivedMessage(event)),
          db,
        )),
      );
    }
    for (const edit of batch.filter(
      (event) => event.kind === 9 && validPublicAction(event, address),
    )) {
      if (await db.message(address, editRoot(edit)!)) continue;
      saved.push(await db.put(address, edit));
    }
    return saved;
  }
  async function refreshVisible(address: string, db = data!, token = view) {
    const revision = windowRevision;
    for (let attempt = 0; attempt < 4; attempt++) {
      const snapshot = get(state);
      if (
        (snapshot.history || snapshot.room?.address) !== address ||
        token !== view ||
        data !== db ||
        revision !== windowRevision
      )
        return;
      const events = snapshot.messages;
      const updated = await hydrate(address, events, db);
      if (token !== view || revision !== windowRevision || data !== db) return;
      if (get(state).messages !== events) continue;
      state.update((s) => ({ ...s, messages: updated }));
      return;
    }
  }
  function append(events: PublicGroupMessage[], older = false) {
    state.update((s) => {
      const all = publicMessageRoots([...s.messages, ...events]).sort(
        (a, b) => a.created_at - b.created_at || a.id!.localeCompare(b.id!),
      );
      return {
        ...s,
        messages: older ? all.slice(0, ROOM_WINDOW) : all.slice(-ROOM_WINDOW),
        hasNewer: older ? s.hasNewer || all.length > ROOM_WINDOW : s.hasNewer,
        more: s.more || (!older && all.length > ROOM_WINDOW),
      };
    });
  }
  async function open(link: string) {
    // init resets the account synchronously, but its storage read may still be
    // pending when the component unmounts or another room is opened.
    const initializing = init();
    stopView();
    const token = view;
    try {
      await initializing;
    } catch (error) {
      if (token === view)
        state.update((s) => ({
          ...s,
          refreshing: false,
          stale: true,
          error: (error as Error).message,
        }));
      return;
    }
    if (token !== view || !data) return;
    const owner = account,
      db = data;
    const refreshingCurrent = requested === link && Boolean(get(state).room);
    requested = link;
    state.update((s) => ({
      ...s,
      room: refreshingCurrent ? s.room : null,
      ancestors: refreshingCurrent ? s.ancestors : [],
      history: '',
      messages: refreshingCurrent && !s.history ? s.messages : [],
      loading: false,
      refreshing: true,
      hasNewer: false,
      error: '',
      stale: true,
      more: true,
    }));
    let address: RoomAddress;
    try {
      address = decodeRoomLink(link);
    } catch (e) {
      state.update((s) => ({ ...s, refreshing: false, error: String((e as Error).message) }));
      return;
    }
    let cachedView: Pick<State, 'room' | 'ancestors' | 'messages'> | undefined;
    try {
      // Show the last signed room and its bounded local window before touching
      // the network. Follow only handovers already verified and pinned locally.
      let cachedAddress = address;
      const cachedAncestors: PublicRoom[] = [];
      const cachedSeen = new Set<string>();
      for (let hop = 0; hop < 8 && !cachedSeen.has(cachedAddress.address); hop++) {
        cachedSeen.add(cachedAddress.address);
        const saved = await db.get(cachedAddress.address);
        if (token !== view || owner !== account) return;
        if (!saved?.joined && !saved?.successor) break;
        const cachedRoom = parsePublicRoom(saved.room.event, cachedAddress.address);
        if (
          cachedAncestors.length &&
          cachedRoom.predecessor?.address !== cachedAncestors.at(-1)!.address
        )
          break;
        if (saved.successor && cachedRoom.successor?.address === saved.successor) {
          cachedAncestors.push(cachedRoom);
          cachedAddress = cachedRoom.successor;
          continue;
        }
        if (cachedRoom.successor) break;
        const cached = await db.page(cachedRoom.address, undefined, ROOM_PAGE);
        if (token !== view || owner !== account) return;
        cachedView = {
          room: cachedRoom,
          ancestors: cachedAncestors,
          messages: await hydrate(
            cachedRoom.address,
            cached.filter((e) => validRoomMessage(e, cachedRoom.address)),
            db,
          ),
        };
        if (token !== view || owner !== account || owner !== deps.account()) return;
        state.update((s) => ({ ...s, ...cachedView }));
        // Live messages hydrate even while a replica's policy lookup is pending.
        const urls = await relayUrls(cachedRoom.relays);
        if (token !== view || owner !== account) return;
        startLive(cachedRoom, urls, token, owner, db);
        break;
      }
      const ancestors: PublicRoom[] = [];
      const seen = new Set<string>();
      let room: PublicRoom;
      for (let hop = 0; ; hop++) {
        if (hop >= 8 || seen.has(address.address))
          throw new Error('Invalid or excessive public group handover chain.');
        seen.add(address.address);
        const saved = await db.get(address.address);
        // Pin accepted handovers: a former owner cannot redirect this client again.
        room = saved?.successor
          ? parsePublicRoom(saved.room.event, address.address)
          : await readRoom(address, saved?.room.relays ?? address.relays);
        assertSession(owner);
        if (token !== view) return;
        if (ancestors.length && room.predecessor?.address !== ancestors.at(-1)!.address)
          throw new Error('The successor owner has not accepted this handover.');
        if (!room.successor) break;
        if (room.successor.owner === room.owner)
          throw new Error('Ownership transfer requires a different owner.');
        ancestors.push(room);
        address = room.successor;
      }
      const declared = await relayUrls(room.relays);
      // Check the policy on the declared room relays as well as the link hints.
      const lookupUrls = await relayUrls(
        (await db.get(room.address))?.room.relays ?? address.relays,
      );
      if (JSON.stringify([...lookupUrls].sort()) !== JSON.stringify([...declared].sort()))
        room = await readRoom(room, declared);
      if (ancestors.length && room.predecessor?.address !== ancestors.at(-1)!.address)
        throw new Error('Successor acknowledgement changed.');
      if (room.successor)
        throw new Error('Group ownership changed while loading. Refresh to follow the handover.');
      assertSession(owner);
      if (token !== view) return;
      for (const prior of ancestors) {
        if (token !== view) return;
        await saveRoom(prior, false, prior.successor!.address, owner);
      }
      assertSession(owner);
      if (token !== view) return;
      if (
        !get(state).rooms.some((r) => r.address === room.address) &&
        get(state).rooms.length >= 200
      )
        throw new Error('Leave an unused public group before joining another.');
      room = await saveRoom(room, true, undefined, owner);
      const cached = await db.page(room.address, undefined, ROOM_PAGE);
      assertSession(owner);
      if (token !== view) return;
      const hydrated = await hydrate(
        room.address,
        cached.filter((e) => validRoomMessage(e, room.address)),
        db,
      );
      if (token !== view || owner !== account) return;
      state.update((s) => {
        // Hydration yields to the live listener. Keep any newer signed policy it
        // received while this refresh was reading or saving its older snapshot.
        if (s.room?.address === room.address && newerRoom(s.room, room)) room = s.room;
        return {
          ...s,
          room,
          ancestors,
          messages: s.room?.address === room.address ? s.messages : hydrated,
          refreshing: false,
          stale: false,
        };
      });
      if (token !== view) return;
      const urls = await relayUrls(room.relays);
      if (token !== view || owner !== account) return;
      startLive(room, urls, token, owner, db);
    } catch (e) {
      if (token !== view || owner !== account) return;
      // Retain only the joined room reached through the verified cached chain.
      // Looking up the original address here would discard a pinned successor.
      if (!cachedView) stopLive();
      state.update((s) => ({
        ...s,
        room: cachedView
          ? s.room?.address === cachedView.room?.address
            ? s.room
            : cachedView.room
          : null,
        ancestors: cachedView?.ancestors ?? [],
        messages: cachedView
          ? s.room?.address === cachedView.room?.address
            ? s.messages
            : cachedView.messages
          : [],
        refreshing: false,
        stale: true,
        error: (e as Error).message,
      }));
    }
  }
  function startLive(
    room: PublicRoom,
    urls: string[],
    token: number,
    owner: string,
    db: PublicGroupData,
  ) {
    const key = JSON.stringify([owner, token, room.address, [...urls].sort()]);
    if (live && liveKey === key) return;
    stopLive();
    liveKey = key;
    const revision = liveRevision;
    const active = () => revision === liveRevision && token === view && owner === deps.account();
    let draining = false;
    let received = 0;
    const pending: PublicGroupMessage[] = [];
    live = deps.client.subscribe(
      [
        { kinds: [9], '#a': [room.address], limit: ROOM_PAGE },
        { kinds: [5, 7], '#h': [room.address], limit: 64 },
        { kinds: [34550], authors: [room.owner], '#d': [room.slug], limit: 1 },
      ],
      {
        relayUrls: urls,
        includeRelayDuplicates: true,
        onEvent: (event, relay) => {
          if (!active()) return;
          if (pending.length >= 256) {
            stopLive();
            state.update((s) => ({
              ...s,
              stale: true,
              error: 'Public group traffic exceeded the local queue. Refresh to catch up.',
            }));
            return;
          }
          if (event.kind === 9) received++;
          pending.push(receivedMessage(event, relay?.url ?? event.relay?.url));
          if (!draining && liveTimer === undefined)
            liveTimer = setTimeout(() => {
              liveTimer = undefined;
              void drain();
            }, 0);
        },
        onEose: () => {
          if (active() && !get(state).messages.length && received === 0)
            state.update((s) => ({ ...s, more: false }));
        },
        onClose: () => {
          if (active() && !get(state).refreshing)
            state.update((s) => ({
              ...s,
              stale: true,
              error: 'Public group connection closed. Refresh to reconnect.',
            }));
        },
      },
    );
    let activitySub: NostrSubscription | undefined;
    let activityKey = '',
      activityTimer: ReturnType<typeof setTimeout> | undefined;
    let activityQueue = Promise.resolve(),
      queued = 0;
    const unwatch = state.subscribe((snapshot) => {
      const address = snapshot.history || snapshot.room?.address;
      if (!address) return;
      const ids = [
        ...new Set(
          snapshot.messages.flatMap((event) => [
            event.id!,
            ...(event.activity ?? [])
              .filter((action) => action.kind === 7 || action.kind === 9)
              .map((action) => action.id!),
          ]),
        ),
      ]
        .sort()
        .slice(0, 512);
      const next = JSON.stringify([address, ids]);
      if (next === activityKey) return;
      activityKey = next;
      clearTimeout(activityTimer);
      activityTimer = setTimeout(() => {
        activitySub?.stop();
        if (!active() || !ids.length) return;
        activitySub = deps.client.subscribe([{ kinds: [5, 7, 9], '#e': ids, limit: 256 }], {
          relayUrls: [
            ...new Set([
              ...urls,
              ...(snapshot.ancestors.find((prior) => prior.address === address)?.relays ?? []),
            ]),
          ],
          onEvent: (event, relay) => {
            if (!active() || !validPublicAction(event.rawEvent(), address)) return;
            if (queued >= 256) {
              stopLive();
              state.update((s) => ({
                ...s,
                stale: true,
                error: 'Public group traffic exceeded the local queue. Refresh to catch up.',
              }));
              return;
            }
            queued++;
            activityQueue = activityQueue
              .then(async () => {
                if (!active()) return;
                await cacheEvents(address, [receivedMessage(event, relay?.url)], db);
                if (active()) await refreshVisible(address, db, token);
              })
              .catch(() => {
                if (active())
                  state.update((s) => ({
                    ...s,
                    error: 'Could not save message actions. Refresh to retry.',
                  }));
              })
              .finally(() => {
                queued--;
              });
          },
        });
      }, 50);
    });
    stopActivity = () => {
      unwatch();
      clearTimeout(activityTimer);
      activitySub?.stop();
    };
    async function drain() {
      if (draining) return;
      draining = true;
      try {
        while (pending.length && active()) {
          const event = pending.shift()!;
          const current = get(state).room!;
          if (event.kind === 34550) {
            let next: PublicRoom;
            try {
              next = parsePublicRoom(event, current.address);
            } catch {
              continue;
            }
            if (!newerRoom(next, current)) continue;
            if (next.successor) {
              void open(requested);
              return;
            }
            state.update((s) => ({ ...s, room: next }));
            await saveRoom(next, true, undefined, owner);
            if (!active()) return;

            if (JSON.stringify(next.relays) !== JSON.stringify(current.relays)) {
              void open(requested);
              return;
            }
          } else {
            const batch = [event];
            // Do not move messages across an owner policy update.
            while (batch.length < 64 && pending[0]?.kind === 9) batch.push(pending.shift()!);
            const saved = await cacheTimelineEvents(current.address, batch, urls, db, active);
            if (active() && !get(state).history && !get(state).hasNewer) {
              const hydrated = await hydrate(current.address, saved, db);
              if (active() && !get(state).history && !get(state).hasNewer) append(hydrated);
            }
            if (active() && batch.some((event) => event.kind !== 9 || editTarget(event)))
              await refreshVisible(current.address, db, token);
          }
        }
      } catch {
        if (active())
          state.update((s) => ({
            ...s,
            error: 'Could not save public messages. Refresh to retry.',
          }));
      } finally {
        draining = false;
      }
    }
  }
  async function older() {
    const s = get(state);
    if (!s.room || s.loading) return;
    const token = view,
      revision = windowRevision,
      owner = account,
      db = data!,
      address = s.history || s.room.address;
    const first = s.messages[0];
    state.update((s) => ({ ...s, loading: true, error: '' }));
    try {
      let complete = false;
      let events = await db.page(
        address,
        first ? { created_at: first.created_at, id: first.id! } : undefined,
        ROOM_PAGE,
      );
      if (!events.length) {
        const room = s.ancestors.find((r) => r.address === address) || s.room;
        const result = await query(
          [
            {
              kinds: [9],
              '#a': [address],
              ...(first ? { until: first.created_at } : {}),
              limit: ROOM_WINDOW,
            },
          ],
          await relayUrls(room.relays),
          ROOM_WINDOW * 8,
          (events) =>
            events.filter(
              (e) =>
                validRoomMessage(e.rawEvent(), address) &&
                (!first ||
                  e.created_at < first.created_at ||
                  (e.created_at === first.created_at && e.id < first.id!)),
            ).length >= ROOM_PAGE,
          true,
        );
        const raw = result.events;
        complete = result.complete;
        if (
          first &&
          raw.length >= ROOM_WINDOW &&
          raw.every((e) => e.created_at === first.created_at)
        )
          throw new Error(
            'This relay returned a dense message batch. Earlier history could not be fully paged.',
          );
        events = raw
          .map((e) => receivedMessage(e))
          .filter(
            (e) =>
              validRoomMessage(e, address) &&
              (!first ||
                e.created_at < first.created_at ||
                (e.created_at === first.created_at && e.id! < first.id!)),
          );
        events.sort((a, b) => a.created_at - b.created_at || a.id!.localeCompare(b.id!));
        events = events.slice(-ROOM_PAGE);
        assertSession(owner);
        if (token !== view || revision !== windowRevision) return;
        events = await cacheTimelineEvents(
          address,
          events,
          await relayUrls(room.relays),
          db,
          () => token === view && revision === windowRevision && owner === deps.account(),
        );
      }
      assertSession(owner);
      if (token !== view || revision !== windowRevision) return;
      if ((get(state).history || get(state).room?.address) !== address) return;
      const hydrated = await hydrate(address, events, db);
      if (token !== view || revision !== windowRevision) return;
      append(hydrated, true);
      state.update((s) => ({ ...s, more: !complete || events.length === ROOM_PAGE }));
    } catch (e) {
      if (token === view && revision === windowRevision)
        state.update((s) => ({ ...s, error: (e as Error).message }));
    } finally {
      if (token === view && revision === windowRevision)
        state.update((s) => ({ ...s, loading: false }));
    }
  }
  async function newer() {
    const s = get(state);
    if (!s.room || s.loading || !s.hasNewer) return;
    const token = view,
      revision = windowRevision,
      owner = account,
      db = data!;
    const last = s.messages.at(-1);
    if (!last) return;
    state.update((s) => ({ ...s, loading: true }));
    try {
      const events = await db.page(
        s.history || s.room.address,
        { created_at: last.created_at, id: last.id! },
        ROOM_PAGE,
        'next',
      );
      if (token !== view || revision !== windowRevision || owner !== account) return;
      const hydrated = await hydrate(
        s.history || s.room!.address,
        events.filter((e) => validRoomMessage(e, s.history || s.room!.address)),
        db,
      );
      if (token !== view || revision !== windowRevision || owner !== account) return;
      append(hydrated);
      state.update((s) => ({ ...s, hasNewer: events.length === ROOM_PAGE, more: true }));
    } catch {
      if (token === view && revision === windowRevision)
        state.update((s) => ({ ...s, error: 'Could not load newer public messages.' }));
    } finally {
      if (token === view && revision === windowRevision)
        state.update((s) => ({ ...s, loading: false }));
    }
  }
  // Searches and jumps are scoped to the signed policy, history and account that
  // started them. A late result must never replace a different thread's window.
  function searchContext(signal?: AbortSignal) {
    const snapshot = get(state),
      db = data,
      owner = account,
      token = view;
    if (!snapshot.room || !db) return;
    const room = snapshot.room,
      address = snapshot.history || room.address;
    const active = () => {
      const current = get(state);
      return (
        !signal?.aborted &&
        token === view &&
        owner === account &&
        owner === deps.account() &&
        current.room?.event.id === room.event.id &&
        (current.history || current.room?.address) === address
      );
    };
    const textFor = (event: PublicGroupMessage) => {
      const policy = roomPolicy(room, event.pubkey);
      if (policy === 'blocked' || !validRoomMessage(event, address)) return null;
      return policy === 'trusted' ? event.content : redactPublicLinks(event.content);
    };
    return { db, address, active, textFor };
  }
  async function searchMessages(query: string, signal?: AbortSignal) {
    const context = searchContext(signal),
      normalized = normalizeMessageSearchText(query);
    if (!context || !context.active() || !normalized) return [];
    const results: { messageId: string; text: string }[] = [];
    let before: { created_at: number; id: string } | undefined;
    for (
      let scanned = 0;
      scanned < 2000 && context.active() && results.length < 100;
      scanned += ROOM_PAGE
    ) {
      const batch = await context.db.page(context.address, before, ROOM_PAGE);
      if (!batch.length) break;
      const hydrated = await hydrate(context.address, batch, context.db);
      if (!context.active()) return [];
      for (const event of hydrated.reverse()) {
        const message = publicMessageState(event, get(state).room!, account);
        if (
          !message.meta.deleted &&
          context.textFor(event) !== null &&
          normalizeMessageSearchText(message.text).includes(normalized)
        )
          results.push({ messageId: event.id!, text: message.text });
        if (results.length === 100) break;
      }
      before = { created_at: batch[0].created_at, id: batch[0].id! };
    }
    return context.active() ? results : [];
  }
  async function readMessage(
    id: string,
    context: NonNullable<ReturnType<typeof searchContext>>,
    fetchMissing = true,
  ) {
    if (!context.active() || !/^[a-f0-9]{64}$/.test(id)) return null;
    const room =
      get(state).ancestors.find((room) => room.address === context.address) ?? get(state).room!;
    // Only the owner can set the pin. Without its original event, accept only
    // owner-authored replacements; other authors need the original for verification.
    const author = room.pinned === id ? room.owner : undefined;
    const matches = (event: PublicGroupMessage) =>
      validRoomMessage(event, context.address) &&
      (event.id === id ||
        (event.pubkey === author && (editTarget(event) === id || editRoot(event) === id)));
    const replacement = (events: PublicGroupMessage[]) =>
      publicMessageReference(
        events.filter((event) => context.textFor(event) !== null),
        id,
        context.address,
        author,
      );
    let target = await context.db.message(context.address, id);
    if (!target)
      target = replacement([
        ...get(state).messages,
        ...(await context.db.actionsFor(context.address, [id])),
      ]);
    if (!target && fetchMissing && context.active()) {
      const room =
        get(state).ancestors.find((room) => room.address === context.address) ?? get(state).room!;
      const result = await query(
        [
          { kinds: [9], ids: [id], limit: 1 },
          { kinds: [9], '#a': [context.address], '#e': [id], limit: 64 },
        ],
        await relayUrls(room.relays),
        65, // One original plus the bounded replacement query.
        (events) => events.some((event) => matches(event.rawEvent())),
        true,
        (event) => matches(event.rawEvent()) && context.textFor(event.rawEvent()) !== null,
      );
      if (!context.active()) return null;
      const saved = await cacheEvents(
        context.address,
        result.events.map((event) => receivedMessage(event)),
        context.db,
      );
      target =
        saved.find((event) => event.id === id) ??
        replacement(result.events.map((event) => receivedMessage(event)));
      // Edited messages are normally stored as actions. Retain an available
      // replacement as a timeline anchor when the original has been removed.
      if (target && editTarget(target)) await context.db.put(context.address, target);
    }
    return context.active() && target && context.textFor(target) !== null ? target : null;
  }
  async function pinnedMessage(fetchMissing = true): Promise<Message | null> {
    const room = get(state).room;
    const context = searchContext();
    if (!room?.pinned || get(state).history || !context) return null;
    const target = await readMessage(room.pinned, context, fetchMissing);
    if (!target) return null;
    const [hydrated] = await hydrate(context.address, [target], context.db);
    return context.active() ? publicMessageState(hydrated, room, account) : null;
  }
  async function pinMessage(id: string | null) {
    const room = get(state).room;
    if (!room || get(state).history || room.owner !== account)
      throw new Error('Only the current group owner can pin messages.');
    if (id) await targetMessage(id);
    await update({ pinned: id ?? '' }, room.event.id!);
  }
  async function jumpToMessage(id: string, signal?: AbortSignal) {
    const context = searchContext(signal);
    if (!context || !context.active()) return null;
    const revision = ++windowRevision;
    const active = () => context.active() && revision === windowRevision;
    state.update((s) => ({ ...s, loading: true }));
    try {
      const target = await readMessage(id, context);
      if (!active() || !target || context.textFor(target) === null) return null;
      const cursor = { created_at: target.created_at, id: target.id! };
      const [before, after] = await Promise.all([
        context.db.page(context.address, cursor, 25),
        context.db.page(context.address, cursor, 26, 'next'),
      ]);
      if (!active()) return null;
      const messages = await hydrate(
        context.address,
        [...before, target, ...after.slice(0, 25)].filter((event) =>
          validRoomMessage(event, context.address),
        ),
        context.db,
      );
      if (!active()) return null;
      const last = messages.at(-1)!;
      state.update((s) => ({
        ...s,
        messages,
        more: true,
        hasNewer:
          after.length > 25 ||
          s.messages.some(
            (event) =>
              event.created_at > last.created_at ||
              (event.created_at === last.created_at && event.id! > last.id!),
          ),
      }));
      return target;
    } finally {
      // Cancellation still releases our loading flag, unless another navigation
      // has taken ownership of it in the meantime.
      if (revision === windowRevision) state.update((s) => ({ ...s, loading: false }));
    }
  }
  async function history(address: string) {
    const s = get(state);
    if (!s.room || s.loading || (address && !s.ancestors.some((r) => r.address === address)))
      return;
    state.update((s) => ({ ...s, history: address, messages: [], more: true, hasNewer: false }));
    await older();
  }
  function receivedMessage(event: ClientEvent, url?: string): PublicGroupMessage {
    const urls = [...new Set(url ? [url] : event.onRelays.map((relay) => relay.url))];
    return {
      ...event.rawEvent(),
      relay_statuses: urls.map((relay_url) => ({
        relay_url,
        direction: 'inbound',
        scope: 'subscription',
        status: 'received',
        updated_at: new Date().toISOString(),
      })),
    };
  }
  async function publish(
    event: ClientEvent,
    relays: string[],
    owner = account,
    record?: (event: NostrEvent, statuses: MessageRelayStatus[]) => Promise<void>,
    validate?: () => void,
  ) {
    const current = () => {
      assertSession(owner);
      validate?.();
    };
    current();
    if (deps.containsSecret(JSON.stringify(event.rawEvent())))
      throw new Error('Public content contains your session secret.');
    const signer = await deps.signer();
    current();
    if (signer.pubkey !== owner)
      throw new Error('Public group signer does not match this account.');
    await event.sign(signer);
    current();
    if (!verifiedPublicEvent(event.rawEvent()))
      throw new Error(
        'Public group content exceeds the event limits. Shorten the content or moderation lists.',
      );
    // Keep replication running with bounded timeouts, but one real relay ACK
    // is enough to confirm a public post. A dead replica must not stall typing.
    await publishSigned(event, relays, record, current);
    assertSession(owner);
  }
  async function publishSigned(
    event: ClientEvent,
    relays: string[],
    record: ((event: NostrEvent, statuses: MessageRelayStatus[]) => Promise<void>) | undefined,
    validate: () => void,
  ) {
    validate();
    const report = (urls: string[], status: MessageRelayStatus['status'], detail?: string) =>
      record?.(
        event.rawEvent(),
        urls.map((relay_url) => ({
          relay_url,
          direction: 'outbound',
          scope: 'recipient',
          status,
          updated_at: new Date().toISOString(),
          ...(detail ? { detail } : {}),
        })),
      );
    await report(relays, 'pending');
    try {
      const publications = relays.map(async (url) => {
        try {
          validate();
          const relay = deps.client.pool.getRelay(url, false);
          await relay.connect();
          validate();
          await relay.publish(event, 8000);
        } catch (error) {
          await report([url], 'failed', String(error).slice(0, 300));
          throw error;
        }
        await report([url], 'published');
      });
      await Promise.any(publications);
    } catch {
      throw new Error('No public group or app relay accepted this event. Retry when connected.');
    }
  }
  async function create(input: {
    name: string;
    about: string;
    picture: string;
    predecessor?: string;
    relays?: string[];
  }) {
    await init();
    const owner = account;
    if (
      !input.name.trim() ||
      input.name.length > 100 ||
      input.about.length > 2000 ||
      (input.picture && !previewUrl(input.picture))
    )
      throw new Error('Use a group name, a short description and a public HTTPS picture URL.');
    if (get(state).rooms.length >= 200)
      throw new Error('Leave an unused public group before adding another.');
    const predecessor = input.predecessor ? decodeRoomLink(input.predecessor) : undefined;
    if (predecessor) await readRoom(predecessor);
    const urls = input.relays ? await selectedRelays(input.relays) : await relayUrls([]);
    const event = new ClientEvent(deps.client, {
      kind: 34550,
      content: '',
      tags: roomTags({
        ...input,
        slug: crypto.randomUUID(),
        relays: urls,
        trusted: [],
        blocked: [],
        predecessor,
      }),
    });
    await publish(event, await relayUrls(urls), owner);
    assertSession(owner);
    const room = parsePublicRoom(event.rawEvent());
    await saveRoom(room, true, undefined, owner);
    return encodeRoomLink(room);
  }
  async function update(
    input: Partial<
      Pick<
        PublicRoom,
        'name' | 'about' | 'picture' | 'trusted' | 'blocked' | 'successor' | 'relays' | 'pinned'
      >
    >,
    expectedId: string,
  ) {
    if (writing) throw new Error('Another public group change is being saved.');
    writing = true;
    try {
      const room = get(state).room,
        owner = account,
        token = view;
      if (!room || room.owner !== owner || room.successor)
        throw new Error('Only the current owner can change this group.');
      const previousUrls = await relayUrls(room.relays);
      const changingRelays = input.relays !== undefined;
      if (changingRelays && Object.keys(input).some((key) => key !== 'relays'))
        throw new Error('Save relay changes separately from profile or moderation changes.');
      const preferred = changingRelays ? await selectedRelays(input.relays!) : room.relays;
      const urls = [...new Set([...previousUrls, ...(await relayUrls(preferred))])];
      const fresh = await readRoom(room);
      assertSession(owner);
      if (fresh.event.id !== expectedId || fresh.successor)
        throw new Error('The group changed. Refresh and review before saving.');
      if (input.successor) {
        const target = await readRoom(input.successor);
        if (
          target.owner === owner ||
          target.predecessor?.address !== room.address ||
          target.successor
        )
          throw new Error(
            'The new owner must create a fresh group accepting this group as its predecessor.',
          );
        input = { ...input, successor: target };
      }
      const next = { ...fresh, ...input, relays: changingRelays ? preferred : fresh.relays };
      const event = new ClientEvent(deps.client, {
        kind: 34550,
        content: '',
        created_at: Math.max(Math.floor(Date.now() / 1000), fresh.event.created_at + 1),
        tags: roomTags(next),
      });
      // Validate the proposed schema before asking a signer or publishing.
      if (
        (next.picture && !previewUrl(next.picture)) ||
        !next.name.trim() ||
        next.name.length > 100 ||
        next.about.length > 2000 ||
        (next.pinned && !/^[a-f0-9]{64}$/.test(next.pinned)) ||
        next.blocked.includes(owner) ||
        [...next.trusted, ...next.blocked].some((k) => !/^[a-f0-9]{64}$/.test(k)) ||
        next.trusted.length > 1024 ||
        next.blocked.length > 1024
      )
        throw new Error('Invalid public group profile or moderation list.');
      await publish(event, urls, owner, undefined, () => {
        const observedId = get(state).room?.event.id;
        if (token !== view || (observedId !== expectedId && observedId !== event.id))
          throw new Error('The group changed. Refresh and review before saving.');
      });
      assertSession(owner);
      await saveRoom(parsePublicRoom(event.rawEvent()), true, undefined, owner);
      await open(requested);
    } finally {
      writing = false;
    }
  }
  async function post(
    room: PublicRoom,
    text: string,
    attachments: MessageAttachmentMetadata[],
    replyId: string | undefined,
    validate: () => void,
  ) {
    const owner = account,
      token = view,
      db = data!;
    validate();
    if (room.successor || roomPolicy(room, owner) === 'blocked')
      throw new Error('Posting is unavailable in this public group.');
    if (!text.trim() || text.length > 8000)
      throw new Error('Messages must contain 1–8,000 characters.');
    if (
      attachments.length > 4 ||
      attachments.some(
        (attachment) =>
          roomPolicy(room, owner) !== 'trusted' ||
          !previewUrl(attachment.url) ||
          !/^(image|video)\//.test(attachment.mimeType),
      )
    )
      throw new Error('Media posting requires a trusted account and a public HTTPS URL.');
    const parent = replyId ? await db.message(room.address, replyId) : undefined;
    if (
      replyId &&
      (!parent ||
        !validRoomMessage(parent, room.address) ||
        roomPolicy(room, parent.pubkey) === 'blocked')
    )
      throw new Error('Reply target unavailable.');
    const event = new ClientEvent(deps.client, {
      kind: 9,
      content: roomPolicy(room, owner) === 'trusted' ? text.trim() : redactPublicLinks(text.trim()),
      tags: [
        ['a', room.address],
        ...(replyId ? [['q', replyId, room.relays[0] ?? '', parent!.pubkey]] : []),
        ...attachments.map((attachment) => [
          'imeta',
          `url ${attachment.url}`,
          `m ${attachment.mimeType}`,
          `size ${attachment.size}`,
          ...(attachment.sha256 ? [`x ${attachment.sha256}`] : []),
        ]),
      ],
    });
    await publish(
      event,
      await relayUrls(room.relays),
      owner,
      statusRecorder(room.address, owner, db, token),
      validate,
    );
  }
  async function send(
    text: string,
    attachment?: MessageAttachmentMetadata | MessageAttachmentMetadata[],
    replyId?: string,
  ) {
    const snapshot = get(state),
      room = snapshot.room,
      owner = account,
      token = view;
    if (
      !room ||
      snapshot.stale ||
      snapshot.history ||
      room.successor ||
      roomPolicy(room, owner) === 'blocked'
    )
      throw new Error('Posting is unavailable in this public group.');
    await post(
      room,
      text,
      Array.isArray(attachment) ? attachment : attachment ? [attachment] : [],
      replyId,
      () => assertPostingPolicy(room, owner, token),
    );
  }
  async function forwardMessage(address: string, message: Pick<Message, 'text' | 'meta'>) {
    await init();
    const owner = account,
      token = view,
      db = data!;
    const saved = await db.get(address);
    assertSession(owner);
    if (!saved?.joined || saved.successor || message.meta.deleted)
      throw new Error('Forward destination unavailable.');
    const room = await readRoom(saved.room);
    assertSession(owner);
    await post(room, message.text, message.meta.attachments ?? [], undefined, () => {
      assertSession(owner);
      const current = get(state).room;
      if (token !== view || (current?.address === address && current.event.id !== room.event.id))
        throw new Error('Group changed. Try forwarding again.');
    });
  }
  async function targetMessage(id: string) {
    const snapshot = get(state),
      room = snapshot.room,
      owner = account,
      token = view,
      db = data;
    if (!room || !db) throw new Error('Public group unavailable.');
    assertPostingPolicy(room, owner, token);
    const root = await db.message(room.address, id);
    assertPostingPolicy(room, owner, token);
    if (
      !root ||
      !validRoomMessage(root, room.address) ||
      roomPolicy(room, root.pubkey) === 'blocked'
    )
      throw new Error('Message unavailable.');
    const [hydrated] = await hydrate(room.address, [root], db);
    assertPostingPolicy(room, owner, token);
    const message = publicMessageState(hydrated, room, owner);
    if (message.meta.deleted) throw new Error('This message was deleted.');
    return { room, owner, token, db, root: hydrated, message };
  }
  async function editMessage(id: string, text: string) {
    const { room, owner, token, db, root } = await targetMessage(id);
    if (root.pubkey !== owner) throw new Error('Only the author can edit this message.');
    if (deps.containsSecret(text)) throw new Error('This message contains your session secret.');
    if (!text.trim() || text.length > 8000)
      throw new Error('Messages must contain 1–8,000 characters.');
    const current = publicMessageState(root, room, owner).nostrEvent!.event;
    const urls = await relayUrls(room.relays);
    const deletion = new ClientEvent(deps.client, {
      kind: 5,
      content: '',
      tags: [
        ['h', room.address],
        ['e', current.id!],
        ['k', '9'],
      ],
    });
    await publish(deletion, urls, owner, statusRecorder(room.address, owner, db, token), () =>
      assertPostingPolicy(room, owner, token),
    );
    const event = new ClientEvent(deps.client, {
      kind: 9,
      created_at: current.created_at,
      content: roomPolicy(room, owner) === 'trusted' ? text.trim() : redactPublicLinks(text.trim()),
      tags: [
        ['a', room.address],
        buildMessageEditTag(current.id!)!,
        ...(current.id !== root.id ? [['e', root.id!]] : []),
        ...current.tags.filter(
          (tag) => tag[0] === 'q' || (tag[0] === 'imeta' && roomPolicy(room, owner) === 'trusted'),
        ),
      ],
    });
    await publish(
      event,
      await relayUrls(room.relays),
      owner,
      statusRecorder(room.address, owner, db, token),
      () => assertPostingPolicy(room, owner, token),
    );
  }
  async function deleteMessage(id: string) {
    const { room, owner, token, db, root } = await targetMessage(id);
    if (root.pubkey !== owner) throw new Error('Only the author can delete this message.');
    const ids = [
      root.id!,
      ...(root.activity ?? [])
        .filter((event) => event.pubkey === owner && event.kind === 9)
        .map((event) => event.id!),
    ].slice(0, 64);
    const event = new ClientEvent(deps.client, {
      kind: 5,
      content: '',
      tags: [['h', room.address], ['k', '9'], ...ids.map((id) => ['e', id])],
    });
    await publish(
      event,
      await relayUrls(room.relays),
      owner,
      statusRecorder(room.address, owner, db, token),
      () => assertPostingPolicy(room, owner, token),
    );
  }
  async function react(id: string, emoji: string, remove = false) {
    const { room, owner, token, db, root, message } = await targetMessage(id);
    if (!emoji.trim() || emoji.length > 64) throw new Error('Invalid reaction.');
    const mine = message.meta.reactions?.find(
      (reaction) => reaction.reactorPublicKey === owner && reaction.emoji === emoji,
    );
    if (remove && !mine) return;
    if (!remove && mine) return;
    const ids = (root.activity ?? [])
      .filter(
        (event) =>
          event.kind === 7 &&
          event.pubkey === owner &&
          [
            root.id,
            ...(root.activity ?? [])
              .filter((edit) => edit.kind === 9 && edit.pubkey === root.pubkey)
              .map((edit) => edit.id),
          ].includes(actionTargets(event)[0]) &&
          (event.content === emoji ||
            (emoji === '👍' && (!event.content || event.content === '+')) ||
            (emoji === '👎' && event.content === '-')),
      )
      .map((event) => event.id!)
      .slice(0, 64);
    const event = new ClientEvent(
      deps.client,
      remove
        ? {
            kind: 5,
            content: '',
            tags: [['h', room.address], ['k', '7'], ...ids.map((id) => ['e', id])],
          }
        : {
            kind: 7,
            content: emoji,
            tags: [
              ['h', room.address],
              ['e', root.id!, room.relays[0] ?? '', root.pubkey],
              ['p', root.pubkey],
              ['k', '9'],
            ],
          },
    );
    await publish(
      event,
      await relayUrls(room.relays),
      owner,
      statusRecorder(room.address, owner, db, token),
      () => assertPostingPolicy(room, owner, token),
    );
  }
  function assertPostingPolicy(room: PublicRoom, owner: string, token: number) {
    assertSession(owner);
    const current = get(state);
    if (
      token !== view ||
      current.room?.event.id !== room.event.id ||
      current.stale ||
      current.history ||
      roomPolicy(current.room, owner) === 'blocked'
    )
      throw new Error('Group policy changed. Review the group before sending again.');
  }
  function statusRecorder(address: string, owner: string, db: PublicGroupData, token: number) {
    return async (event: NostrEvent, statuses: MessageRelayStatus[]) => {
      if (owner !== account || owner !== deps.account() || data !== db) return;
      const saved = await cacheEvents(address, [{ ...event, relay_statuses: statuses }], db);
      if (owner !== account || owner !== deps.account() || data !== db) return;
      if (
        token === view &&
        get(state).room?.address === address &&
        !get(state).history &&
        !get(state).hasNewer
      ) {
        const hydrated = await hydrate(address, saved, db);
        if (
          token === view &&
          data === db &&
          owner === deps.account() &&
          get(state).room?.address === address &&
          !get(state).history &&
          !get(state).hasNewer
        )
          append(hydrated);
      }
      if (token === view && (event.kind !== 9 || editTarget(event)))
        await refreshVisible(address, db, token);
    };
  }
  async function retryMessage(eventId: string, url: string) {
    const s = get(state),
      room = s.room,
      owner = account,
      db = data!,
      token = view;
    if (!room || s.stale || s.history || roomPolicy(room, owner) === 'blocked')
      throw new Error('Posting is unavailable in this public group.');
    if (!(await relayUrls(room.relays)).includes(url))
      throw new Error('Relay is not used by this group.');
    const event =
      (await db.message(room.address, eventId)) ?? (await db.action(room.address, eventId));
    assertSession(owner);
    if (get(state).room?.event.id !== room.event.id || get(state).stale || get(state).history)
      throw new Error('Group policy changed. Reopen relay details before retrying.');
    if (
      token !== view ||
      !event ||
      event.pubkey !== owner ||
      !validRoomMessage(event, room.address)
    )
      throw new Error('Message is unavailable for retry.');
    if (
      roomPolicy(room, owner) !== 'trusted' &&
      (redactPublicLinks(event.content) !== event.content ||
        event.tags.some((t) => t[0] === 'imeta'))
    )
      throw new Error('This post requires a trusted account.');
    if (
      !event.relay_statuses?.some(
        (s) => s.relay_url === url && s.direction === 'outbound' && s.status === 'failed',
      )
    )
      throw new Error('Only failed deliveries can be retried.');
    await publishSigned(
      new ClientEvent(deps.client, event),
      [url],
      statusRecorder(room.address, owner, db, token),
      () => assertPostingPolicy(room, owner, token),
    );
  }
  async function leave(address: string) {
    stopView();
    const owner = account,
      db = data!;
    const row = await db.get(address);
    assertSession(owner);
    if (row) await db.save({ ...row, joined: false });
    assertSession(owner);
    state.update((s) => ({
      ...s,
      room: null,
      messages: [],
      rooms: s.rooms.filter((r) => r.address !== address),
    }));
  }
  return {
    state,
    sidebar,
    init,
    open,
    stop,
    stopView,
    create,
    defaultRelays: () => relayUrls([]),
    update,
    send,
    forwardMessage,
    retryMessage,
    editMessage,
    deleteMessage,
    react,
    searchMessages,
    jumpToMessage,
    pinnedMessage,
    pinMessage,
    older,
    newer,
    history,
    leave,
  };
}
