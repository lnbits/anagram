<template>
  <q-page class="home-page" :style-fn="homePageStyleFn">
    <div
      ref="shellRef"
      class="home-shell"
      :class="{
        'home-shell--mobile': isMobile,
        'home-shell--mobile-keyboard': isMobile && isVisualViewportKeyboardVisible
      }"
      :style="homeShellStyle"
    >
      <aside v-if="!isMobile || !isMobileThreadOpen" class="sidebar">
        <div class="sidebar-top">
          <div class="sidebar-top__row">
            <q-input
              v-model="searchQuery"
              class="nc-input sidebar-top__search"
              data-testid="chat-list-search"
              dense
              outlined
              rounded
              clearable
              clear-icon="close"
              :placeholder="$t('common.search')"
            />
            <div class="sidebar-top__actions">
              <q-btn
                flat
                dense
                round
                icon="refresh"
                class="sidebar-top__action"
                data-testid="refresh-chats-button"
                :aria-label="$t('chat.refreshChats')"
                :loading="nostrStore.isReconnectHealing"
                :disable="nostrStore.isReconnectHealing"
                @click="handleRunReconnectHealing"
              />
              <q-btn
                flat
                dense
                round
                icon="group_add"
                class="sidebar-top__action"
                data-testid="start-new-chat-button"
                :aria-label="$t('chat.startNewChat')"
                :loading="isCreatingGroup"
              >
                <q-menu anchor="bottom right" self="top right" class="nc-pop-menu">
                  <q-list dense class="nc-pop-menu__list">
                    <q-item
                      clickable
                      v-close-popup
                      data-testid="start-new-chat-menu-item"
                      @click="handleNewChat"
                    >
                      <q-item-section>{{ $t('chat.newChat') }}</q-item-section>
                    </q-item>
                    <q-item
                      clickable
                      v-close-popup
                      data-testid="start-new-group-menu-item"
                      @click="handleNewGroup"
                    >
                      <q-item-section>{{ $t('group.newGroup') }}</q-item-section>
                    </q-item>
                  </q-list>
                </q-menu>
              </q-btn>
            </div>
          </div>

          <ReconnectHealingBanner class="sidebar-top__healing" />
          <StartupHistoryBanner class="sidebar-top__healing" />
        </div>

        <ChatList
          class="sidebar-list"
          :chats="sidebarChats"
          :selected-chat-id="selectedChatId"
          :show-requests-row="showRequestsRow"
          :request-count="requestCount"
          :requests-active="requestsRowActive"
          @select="handleSelectChat"
          @open-requests="handleOpenRequests"
          @view-profile="handleViewChatProfile"
          @refresh-profile="handleRefreshChatProfile"
          @refresh-chat="handleRefreshChat"
          @mute="handleMuteChat"
          @unmute="handleUnmuteChat"
          @block="handleBlockChat"
          @mark-as-read="handleMarkChatAsRead"
          @delete-chat="handleDeleteChat"
        />
        <AppNavRail
          v-if="!isMobile"
          class="sidebar-nav"
          active="chats"
          @select="handleRailSelect"
        />
      </aside>

      <div
        v-if="!isMobile"
        class="app-shell__resize-handle"
        role="separator"
        :aria-label="$t('common.resizeLeftPanel')"
        aria-orientation="vertical"
        :aria-valuemin="minSidebarWidth"
        :aria-valuemax="maxSidebarWidth"
        :aria-valuenow="sidebarWidth"
        tabindex="0"
        @pointerdown="startSidebarResize"
        @keydown="handleSidebarResizeKeydown"
      />

      <section
        v-if="!isMobile || isMobileThreadOpen"
        class="thread-panel"
        :class="{ 'thread-panel--mobile': isMobile }"
      >
        <ChatRequestsPage
          v-if="isRequestsRoute"
          :requests="requestChats"
          :show-back-button="isMobile"
          @back="handleBackToChatList"
          @open="handleOpenRequestChat"
          @accept="handleAcceptRequest"
          @delete-chat="handleDeleteChat"
          @block="handleBlockChat"
        />

        <ChatThread
          v-else
          :chat="activeChat"
          :messages="currentMessages"
          :is-initializing="isThreadInitializing"
          :show-back-button="isMobile"
          :show-reconnect-healing-banner="isMobile"
          :show-startup-history-banner="isMobile"
          :keyboard-visible="isVisualViewportKeyboardVisible"
          :mobile-viewport-height="visibleViewportHeight"
          @send="handleSend"
          @edit-message="handleEditMessage"
          @send-media="handleSendMedia"
          @back="handleBackToChatList"
          @open-profile="handleOpenProfile"
          @open-chat="handleOpenChat"
          @react="handleReactToMessage"
          @forward-message="handleOpenForwardMessage"
          @delete-message="handleDeleteMessage"
          @remove-reaction="handleRemoveReaction"
        />
      </section>

      <q-dialog v-model="isCreateGroupDialogOpen" :persistent="isCreatingGroup">
        <q-card class="create-group-dialog" data-testid="create-group-dialog">
          <q-card-section class="create-group-dialog__header">
            <div class="create-group-dialog__title">{{ $t('group.newGroup') }}</div>
          </q-card-section>

          <q-card-section>
            <q-input
              v-model="newGroupName"
              class="nc-input"
              data-testid="create-group-name-input"
              dense
              outlined
              rounded
              autofocus
              :label="$t('common.name')"
              @keydown.enter.prevent="handleConfirmNewGroup"
            />

            <q-input
              v-model="newGroupAbout"
              class="q-mt-sm nc-input"
              data-testid="create-group-about-input"
              dense
              outlined
              rounded
              :label="$t('common.about')"
            />
          </q-card-section>

          <q-card-actions align="right" class="create-group-dialog__actions">
            <q-btn
              flat
              :label="$t('common.cancel')"
              color="primary"
              :disable="isCreatingGroup"
              @click="closeCreateGroupDialog()"
            />
            <q-btn
              unelevated
              :label="$t('common.ok')"
              color="primary"
              data-testid="create-group-submit"
              :loading="isCreatingGroup"
              @click="handleConfirmNewGroup"
            />
          </q-card-actions>
        </q-card>
      </q-dialog>

      <ContactLookupDialog
        v-model="isNewChatDialogOpen"
        purpose="chat"
        @resolved="handleResolvedContactForNewChat"
      />

      <ForwardMessageDialog
        v-model="isForwardMessageDialogOpen"
        :chats="forwardTargetChats"
        :is-submitting="isForwardingMessage"
        @forward="handleForwardMessageToChat"
      />
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import ChatList from 'src/components/ChatList.vue';
import { useSectionShell } from 'src/composables/useSectionShell';
import { useVisibleViewportHeight } from 'src/composables/useVisibleViewportHeight';
import { clearAndroidRelayNotificationForChat } from 'src/services/androidRelayNotificationService';
import { useChatStore } from 'src/stores/chatStore';
import {
  isMissingContactRelaysError,
  useMessageStore
} from 'src/stores/messageStore';
import type {
  Message,
  MessageAttachmentMetadata,
  MessageReaction,
  MessageReplyPreview
} from 'src/types/chat';
import type { ContactRecord } from 'src/types/contact';
import { resolveContactAppRelayFallback } from 'src/utils/messageRelayFallback';
import { areMessageEditTimestampsEqual } from 'src/utils/messageEdits';
import { reportUiError } from 'src/utils/uiErrorHandler';
import ContactLookupDialog from 'src/components/ContactLookupDialog.vue';
import ReconnectHealingBanner from 'src/components/ReconnectHealingBanner.vue';
import StartupHistoryBanner from 'src/components/StartupHistoryBanner.vue';
import { useNostrStore } from 'src/stores/nostrStore';
import { t } from 'src/i18n';

