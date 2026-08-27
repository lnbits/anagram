<template>
  <q-item
    clickable
    class="chat-item"
    :class="{ 'chat-item--muted': isMuted }"
    data-testid="chat-item"
    :active="active"
    active-class="chat-item--active"
    @click="handleSelectChat"
  >
    <q-item-section avatar>
      <CachedAvatar
        :src="avatarImageUrl"
        :alt="chatTitle"
        :fallback="chat.avatar"
        class="chat-item__avatar"
      />
    </q-item-section>

    <q-item-section class="chat-item__main">
      <div class="chat-item__headline">
        <q-item-label class="chat-item__name" lines="1">{{ chatTitle }}</q-item-label>
        <q-item-label class="chat-item__time" caption>{{ formattedTime }}</q-item-label>
        <span
          v-if="isMuted"
          class="chat-item__mute-indicator"
          :aria-label="$t('common.mute')"
        >
          <q-icon name="notifications_off" size="15px" aria-hidden="true" />
          <AppTooltip>{{ $t('common.mute') }}</AppTooltip>
        </span>
      </div>
      <q-item-label class="chat-item__caption" caption lines="1">
        <span
          v-if="chatPreviewAuthorLabel"
          class="chat-item__preview-author"
          data-testid="chat-item-preview-author"
        >{{ chatPreviewAuthorLabel }}:</span>
        <span>{{ chatPreview }}</span>
      </q-item-label>
    </q-item-section>

    <q-item-section v-if="hasMetaBadges" side class="chat-item__meta">
      <div class="chat-item__badges">
        <div
          v-if="unseenReactionCount > 0"
          class="chat-item__reaction-badge"
          :aria-label="$t('chat.reactions.unseenCount', { count: unseenReactionCount })"
        >
          <span class="chat-item__reaction-icon-shell" aria-hidden="true">
            <q-icon name="favorite" size="13px" class="chat-item__reaction-icon" />
          </span>
          <span class="chat-item__reaction-count">{{ formatReactionCount(unseenReactionCount) }}</span>
        </div>

        <q-badge
          v-if="chat.unreadCount > 0"
          rounded
          color="primary"
          class="chat-item__unread-badge"
          :class="{ 'chat-item__unread-badge--muted': isMuted }"
        >
          {{ chat.unreadCount }}
        </q-badge>
      </div>
    </q-item-section>

    <q-item-section side class="chat-item__actions">
      <q-btn
        flat
        dense
        round
        icon="more_vert"
        class="chat-item__more"
        :aria-label="$t('chat.chatActions')"
        data-testid="chat-item-actions-button"
        @click.stop
      >
        <q-menu anchor="bottom right" self="top right" class="nc-pop-menu">
          <q-list dense class="nc-pop-menu__list">
            <q-item clickable v-close-popup @click="emitViewProfile">
              <q-item-section>{{ $t('profile.viewProfile') }}</q-item-section>
            </q-item>
            <q-item clickable v-close-popup @click="emitRefreshProfile">
              <q-item-section>{{ $t('profile.refreshProfile') }}</q-item-section>
            </q-item>
            <q-item
              v-if="chat.type === 'group'"
              clickable
              v-close-popup
              @click="emitRefreshChat"
            >
              <q-item-section>{{ $t('group.refreshGroupChat') }}</q-item-section>
            </q-item>
            <q-item clickable v-close-popup @click="isMuted ? emitUnmute() : emitMute()">
              <q-item-section>{{ isMuted ? $t('common.unmute') : $t('common.mute') }}</q-item-section>
            </q-item>
            <q-item clickable v-close-popup @click="emitBlock">
              <q-item-section class="text-negative">{{ $t('common.block') }}</q-item-section>
            </q-item>
            <q-item clickable v-close-popup @click="emitMarkAsRead">
              <q-item-section>{{ $t('chat.markAsRead') }}</q-item-section>
            </q-item>
            <q-item clickable v-close-popup @click="emitDeleteChat">
              <q-item-section class="text-negative">{{ $t('chat.deleteChat') }}</q-item-section>
            </q-item>
          </q-list>
        </q-menu>
      </q-btn>
    </q-item-section>
  </q-item>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Chat } from 'src/types/chat';
import AppTooltip from 'src/components/AppTooltip.vue';
import CachedAvatar from 'src/components/CachedAvatar.vue';
import { resolveChatPreviewAuthorLabel } from 'src/utils/chatPreview';
import { formatGroupMentionsForDisplay } from 'src/utils/nostrMentions';
import { reportUiError } from 'src/utils/uiErrorHandler';
import { getDateTimeLocale, t } from 'src/i18n';

const props = defineProps<{
  chat: Chat;
  active: boolean;
}>();

