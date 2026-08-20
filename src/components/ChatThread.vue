<template>
  <div class="thread-root" @focusin="handleThreadFocusIn">
    <template v-if="chat">
      <div class="thread-header">
        <div class="thread-header__row">
          <q-btn
            v-if="showBackButton"
            flat
            dense
            round
            icon="arrow_back"
            :aria-label="$t('common.back')"
            @click="handleBack"
          />
          <div class="thread-header__identity" @click="handleOpenProfile">
            <CachedAvatar
              :src="avatarImageUrl"
              :alt="chat.name"
              :fallback="chat.avatar"
              class="thread-header__avatar"
            />
            <div class="thread-header__meta">
              <div class="thread-header__name">{{ chat.name }}</div>
              <div class="thread-header__time">{{ $t('common.lastActive', { time: headerTime }) }}</div>
            </div>
          </div>
          <q-btn
            flat
            dense
            round
            icon="search"
            data-testid="thread-search-open-button"
            :aria-label="$t('message.search.title')"
            class="thread-header__action"
            @click="handleOpenThreadSearch"
          />
          <q-btn
            flat
            dense
            round
            icon="badge"
            :aria-label="$t('profile.open.action')"
            class="thread-header__action"
            @click="handleOpenProfile"
          />
        </div>

        <ReconnectHealingBanner v-if="showReconnectHealingBanner" />
        <StartupHistoryBanner v-if="showStartupHistoryBanner" />
      </div>

      <transition name="thread-search-bar">
        <div v-if="isThreadSearchOpen" class="thread-search" :aria-busy="isThreadSearchBusy">
          <q-input
            ref="threadSearchInputRef"
            v-model="threadSearchQuery"
            data-testid="thread-search-input"
            class="nc-input thread-search__input"
            dense
            outlined
            rounded
            clearable
            clear-icon="close"
            :placeholder="$t('common.search')"
            :loading="isThreadSearchBusy"
            @keydown.enter.prevent="handleThreadSearchEnter"
          >
            <template #prepend>
              <q-icon name="search" />
            </template>
          </q-input>

          <div data-testid="thread-search-status" class="thread-search__meta">
            {{ threadSearchStatusLabel }}
          </div>

          <div class="thread-search__actions">
            <q-btn
              flat
              dense
              round
              icon="keyboard_arrow_up"
              data-testid="thread-search-prev-button"
              :aria-label="$t('common.previousSearchResult')"
              class="thread-search__action"
              :disable="!canNavigateThreadSearch"
              @click="handlePreviousThreadSearchResult"
            />
            <q-btn
              flat
              dense
              round
              icon="keyboard_arrow_down"
              data-testid="thread-search-next-button"
              :aria-label="$t('common.nextSearchResult')"
              class="thread-search__action"
              :disable="!canNavigateThreadSearch"
              @click="handleNextThreadSearchResult"
            />
            <q-btn
              flat
              dense
              round
              icon="close"
              data-testid="thread-search-close-button"
              :aria-label="$t('common.closeSearch')"
              class="thread-search__action"
              @click="handleCloseThreadSearch"
            />
          </div>
        </div>
      </transition>

      <div
        ref="threadBodyRef"
        class="thread-body"
        tabindex="-1"
        :class="{ 'thread-body--scroll-locked': isThreadScrollLocked }"
        @scroll="handleThreadScroll"
        @wheel="handleThreadWheel"
        @touchstart="handleThreadTouchStart"
        @touchmove="handleThreadTouchMove"
        @touchend="resetOlderTouchPull"
        @touchcancel="resetOlderTouchPull"
      >
        <div v-if="stickyDayLabel" class="thread-day-sticky" aria-hidden="true">
          <span class="thread-day-sticky__label">{{ stickyDayLabel }}</span>
        </div>
        <div v-if="hasOlderMessages" class="thread-more thread-more--top">
          <q-btn
            flat
            dense
            no-caps
            icon="keyboard_arrow_up"
            :label="$t('common.more')"
            class="thread-more__button"
            data-testid="thread-load-older"
            :disable="isLoadingOlderMessages"
            @mousedown.prevent
            @click="handleLoadOlderMessages"
          />
        </div>
        <template v-for="item in threadItems" :key="item.key">
          <div v-if="item.type === 'separator'" class="thread-day-separator" aria-hidden="true">
            <span class="thread-day-separator__line" />
            <span class="thread-day-separator__label">{{ item.label }}</span>
            <span class="thread-day-separator__line" />
          </div>
          <div
            v-else-if="item.type === 'epoch-separator'"
            class="thread-day-separator"
            aria-hidden="true"
          >
            <span class="thread-day-separator__line" />
            <span class="thread-day-separator__label">{{ item.label }}</span>
            <span class="thread-day-separator__line" />
          </div>
          <div
            v-else-if="item.type === 'unread-separator'"
            class="thread-unread-separator"
            tabindex="-1"
            data-unread-separator="true"
          >
            <span class="thread-unread-separator__line" />
            <span class="thread-unread-separator__label">{{ item.label }}</span>
            <span class="thread-unread-separator__line" />
          </div>
          <div
            v-else
            class="thread-message-entry"
            :class="{
              'thread-message-entry--sender-change': item.startsSenderGroup,
              'thread-message-entry--target':
                highlightedMessageId === item.message.id ||
                highlightedMessageId === item.message.eventId,
              'thread-message-entry--target-search':
                highlightedMessageKind === 'search' &&
                (highlightedMessageId === item.message.id ||
                  highlightedMessageId === item.message.eventId)
            }"
            :data-day-key="item.dayKey"
            :data-day-label="item.dayLabel"
            :data-message-id="item.message.id"
            :data-message-event-id="item.message.eventId ?? ''"
          >
            <MessageBubble
              :message="item.message"
              :contact-name="chat.name"
              :contact-relay-urls="contactRelayUrls"
              :desktop-message-layout="desktopMessageLayout"
              :author-avatar-fallback="item.authorAvatarFallback"
              :author-avatar-src="item.authorAvatarSrc"
              :author-label="item.authorLabel"
              :is-message-expanded="isMessageTextExpanded(item.message.id)"
              :mention-profiles="mentionProfiles"
              :mobile-group-layout="chat.type === 'group'"
              :reserve-telegram-author-avatar-space="item.reserveTelegramAuthorAvatarSpace"
              :show-author-name="item.startsSenderGroup"
              :show-author-on-mobile="chat?.type === 'group' && item.message.sender === 'them'"
              :show-telegram-author-avatar="item.showTelegramAuthorAvatar"
              @open-profile="handleOpenAuthorChat"
              @open-mention-chat="handleOpenMentionChat"
              @reply="handleReplyToMessage"
              @edit="handleEditMessage"
              @forward="handleForwardMessage"
              @react="handleReactToMessage"
              @delete-message="handleDeleteMessage"
              @remove-reaction="handleRemoveReaction"
              @open-reply-target="handleOpenReplyTarget"
              @update-message-expanded="handleMessageExpandedUpdate"
            />
          </div>
        </template>
        <div v-if="hasNewerMessages" class="thread-more thread-more--bottom">
          <q-btn
            flat
            dense
            no-caps
            icon-right="keyboard_arrow_down"
            :label="$t('common.more')"
            class="thread-more__button"
            :disable="isLoadingNewerMessages"
            @mousedown.prevent
            @click="handleLoadNewerMessages"
          />
        </div>
      </div>

      <div class="thread-composer-anchor">
        <transition name="thread-scroll-jump">
          <div v-if="showJumpButtons" class="thread-jump-buttons">
            <q-btn
              v-if="showReactionJumpButton"
              flat
              dense
              :aria-label="$t('message.jumpFirstNewReaction')"
              class="thread-scroll-jump thread-scroll-jump--reaction"
              @click="handleReactionJump"
            >
              <span class="thread-reaction-jump__icon-shell" aria-hidden="true">
                <q-icon name="favorite" size="14px" class="thread-reaction-jump__icon" />
              </span>
              <span class="thread-reaction-jump__count">
                {{ formatReactionCount(unseenReactionCount) }}
              </span>
            </q-btn>

            <q-btn
              v-if="showScrollJumpButton"
              flat
              dense
              round
              icon="keyboard_double_arrow_down"
              :aria-label="$t('message.jumpLatestMessages')"
              class="thread-scroll-jump"
              @click="handleScrollJump"
            />
          </div>
        </transition>

        <MessageComposer
          ref="composerRef"
          :chat-id="chat.id"
          :editing-message="activeEdit"
          :mention-profiles="mentionProfiles"
          :reply-to="activeReply"
          @send="handleSend"
          @edit="handleSubmitEdit"
          @send-media="handleSendMedia"
          @cancel-edit="handleCancelEdit"
          @cancel-reply="handleCancelReply"
        />
      </div>
    </template>

    <div v-else class="thread-empty" :class="{ 'thread-empty--loading': isInitializing }">
      <template v-if="isInitializing">
        <div class="thread-empty__progress">
          <q-linear-progress
            indeterminate
            rounded
            color="primary"
            track-color="grey-4"
          />
        </div>
        <div class="thread-empty__status">{{ $t('message.restoringChatsMessages') }}</div>
      </template>
      <template v-else>
        <div class="thread-empty__mark q-mb-md">...</div>
        <div>{{ $t('chat.selectChatStartMessaging') }}</div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import MessageBubble from 'src/components/MessageBubble.vue';
import MessageComposer from 'src/components/MessageComposer.vue';
import CachedAvatar from 'src/components/CachedAvatar.vue';
import ReconnectHealingBanner from 'src/components/ReconnectHealingBanner.vue';
import StartupHistoryBanner from 'src/components/StartupHistoryBanner.vue';
import { contactsService } from 'src/services/contactsService';
import { useChatStore } from 'src/stores/chatStore';
import { useMessageStore } from 'src/stores/messageStore';
import { useNostrStore } from 'src/stores/nostrStore';
import { useTrustedMediaStore } from 'src/stores/trustedMediaStore';
import type {
  Chat,
  Message,
  MessageAttachmentMetadata,
  MessageReaction,
  MessageReplyPreview,
} from 'src/types/chat';
import type { ContactGroupMember, ContactMetadata } from 'src/types/contact';
import { buildAvatarText } from 'src/utils/avatarText';
import { resolvePreferredContactRelayUrls } from 'src/utils/contactRelayUrls';
import { isGroupEpochNoticeMessageMeta } from 'src/utils/messageActivity';
import { buildMessageReplyPreviewContent } from 'src/utils/messageAttachments';
import {
  countUnseenReactionsForAuthor,
  normalizeMessageReactions
} from 'src/utils/messageReactions';
import { buildMentionProfiles, type NostrMentionProfile } from 'src/utils/nostrMentions';
import { formatCompactPublicKey } from 'src/utils/publicKeyText';
import {
  DESKTOP_MESSAGE_LAYOUT_CHANGED_EVENT,
  DESKTOP_MESSAGE_LAYOUT_STORAGE_KEY,
  readDesktopMessageLayoutPreference,
  type DesktopMessageLayoutPreference
} from 'src/utils/themeStorage';
import {
  getWrappedThreadSearchIndex,
  resolveThreadSearchNavigationIndex
} from 'src/utils/threadSearch';
import { reportUiError } from 'src/utils/uiErrorHandler';
import { getDateTimeLocale, t } from 'src/i18n';

