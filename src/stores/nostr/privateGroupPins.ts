import { contactsService } from '#src/services/contactsService.ts';
import { chatDataService } from '#src/services/chatDataService.ts';
import { buildMessageReplyPreviewContent } from '#src/utils/messageAttachments.ts';
import type { PublishUserMetadataInput } from './types.ts';

export interface PrivateGroupPin {
  group: string;
  canPin: boolean;
  eventId: string;
  createdAt?: number;
  text: string;
  available: boolean;
  deleted: boolean;
}

export function createPrivateGroupPins(deps: {
  account: () => string | null;
  publish: (group: string, profile: PublishUserMetadataInput) => Promise<void>;
  refresh: (group: string) => Promise<unknown>;
}) {
  const pending = new Set<string>();
  async function read(group: string): Promise<PrivateGroupPin | null> {
    const account = deps.account();
    if (!account) return null;
    const contact = await contactsService.getContactByPublicKey(group);
    if (!contact || contact.type !== 'group' || deps.account() !== account) return null;
    const eventId = contact.meta.pinned ?? '';
    const row = eventId ? await chatDataService.getMessageByEventIdOrEditReference(eventId) : null;
    if (deps.account() !== account) return null;
    const message = row?.chat_public_key === group ? row : null;
    return {
      group,
      canPin:
        contact.meta.owner_public_key === account &&
        Boolean(contact.meta.group_private_key_encrypted),
      eventId,
      available: Boolean(message),
      deleted: Boolean(message?.meta.deleted),
      createdAt: contact.meta.pinned_created_at,
      text: message
        ? message.meta.deleted
          ? 'Message deleted'
          : buildMessageReplyPreviewContent(message.message, message.meta).text
        : 'Message unavailable · Click to load',
    };
  }
  async function set(group: string, eventId: string | null) {
    const account = deps.account();
    if (!account) throw new Error('Login is required.');
    const operation = `${account}:${group}`;
    if (pending.has(operation)) throw new Error('A pin change is already being saved.');
    pending.add(operation);
    try {
      const contact = await contactsService.getContactByPublicKey(group);
      if (deps.account() !== account) throw new Error('Account changed.');
      if (
        contact?.type !== 'group' ||
        contact.meta.owner_public_key !== account ||
        !contact.meta.group_private_key_encrypted
      )
        throw new Error('Only a group owner can pin messages.');
      const row = eventId
        ? await chatDataService.getMessageByEventIdOrEditReference(eventId)
        : null;
      if (
        eventId &&
        (!/^[a-f0-9]{64}$/.test(eventId) ||
          !row ||
          row.chat_public_key !== group ||
          row.meta.deleted)
      )
        throw new Error('Choose an available message from this group.');
      if (deps.account() !== account) throw new Error('Account changed.');
      // Contact metadata also contains recovery secrets and membership data.
      const profile: PublishUserMetadataInput = Object.fromEntries(
        [
          'name',
          'about',
          'picture',
          'nip05',
          'lud06',
          'lud16',
          'display_name',
          'website',
          'banner',
          'bot',
          'birthday',
        ]
          .filter((key) => Object.hasOwn(contact.meta, key))
          .map((key) => [key, contact.meta[key as keyof typeof contact.meta]]),
      );
      await deps.publish(group, {
        ...profile,
        group: true,
        pinned: eventId ?? '',
        pinned_created_at: row ? Math.floor(Date.parse(row.created_at) / 1000) : 0,
      });
      if (deps.account() !== account) throw new Error('Account changed.');
      await deps.refresh(group);
    } finally {
      pending.delete(operation);
    }
  }
  return { read, set };
}