const emit = defineEmits<{
  (event: 'select', chatId: string): void;
  (event: 'view-profile', chatId: string): void;
  (event: 'refresh-profile', chatId: string): void;
  (event: 'refresh-chat', chatId: string): void;
  (event: 'mute', chatId: string): void;
  (event: 'unmute', chatId: string): void;
  (event: 'block', chatId: string): void;
  (event: 'mark-as-read', chatId: string): void;
  (event: 'delete-chat', chatId: string): void;
}>();

function readMetaString(key: string): string {
  const value = props.chat.meta[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readMetaCount(key: string): number {
  const value = props.chat.meta[key];
  const numericValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return 0;
  }

  return Math.max(0, Math.floor(numericValue));
}

function chatPubkeySnippet(value: string): string {
  return value.trim().slice(0, 32);
}

function getLoggedInPubkey(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  return window.localStorage.getItem('npub')?.trim().toLowerCase() ?? '';
}

const formattedTime = computed(() => {
  return new Intl.DateTimeFormat(getDateTimeLocale(), {
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(props.chat.lastMessageAt));
});

const chatTitle = computed(() => {
  const loggedInPubkey = getLoggedInPubkey();
  if (loggedInPubkey && props.chat.publicKey.trim().toLowerCase() === loggedInPubkey) {
    return t('common.self');
  }

  const givenName = readMetaString('given_name');
  if (givenName) {
    return givenName;
  }

  const contactName = readMetaString('contact_name');
  if (contactName) {
    return contactName;
  }

  const name = props.chat.name.trim();
  if (name) {
    return name;
  }

  return chatPubkeySnippet(props.chat.publicKey);
});

const avatarImageUrl = computed(() => {
  const picture = props.chat.meta.picture;
  if (typeof picture === 'string' && picture.trim()) {
    return picture.trim();
  }

  return '';
});

const isMuted = computed(() => props.chat.meta.muted === true);
const unseenReactionCount = computed(() => readMetaCount('unseen_reaction_count'));
const hasMetaBadges = computed(() => props.chat.unreadCount > 0 || unseenReactionCount.value > 0);
const chatPreview = computed(() =>
  props.chat.type === 'group'
    ? formatGroupMentionsForDisplay(props.chat.lastMessage, props.chat.meta)
    : props.chat.lastMessage
);
const chatPreviewAuthorLabel = computed(() =>
  resolveChatPreviewAuthorLabel(props.chat, getLoggedInPubkey(), t('common.you'))
);

function formatReactionCount(value: number): string {
  return value > 99 ? '99+' : String(value);
}

function handleSelectChat(): void {
  try {
    emit('select', props.chat.id);
  } catch (error) {
    reportUiError('Failed to select chat item', error);
  }
}

function emitViewProfile(): void {
  try {
    emit('view-profile', props.chat.id);
  } catch (error) {
    reportUiError('Failed to emit chat profile action', error);
  }
}

function emitRefreshProfile(): void {
  try {
    emit('refresh-profile', props.chat.id);
  } catch (error) {
    reportUiError('Failed to emit chat refresh action', error);
  }
}

function emitRefreshChat(): void {
  try {
    emit('refresh-chat', props.chat.id);
  } catch (error) {
    reportUiError('Failed to emit chat reload action', error);
  }
}

function emitMute(): void {
  try {
    emit('mute', props.chat.id);
  } catch (error) {
    reportUiError('Failed to emit chat mute action', error);
  }
}

function emitUnmute(): void {
  try {
    emit('unmute', props.chat.id);
  } catch (error) {
    reportUiError('Failed to emit chat unmute action', error);
  }
}

function emitBlock(): void {
  try {
    emit('block', props.chat.id);
  } catch (error) {
    reportUiError('Failed to emit chat block action', error);
  }
}

function emitMarkAsRead(): void {
  try {
    emit('mark-as-read', props.chat.id);
  } catch (error) {
    reportUiError('Failed to emit mark-as-read action', error);
  }
}

function emitDeleteChat(): void {
  try {
    emit('delete-chat', props.chat.id);
  } catch (error) {
    reportUiError('Failed to emit chat delete action', error);
  }
}
</script>

<style scoped>
.chat-item {
  min-width: 0;
  min-height: 64px;
  margin: 0;
  padding: 0 8px;
  border-radius: 0;
  border-bottom: 0;
  transition:
    background-color 0.2s ease,
    border-color 0.2s ease,
    color 0.2s ease;
}

.chat-item:hover {
  background: var(--nc-hover);
}

.chat-item--active {
  background: var(--nc-active);
  color: var(--nc-active-text);
}

.chat-item__name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-item__caption {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.25;
}

.chat-item__preview-author {
  margin-right: 0.3em;
  color: var(--q-primary);
}

.chat-item__main {
  flex: 1 1 auto;
  min-width: 0;
}

.chat-item__headline {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.chat-item__meta {
  flex: 0 0 auto;
  justify-content: center;
  color: var(--nc-text-secondary);
}

.chat-item__actions {
  flex: 0 0 28px;
  min-width: 28px;
  padding-left: 0 !important;
  align-items: flex-end;
  justify-content: center;
}

.chat-item__time {
  flex: 0 0 auto;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.chat-item__mute-indicator {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  color: var(--nc-text-secondary);
}

.chat-item--muted .chat-item__mute-indicator {
  color: color-mix(in srgb, var(--nc-text-secondary) 86%, var(--q-primary) 14%);
}

.chat-item__badges {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}

.chat-item__reaction-badge {
  min-height: 20px;
  padding: 1px 6px 1px 2px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--nc-reaction-accent-bg);
  border: 1px solid var(--nc-reaction-accent-border);
  color: var(--nc-reaction-accent-text);
}

.chat-item--muted .chat-item__reaction-badge {
  background: transparent;
  border-color: var(--nc-border);
  color: var(--nc-text-secondary);
}

.chat-item__reaction-icon-shell {
  width: 16px;
  height: 16px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--nc-reaction-accent-icon-bg);
}

.chat-item--muted .chat-item__reaction-icon-shell {
  background: var(--nc-hover);
}

.chat-item__reaction-icon {
  color: #ffffff;
}

.chat-item--muted .chat-item__reaction-icon {
  color: var(--nc-text-secondary);
}

.chat-item__reaction-count {
  display: inline-block;
  min-width: 1.3em;
  font-size: 11px;
  line-height: 1;
  font-weight: 800;
  letter-spacing: 0;
  font-variant-numeric: tabular-nums;
}

.chat-item__unread-badge {
  min-width: 20px;
  min-height: 20px;
  padding: 0 6px;
  justify-content: center;
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.chat-item__unread-badge--muted {
  background: transparent !important;
  border: 1px solid var(--nc-border);
  color: var(--nc-text-secondary) !important;
}

.q-btn.chat-item__more {
  min-width: 28px;
  min-height: 28px;
  color: var(--nc-text-secondary);
  background: transparent !important;
  box-shadow: none !important;
  opacity: 0;
  transition: color 0.2s ease, opacity 0.2s ease;
}

.q-btn.chat-item__more::before {
  border-color: transparent !important;
}

.q-btn.chat-item__more:hover {
  color: var(--nc-text);
  background: transparent !important;
  box-shadow: none !important;
  transform: none !important;
}

.chat-item:hover .chat-item__more,
.chat-item:focus-within .chat-item__more {
  opacity: 1;
}

.chat-item :deep(.q-item__section--avatar) {
  min-width: 56px;
  padding-right: 8px;
}

.chat-item :deep(.q-item__section--side) {
  padding-left: 6px;
}

.chat-item :deep(.q-item__label--caption) {
  color: var(--nc-text-secondary);
}

.chat-item :deep(.chat-item__avatar) {
  width: 48px;
  height: 48px;
  font-size: 21px;
}

.chat-item--active .chat-item__meta,
.chat-item--active :deep(.q-item__label--caption),
.chat-item--active .q-btn.chat-item__more {
  color: var(--nc-active-subtext);
}

.chat-item--active .chat-item__preview-author {
  color: var(--nc-active-text);
}

.chat-item--active .chat-item__reaction-badge {
  background: rgba(255, 255, 255, 0.16);
  border-color: rgba(255, 255, 255, 0.22);
  color: var(--nc-active-text);
}

.chat-item--active .chat-item__reaction-icon-shell {
  background: rgba(255, 255, 255, 0.22);
}

.chat-item--active .chat-item__unread-badge--muted {
  background: rgba(255, 255, 255, 0.08) !important;
  border-color: rgba(255, 255, 255, 0.24);
  color: var(--nc-active-text) !important;
}

@media (--nc-mobile-viewport) {
  .chat-item {
    font-family: var(--nc-mobile-font);
  }

  .chat-item__name {
    font-size: var(--nc-mobile-ui-font-size);
    font-weight: 600;
    line-height: var(--nc-mobile-ui-line-height);
    letter-spacing: 0;
  }

  .chat-item__caption {
    font-size: var(--nc-mobile-caption-font-size);
    font-weight: 400;
    line-height: var(--nc-mobile-caption-line-height);
    letter-spacing: 0;
  }

  .chat-item__time {
    font-size: var(--nc-mobile-small-font-size);
    font-weight: 400;
    line-height: var(--nc-mobile-small-line-height);
    letter-spacing: 0;
  }

  .q-btn.chat-item__more {
    opacity: 1;
  }

  .chat-item__reaction-count,
  .chat-item :deep(.q-badge) {
    font-size: var(--nc-mobile-small-font-size);
    line-height: 1;
    letter-spacing: 0;
  }
}
</style>