const props = withDefaults(
  defineProps<{
    chat: Chat | null;
    messages: Message[];
    isInitializing?: boolean;
    showBackButton?: boolean;
    showReconnectHealingBanner?: boolean;
    showStartupHistoryBanner?: boolean;
    keyboardVisible?: boolean;
    mobileViewportHeight?: number | null;
  }>(),
  {
    isInitializing: false,
    showBackButton: false,
    showReconnectHealingBanner: false,
    showStartupHistoryBanner: false,
    keyboardVisible: false,
    mobileViewportHeight: null
  }
);

const emit = defineEmits<{
  (event: 'send', payload: { text: string; replyTo: MessageReplyPreview | null }): void;
  (event: 'edit-message', payload: { message: Message; text: string }): void;
  (
    event: 'send-media',
    payload: { attachment: MessageAttachmentMetadata; replyTo: MessageReplyPreview | null }
  ): void;
  (event: 'back'): void;
  (event: 'open-profile', publicKey: string): void;
  (
    event: 'open-chat',
    payload: {
      publicKey: string;
      displayName?: string;
      picture?: string;
      avatar?: string;
  }
  ): void;
  (event: 'react', payload: { message: Message; emoji: string }): void;
  (event: 'forward-message', message: Message): void;
  (event: 'delete-message', message: Message): void;
  (event: 'remove-reaction', payload: { message: Message; reaction: MessageReaction }): void;
}>();

const threadBodyRef = ref<HTMLElement | null>(null);
const composerRef = ref<{ focusInputAtEnd: () => void } | null>(null);
const threadSearchInputRef = ref<{ focus: () => void } | null>(null);
const stickyDayLabel = ref('');
const activeReply = ref<MessageReplyPreview | null>(null);
const activeEdit = ref<Message | null>(null);
const highlightedMessageId = ref<string | null>(null);
const highlightedMessageKind = ref<'default' | 'search' | null>(null);
const isThreadScrollLocked = ref(false);
const isAutomaticBottomScrollEnabled = ref(true);
const chatStore = useChatStore();
const messageStore = useMessageStore();
const nostrStore = useNostrStore();
const trustedMediaStore = useTrustedMediaStore();
const isThreadScrolledUp = ref(false);
const lastReadMessageId = ref<string | null>(null);
const hasJumpedToLastReadMessage = ref(false);
const pendingInitialPositionChatId = ref<string | null>(null);
const openedUnreadBoundaryAt = ref<string | null>(null);
const contactRelayUrls = ref<string[]>([]);
const groupMentionContactMeta = ref<ContactMetadata | null>(null);
const selfAvatarImageUrl = ref('');
const selfAvatarFallback = ref('YO');
const desktopMessageLayout = ref<DesktopMessageLayoutPreference>(
  readDesktopMessageLayoutPreference()
);
const isThreadSearchOpen = ref(false);
const threadSearchQuery = ref('');
const isThreadSearchBusy = ref(false);
const threadSearchMatches = ref<
  Array<{
    messageId: string;
    eventId: string | null;
    sentAt: string;
    text: string;
  }>
>([]);
const activeThreadSearchMatchIndex = ref(-1);
const authorIdentityByPublicKey = ref<
  Record<
    string,
    {
      label: string;
      avatarSrc: string;
      avatarFallback: string;
    }
  >
>({});
const expandedMessageIds = ref<Set<string>>(new Set());
let scrollFrameId: number | null = null;
let highlightTimerId: number | null = null;
let visibleReactionSyncFrameId: number | null = null;
let visibleReactionSyncPromise: Promise<void> = Promise.resolve();
let pendingSentMessageReveal = false;
let isScrollingToBottom = false;
let scrollToBottomRequestId = 0;
let threadSearchDebounceId: number | null = null;
let threadSearchRequestToken = 0;
let threadSearchNavigationToken = 0;
const pendingViewportSettleScrollTimeoutIds = new Set<number>();
let pendingPaginationContext:
  | {
      direction: 'older' | 'newer';
      previousScrollHeight: number;
      previousScrollTop: number;
      previousMessageCount: number;
      anchorMessageId: string | null;
      anchorVisibleOffset: number | null;
    }
  | null = null;
const LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY = 'last_seen_received_activity_at';
let groupMentionContactRefreshToken = 0;
let selfAuthorIdentityRefreshToken = 0;
let authorIdentityRefreshToken = 0;
const OLDER_PULL_TOP_TOLERANCE_PX = 1;
const OLDER_PULL_TOUCH_THRESHOLD_PX = 48;
const OLDER_PULL_WHEEL_THRESHOLD_PX = 36;
const OLDER_PULL_WHEEL_GESTURE_GAP_MS = 180;
let olderTouchPullStartY: number | null = null;
let olderWheelPullDistance = 0;
let olderWheelPullEligible = false;
let lastThreadWheelAt = 0;

function refreshDesktopMessageLayoutPreference(): void {
  desktopMessageLayout.value = readDesktopMessageLayoutPreference();
}

function handleDesktopMessageLayoutPreferenceChanged(event: Event): void {
  const nextLayout = (event as CustomEvent<{ layout?: unknown }>).detail?.layout;
  desktopMessageLayout.value =
    nextLayout === 'bubbles' || nextLayout === 'text'
      ? nextLayout
      : readDesktopMessageLayoutPreference();
}

function handleDesktopMessageLayoutStorage(event: StorageEvent): void {
  if (event.key === DESKTOP_MESSAGE_LAYOUT_STORAGE_KEY) {
    refreshDesktopMessageLayoutPreference();
  }
}

function logThreadScrollTrace(label: string, extra: Record<string, unknown> = {}): void {
  void label;
  void extra;
}