const AppNavRail = defineAsyncComponent(() => import('src/components/AppNavRail.vue'));
const ChatRequestsPage = defineAsyncComponent(() => import('src/components/ChatRequestsPage.vue'));
const ChatThread = defineAsyncComponent(() => import('src/components/ChatThread.vue'));
const ForwardMessageDialog = defineAsyncComponent(
  () => import('src/components/ForwardMessageDialog.vue')
);

type NostrStore = ReturnType<typeof useNostrStore>;
type RelayStoreModule = typeof import('src/stores/relayStore');
type RelayStore = ReturnType<RelayStoreModule['useRelayStore']>;

interface OpenChatPayload {
  publicKey: string;
  displayName?: string;
  picture?: string;
}

const $q = useQuasar();
const route = useRoute();
const router = useRouter();
const chatStore = useChatStore();
const messageStore = useMessageStore();
const nostrStore = useNostrStore();
const {
  visibleViewportHeight,
  visibleViewportOffsetTop,
  visibleViewportKeyboardInset,
  isVisualViewportKeyboardVisible
} = useVisibleViewportHeight(() => $q.screen.height);
const {
  isMobile,
  shellRef,
  shellStyle,
  sidebarWidth,
  minSidebarWidth,
  maxSidebarWidth,
  startSidebarResize,
  handleSidebarResizeKeydown,
  buildPageStyle: homePageStyleFn,
  handleRailSelect
} = useSectionShell({
  activeSection: 'chats',
  errorContext: 'Failed to navigate from chats rail',
  resolveHeight: (height) => visibleViewportHeight.value ?? height
});
const isNewChatDialogOpen = ref(false);
const isCreateGroupDialogOpen = ref(false);
const isCreatingGroup = ref(false);
const isForwardMessageDialogOpen = ref(false);
const isForwardingMessage = ref(false);
const forwardingMessage = ref<Message | null>(null);
const newGroupName = ref('');
const newGroupAbout = ref('');
const isRequestsRoute = computed(() => route.name === 'chat-requests');
const activeChatId = computed(() => {
  const rawChatId = route.params.pubkey;
  if (Array.isArray(rawChatId)) {
    return rawChatId[0]?.trim().toLowerCase() ?? '';
  }

  return typeof rawChatId === 'string' ? rawChatId.trim().toLowerCase() : '';
});
const activeChat = computed(() => {
  return chatStore.chats.find((chat) => chat.id === activeChatId.value) ?? null;
});
const sidebarChats = computed(() => chatStore.visibleChats);
const forwardTargetChats = computed(() => chatStore.inboxChats);
const requestChats = computed(() => chatStore.requestChats);
const showRequestsRow = computed(() => chatStore.requestCount > 0 || isRequestsRoute.value);
const requestCount = computed(() => chatStore.requestCount);
const requestsRowActive = computed(() => {
  return isRequestsRoute.value || chatStore.isRequestChat(activeChatId.value);
});
const selectedChatId = computed(() => {
  if (isRequestsRoute.value || chatStore.isRequestChat(activeChatId.value)) {
    return null;
  }

  return activeChatId.value || null;
});
const isMobileThreadOpen = computed(() => {
  return isMobile.value && (isRequestsRoute.value || Boolean(activeChatId.value));
});
const chatIdSignature = computed(() => chatStore.chats.map((chat) => chat.id).join('|'));
const isThreadInitializing = computed(() => {
  return !chatStore.isLoaded;
});
const mobileViewportShellStyle = computed<Record<string, string>>(() => {
  if (!isMobile.value) {
    return {};
  }

  const viewportHeight = Math.max(0, visibleViewportHeight.value ?? $q.screen.height);
  const viewportOffsetTop = isVisualViewportKeyboardVisible.value
    ? Math.max(0, visibleViewportOffsetTop.value)
    : 0;

  return {
    '--nc-mobile-keyboard-inset': `${Math.max(0, visibleViewportKeyboardInset.value)}px`,
    '--nc-mobile-visual-viewport-offset-top': `${viewportOffsetTop}px`,
    height: `${viewportHeight}px`,
    minHeight: `${viewportHeight}px`,
    maxHeight: `${viewportHeight}px`,
    transform: viewportOffsetTop > 0 ? `translateY(${viewportOffsetTop}px)` : 'translateY(0)'
  };
});
const homeShellStyle = computed<Record<string, string>>(() => ({
  ...shellStyle.value,
  ...mobileViewportShellStyle.value
}));

