import { buildMessageReplyPreviewContent } from '#src/utils/messageAttachments.ts';
import { readMessageEditTargetEventId, buildEditedMessageMeta } from '#src/utils/messageEdits.ts';
import type { NostrEvent } from '#src/lib/nostr/client.ts';
import type { PublicGroupMessage } from '#src/services/publicGroupData.ts';
import type { Message } from '#src/types/chat.ts';
import {
  roomPolicy,
  validRoomMessage,
  verifiedPublicEvent,
  type PublicRoom,
} from './publicGroups.ts';
import { previewUrl } from '#src/utils/linkPreview.ts';
import { publicMessageForDisplay, redactPublicLinks } from '#src/utils/publicMessage.ts';

const HEX = /^[a-f0-9]{64}$/;
export function editTarget(event: NostrEvent): string | undefined {
  const id = readMessageEditTargetEventId(event.tags);
  return id && HEX.test(id) ? id : undefined;
}
export function editRoot(event: NostrEvent): string | undefined {
  return editTarget(event)
    ? (event.tags.find((tag) => tag[0] === 'e' && !tag[3] && HEX.test(tag[1]))?.[1] ??
        editTarget(event))
    : undefined;
}
// A relay may retain several replacement versions after honoring the original deletion.
// Keep one stable row, using the earliest available signed version as its anchor.
export function publicMessageRoots(events: PublicGroupMessage[]): PublicGroupMessage[] {
  const byId = new Map(events.map((event) => [event.id!, event]));
  const roots = new Map<string, PublicGroupMessage>();
  for (const event of events) {
    let root = event;
    for (let hop = 0; hop < 64; hop++) {
      const previous = byId.get(editTarget(root) ?? '');
      if (
        !previous ||
        previous.pubkey !== event.pubkey ||
        previous.created_at !== event.created_at ||
        previous.tags.find((tag) => tag[0] === 'a')?.[1] !==
          event.tags.find((tag) => tag[0] === 'a')?.[1]
      )
        break;
      root = previous;
    }
    const key = `${root.pubkey}:${root.created_at}:${editRoot(root) ?? root.id}`;
    const previous = roots.get(key);
    if (!previous || !editTarget(root) || (editTarget(previous) && root.id! < previous.id!))
      roots.set(key, root);
  }
  return [...roots.values()];
}
// Resolve an available signed version without scanning the room's history.
// An exact original remains authoritative; missing originals may be resolved
// through edit references, but conflicting authors/timestamps are ambiguous.
export function publicMessageReference(
  events: PublicGroupMessage[],
  id: string,
  address: string,
  author?: string,
): PublicGroupMessage | undefined {
  const candidates = events.filter(
    (event) =>
      validRoomMessage(event, address) &&
      (event.id === id || editTarget(event) === id || editRoot(event) === id),
  );
  const exact = candidates.find((event) => event.id === id);
  if (exact) return !author || exact.pubkey === author ? exact : undefined;
  // A replacement cannot establish the missing original's author by claiming its ID.
  if (!author) return undefined;
  const replacements = candidates.filter((event) => event.pubkey === author);
  if (new Set(replacements.map((event) => `${event.pubkey}:${event.created_at}`)).size !== 1)
    return undefined;
  return publicMessageRoots(replacements)[0];
}
export function replyTarget(event: NostrEvent): string | undefined {
  const tag = event.tags.find((tag) => tag[0] === 'q');
  return tag && HEX.test(tag[1]) ? tag[1] : undefined;
}
export function actionTargets(event: NostrEvent): string[] {
  if (event.kind === 9)
    return editTarget(event) ? [...new Set([editTarget(event)!, editRoot(event)!])] : [];
  const ids = event.tags.filter((tag) => tag[0] === 'e' && HEX.test(tag[1])).map((tag) => tag[1]);
  return event.kind === 7 ? ids.slice(-1) : [...new Set(ids)];
}
export function validPublicAction(event: NostrEvent, address: string): boolean {
  if (event.kind === 9) return Boolean(editTarget(event)) && validRoomMessage(event, address);
  return (
    [5, 7].includes(event.kind) &&
    event.content.length <= (event.kind === 7 ? 64 : 1000) &&
    event.tags.length <= 140 &&
    actionTargets(event).length > 0 &&
    actionTargets(event).length <= 64 &&
    event.tags.filter((tag) => tag[0] === 'h').every((tag) => tag[1] === address) &&
    verifiedPublicEvent(event)
  );
}
function newer(a: NostrEvent, b: NostrEvent) {
  return b.created_at - a.created_at || a.id!.localeCompare(b.id!);
}
function deleted(event: NostrEvent, actions: NostrEvent[]) {
  return actions
    .filter(
      (action) =>
        action.kind === 5 &&
        action.pubkey === event.pubkey &&
        actionTargets(action).includes(event.id!),
    )
    .sort(newer)[0];
}
export function publicMessageState(root: PublicGroupMessage, room: PublicRoom, own = ''): Message {
  const address = root.tags.find((tag) => tag[0] === 'a')?.[1] ?? '';
  const actions = (root.activity ?? []).filter(
    (event) =>
      validPublicAction(event, address) &&
      (!event.relay_statuses?.length ||
        event.relay_statuses.some(
          (status) => status.status === 'published' || status.status === 'received',
        )),
  );
  const candidates = actions.filter(
    (event) =>
      event.kind === 9 &&
      event.pubkey === root.pubkey &&
      event.created_at === root.created_at &&
      event.id !== root.id,
  );
  const depth = new Map<string, number>([[root.id!, 0]]);
  for (let hop = 0; hop < 64; hop++) {
    let changed = false;
    for (const event of candidates) {
      const previous = depth.get(editTarget(event) ?? '');
      if (previous !== undefined && !depth.has(event.id!)) {
        depth.set(event.id!, previous + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const edits = candidates
    .filter((event) => depth.has(event.id!))
    .sort((a, b) => depth.get(b.id!)! - depth.get(a.id!)! || newer(a, b));
  const current = edits[0] ?? root;
  const removal = deleted(current, actions);
  const message = publicMessageForDisplay(current, own);
  message.id = root.id!;
  message.chatId = address;
  message.sentAt = new Date(root.created_at * 1000).toISOString();
  message.text =
    roomPolicy(room, root.pubkey) === 'trusted'
      ? current.content
      : redactPublicLinks(current.content);
  if (roomPolicy(room, root.pubkey) === 'trusted')
    message.meta.attachments = current.tags
      .filter((tag) => tag[0] === 'imeta')
      .flatMap((tag) => {
        const url = tag.find((value) => value.startsWith('url '))?.slice(4) ?? '';
        const mimeType = tag.find((value) => value.startsWith('m '))?.slice(2) ?? '';
        return previewUrl(url) && /^(image|video)\//.test(mimeType)
          ? [
              {
                type: 'media' as const,
                url,
                mimeType,
                size: Number(tag.find((value) => value.startsWith('size '))?.slice(5)) || 0,
              },
            ]
          : [];
      })
      .slice(0, 4);
  if (current.id !== root.id || editTarget(root))
    message.meta = buildEditedMessageMeta(
      message.meta,
      {},
      current.id !== root.id ? root.id! : editTarget(root)!,
      new Date((deleted(root, actions)?.created_at ?? current.created_at) * 1000).toISOString(),
    );
  if (removal)
    message.meta.deleted = {
      deletedAt: new Date(removal.created_at * 1000).toISOString(),
      deletedByPublicKey: removal.pubkey,
      deleteEventId: removal.id,
      deletedEventKind: 9,
    };
  const targets = new Set([root.id, ...edits.map((event) => event.id)]);
  const reactions = new Map<string, NonNullable<Message['meta']['reactions']>[number]>();
  for (const reaction of actions.filter((event) => event.kind === 7).sort(newer)) {
    if (
      !targets.has(actionTargets(reaction)[0]) ||
      roomPolicy(room, reaction.pubkey) === 'blocked' ||
      deleted(reaction, actions)
    )
      continue;
    const author = reaction.tags.filter((tag) => tag[0] === 'p').at(-1)?.[1];
    if (author && author !== root.pubkey) continue;
    const emoji =
      !reaction.content || reaction.content === '+'
        ? '👍'
        : reaction.content === '-'
          ? '👎'
          : reaction.content;
    const key = `${reaction.pubkey}:${emoji}`;
    if (!reactions.has(key))
      reactions.set(key, {
        emoji,
        name: emoji,
        reactorPublicKey: reaction.pubkey,
        eventId: reaction.id,
        createdAt: new Date(reaction.created_at * 1000).toISOString(),
      });
  }
  if (!removal) message.meta.reactions = [...reactions.values()];
  const parentId = replyTarget(current);
  if (parentId) {
    const parent = root.replyEvent;
    const quoteAuthor = current.tags.find((tag) => tag[0] === 'q')?.[3] ?? '';
    const preview =
      parent && publicMessageReference([parent], parentId, address, quoteAuthor)
        ? publicMessageState({ ...parent, replyEvent: undefined }, room, own)
        : undefined;
    const visible = preview && roomPolicy(room, preview.authorPublicKey) !== 'blocked';
    message.meta.reply = {
      messageId: parentId,
      eventId: parentId,
      text: visible
        ? preview.meta.deleted
          ? 'Message deleted'
          : buildMessageReplyPreviewContent(preview.text, preview.meta).text
        : 'Message unavailable',
      authorPublicKey: visible ? preview.authorPublicKey : '',
      authorName: visible
        ? preview.sender === 'me'
          ? 'You'
          : preview.authorPublicKey.slice(0, 12)
        : '',
      sender: visible ? preview.sender : 'them',
      sentAt: visible ? preview.sentAt : '',
    };
  }
  return message;
}