function readMetaString(
  meta: ContactMetadata | Record<string, unknown> | null | undefined,
  key: string
): string {
  const value = meta?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function isContactGroupMember(value: unknown): value is ContactGroupMember {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<ContactGroupMember>;
  return typeof candidate.public_key === 'string' && candidate.public_key.trim().length > 0;
}

type ThreadItem =
  | {
      type: 'separator';
      key: string;
      label: string;
    }
  | {
      type: 'epoch-separator';
      key: string;
      label: string;
    }
  | {
      type: 'unread-separator';
      key: string;
      label: string;
    }
  | {
      type: 'message';
      key: string;
      dayKey: string;
      dayLabel: string;
      authorAvatarFallback: string;
      authorAvatarSrc: string;
      authorLabel: string;
      reserveTelegramAuthorAvatarSpace: boolean;
      showTelegramAuthorAvatar: boolean;
      startsSenderGroup: boolean;
      message: Message;
    };

const headerTime = computed(() => {
  if (!props.chat) {
    return '';
  }

  return new Intl.DateTimeFormat(getDateTimeLocale(), {
    hour: 'numeric',
    minute: '2-digit',
    month: 'short',
    day: 'numeric'
  }).format(new Date(props.chat.lastMessageAt));
});

const avatarImageUrl = computed(() => {
  if (!props.chat) {
    return '';
  }

  const picture = props.chat.meta.picture;
  if (typeof picture === 'string' && picture.trim()) {
    return picture.trim();
  }

  return '';
});

const contactAuthorLabel = computed(() => {
  return props.chat?.name?.trim() || t('contacts.contact.label');
});

const contactAvatarFallback = computed(() => {
  return props.chat?.avatar?.trim() || buildAvatarText(contactAuthorLabel.value);
});

const loggedInPublicKey = computed(() => {
  return nostrStore.getLoggedInPublicKeyHex()?.trim().toLowerCase() ?? '';
});

function readGroupMentionMembers(
  meta: ContactMetadata | Record<string, unknown>
): ContactGroupMember[] {
  const groupMembers = meta.group_members;
  return Array.isArray(groupMembers) ? groupMembers.filter(isContactGroupMember) : [];
}

function readGroupMentionOwnerPublicKey(
  meta: ContactMetadata | Record<string, unknown>
): string {
  return typeof meta.owner_public_key === 'string'
    ? meta.owner_public_key.trim().toLowerCase()
    : '';
}

const mentionProfiles = computed<NostrMentionProfile[]>(() => {
  if (props.chat?.type !== 'group') {
    return [];
  }

  const contactMeta = groupMentionContactMeta.value;
  const chatGroupMembers = readGroupMentionMembers(props.chat.meta);
  const contactGroupMembers = contactMeta ? readGroupMentionMembers(contactMeta) : [];
  const groupMembers = contactGroupMembers.length > 0 ? contactGroupMembers : chatGroupMembers;
  const ownerPublicKey =
    (contactMeta ? readGroupMentionOwnerPublicKey(contactMeta) : '') ||
    readGroupMentionOwnerPublicKey(props.chat.meta);
  const ownerIdentity = ownerPublicKey
    ? authorIdentityByPublicKey.value[ownerPublicKey] ?? null
    : null;
  const ownerDisplayName =
    ownerPublicKey === loggedInPublicKey.value
      ? t('common.you')
      : ownerIdentity?.label || formatCompactPublicKey(ownerPublicKey);

  return buildMentionProfiles([
    ...groupMembers.map((member) => ({
      publicKey: member.public_key,
      displayName: member.given_name?.trim() || member.name.trim() || member.public_key,
      picture: member.picture ?? null,
      avatar: member.avatar ?? null,
      nprofile: member.nprofile ?? null,
    })),
    ...(ownerPublicKey
      ? [
          {
            publicKey: ownerPublicKey,
            displayName: ownerDisplayName,
            picture:
              ownerPublicKey === loggedInPublicKey.value
                ? selfAvatarImageUrl.value
                : ownerIdentity?.avatarSrc ?? null,
            avatar:
              ownerPublicKey === loggedInPublicKey.value
                ? selfAvatarFallback.value
                : ownerIdentity?.avatarFallback ?? null,
          },
        ]
      : []),
  ]);
});

const latestMessageId = computed(() => {
  return props.messages[props.messages.length - 1]?.id ?? null;
});

const currentPaginationState = computed(() => {
  return messageStore.getPaginationState(props.chat?.id ?? null);
});

const hasOlderMessages = computed(() => currentPaginationState.value.hasOlder);
const hasNewerMessages = computed(() => currentPaginationState.value.hasNewer);
const isLoadingOlderMessages = computed(() => currentPaginationState.value.isLoadingOlder);
const isLoadingNewerMessages = computed(() => currentPaginationState.value.isLoadingNewer);
const canNavigateThreadSearch = computed(() => {
  return !isThreadSearchBusy.value && threadSearchMatches.value.length > 0;
});
const isChatActuallyVisible = computed(() => {
  const currentChatId = props.chat?.id ?? null;
  return Boolean(currentChatId && chatStore.visibleChatId === currentChatId);
});
const threadSearchStatusLabel = computed(() => {
  const normalizedQuery = threadSearchQuery.value.trim();
  if (!normalizedQuery) {
    return t('message.search.placeholder');
  }

  if (isThreadSearchBusy.value) {
    return t('common.searching');
  }

  if (threadSearchMatches.value.length === 0) {
    return t('common.matches');
  }

  const activeIndex = Math.max(0, activeThreadSearchMatchIndex.value);
  return `${activeIndex + 1} of ${threadSearchMatches.value.length}`;
});

const showScrollJumpButton = computed(() => {
  return Boolean(
    props.chat &&
      props.messages.length > 0 &&
      (isThreadScrolledUp.value || hasNewerMessages.value)
  );
});

const unseenReactionMessages = computed(() => {
  return props.messages.filter((message) => {
    if (message.sender !== 'me') {
      return false;
    }

    return (
      countUnseenReactionsForAuthor(
        normalizeMessageReactions(message.meta.reactions),
        message.authorPublicKey
      ) > 0
    );
  });
});

const unseenReactionCount = computed(() => {
  return unseenReactionMessages.value.reduce((count, message) => {
    return (
      count +
      countUnseenReactionsForAuthor(
        normalizeMessageReactions(message.meta.reactions),
        message.authorPublicKey
      )
    );
  }, 0);
});

function formatReactionCount(value: number): string {
  return value > 99 ? '99+' : String(value);
}

const showReactionJumpButton = computed(() => unseenReactionCount.value > 0);

const showJumpButtons = computed(() => {
  return showReactionJumpButton.value || showScrollJumpButton.value;
});

const reactionVisibilitySignature = computed(() => {
  return props.messages
    .map((message) => {
      const unseenReactionCountForMessage =
        message.sender === 'me'
          ? countUnseenReactionsForAuthor(
              normalizeMessageReactions(message.meta.reactions),
              message.authorPublicKey
            )
          : 0;
      return `${message.id}:${unseenReactionCountForMessage}`;
    })
    .join('|');
});

const authorIdentitySignature = computed(() => {
  return props.messages
    .map((message) => message.authorPublicKey.trim().toLowerCase())
    .filter(Boolean)
    .join('|');
});

const messageIdSignature = computed(() => props.messages.map((message) => message.id).join('|'));

function isMessageTextExpanded(messageId: string): boolean {
  return expandedMessageIds.value.has(messageId);
}

function handleMessageExpandedUpdate(payload: { message: Message; expanded: boolean }): void {
  const messageId = payload.message.id;
  if (!messageId) {
    return;
  }

  const nextExpandedMessageIds = new Set(expandedMessageIds.value);
  if (payload.expanded) {
    nextExpandedMessageIds.add(messageId);
  } else {
    nextExpandedMessageIds.delete(messageId);
  }
  expandedMessageIds.value = nextExpandedMessageIds;
}

function pruneExpandedMessageIds(): void {
  if (expandedMessageIds.value.size === 0) {
    return;
  }

  const visibleMessageIds = new Set(props.messages.map((message) => message.id));
  const nextExpandedMessageIds = new Set(
    Array.from(expandedMessageIds.value).filter((messageId) => visibleMessageIds.has(messageId))
  );

  if (nextExpandedMessageIds.size !== expandedMessageIds.value.size) {
    expandedMessageIds.value = nextExpandedMessageIds;
  }
}

function toComparableTimestamp(value: string | null | undefined): number {
  if (typeof value !== 'string' || !value.trim()) {
    return 0;
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function readCurrentLastSeenReceivedActivityAt(): string {
  const rawValue = props.chat?.meta?.[LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY];
  return typeof rawValue === 'string' ? rawValue.trim() : '';
}

function getIncomingMessageTimestampAfter(message: Message, afterTimestamp: string): number | null {
  const afterComparableTimestamp = toComparableTimestamp(afterTimestamp);
  if (message.sender !== 'them' || isGroupEpochNoticeMessageMeta(message.meta)) {
    return null;
  }

  const messageTimestamp = toComparableTimestamp(message.sentAt);
  return messageTimestamp > afterComparableTimestamp ? messageTimestamp : null;
}

const firstMessageAfterUnreadBoundaryId = computed(() => {
  const openedUnreadBoundaryTimestamp = openedUnreadBoundaryAt.value;
  const currentLastSeenReceivedActivityAt = readCurrentLastSeenReceivedActivityAt();
  const afterTimestamp =
    toComparableTimestamp(currentLastSeenReceivedActivityAt) >
      toComparableTimestamp(openedUnreadBoundaryTimestamp)
      ? currentLastSeenReceivedActivityAt
      : openedUnreadBoundaryTimestamp;
  if (!afterTimestamp || props.messages.length === 0) {
    return null;
  }

  let firstMatch: {
    messageId: string;
    activityTimestamp: number;
    index: number;
  } | null = null;

  props.messages.forEach((message, index) => {
    const activityTimestamp = getIncomingMessageTimestampAfter(message, afterTimestamp);
    if (activityTimestamp === null) {
      return;
    }

    if (
      !firstMatch ||
      activityTimestamp < firstMatch.activityTimestamp ||
      (activityTimestamp === firstMatch.activityTimestamp && index < firstMatch.index)
    ) {
      firstMatch = {
        messageId: message.id,
        activityTimestamp,
        index
      };
    }
  });

  return firstMatch?.messageId ?? null;
});

function getDayKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDayLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const isCurrentYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(getDateTimeLocale(), {
    day: '2-digit',
    month: 'long',
    ...(isCurrentYear ? {} : { year: 'numeric' })
  }).format(date);
}

function readGroupEpochNoticeNumber(message: Message): number | null {
  const rawValue = message.meta.group_epoch_notice;
  if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
    return null;
  }

  const epochNumber = 'epochNumber' in rawValue ? Number(rawValue.epochNumber) : Number.NaN;
  if (!Number.isInteger(epochNumber) || epochNumber < 0) {
    return null;
  }

  return Math.floor(epochNumber);
}

const threadItems = computed<ThreadItem[]>(() => {
  const items: ThreadItem[] = [];
  let lastDayKey = '';
  const unreadBoundaryMessageId = firstMessageAfterUnreadBoundaryId.value;

  for (const [index, message] of props.messages.entries()) {
    const previousMessage = index > 0 ? props.messages[index - 1] : null;
    const nextMessage = props.messages[index + 1] ?? null;
    const dayKey = getDayKey(message.sentAt);
    const dayLabel = formatDayLabel(message.sentAt);
    if (dayKey !== lastDayKey) {
      items.push({
        type: 'separator',
        key: `separator-${dayKey}`,
        label: dayLabel
      });
      lastDayKey = dayKey;
    }

    if (unreadBoundaryMessageId && message.id === unreadBoundaryMessageId) {
      items.push({
        type: 'unread-separator',
        key: `unread-separator-${message.id}`,
        label: t('relays.unreadMessages')
      });
    }

    const epochNoticeNumber = readGroupEpochNoticeNumber(message);
    if (epochNoticeNumber !== null) {
      items.push({
        type: 'epoch-separator',
        key: `epoch-separator-${message.id}`,
        label: t('group.epoch.numberLabel', { number: epochNoticeNumber })
      });
      continue;
    }

    const authorIdentity = resolveMessageAuthorIdentity(message);
    const currentAuthorKey = message.authorPublicKey.trim().toLowerCase();
    const previousAuthorKey = previousMessage?.authorPublicKey?.trim().toLowerCase() ?? '';
    const startsSenderGroup =
      previousMessage?.sender !== message.sender ||
      (props.chat?.type === 'group' &&
        message.sender === 'them' &&
        currentAuthorKey !== previousAuthorKey);
    const nextAuthorKey = nextMessage?.authorPublicKey?.trim().toLowerCase() ?? '';
    const reserveTelegramAuthorAvatarSpace = true;
    const continuesSenderGroup = Boolean(
      nextMessage &&
        nextMessage.sender === message.sender &&
        readGroupEpochNoticeNumber(nextMessage) === null &&
        (!unreadBoundaryMessageId || nextMessage.id !== unreadBoundaryMessageId) &&
        getDayKey(nextMessage.sentAt) === dayKey &&
        nextAuthorKey === currentAuthorKey
    );

    items.push({
      type: 'message',
      key: message.id,
      dayKey,
      dayLabel,
      authorAvatarFallback: authorIdentity.avatarFallback,
      authorAvatarSrc: authorIdentity.avatarSrc,
      authorLabel: authorIdentity.label,
      reserveTelegramAuthorAvatarSpace,
      showTelegramAuthorAvatar: reserveTelegramAuthorAvatarSpace && !continuesSenderGroup,
      startsSenderGroup,
      message
    });
  }

  return items;
});

let contactRelayRefreshToken = 0;

async function refreshContactRelayUrls(chatPublicKey: string | null): Promise<void> {
  const refreshToken = ++contactRelayRefreshToken;
  if (!chatPublicKey) {
    contactRelayUrls.value = [];
    return;
  }

  try {
    await contactsService.init();
    const contact = await contactsService.getContactByPublicKey(chatPublicKey);
    if (refreshToken !== contactRelayRefreshToken) {
      return;
    }

    contactRelayUrls.value = resolvePreferredContactRelayUrls(contact?.relays);
  } catch (error) {
    if (refreshToken !== contactRelayRefreshToken) {
      return;
    }

    contactRelayUrls.value = [];
    console.error('Failed to load contact relay urls for chat thread', chatPublicKey, error);
  }
}

async function refreshGroupMentionContactMeta(chat: Chat | null): Promise<void> {
  const refreshToken = ++groupMentionContactRefreshToken;
  if (!chat || chat.type !== 'group') {
    groupMentionContactMeta.value = null;
    return;
  }

  try {
    await contactsService.init();
    const contact = await contactsService.getContactByPublicKey(chat.publicKey);
    if (refreshToken !== groupMentionContactRefreshToken) {
      return;
    }

    groupMentionContactMeta.value = contact?.type === 'group' ? contact.meta : null;
  } catch (error) {
    if (refreshToken !== groupMentionContactRefreshToken) {
      return;
    }

    groupMentionContactMeta.value = null;
    console.error('Failed to load group mention members for chat thread', chat.publicKey, error);
  }
}

async function refreshSelfAuthorIdentity(loggedInPublicKeyValue: string | null): Promise<void> {
  const refreshToken = ++selfAuthorIdentityRefreshToken;
  if (!loggedInPublicKeyValue) {
    selfAvatarImageUrl.value = '';
    selfAvatarFallback.value = buildAvatarText(t('common.you'));
    return;
  }

  try {
    await contactsService.init();
    const loggedInContact = await contactsService.getContactByPublicKey(loggedInPublicKeyValue);
    if (refreshToken !== selfAuthorIdentityRefreshToken) {
      return;
    }

    const meta =
      loggedInContact?.meta && typeof loggedInContact.meta === 'object'
        ? loggedInContact.meta
        : null;
    const preferredName =
      readMetaString(meta, 'display_name') ||
      readMetaString(meta, 'name') ||
      loggedInContact?.name?.trim() ||
      loggedInContact?.given_name?.trim() ||
      t('common.you');

    selfAvatarImageUrl.value = readMetaString(meta, 'picture');
    selfAvatarFallback.value = readMetaString(meta, 'avatar') || buildAvatarText(preferredName);
  } catch (error) {
    if (refreshToken !== selfAuthorIdentityRefreshToken) {
      return;
    }

    selfAvatarImageUrl.value = '';
    selfAvatarFallback.value = buildAvatarText(t('common.you'));
    console.error(
      'Failed to load logged-in user avatar for chat thread',
      loggedInPublicKeyValue,
      error
    );
  }
}

function resolveMessageAuthorIdentity(message: Message): {
  label: string;
  avatarSrc: string;
  avatarFallback: string;
} {
  if (message.sender === 'me') {
    return {
      label: t('common.you'),
      avatarSrc: selfAvatarImageUrl.value,
      avatarFallback: selfAvatarFallback.value
    };
  }

  const normalizedAuthorPublicKey = message.authorPublicKey.trim().toLowerCase();
  const authorIdentity = authorIdentityByPublicKey.value[normalizedAuthorPublicKey];
  if (authorIdentity) {
    return authorIdentity;
  }

  return {
    label: contactAuthorLabel.value,
    avatarSrc: avatarImageUrl.value,
    avatarFallback: contactAvatarFallback.value
  };
}

async function refreshMessageAuthorIdentities(): Promise<void> {
  const refreshToken = ++authorIdentityRefreshToken;
  const loggedInPublicKeyValue = loggedInPublicKey.value;
  const authorPubkeys = Array.from(
    new Set(
      props.messages
        .map((message) => message.authorPublicKey.trim().toLowerCase())
        .filter(Boolean)
        .filter((pubkey) => pubkey !== loggedInPublicKeyValue)
    )
  );

  if (authorPubkeys.length === 0) {
    authorIdentityByPublicKey.value = {};
    return;
  }

  try {
    await contactsService.init();
    const entries = await Promise.all(
      authorPubkeys.map(async (authorPublicKey) => {
        const existingContact = await contactsService.getContactByPublicKey(authorPublicKey);
        const preview =
          existingContact ??
          (await nostrStore.fetchContactPreviewByPublicKey(
            authorPublicKey,
            formatCompactPublicKey(authorPublicKey)
          ));
        const meta =
          preview?.meta && typeof preview.meta === 'object'
            ? preview.meta
            : null;
        const label =
          readMetaString(meta, 'display_name') ||
          readMetaString(meta, 'name') ||
          preview?.name?.trim() ||
          preview?.given_name?.trim() ||
          formatCompactPublicKey(authorPublicKey);

        return [
          authorPublicKey,
          {
            label,
            avatarSrc: readMetaString(meta, 'picture'),
            avatarFallback: readMetaString(meta, 'avatar') || buildAvatarText(label)
          }
        ] as const;
      })
    );

    if (refreshToken !== authorIdentityRefreshToken) {
      return;
    }

    authorIdentityByPublicKey.value = Object.fromEntries(entries);
  } catch (error) {
    if (refreshToken !== authorIdentityRefreshToken) {
      return;
    }

    console.error('Failed to load message author identities for chat thread', error);
    authorIdentityByPublicKey.value = Object.fromEntries(
      authorPubkeys.map((authorPublicKey) => [
        authorPublicKey,
        {
          label: formatCompactPublicKey(authorPublicKey),
          avatarSrc: '',
          avatarFallback: buildAvatarText(formatCompactPublicKey(authorPublicKey))
        }
      ])
    );
  }
}

function cancelPendingScrollToBottom(): void {
  scrollToBottomRequestId += 1;
  isScrollingToBottom = false;
}

function clearPendingViewportSettleScrolls(): void {
  pendingViewportSettleScrollTimeoutIds.forEach((timeoutId) => {
    window.clearTimeout(timeoutId);
  });
  pendingViewportSettleScrollTimeoutIds.clear();
}

function scheduleViewportSettleScrollToBottom(): void {
  if (typeof window === 'undefined' || !props.chat || !isAutomaticBottomScrollEnabled.value) {
    return;
  }

  clearPendingViewportSettleScrolls();

  [80, 220, 420].forEach((delay) => {
    const timeoutId = window.setTimeout(() => {
      pendingViewportSettleScrollTimeoutIds.delete(timeoutId);
      void scrollToBottom('auto');
    }, delay);
    pendingViewportSettleScrollTimeoutIds.add(timeoutId);
  });
}

function cancelPendingAutomaticThreadPosition(): void {
  pendingInitialPositionChatId.value = null;
  cancelPendingScrollToBottom();
}

function setAutomaticBottomScrollEnabled(enabled: boolean): void {
  isAutomaticBottomScrollEnabled.value = enabled;
}

function shouldPinMobileThreadToAbsoluteBottom(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.matchMedia('(max-width: 1023px)').matches;
}

async function scrollToBottom(mode: 'auto' | 'explicit' = 'auto'): Promise<void> {
  logThreadScrollTrace('SCROLL_TO_BOTTOM_CALL', { mode });

  if (mode === 'auto' && !isAutomaticBottomScrollEnabled.value) {
    logThreadScrollTrace('SCROLL_TO_BOTTOM_SKIPPED_AUTO_DISABLED', { mode });
    return;
  }

  if (isScrollingToBottom) {
    logThreadScrollTrace('SCROLL_TO_BOTTOM_SKIPPED_ALREADY_RUNNING', { mode });
    return;
  }

  if (mode === 'explicit') {
    setAutomaticBottomScrollEnabled(true);
  }

  logThreadScrollTrace('SCROLL_TO_BOTTOM_BEGIN', { mode });
  isScrollingToBottom = true;
  const requestId = ++scrollToBottomRequestId;
  try {
    await loadAllNewerMessagesForCurrentChat(requestId);
    if (requestId !== scrollToBottomRequestId) {
      return;
    }

    await nextTick();
    if (requestId !== scrollToBottomRequestId) {
      return;
    }

    const revealLatestMessage = (): void => {
      if (requestId !== scrollToBottomRequestId) {
        return;
      }

      const threadBody = threadBodyRef.value;
      if (!threadBody) {
        return;
      }

      if (shouldPinMobileThreadToAbsoluteBottom()) {
        threadBody.scrollTop = Math.max(0, threadBody.scrollHeight - threadBody.clientHeight);
        return;
      }

      const latestMessage = latestMessageId.value;
      const latestEntry = latestMessage ? findThreadMessageEntry(latestMessage) : null;
      if (latestEntry) {
        const latestEntryTop = latestEntry.offsetTop;
        const latestEntryHeight = latestEntry.offsetHeight;
        const targetScrollTop = Math.max(
          0,
          latestEntryTop + latestEntryHeight - threadBody.clientHeight + 16
        );
        threadBody.scrollTop = targetScrollTop;
        return;
      }

      threadBody.scrollTop = threadBody.scrollHeight;
    };

    revealLatestMessage();
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => {
        revealLatestMessage();
        resolve();
      });
    });
    if (requestId !== scrollToBottomRequestId) {
      logThreadScrollTrace('SCROLL_TO_BOTTOM_ABORTED_REQUEST_CHANGED', { mode, requestId });
      return;
    }

    logThreadScrollTrace('SCROLL_TO_BOTTOM_APPLIED', { mode, requestId });
    isThreadScrolledUp.value = false;
    lastReadMessageId.value = latestMessageId.value;
    hasJumpedToLastReadMessage.value = false;
    updateStickyDayLabel();
    scheduleVisibleReactionViewSync();
  } finally {
    if (requestId === scrollToBottomRequestId) {
      isScrollingToBottom = false;
    }

    logThreadScrollTrace('SCROLL_TO_BOTTOM_FINALLY', {
      mode,
      requestId,
      currentRequestId: scrollToBottomRequestId
    });
  }
}

