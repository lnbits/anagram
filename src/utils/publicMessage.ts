import type { Message } from '#src/types/chat.ts';
import type { PublicGroupMessage } from '#src/services/publicGroupData.ts';
import { buildMessageTextParts } from './messageTextParts.ts';

export function redactPublicLinks(text: string): string {
  return buildMessageTextParts(text)
    .map((part) =>
      part.type === 'url'
        ? '[link removed]'
        : part.type === 'mention'
          ? '[profile removed]'
          : part.text,
    )
    .join('');
}

export function publicMessageForDisplay(event: PublicGroupMessage, own = ''): Message {
  const { activity: _, replyEvent: __, relay_statuses: ___, ...signed } = event;
  return {
    id: event.id ?? '',
    chatId: '',
    text: event.content,
    sender: event.pubkey === own ? 'me' : 'them',
    sentAt: new Date(event.created_at * 1000).toISOString(),
    authorPublicKey: event.pubkey,
    eventId: event.id ?? null,
    meta: {},
    nostrEvent: {
      event: signed,
      direction: event.pubkey === own ? 'out' : 'in',
      relay_statuses: event.relay_statuses ?? [],
    },
  };
}