const currentMessages = computed(() => {
  return messageStore.getMessages(activeChatId.value || null);
});

const searchQuery = computed({
  get: () => chatStore.searchQuery,
  set: (value: string | null) => chatStore.setSearchQuery(typeof value === 'string' ? value : '')
});
let nostrStorePromise: Promise<NostrStore> | null = null;
let relayStorePromise: Promise<RelayStore> | null = null;

async function getNostrStore(): Promise<NostrStore> {
  if (!nostrStorePromise) {
    nostrStorePromise = Promise.resolve(nostrStore);
  }

  return nostrStorePromise;
}

async function getRelayStore(): Promise<RelayStore> {
  if (!relayStorePromise) {
    relayStorePromise = import('src/stores/relayStore').then(({ useRelayStore }) => {
      const relayStore = useRelayStore();
      relayStore.init();
      return relayStore;
    });
  }

  return relayStorePromise;
}

function handleSelectChat(chatId: string): void {
  try {
    void router.push({ name: 'chats', params: { pubkey: chatId } });
  } catch (error) {
    reportUiError('Failed to select chat', error);
  }
}

function handleOpenRequests(): void {
  try {
    void router.push({ name: 'chat-requests' });
  } catch (error) {
    reportUiError('Failed to open requests page', error);
  }
}

function formatRelayList(relayUrls: string[]): string {
  return relayUrls.join(', ');
}