async function loadAllNewerMessagesForCurrentChat(requestId?: number): Promise<void> {
  const currentChatId = props.chat?.id ?? null;
  if (!currentChatId) {
    return;
  }

  let iterationCount = 0;
  while (messageStore.getPaginationState(currentChatId).hasNewer && iterationCount < 100) {
    if (requestId && requestId !== scrollToBottomRequestId) {
      return;
    }

    iterationCount += 1;
    await messageStore.loadNewerMessages(currentChatId);
  }
}

function isThreadNearBottom(): boolean {
  const threadBody = threadBodyRef.value;
  if (!threadBody) {
    return true;
  }

  return threadBody.scrollHeight - (threadBody.scrollTop + threadBody.clientHeight) <= 72;
}

function updateScrollJumpState(): void {
  const latestMessage = latestMessageId.value;
  if (!latestMessage) {
    isThreadScrolledUp.value = false;
    lastReadMessageId.value = null;
    hasJumpedToLastReadMessage.value = false;
    return;
  }

  if (isThreadNearBottom()) {
    setAutomaticBottomScrollEnabled(true);
    isThreadScrolledUp.value = false;
    lastReadMessageId.value = latestMessage;
    hasJumpedToLastReadMessage.value = false;
    return;
  }

  if (!isThreadScrolledUp.value) {
    lastReadMessageId.value = latestMessage;
    hasJumpedToLastReadMessage.value = false;
  }

  isThreadScrolledUp.value = true;
}

function updateStickyDayLabel(): void {
  const threadBody = threadBodyRef.value;
  if (!threadBody) {
    stickyDayLabel.value = '';
    return;
  }

  const threadRect = threadBody.getBoundingClientRect();
  const messageEntries = threadBody.querySelectorAll<HTMLElement>('.thread-message-entry');

  for (const entry of messageEntries) {
    const rect = entry.getBoundingClientRect();
    if (rect.bottom > threadRect.top) {
      stickyDayLabel.value = entry.dataset.dayLabel?.trim() ?? '';
      return;
    }
  }

  stickyDayLabel.value =
    messageEntries[messageEntries.length - 1]?.dataset.dayLabel?.trim() ?? '';
}

function getEntryVisibleOffsetWithinThread(entry: HTMLElement): number | null {
  const threadBody = threadBodyRef.value;
  if (!threadBody) {
    return null;
  }

  return entry.offsetTop - threadBody.scrollTop;
}

function setThreadScrollLocked(locked: boolean): void {
  isThreadScrollLocked.value = locked;
}

function blurThreadMoreTrigger(): void {
  if (typeof document === 'undefined') {
    return;
  }

  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) {
    return;
  }

  if (activeElement.closest('.thread-more')) {
    activeElement.blur();
  }
}

function focusThreadBodyWithoutScroll(): void {
  const threadBody = threadBodyRef.value;
  if (!threadBody) {
    return;
  }

  threadBody.focus({ preventScroll: true });
}

function canPullToLoadOlderMessages(): boolean {
  return Boolean(
    hasOlderMessages.value &&
      !isLoadingOlderMessages.value &&
      pendingPaginationContext === null
  );
}

function resetOlderWheelPull(): void {
  olderWheelPullDistance = 0;
  olderWheelPullEligible = false;
}

function resetOlderTouchPull(): void {
  olderTouchPullStartY = null;
}

function resetOlderPullGestures(): void {
  resetOlderWheelPull();
  resetOlderTouchPull();
  lastThreadWheelAt = 0;
}

function handleThreadWheel(event: WheelEvent): void {
  if (isThreadScrollLocked.value) {
    event.preventDefault();
    return;
  }

  const threadBody = threadBodyRef.value;
  if (!threadBody) {
    resetOlderWheelPull();
    return;
  }

  const eventTime = event.timeStamp;
  const startsNewGesture =
    lastThreadWheelAt === 0 ||
    eventTime < lastThreadWheelAt ||
    eventTime - lastThreadWheelAt > OLDER_PULL_WHEEL_GESTURE_GAP_MS;
  lastThreadWheelAt = eventTime;

  if (startsNewGesture) {
    olderWheelPullEligible =
      event.deltaY < 0 &&
      threadBody.scrollTop <= OLDER_PULL_TOP_TOLERANCE_PX &&
      canPullToLoadOlderMessages();
    olderWheelPullDistance = 0;
  }

  if (
    !olderWheelPullEligible ||
    event.deltaY >= 0 ||
    threadBody.scrollTop > OLDER_PULL_TOP_TOLERANCE_PX ||
    !canPullToLoadOlderMessages()
  ) {
    if (event.deltaY >= 0 || threadBody.scrollTop > OLDER_PULL_TOP_TOLERANCE_PX) {
      resetOlderWheelPull();
    }
    return;
  }

  olderWheelPullDistance += Math.abs(event.deltaY);
  if (olderWheelPullDistance < OLDER_PULL_WHEEL_THRESHOLD_PX) {
    return;
  }

  event.preventDefault();
  resetOlderWheelPull();
  void loadOlderMessagesForCurrentChat();
}

