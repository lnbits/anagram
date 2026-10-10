import { chatDataService } from '#src/services/chatDataService.ts';
import { emitForegroundMessageActivity } from '#src/services/foregroundMessageActivityService.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import type { ContactRecord } from '#src/types/contact.ts';
import { areBrowserNotificationsEnabled } from '#src/utils/browserNotificationPreference.ts';
import type { Ref } from '#src/lib/state/reactivity.ts';

interface InboundTraceOptions {
  wrappedEvent?: {
    id?: string | null;
    kind?: number | null;
    created_at?: number | null;
  } | null;
  rumorEvent?: { id?: string | null; kind?: number | null; created_at?: number | null } | null;
  loggedInPubkeyHex?: string | null;
  senderPubkeyHex?: string | null;
  chatPubkey?: string | null;
  targetEventId?: string | null;
  relayUrls?: string[];
  recipients?: string[];
}

interface InboundPresentationRuntimeDeps {
  formatSubscriptionLogValue: (value: string | null | undefined) => string | null;
  getLoggedInPublicKeyHex: () => string | null;
  getVisibleChatId: () => string | null;
  isAppForeground: Ref<boolean>;
  isRestoringStartupState: Ref<boolean>;
  logDeveloperTrace: (
    level: 'info' | 'warn' | 'error',
    area: string,
    phase: string,
    details: Record<string, unknown>,
  ) => void;
  normalizeEventId: (value: unknown) => string | null;
}

