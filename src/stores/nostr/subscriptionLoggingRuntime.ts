import type NDK from '@nostr-dev-kit/ndk';
import type {
  NDKEvent,
  NDKFilter,
  NDKSubscription,
  NDKSubscriptionOptions,
} from '@nostr-dev-kit/ndk';
import { chatDataService } from 'src/services/chatDataService';
import { contactsService } from 'src/services/contactsService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { observeConnectedRelayEose } from 'src/stores/nostr/subscriptionEose';
import type { SubscriptionLogName } from 'src/stores/nostr/types';
import type { ChatGroupEpochKey } from 'src/types/chat';
import type { ContactRecord } from 'src/types/contact';

interface SubscriptionLoggingRuntimeDeps {
  ndk: NDK;
  logDeveloperTrace: (
    level: 'info' | 'warn' | 'error',
    area: string,
    phase: string,
    details: Record<string, unknown>
  ) => void;
  normalizeEventId: (value: unknown) => string | null;
  resolveGroupChatEpochEntries: (chat: {
    meta: Record<string, unknown>;
    type?: string | null;
  }) => ChatGroupEpochKey[];
}

export function createSubscriptionLoggingRuntime({
  ndk,
  logDeveloperTrace,
  normalizeEventId,
  resolveGroupChatEpochEntries,
}: SubscriptionLoggingRuntimeDeps) {
  let subscriptionRequestCounter = 0;

  function relaySignature(relays: string[]): string {
    return [...relays].sort((a, b) => a.localeCompare(b)).join('|');
  }

  function formatSubscriptionLogValue(value: string | null | undefined): string | null {
    const normalizedValue = value?.trim() ?? '';
    if (!normalizedValue) {
      return null;
    }

    if (normalizedValue.length <= 18) {
      return normalizedValue;
    }

    return `${normalizedValue.slice(0, 8)}...${normalizedValue.slice(-8)}`;
  }

  function buildSubscriptionRelayDetails(relayUrls: string[]): Record<string, unknown> {
    return {
      relayCount: relayUrls.length,
      relayUrls,
    };
  }

  function buildSubscriptionEventDetails(
    event: Pick<NDKEvent, 'id' | 'kind' | 'created_at' | 'pubkey'>
  ): Record<string, unknown> {
    return {
      eventId: formatSubscriptionLogValue(event.id),
      kind: event.kind ?? null,
      createdAt: event.created_at ?? null,
      author: formatSubscriptionLogValue(event.pubkey),
    };
  }

  function buildLoggedNostrEvent(
    event: Pick<NDKEvent, 'id' | 'kind' | 'created_at' | 'pubkey' | 'content' | 'tags'>,
    storedEvent: Record<string, unknown> | null | undefined = null
  ): Record<string, unknown> {
    if (storedEvent) {
      return JSON.parse(JSON.stringify(storedEvent)) as Record<string, unknown>;
    }

    return {
      id: normalizeEventId(event.id ?? null) ?? event.id ?? null,
      kind: event.kind ?? null,
      created_at: Number.isInteger(event.created_at) ? Number(event.created_at) : null,
      pubkey: inputSanitizerService.normalizeHexKey(event.pubkey ?? '') ?? event.pubkey ?? null,
      content: typeof event.content === 'string' ? event.content : '',
      tags: Array.isArray(event.tags)
        ? event.tags
            .filter((tag): tag is string[] => Array.isArray(tag))
            .map((tag) => tag.map((value) => String(value ?? '')))
        : [],
    };
  }

  async function buildTrackedContactSubscriptionTargetDetails(
    contactPubkeys: string[]
  ): Promise<Record<string, unknown>> {
    const normalizedContactPubkeys = Array.from(
      new Set(
        contactPubkeys
          .map((pubkey) => inputSanitizerService.normalizeHexKey(pubkey))
          .filter((pubkey): pubkey is string => Boolean(pubkey))
      )
    );
    if (normalizedContactPubkeys.length === 0) {
      return {
        userTargetCount: 0,
        groupTargetCount: 0,
        userTargetPubkeys: [],
        groupTargetPubkeys: [],
      };
    }

    await Promise.all([contactsService.init(), chatDataService.init()]);
    const groupChatPubkeys = new Set(
      (await chatDataService.listChats())
        .filter((chat) => chat.type === 'group')
        .map((chat) => inputSanitizerService.normalizeHexKey(chat.public_key))
        .filter((pubkey): pubkey is string => Boolean(pubkey))
    );
    const contactsByPubkey = new Map(
      (await contactsService.listContacts())
        .map((contact) => {
          const normalizedPubkey = inputSanitizerService.normalizeHexKey(contact.public_key);
          return normalizedPubkey ? ([normalizedPubkey, contact] as const) : null;
        })
        .filter((entry): entry is readonly [string, ContactRecord] => Boolean(entry))
    );

    const userTargetPubkeys: string[] = [];
    const groupTargetPubkeys: string[] = [];

    for (const pubkey of normalizedContactPubkeys) {
      const formattedPubkey = formatSubscriptionLogValue(pubkey) ?? pubkey;
      if (groupChatPubkeys.has(pubkey) || contactsByPubkey.get(pubkey)?.type === 'group') {
        groupTargetPubkeys.push(formattedPubkey);
        continue;
      }

      userTargetPubkeys.push(formattedPubkey);
    }

    return {
      userTargetCount: userTargetPubkeys.length,
      groupTargetCount: groupTargetPubkeys.length,
      userTargetPubkeys,
      groupTargetPubkeys,
    };
  }

  async function buildPrivateMessageSubscriptionTargetDetails(
    recipientPubkeys: string[],
    loggedInPubkeyHex: string | null
  ): Promise<Record<string, unknown>> {
    const normalizedLoggedInPubkey = inputSanitizerService.normalizeHexKey(loggedInPubkeyHex ?? '');
    const normalizedRecipientPubkeys = Array.from(
      new Set(
        recipientPubkeys
          .map((pubkey) => inputSanitizerService.normalizeHexKey(pubkey))
          .filter((pubkey): pubkey is string => Boolean(pubkey))
      )
    );
    const recipientSet = new Set(normalizedRecipientPubkeys);

    await chatDataService.init();
    const userRecipientPubkeys =
      normalizedLoggedInPubkey && recipientSet.has(normalizedLoggedInPubkey)
        ? [formatSubscriptionLogValue(normalizedLoggedInPubkey) ?? normalizedLoggedInPubkey]
        : [];
    const matchedEpochRecipientPubkeys = new Set<string>();
    const groupChatPubkeys = new Set<string>();
    const epochRecipients: Array<{
      groupChatPubkey: string;
      epochRecipientPubkey: string;
      epochNumber: number;
    }> = [];

    const chats = await chatDataService.listChats();
    for (const chat of chats) {
      if (chat.type !== 'group') {
        continue;
      }

      const normalizedGroupChatPubkey = inputSanitizerService.normalizeHexKey(chat.public_key);
      if (!normalizedGroupChatPubkey) {
        continue;
      }

      for (const entry of resolveGroupChatEpochEntries(chat)) {
        const normalizedEpochPubkey = inputSanitizerService.normalizeHexKey(entry.epoch_public_key);
        if (!normalizedEpochPubkey || !recipientSet.has(normalizedEpochPubkey)) {
          continue;
        }

        matchedEpochRecipientPubkeys.add(normalizedEpochPubkey);
        groupChatPubkeys.add(
          formatSubscriptionLogValue(normalizedGroupChatPubkey) ?? normalizedGroupChatPubkey
        );
        epochRecipients.push({
          groupChatPubkey:
            formatSubscriptionLogValue(normalizedGroupChatPubkey) ?? normalizedGroupChatPubkey,
          epochRecipientPubkey:
            formatSubscriptionLogValue(normalizedEpochPubkey) ?? normalizedEpochPubkey,
          epochNumber: entry.epoch_number,
        });
      }
    }

    const unclassifiedRecipientPubkeys = normalizedRecipientPubkeys
      .filter(
        (pubkey) => pubkey !== normalizedLoggedInPubkey && !matchedEpochRecipientPubkeys.has(pubkey)
      )
      .map((pubkey) => formatSubscriptionLogValue(pubkey) ?? pubkey);

    return {
      userRecipientCount: userRecipientPubkeys.length,
      groupChatCount: groupChatPubkeys.size,
      epochRecipientCount: epochRecipients.length,
      unclassifiedRecipientCount: unclassifiedRecipientPubkeys.length,
      userRecipientPubkeys,
      groupChatPubkeys: Array.from(groupChatPubkeys),
      epochRecipients,
      unclassifiedRecipientPubkeys,
    };
  }

  function buildNostrReqFrame(subId: string, filters: NDKFilter | NDKFilter[]): unknown[] {
    const normalizedFilters = Array.isArray(filters) ? filters : [filters];
    const serializedFilters = normalizedFilters.map(
      (filter) => JSON.parse(JSON.stringify(filter)) as Record<string, unknown>
    );

    return ['REQ', subId, ...serializedFilters];
  }

  function buildLoggedNostrReqStatement(subId: string, filters: NDKFilter | NDKFilter[]): string[] {
    const normalizedFilters = Array.isArray(filters) ? filters : [filters];

    return [
      'REQ',
      subId,
      ...normalizedFilters.map((filter) =>
        JSON.stringify(JSON.parse(JSON.stringify(filter)) as Record<string, unknown>)
      ),
    ];
  }

  function createLoggedSubscriptionSubId(label: string): string {
    subscriptionRequestCounter += 1;
    const normalizedLabel =
      label
        .trim()
        .replace(/[^a-z0-9-]+/gi, '-')
        .replace(/^-+|-+$/g, '') || 'subscription';
    return `${normalizedLabel}-${subscriptionRequestCounter.toString(36)}`;
  }

  function subscribeWithReqLogging(
    name: SubscriptionLogName,
    label: string,
    filters: NDKFilter | NDKFilter[],
    options: NDKSubscriptionOptions,
    details: Record<string, unknown> = {}
  ) {
    const subId = createLoggedSubscriptionSubId(label);
    let initialEoseDelivered = false;
    const onEose = (source: NDKSubscription) => {
      if (initialEoseDelivered) return;
      initialEoseDelivered = true;
      options.onEose?.(source);
    };
    const subscription = ndk.subscribe(filters, {
      ...options,
      subId,
      // Routing and batching are explicit. NDK regrouping would replace unrelated listeners.
      groupable: false,
      ...(options.onEose ? { onEose } : {}),
    });
    if (options.onEose && !options.closeOnEose)
      observeConnectedRelayEose(subscription, () => onEose(subscription));
    const reqFrame = buildNostrReqFrame(subId, subscription.filters);
    const reqStatement = buildLoggedNostrReqStatement(subId, subscription.filters);
    const relayUrls = Array.from(
      new Set<string>(
        [...(options.relaySet?.relayUrls ?? []), ...(options.relayUrls ?? [])].filter(
          (url): url is string => typeof url === 'string' && url.trim().length > 0
        )
      )
    );

    logDeveloperTrace('info', `subscription:${name}`, 'req', {
      subId,
      reqFrame,
      reqStatement,
      ...buildSubscriptionRelayDetails(relayUrls),
      ...details,
    });

    return subscription;
  }

  function buildFilterSinceDetails(since: number | undefined): Record<string, unknown> {
    const normalizedSince = Number.isInteger(since) ? Number(since) : null;
    return {
      since: normalizedSince,
      sinceIso:
        normalizedSince && normalizedSince > 0
          ? new Date(normalizedSince * 1000).toISOString()
          : null,
    };
  }

  function buildFilterUntilDetails(until: number | undefined): Record<string, unknown> {
    const normalizedUntil = Number.isInteger(until) ? Number(until) : null;
    return {
      until: normalizedUntil,
      untilIso:
        normalizedUntil && normalizedUntil > 0
          ? new Date(normalizedUntil * 1000).toISOString()
          : null,
    };
  }

  return {
    buildFilterSinceDetails,
    buildFilterUntilDetails,
    buildLoggedNostrEvent,
    buildPrivateMessageSubscriptionTargetDetails,
    buildSubscriptionEventDetails,
    buildSubscriptionRelayDetails,
    buildTrackedContactSubscriptionTargetDetails,
    formatSubscriptionLogValue,
    relaySignature,
    subscribeWithReqLogging,
  };
}