function handleThreadTouchStart(event: TouchEvent): void {
  resetOlderTouchPull();

  const threadBody = threadBodyRef.value;
  const touch = event.touches[0];
  if (
    !threadBody ||
    !touch ||
    threadBody.scrollTop > OLDER_PULL_TOP_TOLERANCE_PX ||
    !canPullToLoadOlderMessages()
  ) {
    return;
  }

  olderTouchPullStartY = touch.clientY;
}

function handleThreadTouchMove(event: TouchEvent): void {
  if (isThreadScrollLocked.value) {
    event.preventDefault();
    return;
  }

  const threadBody = threadBodyRef.value;
  const touch = event.touches[0];
  if (!threadBody || !touch || olderTouchPullStartY === null) {
    return;
  }

  if (
    threadBody.scrollTop > OLDER_PULL_TOP_TOLERANCE_PX ||
    !canPullToLoadOlderMessages()
  ) {
    resetOlderTouchPull();
    return;
  }

  const pullDistance = touch.clientY - olderTouchPullStartY;
  if (pullDistance < OLDER_PULL_TOUCH_THRESHOLD_PX) {
    return;
  }

  event.preventDefault();
  resetOlderTouchPull();
  void loadOlderMessagesForCurrentChat();
}

function handleThreadScroll(): void {
  if (isThreadScrollLocked.value && pendingPaginationContext) {
    const threadBody = threadBodyRef.value;
    if (!threadBody) {
      return;
    }

    if (pendingPaginationContext.direction === 'older') {
      const anchorEntry = pendingPaginationContext.anchorMessageId
        ? findThreadMessageEntry(pendingPaginationContext.anchorMessageId)
        : null;
      if (anchorEntry && pendingPaginationContext.anchorVisibleOffset !== null) {
        const lockedScrollTop =
          anchorEntry.offsetTop - pendingPaginationContext.anchorVisibleOffset;
        if (threadBody.scrollTop !== lockedScrollTop) {
          threadBody.scrollTop = lockedScrollTop;
        }
      }
    } else if (threadBody.scrollTop !== pendingPaginationContext.previousScrollTop) {
      threadBody.scrollTop = pendingPaginationContext.previousScrollTop;
    }

    return;
  }

  if (scrollFrameId !== null) {
    cancelAnimationFrame(scrollFrameId);
  }

  scrollFrameId = window.requestAnimationFrame(() => {
    scrollFrameId = null;
    if ((threadBodyRef.value?.scrollTop ?? 0) > OLDER_PULL_TOP_TOLERANCE_PX) {
      resetOlderWheelPull();
      resetOlderTouchPull();
    }
    updateStickyDayLabel();
    updateScrollJumpState();
    scheduleVisibleReactionViewSync();
  });
}

function handleLoadOlderMessages(): void {
  void loadOlderMessagesForCurrentChat();
}

function handleLoadNewerMessages(): void {
  void loadNewerMessagesForCurrentChat();
}

async function loadOlderMessagesForCurrentChat(): Promise<void> {
  const threadBody = threadBodyRef.value;
  const currentChatId = props.chat?.id ?? null;
  if (
    !threadBody ||
    !currentChatId ||
    pendingPaginationContext !== null ||
    isLoadingOlderMessages.value ||
    !hasOlderMessages.value
  ) {
    return;
  }

  resetOlderPullGestures();
  blurThreadMoreTrigger();
  focusThreadBodyWithoutScroll();
  logThreadScrollTrace('MORE_OLDER_CLICK', {
    oldestMessageId: props.messages[0]?.id ?? null
  });
  setAutomaticBottomScrollEnabled(false);
  cancelPendingAutomaticThreadPosition();

  const lastOldMessageId = props.messages[0]?.id ?? null;
  const lastOldMessageEntry = lastOldMessageId
    ? findThreadMessageEntry(lastOldMessageId)
    : null;
  pendingPaginationContext = {
    direction: 'older',
    previousScrollHeight: threadBody.scrollHeight,
    previousScrollTop: threadBody.scrollTop,
    previousMessageCount: props.messages.length,
    anchorMessageId: lastOldMessageId,
    anchorVisibleOffset: lastOldMessageEntry
      ? getEntryVisibleOffsetWithinThread(lastOldMessageEntry)
      : null
  };
  setThreadScrollLocked(true);

  try {
    await messageStore.loadOlderMessages(currentChatId);
  } catch (error) {
    pendingPaginationContext = null;
    setThreadScrollLocked(false);
    reportUiError('Failed to load older chat messages', error);
    return;
  }

  try {
    await nextTick();

    if (
      pendingPaginationContext &&
      pendingPaginationContext.direction === 'older' &&
      props.messages.length !== pendingPaginationContext.previousMessageCount
    ) {
      const anchorEntry = pendingPaginationContext.anchorMessageId
        ? findThreadMessageEntry(pendingPaginationContext.anchorMessageId)
        : null;

      if (anchorEntry && pendingPaginationContext.anchorVisibleOffset !== null) {
        threadBody.scrollTop =
          anchorEntry.offsetTop - pendingPaginationContext.anchorVisibleOffset;
      } else {
        const addedHeight = threadBody.scrollHeight - pendingPaginationContext.previousScrollHeight;
        threadBody.scrollTop = pendingPaginationContext.previousScrollTop + Math.max(0, addedHeight);
      }

      updateStickyDayLabel();
      updateScrollJumpState();
      scheduleVisibleReactionViewSync();
    }
  } finally {
    pendingPaginationContext = null;
    setThreadScrollLocked(false);
  }
}

async function loadNewerMessagesForCurrentChat(): Promise<void> {
  const threadBody = threadBodyRef.value;
  const currentChatId = props.chat?.id ?? null;
  if (
    !threadBody ||
    !currentChatId ||
    pendingPaginationContext !== null ||
    isLoadingNewerMessages.value ||
    !hasNewerMessages.value
  ) {
    return;
  }

  blurThreadMoreTrigger();
  focusThreadBodyWithoutScroll();
  logThreadScrollTrace('MORE_NEWER_CLICK', {
    newestMessageId: props.messages[props.messages.length - 1]?.id ?? null
  });
  setAutomaticBottomScrollEnabled(false);
  cancelPendingAutomaticThreadPosition();

  pendingPaginationContext = {
    direction: 'newer',
    previousScrollHeight: threadBody.scrollHeight,
    previousScrollTop: threadBody.scrollTop,
    previousMessageCount: props.messages.length,
    anchorMessageId: null,
    anchorVisibleOffset: null
  };
  setThreadScrollLocked(true);

  try {
    await messageStore.loadNewerMessages(currentChatId);
  } catch (error) {
    pendingPaginationContext = null;
    setThreadScrollLocked(false);
    reportUiError('Failed to load newer chat messages', error);
    return;
  }

  try {
    await nextTick();

    if (
      pendingPaginationContext &&
      pendingPaginationContext.direction === 'newer' &&
      props.messages.length !== pendingPaginationContext.previousMessageCount
    ) {
      threadBody.scrollTop = pendingPaginationContext.previousScrollTop;
      updateStickyDayLabel();
      updateScrollJumpState();
      scheduleVisibleReactionViewSync();
    }
  } finally {
    pendingPaginationContext = null;
    setThreadScrollLocked(false);
  }
}

function handleBack(): void {
  try {
    emit('back');
  } catch (error) {
    reportUiError('Failed to go back from chat thread', error);
  }
}

function handleSend(payload: { text: string }): void {
  try {
    pendingSentMessageReveal = true;
    emit('send', {
      text: payload.text,
      replyTo: activeReply.value
    });
    activeReply.value = null;
  } catch (error) {
    reportUiError('Failed to emit chat thread send event', error);
  }
}

function handleSendMedia(payload: { attachment: MessageAttachmentMetadata }): void {
  try {
    pendingSentMessageReveal = true;
    emit('send-media', {
      attachment: payload.attachment,
      replyTo: activeReply.value,
    });
    activeReply.value = null;
  } catch (error) {
    reportUiError('Failed to emit chat thread media send event', error);
  }
}

function handleReplyToMessage(message: Message): void {
  try {
    activeEdit.value = null;
    const authorIdentity = resolveMessageAuthorIdentity(message);
    const replyContent = buildMessageReplyPreviewContent(message.text, message.meta);
    const canShowReplyImage =
      message.sender === 'me' ||
      trustedMediaStore.isImageSenderTrusted(
        message.authorPublicKey,
        loggedInPublicKey.value
      );
    activeReply.value = {
      messageId: message.id,
      text: replyContent.text,
      ...(canShowReplyImage && replyContent.imageUrl
        ? { imageUrl: replyContent.imageUrl }
        : {}),
      sender: message.sender,
      authorName: authorIdentity.label,
      authorPublicKey: message.authorPublicKey,
      sentAt: message.sentAt,
      eventId: message.eventId
    };
    queueComposerFocus();
  } catch (error) {
    reportUiError('Failed to prepare reply target', error);
  }
}

function handleEditMessage(message: Message): void {
  activeReply.value = null;
  activeEdit.value = message;
  queueComposerFocus();
}

function handleSubmitEdit(payload: { text: string }): void {
  const message = activeEdit.value;
  if (!message) {
    return;
  }

  emit('edit-message', {
    message,
    text: payload.text,
  });
  activeEdit.value = null;
}

function handleForwardMessage(message: Message): void {
  try {
    emit('forward-message', message);
  } catch (error) {
    reportUiError('Failed to emit message forwarding', error);
  }
}

function queueComposerFocus(): void {
  void nextTick(() => {
    window.setTimeout(() => {
      composerRef.value?.focusInputAtEnd();
    }, 0);
  });
}

function queueThreadSearchFocus(): void {
  void nextTick(() => {
    window.setTimeout(() => {
      threadSearchInputRef.value?.focus();
    }, 0);
  });
}

function handleReactToMessage(payload: { message: Message; emoji: string }): void {
  try {
    emit('react', payload);
  } catch (error) {
    reportUiError('Failed to emit message reaction', error);
  }
}

function handleRemoveReaction(payload: {
  message: Message;
  reaction: MessageReaction;
}): void {
  try {
    emit('remove-reaction', payload);
  } catch (error) {
    reportUiError('Failed to emit message reaction removal', error);
  }
}

function handleDeleteMessage(message: Message): void {
  try {
    emit('delete-message', message);
  } catch (error) {
    reportUiError('Failed to emit message deletion', error);
  }
}

function handleCancelReply(): void {
  activeReply.value = null;
}

function handleCancelEdit(): void {
  activeEdit.value = null;
}

function clearReplyTargetHighlight(): void {
  highlightedMessageId.value = null;
  highlightedMessageKind.value = null;
  if (highlightTimerId !== null) {
    window.clearTimeout(highlightTimerId);
    highlightTimerId = null;
  }
}

function highlightMessageTarget(
  messageId: string,
  options: {
    durationMs?: number;
    kind?: 'default' | 'search';
  } = {}
): void {
  clearReplyTargetHighlight();
  highlightedMessageId.value = messageId;
  highlightedMessageKind.value = options.kind ?? 'default';
  highlightTimerId = window.setTimeout(() => {
    if (highlightedMessageId.value === messageId) {
      highlightedMessageId.value = null;
      highlightedMessageKind.value = null;
    }
    highlightTimerId = null;
  }, options.durationMs ?? 1800);
}

