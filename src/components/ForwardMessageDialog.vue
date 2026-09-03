<template>
  <AppDialog
    v-model="dialogModel"
    :title="$t('message.forward.title')"
    :subtitle="$t('message.forward.subtitle')"
    :persistent="isSubmitting"
    max-width="460px"
    body-class="forward-dialog__body"
  >
    <q-input
      v-model="searchText"
      class="nc-input"
      data-testid="forward-message-search"
      dense
      outlined
      rounded
      autofocus
      clearable
      clear-icon="close"
      :placeholder="$t('message.forward.search')"
    >
      <template #prepend>
        <q-icon name="search" />
      </template>
    </q-input>

    <div class="forward-dialog__list" data-testid="forward-message-chat-list">
      <q-list v-if="filteredChats.length > 0" separator>
        <q-item
          v-for="chat in filteredChats"
          :key="chat.id"
          clickable
          class="forward-dialog__chat"
          data-testid="forward-message-chat"
          :data-chat-public-key="chat.publicKey.trim().toLowerCase()"
          :disable="isSubmitting"
          :aria-label="$t('message.forward.toChat', { name: chatDisplayName(chat) })"
          @click="selectChat(chat)"
        >
          <q-item-section avatar>
            <CachedAvatar
              :src="chatPicture(chat)"
              :alt="chatDisplayName(chat)"
              :fallback="chat.avatar"
              size="36px"
              bordered
            />
          </q-item-section>

          <q-item-section class="forward-dialog__chat-main">
            <q-item-label lines="1">{{ chatDisplayName(chat) }}</q-item-label>
            <q-item-label caption lines="1">{{ chatSubtitle(chat) }}</q-item-label>
          </q-item-section>

          <q-item-section v-if="chat.type === 'group'" side>
            <q-badge rounded color="primary" :label="$t('group.group')" />
          </q-item-section>
        </q-item>
      </q-list>

      <div v-else class="forward-dialog__empty-state">
        {{ emptyLabel }}
      </div>
    </div>

    <template #actions>
      <q-btn
        outline
        color="primary"
        no-caps
        :label="$t('common.cancel')"
        :disable="isSubmitting"
        @click="closeDialog"
      />
    </template>
  </AppDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppDialog from 'src/components/AppDialog.vue';
import CachedAvatar from 'src/components/CachedAvatar.vue';
import type { Chat } from 'src/types/chat';
import { t } from 'src/i18n';

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    chats: Chat[];
    isSubmitting?: boolean;
  }>(),
  {
    isSubmitting: false,
  }
);

const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void;
  (event: 'forward', chatId: string): void;
}>();

const searchText = ref('');

const dialogModel = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
});

const filteredChats = computed(() => {
  const query = searchText.value.trim().toLowerCase();
  if (!query) {
    return props.chats;
  }

  return props.chats.filter((chat) => {
    const displayName = chatDisplayName(chat).toLowerCase();
    return (
      displayName.includes(query) ||
      chat.name.toLowerCase().includes(query) ||
      chat.publicKey.toLowerCase().includes(query) ||
      chat.lastMessage.toLowerCase().includes(query)
    );
  });
});

const emptyLabel = computed(() => {
  return props.chats.length === 0 ? t('message.forward.empty') : t('message.forward.noMatches');
});

watch(
  () => props.modelValue,
  (isOpen) => {
    if (isOpen) {
      searchText.value = '';
    }
  }
);

function chatPicture(chat: Chat): string {
  const picture = chat.meta.picture;
  return typeof picture === 'string' ? picture.trim() : '';
}

function chatMetaString(chat: Chat, key: string): string {
  const value = chat.meta[key];
  return typeof value === 'string' ? value.trim() : '';
}

function chatDisplayName(chat: Chat): string {
  return (
    chatMetaString(chat, 'given_name') ||
    chatMetaString(chat, 'contact_name') ||
    chat.name.trim() ||
    chat.publicKey.slice(0, 32)
  );
}

function chatSubtitle(chat: Chat): string {
  return chat.lastMessage || chat.publicKey;
}

function selectChat(chat: Chat): void {
  if (props.isSubmitting) {
    return;
  }

  emit('forward', chat.id);
}

function closeDialog(): void {
  emit('update:modelValue', false);
}
</script>

<style scoped>
.forward-dialog__list {
  margin-top: 12px;
  max-height: min(52vh, 420px);
  overflow-y: auto;
  border: 1px solid var(--nc-border);
  border-radius: 8px;
  background: var(--nc-surface-soft);
}

.forward-dialog__chat {
  min-height: 58px;
  padding: 8px 10px;
}

.forward-dialog__chat-main {
  min-width: 0;
}

.forward-dialog__empty-state {
  padding: 18px;
  color: var(--nc-text-secondary);
  text-align: center;
}

</style>
