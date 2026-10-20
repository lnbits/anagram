import { writable } from 'svelte/store';
import {
  ClientEvent,
  NostrUser,
  giftWrap,
  type NostrEvent,
  type NostrSigner,
} from '#src/lib/nostr/client.ts';
import type NostrClient from '#src/lib/nostr/client.ts';
import {
  readBotInteraction,
  saveBotInteraction,
  type BotInteraction,
} from '#src/services/botInteractionData.ts';
import {
  BOT_CONTROL_KIND,
  KEYBOARD_TAG,
  controlTag,
  parseControl,
  keyboardFromTags,
  hasCallback,
  targetKey,
  type BotTarget,
  type BotMembership,
  type InlineKeyboard,
} from './botKeyboardProtocol.ts';

export function createBotKeyboardRuntime(deps: {
  client: NostrClient;
  account(): string | null;
  blocked(peer: string): boolean;
  signer(): Promise<NostrSigner>;
  authorize(
    target: BotTarget,
    proof?: BotMembership,
  ): Promise<{ keyboard: InlineKeyboard; membership?: BotMembership }>;
  publish(event: NostrEvent, target: BotTarget, isActive: () => boolean): Promise<void>;
  containsSecret(text: string): boolean;
}) {
  const changes = writable<{ key: string | null }>({ key: null });
  const busy = new Set<string>();
  let generation = 0;
  const changed = (target?: BotTarget) => changes.set({ key: target ? targetKey(target) : null });
  function active(owner: string, token: number, peer: string) {
    return deps.account() === owner && generation === token && !deps.blocked(peer);
  }
  async function read(target: BotTarget) {
    const owner = deps.account(),
      token = generation;
    if (!owner || deps.blocked(target.bot)) return undefined;
    const value = await readBotInteraction(owner, targetKey(target));
    return active(owner, token, target.bot) ? value : undefined;
  }
  async function click(target: BotTarget, data: string, view?: string, retry = false) {
    const owner = deps.account(),
      token = generation;
    if (!owner || owner === target.bot || deps.blocked(target.bot))
      throw new Error('Bot unavailable');
    const key = `${token}:${owner}:${targetKey(target)}`;
    if (busy.has(key) || busy.size >= 8) throw new Error('An interaction is already pending');
    busy.add(key);
    try {
      const auth = await deps.authorize(target);
      const previous = await readBotInteraction(owner, targetKey(target));
      if (!active(owner, token, target.bot)) throw new Error('Account changed');
      const now = Math.floor(Date.now() / 1000);
      let row: BotInteraction;
      if (retry && previous && !previous.answer && previous.request.expires > now) {
        row = previous;
        if (JSON.stringify(row.request.membership) !== JSON.stringify(auth.membership))
          throw new Error('Group membership changed. Open the menu again.');
      } else {
        const priorView = previous?.answer ?? previous?.previous;
        const keyboard =
          view && priorView?.eventId === view ? priorView.keyboard : !view ? auth.keyboard : null;
        if (!hasCallback(keyboard, data)) throw new Error('This menu has changed');
        const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join('');
        const request = {
          op: 'request' as const,
          id,
          target,
          data,
          expires: now + 300,
          ...(view ? { view } : {}),
          ...(auth.membership ? { membership: auth.membership } : {}),
        };
        if (
          deps.containsSecret(JSON.stringify(request)) ||
          /nsec1[023456789acdefghjklmnpqrstuvwxyz]+/i.test(data)
        )
          throw new Error('Callback contains a private key');
        row = {
          key: targetKey(target),
          updated: Date.now(),
          created: now,
          request,
          previous: previous?.answer ?? previous?.previous,
        };
        // Commit the operation identity before signing or publishing.
        await saveBotInteraction(owner, row);
        changed(target);
      }
      if (!row.wrap) {
        const signer = await deps.signer();
        if ((await signer.user()).pubkey !== owner || !active(owner, token, target.bot))
          throw new Error('Account changed');
        const rumor = new ClientEvent(deps.client, {
          kind: BOT_CONTROL_KIND,
          created_at: row.created,
          pubkey: owner,
          content: '',
          tags: [['p', target.bot], controlTag(row.request)],
        });
        const wrap = await giftWrap(rumor, new NostrUser({ pubkey: target.bot }), signer, {
          rumorKind: BOT_CONTROL_KIND,
        });
        if (!active(owner, token, target.bot)) throw new Error('Account changed');
        row = { ...row, wrap: wrap.rawEvent() };
        if (!(await saveBotInteraction(owner, row, row.request.id))) return;
      }
      const refreshed = await deps.authorize(target);
      if (JSON.stringify(row.request.membership) !== JSON.stringify(refreshed.membership))
        throw new Error('Group membership changed. Open the menu again.');
      if (!active(owner, token, target.bot) || row.request.expires <= Math.floor(Date.now() / 1000))
        throw new Error('Interaction expired');
      await deps.publish(row.wrap!, target, () => active(owner, token, target.bot));
      // A relay ACK is not a bot answer. The pending row remains retryable.
    } finally {
      busy.delete(key);
      if (deps.account() === owner && generation === token) changed(target);
    }
  }
  async function receive(event: NostrEvent) {
    const owner = deps.account(),
      token = generation;
    const response = parseControl(event.tags);
    const now = Math.floor(Date.now() / 1000);
    if (
      !owner ||
      event.kind !== BOT_CONTROL_KIND ||
      !event.id ||
      response?.op !== 'answer' ||
      event.pubkey !== response.target.bot ||
      deps.blocked(event.pubkey) ||
      event.tags.filter((t) => t[0] === 'p').length !== 1 ||
      event.tags.find((t) => t[0] === 'p')?.[1] !== owner ||
      event.content.length > 8000 ||
      !Number.isSafeInteger(event.created_at) ||
      event.created_at > now + 60
    )
      return;
    const row = await readBotInteraction(owner, response.id, true);
    if (
      !row ||
      row.answer ||
      row.request.expires !== response.expires ||
      targetKey(row.request.target) !== targetKey(response.target) ||
      event.created_at < row.created - 60 ||
      event.created_at > row.request.expires
    )
      return;
    const keyboard = keyboardFromTags(event.tags);
    if (event.tags.some((t) => t[0] === KEYBOARD_TAG) && !keyboard) return;
    try {
      await deps.authorize(response.target, response.membership);
    } catch {
      return;
    }
    if (!active(owner, token, event.pubkey)) return;
    // Match the latest operation atomically; late replies cannot replace a new menu.
    if (
      await saveBotInteraction(
        owner,
        {
          ...row,
          updated: Date.now(),
          wrap: undefined,
          previous: undefined,
          answer: { eventId: event.id, text: event.content, keyboard },
        },
        response.id,
      )
    )
      changed(response.target);
  }
  return {
    changes,
    read,
    click,
    receive,
    reset() {
      generation++;
      busy.clear();
      changed();
    },
  };
}