function findThreadMessageEntry(targetId: string): HTMLElement | null {
  const threadBody = threadBodyRef.value;
  if (!threadBody) {
    return null;
  }

  return Array.from(threadBody.querySelectorAll<HTMLElement>('.thread-message-entry'))
    .find((entry) => {
      return (
        entry.dataset.messageId === targetId ||
        entry.dataset.messageEventId === targetId
      );
    }) ?? null;
}

function findUnreadSeparatorEntry(): HTMLElement | null {
  const threadBody = threadBodyRef.value;
  if (!threadBody) {
    return null;
  }

  return threadBody.querySelector<HTMLElement>('[data-unread-separator="true"]');
}

async function scrollToMessageEntry(
  targetId: string,
  block: ScrollLogicalPosition,
  behavior: ScrollBehavior = 'smooth'
): Promise<boolean> {
  await nextTick();

  const targetEntry = findThreadMessageEntry(targetId);
  if (!targetEntry) {
    return false;
  }

  targetEntry.scrollIntoView({
    behavior,
    block
  });

  return true;
}

async function revealMessageById(
  messageId: string,
  options: {
    behavior?: ScrollBehavior;
    block?: ScrollLogicalPosition;
    ensureLoaded?: boolean;
    highlightDurationMs?: number;
    highlightKind?: 'default' | 'search';
  } = {}
): Promise<boolean> {
  const currentChatId = props.chat?.id ?? null;
  if (!messageId || (options.ensureLoaded && !currentChatId)) {
    return false;
  }

  setAutomaticBottomScrollEnabled(false);
  cancelPendingAutomaticThreadPosition();
  threadSearchNavigationToken += 1;
  const navigationToken = threadSearchNavigationToken;

  if (options.ensureLoaded && currentChatId) {
    const ensuredMessage = await messageStore.ensureMessageLoaded(currentChatId, messageId);
    if (!ensuredMessage || navigationToken !== threadSearchNavigationToken) {
      return false;
    }
  }

  const didScroll = await scrollToMessageEntry(
    messageId,
    options.block ?? 'center',
    options.behavior ?? 'smooth'
  );
  if (!didScroll || navigationToken !== threadSearchNavigationToken) {
    return false;
  }

  highlightMessageTarget(messageId, {
    durationMs: options.highlightDurationMs,
    kind: options.highlightKind
  });
  window.setTimeout(() => {
    if (navigationToken !== threadSearchNavigationToken) {
      return;
    }

    updateStickyDayLabel();
    updateScrollJumpState();
    scheduleVisibleReactionViewSync();
  }, options.behavior === 'smooth' ? 220 : 0);
  return true;
}

async function scrollToUnreadSeparator(
  block: ScrollLogicalPosition,
  behavior: ScrollBehavior = 'smooth'
): Promise<boolean> {
  await nextTick();

  const separatorEntry = findUnreadSeparatorEntry();
  if (!separatorEntry) {
    return false;
  }

  separatorEntry.scrollIntoView({
    behavior,
    block
  });
  separatorEntry.focus({ preventScroll: true });
  return true;
}

function getClosestUnseenReactionMessageId(): string | null {
  const fallbackMessageId = unseenReactionMessages.value[0]?.id ?? null;
  const threadBody = threadBodyRef.value;

  if (!threadBody || unseenReactionMessages.value.length <= 1) {
    return fallbackMessageId;
  }

  const threadRect = threadBody.getBoundingClientRect();
  const viewportCenter = threadRect.top + threadRect.height / 2;
  let closestMatch: { messageId: string; distance: number; isVisible: boolean } | null = null;

  unseenReactionMessages.value.forEach((message) => {
    const entry = findThreadMessageEntry(message.id);
    if (!entry) {
      return;
    }

    const entryRect = entry.getBoundingClientRect();
    const entryCenter = entryRect.top + entryRect.height / 2;
    const distance = Math.abs(entryCenter - viewportCenter);
    const isVisible = isEntryVisibleWithinThread(entry);

    if (
      !closestMatch ||
      distance < closestMatch.distance ||
      (distance === closestMatch.distance && isVisible && !closestMatch.isVisible)
    ) {
      closestMatch = {
        messageId: message.id,
        distance,
        isVisible
      };
    }
  });

  return closestMatch?.messageId ?? fallbackMessageId;
}

async function initializeThreadPosition(): Promise<void> {
  const currentChatId = props.chat?.id ?? null;
  if (!currentChatId || pendingInitialPositionChatId.value !== currentChatId) {
    return;
  }

  if (props.messages.length === 0) {
    return;
  }

  if (firstMessageAfterUnreadBoundaryId.value && (await scrollToUnreadSeparator('center', 'auto'))) {
    if (pendingInitialPositionChatId.value !== currentChatId) {
      return;
    }

    isThreadScrolledUp.value = true;
    lastReadMessageId.value = firstMessageAfterUnreadBoundaryId.value;
    hasJumpedToLastReadMessage.value = true;
    updateStickyDayLabel();
    scheduleVisibleReactionViewSync();
    pendingInitialPositionChatId.value = null;
    return;
  }

  if (pendingInitialPositionChatId.value !== currentChatId) {
    return;
  }

  pendingInitialPositionChatId.value = null;
  logThreadScrollTrace('INIT_POSITION_NO_UNREAD_AUTO');
  await scrollToBottom('auto');
}

function isEntryVisibleWithinThread(entry: HTMLElement): boolean {
  const threadBody = threadBodyRef.value;
  if (!threadBody) {
    return false;
  }

  const threadRect = threadBody.getBoundingClientRect();
  const entryRect = entry.getBoundingClientRect();

  return entryRect.bottom > threadRect.top && entryRect.top < threadRect.bottom;
}

function scheduleVisibleReactionViewSync(): void {
  if (visibleReactionSyncFrameId !== null) {
    cancelAnimationFrame(visibleReactionSyncFrameId);
  }

  visibleReactionSyncFrameId = window.requestAnimationFrame(() => {
    visibleReactionSyncFrameId = null;
    void syncVisibleReactionViews();
  });
}

async function syncVisibleReactionViews(): Promise<void> {
  const currentChatId = props.chat?.id ?? null;
  if (!currentChatId || !isChatActuallyVisible.value) {
    return;
  }
  const currentLastSeenReceivedActivityAt = readCurrentLastSeenReceivedActivityAt();

  const visibleMessages = props.messages.filter((message) => {
    const entry = findThreadMessageEntry(message.id);
    return entry ? isEntryVisibleWithinThread(entry) : false;
  });

  let latestVisibleReceivedActivity: {
    at: string;
    eventId: string | null;
  } | null = null;
  visibleMessages.forEach((message) => {
    if (message.sender === 'them' && !isGroupEpochNoticeMessageMeta(message.meta)) {
      if (
        !latestVisibleReceivedActivity ||
        toComparableTimestamp(message.sentAt) > toComparableTimestamp(latestVisibleReceivedActivity.at)
      ) {
        latestVisibleReceivedActivity = {
          at: message.sentAt,
          eventId: message.eventId ?? null
        };
      }
    }

    const normalizedAuthorPublicKey = message.authorPublicKey.trim().toLowerCase();
    normalizeMessageReactions(message.meta.reactions).forEach((reaction) => {
      const isIncomingReaction = loggedInPublicKey.value
        ? reaction.reactorPublicKey !== loggedInPublicKey.value
        : message.sender === 'me'
          ? reaction.reactorPublicKey !== normalizedAuthorPublicKey
          : reaction.reactorPublicKey === normalizedAuthorPublicKey;
      if (!isIncomingReaction || !reaction.createdAt) {
        return;
      }

      if (
        !latestVisibleReceivedActivity ||
        toComparableTimestamp(reaction.createdAt) >
          toComparableTimestamp(latestVisibleReceivedActivity.at)
      ) {
        latestVisibleReceivedActivity = {
          at: reaction.createdAt,
          eventId: reaction.eventId ?? null
        };
      }
    });
  });

  if (latestVisibleReceivedActivity) {
    const latestVisibleActivityTimestamp = toComparableTimestamp(latestVisibleReceivedActivity.at);
    const currentLastSeenTimestamp = toComparableTimestamp(currentLastSeenReceivedActivityAt);
    const effectiveLastSeenReceivedActivityAt =
      latestVisibleActivityTimestamp > currentLastSeenTimestamp
        ? latestVisibleReceivedActivity.at
        : currentLastSeenReceivedActivityAt;

    if (latestVisibleActivityTimestamp > currentLastSeenTimestamp) {
      await chatStore.setLastSeenReceivedActivityAt(currentChatId, latestVisibleReceivedActivity.at);
      nostrStore.scheduleContactCursorPublish(currentChatId, latestVisibleReceivedActivity);
    }

    const nextUnreadMessageCount = props.messages.reduce((count, message) => {
      if (
        message.sender !== 'them' ||
        isGroupEpochNoticeMessageMeta(message.meta) ||
        toComparableTimestamp(message.sentAt) <=
          toComparableTimestamp(effectiveLastSeenReceivedActivityAt)
      ) {
        return count;
      }

      return count + 1;
    }, 0);

    if (nextUnreadMessageCount !== (props.chat?.unreadCount ?? 0)) {
      await chatStore.setUnreadCount(currentChatId, nextUnreadMessageCount);
    }
  }

  if (unseenReactionMessages.value.length === 0) {
    return;
  }

  const visibleMessageIds = unseenReactionMessages.value
    .filter((message) => {
      const entry = findThreadMessageEntry(message.id);
      return entry ? isEntryVisibleWithinThread(entry) : false;
    })
    .map((message) => message.id);

  if (visibleMessageIds.length === 0) {
    return;
  }

  visibleReactionSyncPromise = visibleReactionSyncPromise
    .catch(() => undefined)
    .then(async () => {
      await messageStore.markMessagesReactionsViewed(currentChatId, visibleMessageIds);
    });

  await visibleReactionSyncPromise;
}

async function handleScrollJump(): Promise<void> {
  try {
    if (!props.messages.length) {
      return;
    }

    if (!hasJumpedToLastReadMessage.value && lastReadMessageId.value) {
      const didScrollToLastReadMessage = await scrollToMessageEntry(lastReadMessageId.value, 'start');
      if (didScrollToLastReadMessage) {
        hasJumpedToLastReadMessage.value = true;
        return;
      }
    }

    hasJumpedToLastReadMessage.value = false;
    logThreadScrollTrace('JUMP_TO_LATEST_BUTTON');
    await scrollToBottom('explicit');
  } catch (error) {
    reportUiError('Failed to jump to the latest messages', error);
  }
}

async function handleReactionJump(): Promise<void> {
  try {
    const closestUnseenReactionMessageId = getClosestUnseenReactionMessageId();
    if (!closestUnseenReactionMessageId) {
      return;
    }

    await scrollToMessageEntry(closestUnseenReactionMessageId, 'center');
    window.setTimeout(() => {
      scheduleVisibleReactionViewSync();
    }, 220);
  } catch (error) {
    reportUiError('Failed to jump to the closest new reaction', error);
  }
}