function notifyGroupSecretSave(result: Awaited<ReturnType<NostrStore['createGroupChat']>>): void {
  const { relayUrls, publishedRelayUrls, failedRelayUrls, errorMessage } = result.groupSecretSave;

  if (publishedRelayUrls.length > 0 && failedRelayUrls.length === 0) {
    $q.notify({
      type: 'positive',
      message: t('group.groupCreated'),
      caption: t('relays.identitySecretSaved', {
        relays: formatRelayList(publishedRelayUrls)
      }),
      position: 'top',
      timeout: 5000
    });
    return;
  }

  if (publishedRelayUrls.length > 0) {
    $q.notify({
      type: 'warning',
      message: t('relays.groupCreatedPartialRelay'),
      caption: t('relays.savedFailed', {
        savedRelays: formatRelayList(publishedRelayUrls),
        failedRelays: formatRelayList(failedRelayUrls)
      }),
      position: 'top',
      timeout: 6500
    });
    return;
  }

  $q.notify({
    type: 'warning',
    message: t('group.groupCreatedLocally'),
    caption:
      errorMessage ??
      (relayUrls.length > 0
        ? t('errors.saveIdentitySecret.withRelays', {
            relays: formatRelayList(relayUrls)
          })
        : t('errors.saveIdentitySecret')),
    position: 'top',
    timeout: 6500
  });
}

function handleNewChat(): void {
  try {
    isNewChatDialogOpen.value = true;
  } catch (error) {
    reportUiError('Failed to open new chat flow', error);
  }
}

async function handleResolvedContactForNewChat(contact: ContactRecord): Promise<void> {
  try {
    const contactPubkey = contact.public_key.trim();
    if (!contactPubkey) {
      return;
    }

    await chatStore.init();
    const fallbackName = contactPubkey.slice(0, 32);
    const chatName =
      contact.meta.display_name?.trim() ||
      contact.given_name?.trim() ||
      contact.name.trim() ||
      fallbackName;
    const chat = await chatStore.addContact(chatName, contactPubkey);
    if (!chat) {
      return;
    }

    chatStore.selectChat(chat.id);
    void router.push({ name: 'chats', params: { pubkey: chat.publicKey } });
  } catch (error) {
    reportUiError('Failed to open chat for resolved contact', error);
  }
}

function openCreateGroupDialog(): void {
  isCreateGroupDialogOpen.value = true;
}

function closeCreateGroupDialog(force = false): void {
  if (isCreatingGroup.value && !force) {
    return;
  }

  isCreateGroupDialogOpen.value = false;
  newGroupName.value = '';
  newGroupAbout.value = '';
}

function handleNewGroup(): void {
  try {
    openCreateGroupDialog();
  } catch (error) {
    reportUiError('Failed to open create group dialog', error);
  }
}

async function handleConfirmNewGroup(): Promise<void> {
  if (isCreatingGroup.value) {
    return;
  }

  isCreatingGroup.value = true;

  try {
    const [nostrStore, relayStore] = await Promise.all([getNostrStore(), getRelayStore()]);
    const createdGroup = await nostrStore.createGroupChat({
      name: newGroupName.value,
      about: newGroupAbout.value,
      relayUrls: relayStore.relays
    });

    notifyGroupSecretSave(createdGroup);

    if (createdGroup.memberListSyncError) {
      $q.notify({
        type: 'warning',
        message: t('group.groupCreatedMemberList'),
        caption: createdGroup.memberListSyncError,
        position: 'top',
        timeout: 6500
      });
    }

    if (createdGroup.contactListSyncError) {
      $q.notify({
        type: 'warning',
        message: t('group.groupCreatedContactList'),
        caption: createdGroup.contactListSyncError,
        position: 'top',
        timeout: 6500
      });
    }

    closeCreateGroupDialog(true);
    void router.push({
      name: 'contacts',
      params: { pubkey: createdGroup.groupPublicKey }
    });
  } catch (error) {
    reportUiError('Failed to create group from chats page', error, t('errors.failedCreateGroup'));
  } finally {
    isCreatingGroup.value = false;
  }
}

function getFallbackSidebarChatId(): string {
  return chatStore.inboxChats[0]?.id ?? '';
}

function getFallbackChatsRoute(): { name: 'chats'; params?: { pubkey: string } } | { name: 'chat-requests' } {
  const fallbackChatId = getFallbackSidebarChatId();
  if (fallbackChatId) {
    return {
      name: 'chats',
      params: { pubkey: fallbackChatId }
    };
  }

  if (chatStore.requestChats.length > 0) {
    return { name: 'chat-requests' };
  }

  return { name: 'chats' };
}

function handleOpenRequestChat(chatId: string): void {
  handleSelectChat(chatId);
}