export function createInboundPresentationRuntime({
  formatSubscriptionLogValue,
  getLoggedInPublicKeyHex,
  getVisibleChatId,
  isAppForeground,
  isRestoringStartupState,
  logDeveloperTrace,
  normalizeEventId,
}: InboundPresentationRuntimeDeps) {
  function buildInboundTraceDetails(options: InboundTraceOptions = {}): Record<string, unknown> {
    const relayUrls = Array.isArray(options.relayUrls)
      ? options.relayUrls.filter(
          (value): value is string => typeof value === 'string' && value.trim().length > 0,
        )
      : [];
    const recipients = Array.isArray(options.recipients)
      ? options.recipients.filter(
          (value): value is string => typeof value === 'string' && value.trim().length > 0,
        )
      : [];
    const wrappedEventId =
      normalizeEventId(options.wrappedEvent?.id ?? null) ?? options.wrappedEvent?.id ?? null;
    const rumorEventId =
      normalizeEventId(options.rumorEvent?.id ?? null) ?? options.rumorEvent?.id ?? null;
    const createdAt = options.rumorEvent?.created_at ?? options.wrappedEvent?.created_at;
    const normalizedCreatedAt = Number.isInteger(createdAt) ? Number(createdAt) : null;

    return {
      wrappedEventId: formatSubscriptionLogValue(wrappedEventId),
      wrappedKind: options.wrappedEvent?.kind ?? null,
      rumorEventId: formatSubscriptionLogValue(rumorEventId),
      rumorKind: options.rumorEvent?.kind ?? null,
      createdAt: normalizedCreatedAt,
      createdAtIso:
        normalizedCreatedAt && normalizedCreatedAt > 0
          ? new Date(normalizedCreatedAt * 1000).toISOString()
          : null,
      senderPubkey: formatSubscriptionLogValue(options.senderPubkeyHex),
      loggedInPubkey: formatSubscriptionLogValue(options.loggedInPubkeyHex),
      chatPubkey: formatSubscriptionLogValue(options.chatPubkey),
      targetEventId: formatSubscriptionLogValue(options.targetEventId),
      relayCount: relayUrls.length,
      relayUrls,
      ...(recipients.length > 0
        ? {
            recipientCount: recipients.length,
            recipients: recipients.map((value) => formatSubscriptionLogValue(value)),
          }
        : {}),
    };
  }

  function logInboundEvent(stage: string, details: Record<string, unknown> = {}): void {
    logDeveloperTrace('info', 'inbound', stage, details);
  }

  function deriveChatName(contact: ContactRecord | null, publicKey: string): string {
    const displayName = contact?.meta.display_name?.trim() ?? '';
    if (displayName) {
      return displayName;
    }

    const profileName = contact?.meta.name?.trim() ?? '';
    if (profileName) {
      return profileName;
    }

    const contactName = contact?.name?.trim() ?? '';
    if (contactName) {
      return contactName;
    }

    return publicKey.slice(0, 16);
  }

  function buildBrowserNotificationMessagePreview(messageText: string): string {
    const normalizedText = messageText.replace(/\s+/g, ' ').trim();
    if (!normalizedText) {
      return 'New message';
    }

    if (normalizedText.length <= 140) {
      return normalizedText;
    }

    return `${normalizedText.slice(0, 137)}...`;
  }

  function buildChatNotificationHref(chatPubkey: string): string | null {
    if (typeof window === 'undefined') {
      return null;
    }

    const normalizedBase = (() => {
      const base = process.env.VUE_ROUTER_BASE?.trim() || '/';
      return base.endsWith('/') ? base : `${base}/`;
    })();
    const encodedChatPubkey = encodeURIComponent(chatPubkey);

    if (process.env.VUE_ROUTER_MODE === 'hash') {
      const currentHref =
        typeof window.location.href === 'string' ? window.location.href.trim() : '';
      const hashIndex = currentHref.indexOf('#');
      const baseHref =
        !currentHref || hashIndex === -1
          ? `${window.location.origin}${normalizedBase}`
          : currentHref.slice(0, hashIndex);
      return `${baseHref}#/chats/${encodedChatPubkey}`;
    }

    return `${window.location.origin}${normalizedBase}chats/${encodedChatPubkey}`;
  }

  function shouldSuppressIncomingMessageBrowserNotification(chatPubkey: string): boolean {
    if (isRestoringStartupState.value || !areBrowserNotificationsEnabled()) {
      return true;
    }

    return isAppForeground.value || getVisibleChatId() === chatPubkey;
  }

  function emitForegroundIncomingMessageActivity(options: {
    chatPubkey: string;
    iconUrl?: string;
    messageText: string;
    title: string;
  }): boolean {
    if (isRestoringStartupState.value || !isAppForeground.value) {
      return false;
    }

    emitForegroundMessageActivity({
      chatPubkey: options.chatPubkey,
      iconUrl: options.iconUrl,
      messageText: buildBrowserNotificationMessagePreview(options.messageText),
      title: options.title,
      showBanner: getVisibleChatId() !== options.chatPubkey,
    });
    return true;
  }

  async function shouldNotifyForAcceptedChatOnly(
    chatPubkey: string,
    chatMeta: Record<string, unknown> | null | undefined,
  ): Promise<boolean> {
    if (chatMeta?.muted === true) {
      return false;
    }

    const inboxState =
      chatMeta && typeof chatMeta.inbox_state === 'string' ? chatMeta.inbox_state.trim() : '';
    if (inboxState === 'blocked') {
      return false;
    }

    if (inboxState === 'accepted') {
      return true;
    }

    const acceptedAt =
      chatMeta && typeof chatMeta.accepted_at === 'string' ? chatMeta.accepted_at.trim() : '';
    if (acceptedAt) {
      return true;
    }

    const lastOutgoingMessageAt =
      chatMeta && typeof chatMeta.last_outgoing_message_at === 'string'
        ? chatMeta.last_outgoing_message_at.trim()
        : '';
    if (lastOutgoingMessageAt) {
      return true;
    }

    const loggedInPubkeyHex = getLoggedInPublicKeyHex();
    if (!loggedInPubkeyHex) {
      return false;
    }

    try {
      return Boolean(
        await chatDataService.findLatestMessageByAuthor(chatPubkey, loggedInPubkeyHex),
      );
    } catch (error) {
      console.warn(
        'Failed to confirm accepted-chat state for browser notification eligibility',
        error,
      );
      return false;
    }
  }

  function showIncomingMessageBrowserNotification(options: {
    chatPubkey: string;
    title: string;
    messageText: string;
    iconUrl?: string;
  }): void {
    if (typeof window === 'undefined') {
      return;
    }

    if (emitForegroundIncomingMessageActivity(options)) {
      return;
    }

    if (shouldSuppressIncomingMessageBrowserNotification(options.chatPubkey)) {
      return;
    }

    const messagePreview = buildBrowserNotificationMessagePreview(options.messageText);

    if (
      window.desktopRuntime?.isElectron &&
      typeof window.desktopRuntime.showIncomingMessageNotification === 'function'
    ) {
      try {
        window.desktopRuntime.showIncomingMessageNotification({
          chatPubkey: options.chatPubkey,
          title: options.title,
          body: messagePreview,
        });
        return;
      } catch (error) {
        console.warn('Failed to show incoming desktop notification', error);
      }
    }

    if (typeof window.Notification !== 'function') {
      return;
    }

    try {
      const notification = new window.Notification(options.title, {
        body: messagePreview,
        ...(options.iconUrl ? { icon: options.iconUrl } : {}),
      });

      notification.onclick = () => {
        notification.close();
        window.focus();

        const href = buildChatNotificationHref(options.chatPubkey);
        if (href) {
          window.location.assign(href);
        }
      };
    } catch (error) {
      console.warn('Failed to show incoming browser notification', error);
    }
  }

  return {
    buildInboundTraceDetails,
    deriveChatName,
    logInboundEvent,
    shouldNotifyForAcceptedChatOnly,
    showIncomingMessageBrowserNotification,
  };
}