async function handleOpenReplyTarget(messageId: string, referenceSentAt?: string): Promise<void> {
  try {
    let didReveal = await revealMessageById(messageId, {
      behavior: 'smooth',
      block: 'center',
      ensureLoaded: true
    });
    if (didReveal) {
      return;
    }

    const currentChatId = props.chat?.id ?? null;
    if (!currentChatId) {
      return;
    }

    const referenceCreatedAtMs =
      typeof referenceSentAt === 'string' && referenceSentAt.trim()
        ? Date.parse(referenceSentAt)
        : Number.NaN;
    await nostrStore.repairMissingMessageDependency(currentChatId, messageId, {
      reason: 'reply-open',
      immediate: true,
      force: true,
      ...(Number.isFinite(referenceCreatedAtMs)
        ? { referenceCreatedAt: Math.floor(referenceCreatedAtMs / 1000) }
        : {}),
    });
    const ensuredMessage = await messageStore.ensureMessageLoadedByEventId(currentChatId, messageId);
    if (!ensuredMessage) {
      return;
    }

    didReveal = await revealMessageById(ensuredMessage.id, {
      behavior: 'smooth',
      block: 'center',
    });
    if (!didReveal) {
      return;
    }
  } catch (error) {
    reportUiError('Failed to focus replied message', error);
  }
}

function clearPendingThreadSearchDebounce(): void {
  if (threadSearchDebounceId !== null) {
    window.clearTimeout(threadSearchDebounceId);
    threadSearchDebounceId = null;
  }
}

function resetThreadSearchResults(): void {
  clearPendingThreadSearchDebounce();
  threadSearchRequestToken += 1;
  threadSearchNavigationToken += 1;
  isThreadSearchBusy.value = false;
  threadSearchMatches.value = [];
  activeThreadSearchMatchIndex.value = -1;
}

function handleOpenThreadSearch(): void {
  isThreadSearchOpen.value = true;
  queueThreadSearchFocus();
}

function handleCloseThreadSearch(): void {
  isThreadSearchOpen.value = false;
  threadSearchQuery.value = '';
  resetThreadSearchResults();
  clearReplyTargetHighlight();
}

async function revealThreadSearchMatch(
  nextIndex: number,
  behavior: ScrollBehavior = 'smooth'
): Promise<void> {
  const targetIndex = getWrappedThreadSearchIndex(nextIndex, threadSearchMatches.value.length);
  if (targetIndex < 0) {
    return;
  }

  const targetMatch = threadSearchMatches.value[targetIndex];
  if (!targetMatch) {
    return;
  }

  const didReveal = await revealMessageById(targetMatch.messageId, {
    behavior,
    block: 'center',
    ensureLoaded: true,
    highlightDurationMs: 3600,
    highlightKind: 'search'
  });
  if (!didReveal) {
    return;
  }

  activeThreadSearchMatchIndex.value = targetIndex;
}

function handleThreadSearchEnter(event: KeyboardEvent): void {
  if (event.shiftKey) {
    void handlePreviousThreadSearchResult();
    return;
  }

  void handleNextThreadSearchResult();
}

async function handlePreviousThreadSearchResult(): Promise<void> {
  if (!canNavigateThreadSearch.value) {
    return;
  }

  const targetIndex = resolveThreadSearchNavigationIndex(
    activeThreadSearchMatchIndex.value,
    threadSearchMatches.value.length,
    'previous'
  );
  await revealThreadSearchMatch(targetIndex, 'smooth');
}

async function handleNextThreadSearchResult(): Promise<void> {
  if (!canNavigateThreadSearch.value) {
    return;
  }

  const targetIndex = resolveThreadSearchNavigationIndex(
    activeThreadSearchMatchIndex.value,
    threadSearchMatches.value.length,
    'next'
  );
  await revealThreadSearchMatch(targetIndex, 'smooth');
}

async function runThreadSearch(chatId: string, query: string): Promise<void> {
  const normalizedQuery = query.trim();
  if (!chatId || !normalizedQuery || !isThreadSearchOpen.value) {
    resetThreadSearchResults();
    return;
  }

  const requestToken = ++threadSearchRequestToken;
  isThreadSearchBusy.value = true;

  try {
    const matches = await messageStore.searchMessages(chatId, normalizedQuery);
    if (
      requestToken !== threadSearchRequestToken ||
      chatId !== (props.chat?.id ?? null) ||
      !isThreadSearchOpen.value ||
      normalizedQuery !== threadSearchQuery.value.trim()
    ) {
      return;
    }

    threadSearchMatches.value = matches;
    activeThreadSearchMatchIndex.value = matches.length > 0 ? 0 : -1;

    if (matches.length > 0) {
      await revealThreadSearchMatch(0, 'auto');
    } else {
      clearReplyTargetHighlight();
    }
  } catch (error) {
    if (requestToken !== threadSearchRequestToken) {
      return;
    }

    threadSearchMatches.value = [];
    activeThreadSearchMatchIndex.value = -1;
    reportUiError('Failed to search messages in this chat', error);
  } finally {
    if (requestToken === threadSearchRequestToken) {
      isThreadSearchBusy.value = false;
    }
  }
}

function handleOpenProfile(): void {
  try {
    if (!props.chat?.publicKey) {
      return;
    }

    emitOpenProfile(props.chat.publicKey);
  } catch (error) {
    reportUiError('Failed to open profile from chat thread', error);
  }
}

function emitOpenProfile(publicKey: string): void {
  const normalized = publicKey.trim();
  if (!normalized) {
    return;
  }

  emit('open-profile', normalized);
}

function handleOpenAuthorChat(publicKey: string): void {
  try {
    const normalizedPublicKey = publicKey.trim().toLowerCase();
    if (!normalizedPublicKey) {
      return;
    }

    if (props.chat?.type !== 'group') {
      emitOpenProfile(normalizedPublicKey);
      return;
    }

    const isSelf = normalizedPublicKey === loggedInPublicKey.value;
    const authorIdentity = isSelf
      ? {
          label: t('common.you'),
          avatarSrc: selfAvatarImageUrl.value,
          avatarFallback: selfAvatarFallback.value
        }
      : authorIdentityByPublicKey.value[normalizedPublicKey];
    emit('open-chat', {
      publicKey: normalizedPublicKey,
      ...(authorIdentity?.label ? { displayName: authorIdentity.label } : {}),
      ...(authorIdentity?.avatarSrc ? { picture: authorIdentity.avatarSrc } : {}),
      ...(authorIdentity?.avatarFallback ? { avatar: authorIdentity.avatarFallback } : {})
    });
  } catch (error) {
    reportUiError('Failed to open message author chat from group thread', error);
  }
}

function handleOpenMentionChat(publicKey: string): void {
  const normalizedPublicKey = publicKey.trim().toLowerCase();
  if (!normalizedPublicKey) {
    return;
  }

  try {
    const mentionProfile =
      mentionProfiles.value.find((profile) => profile.publicKey === normalizedPublicKey) ?? null;
    emit('open-chat', {
      publicKey: normalizedPublicKey,
      ...(mentionProfile?.displayName ? { displayName: mentionProfile.displayName } : {}),
      ...(mentionProfile?.picture ? { picture: mentionProfile.picture } : {}),
      ...(mentionProfile?.avatar ? { avatar: mentionProfile.avatar } : {}),
    });
  } catch (error) {
    reportUiError('Failed to open mentioned chat from chat thread', error);
  }
}

function handleThreadFocusIn(event: FocusEvent): void {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (!target?.closest('.composer')) {
    return;
  }

  scheduleViewportSettleScrollToBottom();
}

watch(
  () =>
    [
      props.chat?.publicKey ?? null,
      props.chat?.type ?? null,
      loggedInPublicKey.value,
      nostrStore.contactListVersion,
    ] as const,
  ([chatPublicKey, , loggedInPublicKeyValue]) => {
    void refreshContactRelayUrls(chatPublicKey);
    void refreshGroupMentionContactMeta(props.chat);
    void refreshSelfAuthorIdentity(loggedInPublicKeyValue);
    void refreshMessageAuthorIdentities();
  },
  { immediate: true }
);

watch(
  () => authorIdentitySignature.value,
  () => {
    void refreshMessageAuthorIdentities();
  },
  { immediate: true }
);

watch(
  () => messageIdSignature.value,
  () => {
    pruneExpandedMessageIds();
  }
);

watch(
  isChatActuallyVisible,
  (isVisible) => {
    if (!isVisible) {
      return;
    }

    scheduleVisibleReactionViewSync();
  }
);

watch(
  () => props.chat?.id ?? null,
  (chatId) => {
    isThreadSearchOpen.value = false;
    threadSearchQuery.value = '';
    resetThreadSearchResults();
    activeReply.value = null;
    activeEdit.value = null;
    clearReplyTargetHighlight();
    pendingSentMessageReveal = false;
    pendingPaginationContext = null;
    resetOlderPullGestures();
    expandedMessageIds.value = new Set();
    setThreadScrollLocked(false);
    setAutomaticBottomScrollEnabled(true);
    cancelPendingScrollToBottom();
    pendingInitialPositionChatId.value = chatId;
    openedUnreadBoundaryAt.value =
      chatId && props.chat
        ? typeof props.chat.meta[LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY] === 'string' &&
          props.chat.meta[LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY].trim()
          ? String(props.chat.meta[LAST_SEEN_RECEIVED_ACTIVITY_AT_META_KEY]).trim()
          : null
        : null;
    lastReadMessageId.value = null;
    hasJumpedToLastReadMessage.value = false;
    isThreadScrolledUp.value = false;

    if (!chatId) {
      pendingInitialPositionChatId.value = null;
      logThreadScrollTrace('CHAT_WATCHER_NO_CHAT_AUTO');
      void scrollToBottom('auto');
      return;
    }

    void initializeThreadPosition();
  },
  { immediate: true }
);

watch(
  () => [props.chat?.id ?? null, isThreadSearchOpen.value, threadSearchQuery.value] as const,
  ([chatId, isSearchOpen, searchQuery]) => {
    clearPendingThreadSearchDebounce();

    if (!chatId || !isSearchOpen) {
      resetThreadSearchResults();
      return;
    }

    if (!searchQuery.trim()) {
      resetThreadSearchResults();
      return;
    }

    threadSearchDebounceId = window.setTimeout(() => {
      threadSearchDebounceId = null;
      void runThreadSearch(chatId, searchQuery);
    }, 180);
  }
);

watch(
  () => props.messages.length,
  (nextLength, previousLength) => {
    if (pendingPaginationContext) {
      return;
    }

    if (pendingInitialPositionChatId.value === (props.chat?.id ?? null)) {
      void initializeThreadPosition();
      return;
    }

    if (nextLength === previousLength) {
      return;
    }

    const shouldForceFollowToBottom =
      isAutomaticBottomScrollEnabled.value && !isThreadScrolledUp.value;

    if (pendingSentMessageReveal) {
      pendingSentMessageReveal = false;
      logThreadScrollTrace('MESSAGES_WATCHER_SENT_REVEAL');
      void scrollToBottom('explicit');
      return;
    }

    if (shouldForceFollowToBottom) {
      logThreadScrollTrace('MESSAGES_WATCHER_FOLLOW_FORCE_BOTTOM');
      void scrollToBottom('auto');
      return;
    }

    const shouldStickToBottom = isThreadNearBottom();

    if (shouldStickToBottom) {
      logThreadScrollTrace('MESSAGES_WATCHER_STICK_TO_BOTTOM_AUTO');
      void scrollToBottom('auto');
      return;
    }

    void nextTick(() => {
      updateStickyDayLabel();
      updateScrollJumpState();
      scheduleVisibleReactionViewSync();
    });
  }
);