async function resolveFallbackRelayUrls(
  chatPublicKey: string,
  fallbackName = activeChat.value?.name ?? ''
): Promise<string[] | null> {
  const relayStore = await getRelayStore();

  return resolveContactAppRelayFallback($q, chatPublicKey, relayStore.relays, {
    fallbackName,
  });
}

async function handleSend(payload: { text: string; replyTo: MessageReplyPreview | null }): Promise<void> {
  try {
    if (!activeChatId.value) {
      return;
    }

    let created;
    try {
      created = await messageStore.sendMessage(
        activeChatId.value,
        payload.text,
        payload.replyTo
      );
    } catch (error) {
      if (!isMissingContactRelaysError(error)) {
        throw error;
      }

      const fallbackRelayUrls = await resolveFallbackRelayUrls(error.chatPublicKey);
      if (!fallbackRelayUrls) {
        return;
      }

      created = await messageStore.sendMessage(
        activeChatId.value,
        payload.text,
        payload.replyTo,
        {
          relayUrls: fallbackRelayUrls
        }
      );
    }

    if (created) {
      await chatStore.updateChatPreview(activeChatId.value, created.text, created.sentAt, {
        messageMeta: created.meta
      });
      await chatStore.acceptChat(activeChatId.value, {
        lastOutgoingMessageAt: created.sentAt
      });
      clearAndroidChatNotification(activeChatId.value);
    }
  } catch (error) {
    reportUiError('Failed to send chat message', error, t('errors.failedSendMessage'));
  }
}

async function handleSendMedia(payload: {
  attachment: MessageAttachmentMetadata;
  replyTo: MessageReplyPreview | null;
}): Promise<void> {
  try {
    if (!activeChatId.value) {
      return;
    }

    let created;
    try {
      created = await messageStore.sendMediaAttachment(
        activeChatId.value,
        payload.attachment,
        payload.replyTo
      );
    } catch (error) {
      if (!isMissingContactRelaysError(error)) {
        throw error;
      }

      const fallbackRelayUrls = await resolveFallbackRelayUrls(error.chatPublicKey);
      if (!fallbackRelayUrls) {
        return;
      }

      created = await messageStore.sendMediaAttachment(
        activeChatId.value,
        payload.attachment,
        payload.replyTo,
        {
          relayUrls: fallbackRelayUrls
        }
      );
    }

    if (created) {
      await chatStore.updateChatPreview(activeChatId.value, created.text, created.sentAt, {
        messageMeta: created.meta
      });
      await chatStore.acceptChat(activeChatId.value, {
        lastOutgoingMessageAt: created.sentAt
      });
      clearAndroidChatNotification(activeChatId.value);
    }
  } catch (error) {
    reportUiError('Failed to send media attachment', error, t('errors.failedSendMessage'));
  }
}

async function handleEditMessage(payload: { message: Message; text: string }): Promise<void> {
  try {
    let updated;
    try {
      updated = await messageStore.editMessage(
        payload.message.chatId,
        payload.message.id,
        payload.text
      );
    } catch (error) {
      if (!isMissingContactRelaysError(error)) {
        throw error;
      }

      const fallbackRelayUrls = await resolveFallbackRelayUrls(error.chatPublicKey);
      if (!fallbackRelayUrls) {
        return;
      }

      updated = await messageStore.editMessage(
        payload.message.chatId,
        payload.message.id,
        payload.text,
        { relayUrls: fallbackRelayUrls }
      );
    }

    if (
      updated &&
      activeChat.value &&
      areMessageEditTimestampsEqual(activeChat.value.lastMessageAt, payload.message.sentAt)
    ) {
      await chatStore.updateChatPreview(updated.chatId, updated.text, updated.sentAt, {
        messageMeta: updated.meta,
      });
    }
    clearAndroidChatNotification(payload.message.chatId);
  } catch (error) {
    reportUiError('Failed to edit chat message', error, t('errors.failedSendMessage'));
  }
}

function handleOpenForwardMessage(message: Message): void {
  if (!message.text.trim()) {
    return;
  }

  forwardingMessage.value = message;
  isForwardMessageDialogOpen.value = true;
}

