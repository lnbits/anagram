<template>
  <div class="requests-page">
    <header class="requests-page__header">
      <div class="requests-page__heading">
        <q-btn
          v-if="showBackButton"
          flat
          dense
          round
          icon="arrow_back"
          :aria-label="$t('chat.backChats')"
          class="requests-page__back"
          @click="$emit('back')"
        />

        <div class="requests-page__copy">
          <div class="requests-page__eyebrow">{{ $t('chat.inboxReview') }}</div>
          <h1 class="requests-page__title">{{ $t('chat.requests') }}</h1>
          <p class="requests-page__subtitle">
            {{ $t('contacts.firstContactChatsStay') }}
          </p>
        </div>
      </div>

      <div class="requests-page__summary" :aria-label="$t('chat.pendingRequests.label')">
        <div class="requests-page__summary-count">{{ requestCount }}</div>
        <div class="requests-page__summary-label">{{ requestCountLabel }}</div>
      </div>
    </header>

    <div v-if="requests.length === 0" class="requests-page__empty">
      <div class="requests-page__empty-icon" aria-hidden="true">
        <q-icon name="mark_email_unread" size="30px" />
      </div>
      <div class="requests-page__empty-title">{{ $t('chat.pendingRequests.empty') }}</div>
      <div class="requests-page__empty-copy">{{ $t('chat.unknownInboundChatsAppear') }}</div>
    </div>

    <q-scroll-area v-else class="requests-page__scroll">
      <div class="requests-page__list">
        <ChatRequestItem
          v-for="chat in requests"
          :key="chat.id"
          :chat="chat"
          @open="emit('open', $event)"
          @accept="emit('accept', $event)"
          @delete-chat="emit('delete-chat', $event)"
          @block="emit('block', $event)"
        />
      </div>
    </q-scroll-area>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import ChatRequestItem from 'src/components/ChatRequestItem.vue';
import type { Chat } from 'src/types/chat';
import { t } from 'src/i18n';

const props = withDefaults(defineProps<{
  requests: Chat[];
  showBackButton?: boolean;
}>(), {
  showBackButton: false
});

const emit = defineEmits<{
  (event: 'back'): void;
  (event: 'open', chatId: string): void;
  (event: 'accept', chatId: string): void;
  (event: 'delete-chat', chatId: string): void;
  (event: 'block', chatId: string): void;
}>();

const requestCount = computed(() => props.requests.length);
const requestCountLabel = computed(() => {
  return requestCount.value === 1 ? t('chat.pendingChat') : t('chat.pendingChats');
});
</script>

<style scoped>
.requests-page {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  width: 100%;
  height: 100%;
  background:
    radial-gradient(circle at top right, rgba(79, 169, 230, 0.12), transparent 34%),
    var(--nc-panel-thread-bg);
}

.requests-page__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 24px 24px 20px;
  border-bottom: 1px solid var(--nc-border);
  background: color-mix(in srgb, var(--nc-panel-header-bg) 92%, white 8%);
}

.requests-page__heading {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}

.requests-page__back {
  margin-top: 2px;
  color: var(--nc-text-secondary);
}

.requests-page__copy {
  min-width: 0;
}

.requests-page__eyebrow {
  margin-bottom: 6px;
  color: color-mix(in srgb, var(--nc-text-secondary) 88%, #6b7f95 12%);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.requests-page__title {
  margin: 0;
  font-family: var(--nc-title-font);
  font-size: clamp(28px, 3vw, 36px);
  line-height: 1.05;
}

.requests-page__subtitle {
  max-width: 620px;
  margin: 8px 0 0;
  color: var(--nc-text-secondary);
  font-size: 15px;
  line-height: 1.45;
}

.requests-page__summary {
  flex: 0 0 auto;
  min-width: 112px;
  padding: 14px 16px;
  border: 1px solid color-mix(in srgb, var(--nc-border) 84%, #b8c9da 16%);
  border-radius: 20px;
  background: color-mix(in srgb, var(--nc-surface-soft-strong) 72%, white 28%);
  text-align: right;
}

.requests-page__summary-count {
  font-family: var(--nc-title-font);
  font-size: 28px;
  font-weight: 700;
  line-height: 1;
}

.requests-page__summary-label {
  margin-top: 6px;
  color: var(--nc-text-secondary);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.requests-page__scroll {
  flex: 1;
  min-height: 0;
}

.requests-page__list {
  display: grid;
  gap: 14px;
  padding: 22px 24px 28px;
}

.requests-page__empty {
  flex: 1;
  min-height: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 10px;
  padding: 32px 24px;
  text-align: center;
}

.requests-page__empty-icon {
  width: 72px;
  height: 72px;
  border-radius: 24px;
  display: grid;
  place-items: center;
  color: var(--q-primary);
  background: color-mix(in srgb, var(--nc-surface-soft-strong) 78%, white 22%);
  border: 1px solid color-mix(in srgb, var(--nc-border) 84%, #c4d4e4 16%);
}

.requests-page__empty-title {
  font-family: var(--nc-title-font);
  font-size: 20px;
  font-weight: 700;
}

.requests-page__empty-copy {
  max-width: 360px;
  color: var(--nc-text-secondary);
  line-height: 1.5;
}

@media (--nc-mobile-viewport) {
  .requests-page__header {
    padding: 16px 16px 18px;
  }

  .requests-page__title {
    font-size: 28px;
  }

  .requests-page__subtitle {
    font-size: 14px;
  }

  .requests-page__summary {
    min-width: 96px;
    padding: 12px 14px;
  }

  .requests-page__summary-count {
    font-size: 24px;
  }

  .requests-page__list {
    padding: 16px;
  }
}
</style>