watch(
  () => props.keyboardVisible,
  (isVisible) => {
    if (isVisible) {
      scheduleViewportSettleScrollToBottom();
    }
  }
);

watch(
  () => props.mobileViewportHeight,
  (nextHeight, previousHeight) => {
    if (
      typeof nextHeight !== 'number' ||
      typeof previousHeight !== 'number' ||
      nextHeight >= previousHeight
    ) {
      return;
    }

    scheduleViewportSettleScrollToBottom();
  }
);

watch(
  reactionVisibilitySignature,
  () => {
    scheduleVisibleReactionViewSync();
  },
  { immediate: true }
);

onMounted(() => {
  if (typeof window === 'undefined') {
    return;
  }

  window.addEventListener(
    DESKTOP_MESSAGE_LAYOUT_CHANGED_EVENT,
    handleDesktopMessageLayoutPreferenceChanged
  );
  window.addEventListener('storage', handleDesktopMessageLayoutStorage);
});

onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener(
      DESKTOP_MESSAGE_LAYOUT_CHANGED_EVENT,
      handleDesktopMessageLayoutPreferenceChanged
    );
    window.removeEventListener('storage', handleDesktopMessageLayoutStorage);
  }
  clearReplyTargetHighlight();
  clearPendingThreadSearchDebounce();
  if (scrollFrameId !== null) {
    cancelAnimationFrame(scrollFrameId);
  }
  if (visibleReactionSyncFrameId !== null) {
    cancelAnimationFrame(visibleReactionSyncFrameId);
  }
  pendingPaginationContext = null;
  resetOlderPullGestures();
  setThreadScrollLocked(false);
  cancelPendingScrollToBottom();
  clearPendingViewportSettleScrolls();
});
</script>

<style scoped>
.thread-root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  min-width: 0;
  width: 100%;
  overflow: hidden;
  overscroll-behavior: none;
  background: transparent;
}

.thread-header {
  position: sticky;
  top: 0;
  z-index: 6;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0;
  padding: 10px 16px;
  border-bottom: 1px solid var(--nc-border);
  background: var(--nc-panel-header-bg);
}

.thread-header__row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.thread-header__identity {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.thread-header__meta {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.thread-header__name {
  font-size: 15px;
  font-weight: 600;
  color: var(--nc-text);
}

.thread-header__time {
  font-size: 12px;
  color: var(--nc-text-secondary);
}

.thread-header__action {
}

body.body--dark .thread-header__action {
  color: var(--nc-text-secondary) !important;
}

.thread-search {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px 12px;
  border-bottom: 1px solid var(--nc-border);
  background: var(--nc-panel-header-bg);
}

.thread-search__input {
  flex: 1 1 220px;
  min-width: 0;
}

.thread-search__meta {
  flex: 0 0 auto;
  min-width: 72px;
  font-size: 12px;
  font-weight: 600;
  color: var(--nc-text-secondary);
  text-align: right;
  white-space: nowrap;
}

.thread-search__actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.thread-search__action {
  color: var(--nc-text-secondary);
}

.thread-search-bar-enter-active,
.thread-search-bar-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.thread-search-bar-enter-from,
.thread-search-bar-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.thread-body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 12px 16px;
  position: relative;
  background: var(--nc-thread-bg);
  overflow-anchor: none;
  overscroll-behavior: contain;
}

.thread-body--scroll-locked {
  overscroll-behavior: contain;
  touch-action: none;
}

.thread-more {
  position: absolute;
  left: 16px;
  right: 16px;
  z-index: 4;
  display: flex;
  justify-content: center;
  pointer-events: none;
}

.thread-more--top {
  top: 44px;
}

.thread-more--bottom {
  bottom: 12px;
}

.thread-more__button {
  pointer-events: auto;
  min-height: 28px;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--q-primary) !important;
  border: 1px solid var(--q-primary);
  box-shadow: none !important;
  color: var(--nc-active-text) !important;
}

.thread-more__button::before {
  border-color: transparent !important;
}

.thread-more__button:hover {
  background: var(--q-primary) !important;
  box-shadow: none !important;
}

.thread-composer-anchor {
  position: sticky;
  bottom: 0;
  z-index: 6;
  flex: 0 0 auto;
}

.thread-jump-buttons {
  position: absolute;
  right: 18px;
  bottom: 72px;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 8px;
}

.q-btn.thread-scroll-jump {
  background: var(--nc-panel-sidebar-bg) !important;
  box-shadow: none !important;
  border: 1px solid var(--nc-border);
  color: var(--q-primary);
}

.q-btn.thread-scroll-jump::before {
  border-color: transparent !important;
}

.q-btn.thread-scroll-jump:hover {
  background: var(--nc-hover) !important;
  box-shadow: none !important;
  transform: none;
}

.q-btn.thread-scroll-jump--reaction {
  min-height: 36px;
  padding: 0 12px 0 6px;
  border-radius: 999px;
  background: var(--nc-reaction-accent-bg) !important;
  border-color: var(--nc-reaction-accent-border);
  color: var(--nc-reaction-accent-text);
}

.q-btn.thread-scroll-jump--reaction .q-btn__content {
  gap: 6px;
}

.q-btn.thread-scroll-jump--reaction:hover {
  background: var(--nc-reaction-accent-bg-hover) !important;
  box-shadow: none !important;
}

.thread-reaction-jump__icon-shell {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 999px;
  background: var(--nc-reaction-accent-icon-bg);
}

.thread-reaction-jump__icon {
  color: #ffffff;
}

.thread-reaction-jump__count {
  display: inline-block;
  min-width: 1.4em;
  font-size: 12px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}

.thread-scroll-jump-enter-active,
.thread-scroll-jump-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.thread-scroll-jump-enter-from,
.thread-scroll-jump-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

@media (max-width: 1023px) {
  .thread-header {
    min-height: 56px;
    padding: 8px 10px;
    font-family: var(--nc-mobile-font);
  }

  .thread-header__name {
    overflow: hidden;
    font-size: var(--nc-mobile-header-title-font-size);
    font-weight: 600;
    line-height: var(--nc-mobile-header-title-line-height);
    letter-spacing: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .thread-header__time {
    overflow: hidden;
    font-size: var(--nc-mobile-header-subtitle-font-size);
    font-weight: 400;
    line-height: var(--nc-mobile-header-subtitle-line-height);
    letter-spacing: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .thread-search {
    flex-wrap: wrap;
    padding: 10px 10px 12px;
    font-family: var(--nc-mobile-font);
  }

  .thread-search__input {
    flex-basis: 100%;
  }

  .thread-search__meta {
    min-width: 0;
    font-size: var(--nc-mobile-small-font-size);
    line-height: var(--nc-mobile-small-line-height);
    text-align: left;
  }

  .thread-body {
    padding: 12px 10px calc(78px + env(safe-area-inset-bottom));
  }

  .thread-more {
    left: 10px;
    right: 10px;
  }

  .thread-more--bottom {
    bottom: calc(64px + env(safe-area-inset-bottom));
  }

  .thread-composer-anchor {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding-bottom: 0;
  }

  .thread-jump-buttons {
    right: 14px;
    bottom: calc(64px + env(safe-area-inset-bottom));
  }
}

body.body--dark .q-btn.thread-scroll-jump {
  background: var(--nc-panel-sidebar-bg) !important;
  border-color: var(--nc-border);
  box-shadow: none !important;
  color: var(--nc-text-secondary);
}

body.body--dark .q-btn.thread-scroll-jump:hover {
  background: var(--nc-hover) !important;
}


.thread-day-sticky {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  justify-content: center;
  padding: 2px 0 8px;
  pointer-events: none;
}

.thread-day-sticky__label {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 28px;
  padding: 4px 12px;
  border-radius: 999px;
  background: var(--nc-sticky-bg);
  border: 1px solid var(--nc-border);
  box-shadow: none;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0;
  color: var(--nc-text-secondary);
  backdrop-filter: none;
}

.thread-day-separator {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 12px 0 10px;
}

.thread-day-separator__line {
  flex: 1;
  height: 1px;
  background: var(--nc-border);
}

.thread-day-separator__label {
  flex: 0 0 auto;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--nc-sticky-bg);
  border: 1px solid var(--nc-border);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0;
  color: var(--nc-text-secondary);
  white-space: nowrap;
}

.thread-unread-separator {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 18px 0 14px;
  outline: none;
}

.thread-unread-separator__line {
  flex: 1;
  height: 1px;
  background: rgba(100, 181, 246, 0.3);
}

.thread-unread-separator__label {
  flex: 0 0 auto;
  padding: 5px 12px;
  border-radius: 999px;
  background: var(--nc-reaction-accent-bg);
  border: 1px solid var(--nc-reaction-accent-border);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: none;
  color: var(--nc-reaction-accent-text);
  white-space: nowrap;
}

.thread-unread-separator:focus-visible .thread-unread-separator__label,
.thread-unread-separator:focus .thread-unread-separator__label {
  box-shadow:
    var(--nc-reaction-accent-shadow-soft),
    0 0 0 2px color-mix(in srgb, var(--q-primary) 24%, transparent);
}

@media (max-width: 1023px) {
  .thread-day-sticky__label,
  .thread-day-separator__label,
  .thread-unread-separator__label {
    font-family: var(--nc-mobile-font);
    font-size: var(--nc-mobile-small-font-size);
    line-height: var(--nc-mobile-small-line-height);
    letter-spacing: 0;
  }
}

.thread-message-entry {
  scroll-margin-top: 88px;
  scroll-margin-bottom: 16px;
}

.thread-message-entry--sender-change {
  margin-top: 4px;
}

@media (max-width: 1023px) {
  .thread-message-entry--sender-change {
    margin-top: 0;
  }
}

.thread-message-entry--target :deep(.bubble) {
  animation: thread-message-target 1.8s ease;
}

.thread-message-entry--target-search :deep(.bubble) {
  animation: thread-message-target-search 3.6s ease;
}

@keyframes thread-message-target {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--q-primary) 42%, transparent);
  }

  30% {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--q-primary) 42%, transparent);
  }

  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}

@keyframes thread-message-target-search {
  0% {
    box-shadow:
      0 0 0 0 color-mix(in srgb, var(--q-primary) 52%, transparent),
      0 0 0 0 color-mix(in srgb, var(--q-primary) 16%, transparent);
    transform: translateY(0);
  }

  14% {
    box-shadow:
      0 0 0 3px color-mix(in srgb, var(--q-primary) 58%, transparent),
      0 0 0 10px color-mix(in srgb, var(--q-primary) 18%, transparent);
    transform: translateY(-1px);
  }

  52% {
    box-shadow:
      0 0 0 2px color-mix(in srgb, var(--q-primary) 34%, transparent),
      0 0 0 6px color-mix(in srgb, var(--q-primary) 10%, transparent);
    transform: translateY(0);
  }

  100% {
    box-shadow:
      0 0 0 0 transparent,
      0 0 0 0 transparent;
    transform: translateY(0);
  }
}

.thread-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 100%;
  padding: 24px;
  text-align: center;
  color: var(--nc-text-secondary);
}

.thread-empty--loading {
  opacity: 1;
}

.thread-empty__mark {
  font-size: 48px;
  line-height: 1;
}

.thread-empty__progress {
  width: min(220px, 72%);
}

.thread-empty__status {
  font-weight: 600;
  color: var(--q-primary);
}
</style>