async function handleForwardMessageToChat(chatId: string): Promise<void> {
  const message = forwardingMessage.value;
  const targetChat = findChatById(chatId);
  if (!message || !targetChat || isForwardingMessage.value) {
    return;
  }

  isForwardingMessage.value = true;
  try {
    let created;
    try {
      created = await messageStore.forwardMessage(targetChat.id, message);
    } catch (error) {
      if (!isMissingContactRelaysError(error)) {
        throw error;
      }

      const fallbackRelayUrls = await resolveFallbackRelayUrls(
        error.chatPublicKey,
        targetChat.name
      );
      if (!fallbackRelayUrls) {
        return;
      }

      created = await messageStore.forwardMessage(targetChat.id, message, {
        relayUrls: fallbackRelayUrls,
      });
    }

    if (created) {
      await chatStore.updateChatPreview(targetChat.id, created.text, created.sentAt, {
        messageMeta: created.meta,
      });
      await chatStore.acceptChat(targetChat.id, {
        lastOutgoingMessageAt: created.sentAt,
      });
      clearAndroidChatNotification(targetChat.id);
      isForwardMessageDialogOpen.value = false;
      forwardingMessage.value = null;
      $q.notify({
        type: 'positive',
        message: t('message.forward.sent'),
        position: 'top',
        timeout: 1600,
      });
    }
  } catch (error) {
    reportUiError('Failed to forward message', error, t('errors.failedForwardMessage'));
  } finally {
    isForwardingMessage.value = false;
  }
}

async function handleReactToMessage(payload: { message: Message; emoji: string }): Promise<void> {
  try {
    try {
      await messageStore.addReaction(payload.message.chatId, payload.message.id, payload.emoji);
    } catch (error) {
      if (!isMissingContactRelaysError(error)) {
        throw error;
      }

      const fallbackRelayUrls = await resolveFallbackRelayUrls(error.chatPublicKey);
      if (!fallbackRelayUrls) {
        return;
      }

      await messageStore.addReaction(
        payload.message.chatId,
        payload.message.id,
        payload.emoji,
        {
          relayUrls: fallbackRelayUrls
        }
      );
    }
    clearAndroidChatNotification(payload.message.chatId);
  } catch (error) {
    reportUiError('Failed to add message reaction', error, t('errors.failedAddReaction'));
  }
}

async function handleDeleteMessage(message: Message): Promise<void> {
  try {
    await messageStore.deleteMessage(message.chatId, message.id);
    clearAndroidChatNotification(message.chatId);
  } catch (error) {
    reportUiError('Failed to delete message', error, t('errors.failedDeleteMessage'));
  }
}

async function handleRemoveReaction(payload: {
  message: Message;
  reaction: MessageReaction;
}): Promise<void> {
  try {
    await messageStore.removeReaction(
      payload.message.chatId,
      payload.message.id,
      payload.reaction
    );
    clearAndroidChatNotification(payload.message.chatId);
  } catch (error) {
    reportUiError('Failed to remove message reaction', error, t('errors.failedRemoveReaction'));
  }
}

function clearAndroidChatNotification(chatId: string): void {
  void clearAndroidRelayNotificationForChat(chatId).catch((error) => {
    console.warn('Failed to clear the active Android chat notification.', error);
  });
}

function handleOpenProfile(publicKey: string): void {
  try {
    const normalized = publicKey.trim();
    if (!normalized) {
      return;
    }

    void router.push({ name: 'contacts', params: { pubkey: normalized } });
  } catch (error) {
    reportUiError('Failed to open contact profile from chat', error);
  }
}

async function handleOpenChat(payload: OpenChatPayload): Promise<void> {
  try {
    const normalizedPublicKey = payload.publicKey.trim().toLowerCase();
    if (!normalizedPublicKey) {
      return;
    }

    await chatStore.init();
    const fallbackName = normalizedPublicKey.slice(0, 32);
    const displayName = payload.displayName?.trim() || fallbackName;
    const chat = await chatStore.addContact(displayName, normalizedPublicKey, {
      contactName: displayName,
      picture: payload.picture,
    });
    if (!chat) {
      return;
    }

    chatStore.selectChat(chat.id);
    await router.push({ name: 'chats', params: { pubkey: chat.publicKey } });
  } catch (error) {
    reportUiError('Failed to open chat from mention', error, t('errors.failedContinueChat'));
  }
}

function findChatById(chatId: string) {
  return chatStore.chats.find((chat) => chat.id === chatId) ?? null;
}

function handleViewChatProfile(chatId: string): void {
  try {
    const chat = findChatById(chatId);
    if (!chat) {
      return;
    }

    void router.push({ name: 'contacts', params: { pubkey: chat.publicKey } });
  } catch (error) {
    reportUiError('Failed to open profile from chat actions', error);
  }
}

async function handleRefreshChatProfile(chatId: string): Promise<void> {
  try {
    const chat = findChatById(chatId);
    if (!chat) {
      return;
    }

    const nostrStore = await getNostrStore();
    await nostrStore.refreshContactByPublicKey(chat.publicKey, chat.name, {
      refreshRelayList: true
    });
  } catch (error) {
    reportUiError('Failed to refresh chat contact profile', error, t('errors.failedRefreshProfile'));
  }
}

