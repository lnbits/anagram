<template>
  <PullToRefreshScrollArea
    class="chat-list-scroll"
    :disable="refreshDisabled"
    @refresh="$emit('refresh', $event)"
  >
    <q-list>
      <q-item
        v-if="showRequestsRow"
        clickable
        class="requests-row"
        data-testid="requests-row"
        :active="requestsActive"
        active-class="requests-row--active"
        @click="$emit('open-requests')"
      >
        <q-item-section avatar>
          <div class="requests-row__icon-shell" aria-hidden="true">
            <q-icon name="mark_email_unread" size="18px" />
          </div>
        </q-item-section>

        <q-item-section class="requests-row__main">
          <q-item-label class="requests-row__title">
            {{ $t('chat.requests') }}
            <span class="requests-row__count">({{ formatRequestCount(requestCount) }})</span>
          </q-item-label>
          <q-item-label caption class="requests-row__caption" lines="1">
            {{ $t('message.unknownInboundChatsStay') }}
          </q-item-label>
        </q-item-section>
      </q-item>

      <ChatItem
        v-for="chat in chats"
        :key="chat.id"
        :chat="chat"
        :active="chat.id === selectedChatId"
        @select="$emit('select', $event)"
        @view-profile="$emit('view-profile', $event)"
        @refresh-profile="$emit('refresh-profile', $event)"
        @refresh-chat="$emit('refresh-chat', $event)"
        @mute="$emit('mute', $event)"
        @unmute="$emit('unmute', $event)"
        @block="$emit('block', $event)"
        @mark-as-read="$emit('mark-as-read', $event)"
        @delete-chat="$emit('delete-chat', $event)"
      />
    </q-list>
  </PullToRefreshScrollArea>
</template>

<script setup lang="ts">
import ChatItem from 'src/components/ChatItem.vue';
import PullToRefreshScrollArea from 'src/components/PullToRefreshScrollArea.vue';
import type { Chat } from 'src/types/chat';

const props = withDefaults(defineProps<{
  chats: Chat[];
  selectedChatId: string | null;
  showRequestsRow?: boolean;
  requestCount?: number;
  requestsActive?: boolean;
  refreshDisabled?: boolean;
}>(), {
  showRequestsRow: false,
  requestCount: 0,
  requestsActive: false,
  refreshDisabled: false
});

defineEmits<{
  (event: 'select', chatId: string): void;
  (event: 'view-profile', chatId: string): void;
  (event: 'refresh-profile', chatId: string): void;
  (event: 'refresh-chat', chatId: string): void;
  (event: 'mute', chatId: string): void;
  (event: 'unmute', chatId: string): void;
  (event: 'block', chatId: string): void;
  (event: 'mark-as-read', chatId: string): void;
  (event: 'delete-chat', chatId: string): void;
  (event: 'open-requests'): void;
  (event: 'refresh', done: () => void): void;
}>();

function formatRequestCount(value: number): string {
  const normalizedCount = Math.max(0, Math.floor(props.requestCount));
  return normalizedCount > 99 ? '99+' : String(normalizedCount);
}
</script>

<style scoped>
.chat-list-scroll {
  height: 100%;
  overflow-x: hidden;
}

.chat-list-scroll :deep(.q-scrollarea__container),
.chat-list-scroll :deep(.q-scrollarea__content),
.chat-list-scroll :deep(.q-list) {
  overflow-x: hidden !important;
  min-width: 0;
  width: 100%;
}

.requests-row {
  margin: 0;
  min-height: 56px;
  padding: 0 12px;
  border-radius: 0;
  border-bottom: 1px solid var(--nc-border);
  background: var(--nc-surface-soft);
  transition:
    border-color 0.2s ease,
    background-color 0.2s ease;
}

.requests-row:hover {
  background: var(--nc-hover);
}

.requests-row--active {
  border-color: var(--nc-border);
  background: var(--nc-active);
  color: var(--nc-active-text);
}

.requests-row__icon-shell {
  width: 42px;
  height: 42px;
  border-radius: 999px;
  display: grid;
  place-items: center;
  color: var(--nc-text);
  background: var(--nc-surface-soft-strong);
  border: 0;
}

.requests-row__main {
  min-width: 0;
}

.requests-row__title {
  font-weight: 600;
}

.requests-row__count {
  color: var(--nc-text-secondary);
}

.requests-row__caption {
  color: var(--nc-text-secondary);
}

.requests-row--active .requests-row__count,
.requests-row--active .requests-row__caption {
  color: var(--nc-active-subtext);
}

.requests-row--active .requests-row__icon-shell {
  color: var(--nc-active-text);
  background: rgba(255, 255, 255, 0.18);
}

@media (--nc-mobile-viewport) {
  .requests-row {
    font-family: var(--nc-mobile-font);
  }

  .requests-row__title {
    font-size: var(--nc-mobile-ui-font-size);
    font-weight: 600;
    line-height: var(--nc-mobile-ui-line-height);
    letter-spacing: 0;
  }

  .requests-row__caption {
    font-size: var(--nc-mobile-caption-font-size);
    font-weight: 400;
    line-height: var(--nc-mobile-caption-line-height);
    letter-spacing: 0;
  }
}
</style>