async function refreshChats(
  chatId = '',
  options: {
    lookbackMinutes?: number;
  } = {}
): Promise<void> {
  const nostrStore = await getNostrStore();

  if (typeof options.lookbackMinutes === 'number' && Number.isFinite(options.lookbackMinutes)) {
    await nostrStore.refreshPrivateMessages({
      lookbackMinutes: options.lookbackMinutes
    });
  } else {
    await nostrStore.subscribePrivateMessagesForLoggedInUser(true);
  }
  await chatStore.reload();

  const targetChatId = chatId.trim() || activeChatId.value;
  if (!targetChatId) {
    return;
  }

  const chat = findChatById(targetChatId);
  if (!chat) {
    return;
  }

  await messageStore.loadMessages(targetChatId, true);
}

async function handleRefreshChat(chatId: string): Promise<void> {
  try {
    const chat = findChatById(chatId);
    if (!chat) {
      return;
    }

    if (chat.type === 'group') {
      const nostrStore = await getNostrStore();
      await nostrStore.restorePrivateMessagesForRecipient(chat.publicKey, { force: true });
      await chatStore.reload();
      const refreshedChat = findChatById(chatId) ?? chat;
      if (refreshedChat.epochPublicKey) {
        await nostrStore.restoreGroupEpochHistory(refreshedChat.publicKey, refreshedChat.epochPublicKey, { force: true });
      }
      await chatStore.reload();
      await messageStore.loadMessages(chatId, true);
      return;
    }

    await refreshChats(chatId);
  } catch (error) {
    reportUiError('Failed to refresh chat', error, t('errors.failedRefreshChat'));
  }
}

async function handleRunReconnectHealing(): Promise<void> {
  try {
    await nostrStore.runReconnectHealing('manual-refresh', {
      propagateError: true,
    });
  } catch (error) {
    reportUiError('Failed to run reconnect healing manually', error, t('errors.failedRefreshChats'));
  }
}

async function handleAcceptRequest(chatId: string): Promise<void> {
  try {
    const chat = findChatById(chatId);
    await chatStore.acceptChat(chatId);
    if (!chat) {
      return;
    }

    try {
      const nostrStore = await getNostrStore();
      const requestType =
        chat.meta && typeof chat.meta.request_type === 'string'
          ? chat.meta.request_type.trim()
          : '';
      if (requestType === 'group_invite') {
        await nostrStore.ensureGroupInvitePubkeyIsContact(chat.publicKey, chat.name);
      } else {
        await nostrStore.ensureRespondedPubkeyIsContact(chat.publicKey, chat.name);
      }
    } catch (error) {
      console.warn('Failed to add accepted chat to contacts', chat.publicKey, error);
    }
  } catch (error) {
    reportUiError('Failed to accept chat request', error, t('errors.failedAcceptRequest'));
  }
}

async function handleMuteChat(chatId: string): Promise<void> {
  try {
    const relayStore = await getRelayStore();
    await nostrStore.mutePubkey(chatId, relayStore.relays);
  } catch (error) {
    reportUiError('Failed to mute chat', error);
  }
}

async function handleUnmuteChat(chatId: string): Promise<void> {
  try {
    const relayStore = await getRelayStore();
    await nostrStore.unmutePubkey(chatId, relayStore.relays);
  } catch (error) {
    reportUiError('Failed to unmute chat', error);
  }
}

async function handleMarkChatAsRead(chatId: string): Promise<void> {
  try {
    const readCursor = await chatStore.markAsRead(chatId);
    if (readCursor) {
      nostrStore.scheduleContactCursorPublish(chatId, readCursor);
    }
  } catch (error) {
    reportUiError('Failed to mark chat as read', error);
  }
}

async function handleDeleteChat(chatId: string): Promise<void> {
  try {
    const isActiveChat = activeChatId.value === chatId;
    const deleted = await chatStore.deleteChat(chatId);
    if (deleted) {
      messageStore.removeChatMessages(chatId);

      if (isActiveChat) {
        if (!isMobile.value) {
          void router.replace(getFallbackChatsRoute());
        } else {
          void router.replace({ name: 'chats' });
        }
      }
    }
  } catch (error) {
    reportUiError('Failed to delete chat', error);
  }
}

async function handleBlockChat(chatId: string): Promise<void> {
  try {
    const chat = findChatById(chatId);
    const isActiveChat = activeChatId.value === chatId;
    const relayStore = await getRelayStore();
    await nostrStore.blockPubkey(chatId, relayStore.relays, {
      fallbackName: chat?.name ?? '',
      type: chat?.type ?? 'user'
    });

    if (isActiveChat) {
      if (!isMobile.value) {
        void router.replace(getFallbackChatsRoute());
      } else {
        void router.replace({ name: 'chats' });
      }
    }
  } catch (error) {
    reportUiError('Failed to block chat request', error, t('errors.failedBlockRequest'));
  }
}

function handleBackToChatList(): void {
  try {
    void router.push({ name: 'chats' });
  } catch (error) {
    reportUiError('Failed to navigate back to chat list', error);
  }
}

async function syncChatRoute(): Promise<void> {
  try {
    await chatStore.init();

    if (isRequestsRoute.value) {
      return;
    }

    const chatId = activeChatId.value;
    if (!chatId) {
      if (isMobile.value) {
        return;
      }

      await router.replace(getFallbackChatsRoute());
      return;
    }

    const matchingChat = chatStore.chats.find((chat) => chat.id === chatId) ?? null;
    const isBlockedChat =
      matchingChat !== null &&
      !chatStore.inboxChats.some((chat) => chat.id === chatId) &&
      !chatStore.requestChats.some((chat) => chat.id === chatId);
    if (!matchingChat || isBlockedChat) {
      if (!isMobile.value) {
        await router.replace(getFallbackChatsRoute());
      } else {
        await router.replace({ name: 'chats' });
      }
      return;
    }

    if (chatStore.selectedChatId !== chatId) {
      chatStore.selectChat(chatId);
    }

    await messageStore.init();
    await messageStore.loadMessages(chatId);
  } catch (error) {
    reportUiError('Failed to synchronize chat route', error);
  }
}

watch([activeChatId, isMobile, chatIdSignature, isRequestsRoute], () => {
  void syncChatRoute();
}, { immediate: true });

watch(isForwardMessageDialogOpen, (isOpen) => {
  if (!isOpen && !isForwardingMessage.value) {
    forwardingMessage.value = null;
  }
});
</script>

<style scoped>
.home-page {
  padding: 0;
  overflow: hidden;
  overscroll-behavior: none;
  width: 100%;
  max-width: 100%;
  background: var(--nc-app-background);
}

.home-shell {
  position: relative;
  display: grid;
  grid-template-columns: var(--desktop-sidebar-width, 360px) 0px minmax(0, 1fr);
  gap: 0;
  height: 100%;
  min-height: 0;
  width: 100%;
  max-width: 100%;
  background: var(--nc-panel-thread-bg);
  overscroll-behavior: none;
}

.home-shell--mobile {
  grid-template-columns: 1fr;
}

.sidebar,
.thread-panel {
  overflow: hidden;
  overscroll-behavior: none;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}

.sidebar {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--nc-panel-sidebar-bg);
  border-right: 0;
}

.sidebar-list {
  flex: 1;
  min-height: 0;
}

.sidebar-top {
  position: relative;
  padding: 12px;
  border-bottom: 1px solid var(--nc-border);
  background: var(--nc-panel-header-bg);
}

.sidebar-top__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 0;
}

.sidebar-top__search {
  flex: 1;
  min-width: 0;
}

.sidebar-top__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  flex-shrink: 0;
}

.sidebar-top__action {
  flex-shrink: 0;
}

@media (--nc-desktop-viewport) {
  .sidebar-top .sidebar-top__healing.reconnect-healing-banner--expanded,
  .sidebar-top .sidebar-top__healing.startup-history-banner--expanded {
    margin-right: -12px;
    margin-bottom: -13px;
    margin-left: -12px;
  }
}

body.body--dark .q-btn.sidebar-top__action {
  color: var(--nc-text-secondary) !important;
}

.create-group-dialog {
  width: min(420px, calc(100vw - 32px));
  border-radius: 12px;
}

.create-group-dialog__header {
  padding-bottom: 8px;
}

.create-group-dialog__title {
  font-size: 18px;
  font-weight: 700;
}

.create-group-dialog__actions {
  padding: 0 16px 16px;
}

.thread-panel {
  display: flex;
  min-height: 0;
  min-width: 0;
  width: 100%;
  background: var(--nc-panel-thread-bg);
}

.sidebar-nav {
  border-top: 1px solid var(--nc-border);
}

@media (--nc-mobile-viewport) {
  .sidebar-top {
    font-family: var(--nc-mobile-font);
  }

  .sidebar {
    border-right: 0;
  }

  .thread-panel--mobile {
    border-bottom: 0;
  }
}

</style>
