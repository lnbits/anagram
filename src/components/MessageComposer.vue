<template>
  <div class="composer">
    <div
      v-if="isMentionAutocompleteVisible"
      class="composer__autocomplete"
      role="listbox"
      :aria-label="$t('message.mentionSuggestions')"
    >
      <button
        v-for="(entry, index) in mentionAutocompleteEntries"
        :key="entry.publicKey"
        type="button"
        class="composer__autocomplete-option"
        :class="{ 'composer__autocomplete-option--active': index === activeMentionAutocompleteIndex }"
        :aria-selected="index === activeMentionAutocompleteIndex ? 'true' : 'false'"
        data-testid="message-mention-option"
        @mousedown.prevent
        @click="handleMentionAutocompleteSelect(entry)"
      >
        <CachedAvatar
          :src="entry.picture ?? ''"
          :alt="entry.displayName"
          :fallback="entry.avatar || entry.displayName.slice(0, 2).toUpperCase()"
          class="composer__mention-avatar"
          aria-hidden="true"
        />
        <span class="composer__mention-copy">
          <span class="composer__mention-name">{{ entry.displayName }}</span>
          <span class="composer__mention-handle">@{{ entry.handle }}</span>
        </span>
      </button>

      <div v-if="mentionAutocompleteEntries.length === 0" class="composer__autocomplete-empty">
        {{ $t('message.mentionFound') }}
      </div>
    </div>

    <div
      v-if="isEmojiAutocompleteVisible"
      class="composer__autocomplete"
      role="listbox"
      :aria-label="$t('message.emojiSuggestions')"
    >
      <button
        v-for="(entry, index) in emojiAutocompleteEntries"
        :key="`${entry.emoji}-${entry.label}`"
        type="button"
        class="composer__autocomplete-option"
        :class="{ 'composer__autocomplete-option--active': index === activeEmojiAutocompleteIndex }"
        :aria-selected="index === activeEmojiAutocompleteIndex ? 'true' : 'false'"
        @mousedown.prevent
        @click="handleEmojiAutocompleteSelect(entry.emoji)"
      >
        <span class="composer__emoji-option-char">{{ entry.emoji }}</span>
        <span class="composer__emoji-option-label">{{ entry.label }}</span>
      </button>

      <div v-if="emojiAutocompleteEntries.length === 0" class="composer__autocomplete-empty">
        {{ $t('message.emojiFound') }}
      </div>
    </div>

    <div v-if="replyTo" class="composer__reply">
      <div class="composer__reply-accent" aria-hidden="true" />
      <div class="composer__reply-copy">
        <div class="composer__reply-title">{{ $t('message.reply.toName', { name: replyTo.authorName }) }}</div>
        <div class="composer__reply-text">{{ replyTo.text }}</div>
      </div>
      <q-btn
        flat
        dense
        round
        icon="close"
        :aria-label="$t('message.cancelReply')"
        class="composer__reply-close"
        @click="$emit('cancel-reply')"
      />
    </div>

    <div class="composer__row">
      <input
        ref="mediaFileInputRef"
        class="composer__file-input"
        type="file"
        accept="image/*,video/*,audio/*"
        @change="handleMediaFileInputChange"
      />

      <q-input
        ref="inputRef"
        v-model="draft"
        class="composer__input nc-input"
        data-testid="message-composer-input"
        dense
        outlined
        rounded
        autogrow
        :placeholder="$t('relays.writeMessage')"
        @update:model-value="handleDraftUpdate"
        @focus="rememberSelection"
        @click="rememberSelection"
        @keyup="rememberSelection"
        @select="rememberSelection"
        @keydown.enter.exact="handleEnterKey"
        @keydown.down="handleAutocompleteArrowDown"
        @keydown.up="handleAutocompleteArrowUp"
        @keydown.tab="handleAutocompleteTab"
        @keydown.esc="handleAutocompleteEscape"
        @paste="handleComposerPaste"
        @dragover="handleComposerDragOver"
        @drop="handleComposerDrop"
      >
        <template #prepend>
          <q-btn
            flat
            dense
            icon="attach_file"
            class="composer__menu-trigger"
            data-testid="message-composer-menu"
            :aria-label="$t('message.openComposerMenu')"
            @click="rememberSelection"
          >
            <q-menu
              v-model="isComposerMenuOpen"
              anchor="top left"
              self="bottom left"
              class="nc-pop-menu"
            >
              <q-list dense class="composer__menu-list">
                <q-item clickable v-close-popup @click="handlePhotoVideoAction">
                  <q-item-section avatar class="composer__menu-icon">
                    <q-icon name="photo_library" />
                  </q-item-section>
                  <q-item-section>{{ $t('message.photoOrVideo') }}</q-item-section>
                </q-item>

                <q-item clickable v-close-popup @click="handleFileAction">
                  <q-item-section avatar class="composer__menu-icon">
                    <q-icon name="insert_drive_file" />
                  </q-item-section>
                  <q-item-section>{{ $t('message.file') }}</q-item-section>
                </q-item>
              </q-list>
            </q-menu>
          </q-btn>
        </template>

        <template #append>
          <q-btn
            flat
            dense
            round
            icon="sentiment_satisfied"
            class="composer__emoji-trigger"
            data-testid="message-composer-emoji"
            :aria-label="$t('message.emoji')"
            @click="handleEmojiAction"
          >
            <q-menu
              v-model="isEmojiMenuOpen"
              no-parent-event
              anchor="top right"
              self="bottom right"
              class="nc-pop-menu"
              @show="handleEmojiMenuShow"
              @hide="handleEmojiMenuHide"
            >
              <EmojiPickerPanel
                ref="emojiPickerRef"
                width="360px"
                max-height="300px"
                :columns="6"
                item-min-height="42px"
                item-padding="10px 6px"
                @select="insertEmoji"
              />
            </q-menu>
          </q-btn>
        </template>
      </q-input>

      <q-btn
        color="primary"
        :icon="sendButtonIcon"
        class="composer__send"
        data-testid="message-composer-send"
        :aria-label="$t('message.sendMessage')"
        @touchstart.prevent.stop="handleSendTouchStart"
        @click="handleSendClick"
      />
    </div>

    <AppDialog
      v-model="isMediaPrivacyDialogOpen"
      :title="$t('message.photoOrVideo')"
      :persistent="isNostrBuildAuthInProgress"
      :show-close="!isNostrBuildAuthInProgress"
      max-width="420px"
    >
      <div class="composer__media-warning">
        <div>{{ $t('message.mediaUrlWarning') }}</div>
        <div>{{ $t('message.mediaUpload.usingNostrBuild') }}</div>
      </div>

      <q-linear-progress
        v-if="isNostrBuildAuthInProgress"
        indeterminate
        rounded
        color="primary"
        class="composer__dialog-progress"
      />

      <template #actions>
        <q-btn
          flat
          no-caps
          :disable="isNostrBuildAuthInProgress"
          :label="$t('common.cancel')"
          @click="handleMediaConsentCancel"
        />
        <q-btn
          unelevated
          no-caps
          color="primary"
          :loading="isNostrBuildAuthInProgress"
          :label="$t('common.ok')"
          @click="handleMediaConsentConfirm"
        />
      </template>
    </AppDialog>

    <AppDialog
      v-model="isMediaUploadDialogOpen"
      :title="$t('message.mediaUpload.title')"
      :persistent="isMediaUploadInProgress"
      :show-close="!isMediaUploadInProgress"
      max-width="420px"
    >
      <div class="composer__media-upload">
        <q-linear-progress
          :indeterminate="isMediaUploadInProgress"
          rounded
          color="primary"
          class="composer__dialog-progress"
        />
        <div class="composer__media-upload-status">
          {{ mediaUploadStatusMessage }}
        </div>
      </div>

      <template v-if="mediaUploadError" #actions>
        <q-btn
          unelevated
          no-caps
          color="primary"
          :label="$t('common.ok')"
          @click="isMediaUploadDialogOpen = false"
        />
      </template>
    </AppDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import AppDialog from 'src/components/AppDialog.vue';
import CachedAvatar from 'src/components/CachedAvatar.vue';
import EmojiPickerPanel from 'src/components/EmojiPickerPanel.vue';
import { TOP_500_EMOJIS, filterEmojiEntries, type EmojiOption } from 'src/data/topEmojis';
import { t } from 'src/i18n';
import {
  uploadNostrBuildMedia,
  validateNostrBuildMediaFile,
} from 'src/services/nostrBuildUploadService';
import { useChatStore } from 'src/stores/chatStore';
import { useNostrStore } from 'src/stores/nostrStore';
import type { MessageAttachmentMetadata, MessageReplyPreview } from 'src/types/chat';
import {
  hasImageTransferFile,
  hasTransferFiles,
  hasTransferText,
  readFirstImageTransferFile,
} from 'src/utils/mediaTransfer';
import { serializeMentionDraft, type NostrMentionProfile } from 'src/utils/nostrMentions';
import { reportUiError } from 'src/utils/uiErrorHandler';

const props = defineProps<{
  chatId?: string | null;
  mentionProfiles?: NostrMentionProfile[];
  replyTo?: MessageReplyPreview | null;
}>();

const $q = useQuasar();
const chatStore = useChatStore();
const nostrStore = useNostrStore();
const draft = ref('');
const inputRef = ref<{ $el: HTMLElement } | null>(null);
const mediaFileInputRef = ref<HTMLInputElement | null>(null);
const selectionStart = ref<number | null>(null);
const selectionEnd = ref<number | null>(null);
const emojiPickerRef = ref<{ reset: () => void } | null>(null);
const isComposerMenuOpen = ref(false);
const isEmojiMenuOpen = ref(false);
const isMediaPrivacyDialogOpen = ref(false);
const isNostrBuildAuthInProgress = ref(false);
const isMediaUploadDialogOpen = ref(false);
const isMediaUploadInProgress = ref(false);
const pendingInlineMediaFile = ref<File | null>(null);
const mediaUploadStatus = ref<'uploading' | 'sending'>('uploading');
const mediaUploadError = ref('');
const shouldRefocusAfterEmojiMenuHide = ref(false);
const activeMentionAutocompleteIndex = ref(0);
const activeEmojiAutocompleteIndex = ref(0);
const dismissedMentionAutocompleteToken = ref('');
const dismissedEmojiAutocompleteToken = ref('');
const MAX_MENTION_AUTOCOMPLETE_RESULTS = 8;
const MAX_EMOJI_AUTOCOMPLETE_RESULTS = 8;
let suppressNextSendClick = false;

const emit = defineEmits<{
  (event: 'send', payload: { text: string }): void;
  (event: 'send-media', payload: { attachment: MessageAttachmentMetadata }): void;
  (event: 'cancel-reply'): void;
}>();

function normalizeChatIdentifier(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalizedValue = value.trim().toLowerCase();
  return normalizedValue || null;
}

const activeChatId = computed(() => normalizeChatIdentifier(props.chatId));
const sendButtonIcon = computed(() => ($q.screen.lt.md ? 'north' : 'send'));
const mentionProfiles = computed(() => props.mentionProfiles ?? []);
const mediaUploadStatusMessage = computed(() => {
  if (mediaUploadError.value) {
    return mediaUploadError.value;
  }

  return mediaUploadStatus.value === 'sending'
    ? t('message.mediaUpload.sending')
    : t('message.mediaUpload.uploading');
});

function setDraftValue(nextDraft: string, options: { persist?: boolean } = {}): void {
  draft.value = nextDraft;

  if (options.persist === false || !activeChatId.value) {
    return;
  }

  chatStore.setComposerDraft(activeChatId.value, nextDraft);
}

function getInputElement(): HTMLInputElement | HTMLTextAreaElement | null {
  return inputRef.value?.$el.querySelector('textarea, input') ?? null;
}

function focusInputAt(nextCursor: number): void {
  void nextTick(() => {
    window.setTimeout(() => {
      const inputElement = getInputElement();

      if (!inputElement) {
        return;
      }

      inputElement.focus();
      inputElement.setSelectionRange(nextCursor, nextCursor);
      selectionStart.value = nextCursor;
      selectionEnd.value = nextCursor;
    }, 0);
  });
}

function rememberSelection(): void {
  try {
    const inputElement = getInputElement();

    if (!inputElement) {
      return;
    }

    selectionStart.value = inputElement.selectionStart ?? draft.value.length;
    selectionEnd.value = inputElement.selectionEnd ?? draft.value.length;
  } catch (error) {
    reportUiError('Failed to track message input cursor', error);
  }
}

function handleDraftUpdate(): void {
  if (activeChatId.value) {
    chatStore.setComposerDraft(activeChatId.value, draft.value);
  }

  void nextTick(() => {
    rememberSelection();
  });
}

interface EmojiAutocompleteMatch {
  start: number;
  end: number;
  query: string;
}

interface MentionAutocompleteMatch {
  start: number;
  end: number;
  query: string;
}

const mentionAutocompleteMatch = computed<MentionAutocompleteMatch | null>(() => {
  const start = selectionStart.value ?? draft.value.length;
  const end = selectionEnd.value ?? start;
  if (start !== end || mentionProfiles.value.length === 0) {
    return null;
  }

  const beforeCursor = draft.value.slice(0, start);
  const atIndex = beforeCursor.lastIndexOf('@');
  if (atIndex < 0) {
    return null;
  }

  if (atIndex > 0) {
    const previousChar = beforeCursor.charAt(atIndex - 1);
    if (!/[\s([{]/u.test(previousChar)) {
      return null;
    }
  }

  const tokenQuery = beforeCursor.slice(atIndex + 1);
  if (/\s/u.test(tokenQuery)) {
    return null;
  }

  return {
    start: atIndex,
    end: start,
    query: tokenQuery
  };
});

const mentionAutocompleteEntries = computed<NostrMentionProfile[]>(() => {
  const match = mentionAutocompleteMatch.value;
  if (!match) {
    return [];
  }

  const normalizedQuery = match.query.trim().toLowerCase();
  const sortedProfiles = mentionProfiles.value
    .slice()
    .sort((first, second) => first.displayName.localeCompare(second.displayName));

  const filteredProfiles = normalizedQuery
    ? sortedProfiles.filter((profile) => {
        return [
          profile.displayName,
          profile.handle,
          profile.publicKey
        ].some((value) => value.toLowerCase().includes(normalizedQuery));
      })
    : sortedProfiles;

  return filteredProfiles.slice(0, MAX_MENTION_AUTOCOMPLETE_RESULTS);
});

const emojiAutocompleteMatch = computed<EmojiAutocompleteMatch | null>(() => {
  const start = selectionStart.value ?? draft.value.length;
  const end = selectionEnd.value ?? start;
  if (start !== end) {
    return null;
  }

  const beforeCursor = draft.value.slice(0, start);
  const colonIndex = beforeCursor.lastIndexOf(':');
  if (colonIndex < 0) {
    return null;
  }

  if (colonIndex > 0) {
    const previousChar = beforeCursor.charAt(colonIndex - 1);
    if (!/[\s([{]/u.test(previousChar)) {
      return null;
    }
  }

  const tokenQuery = beforeCursor.slice(colonIndex + 1);
  if (/\s/u.test(tokenQuery)) {
    return null;
  }

  return {
    start: colonIndex,
    end: start,
    query: tokenQuery
  };
});

const emojiAutocompleteEntries = computed<EmojiOption[]>(() => {
  const match = emojiAutocompleteMatch.value;
  if (!match || isEmojiMenuOpen.value) {
    return [];
  }

  const entries = match.query.trim()
    ? filterEmojiEntries(match.query)
    : TOP_500_EMOJIS;
  return entries.slice(0, MAX_EMOJI_AUTOCOMPLETE_RESULTS);
});

const isEmojiAutocompleteVisible = computed(() => {
  const match = emojiAutocompleteMatch.value;
  if (!match || isEmojiMenuOpen.value) {
    return false;
  }

  return dismissedEmojiAutocompleteToken.value !== `${match.start}:${match.query}`;
});

const isMentionAutocompleteVisible = computed(() => {
  const match = mentionAutocompleteMatch.value;
  if (!match) {
    return false;
  }

  return dismissedMentionAutocompleteToken.value !== `${match.start}:${match.query}`;
});

watch(
  mentionAutocompleteEntries,
  (entries) => {
    if (entries.length === 0) {
      activeMentionAutocompleteIndex.value = 0;
      return;
    }

    activeMentionAutocompleteIndex.value = Math.min(
      activeMentionAutocompleteIndex.value,
      entries.length - 1
    );
  },
  { immediate: true }
);

watch(mentionAutocompleteMatch, () => {
  activeMentionAutocompleteIndex.value = 0;
  const match = mentionAutocompleteMatch.value;
  if (!match) {
    dismissedMentionAutocompleteToken.value = '';
    return;
  }

  const tokenKey = `${match.start}:${match.query}`;
  if (dismissedMentionAutocompleteToken.value !== tokenKey) {
    dismissedMentionAutocompleteToken.value = '';
  }
});

watch(
  emojiAutocompleteEntries,
  (entries) => {
    if (entries.length === 0) {
      activeEmojiAutocompleteIndex.value = 0;
      return;
    }

    activeEmojiAutocompleteIndex.value = Math.min(
      activeEmojiAutocompleteIndex.value,
      entries.length - 1
    );
  },
  { immediate: true }
);

watch(emojiAutocompleteMatch, () => {
  activeEmojiAutocompleteIndex.value = 0;
  const match = emojiAutocompleteMatch.value;
  if (!match) {
    dismissedEmojiAutocompleteToken.value = '';
    return;
  }

  const tokenKey = `${match.start}:${match.query}`;
  if (dismissedEmojiAutocompleteToken.value !== tokenKey) {
    dismissedEmojiAutocompleteToken.value = '';
  }
});

watch(isMediaPrivacyDialogOpen, (isOpen) => {
  if (!isOpen && !isNostrBuildAuthInProgress.value) {
    pendingInlineMediaFile.value = null;
  }
});

function replaceDraftRange(start: number, end: number, replacement: string): void {
  setDraftValue(`${draft.value.slice(0, start)}${replacement}${draft.value.slice(end)}`);
  const nextCursor = start + replacement.length;
  selectionStart.value = nextCursor;
  selectionEnd.value = nextCursor;
  focusInputAt(nextCursor);
}

function insertEmoji(emoji: string): void {
  try {
    const start = selectionStart.value ?? draft.value.length;
    const end = selectionEnd.value ?? draft.value.length;
    replaceDraftRange(start, end, emoji);
    shouldRefocusAfterEmojiMenuHide.value = true;
  } catch (error) {
    reportUiError('Failed to insert emoji', error);
  }
}

function handleEmojiMenuShow(): void {
  void nextTick(() => {
    emojiPickerRef.value?.reset();
  });
}

function handleEmojiMenuHide(): void {
  if (!shouldRefocusAfterEmojiMenuHide.value) {
    return;
  }

  shouldRefocusAfterEmojiMenuHide.value = false;
  focusInputAt(selectionStart.value ?? draft.value.length);
}

function handlePhotoVideoAction(): void {
  isComposerMenuOpen.value = false;
  openMediaPrivacyDialog();
}

function resetMediaFileInput(): void {
  if (mediaFileInputRef.value) {
    mediaFileInputRef.value.value = '';
  }
}

function openMediaFileBrowser(): void {
  resetMediaFileInput();
  mediaFileInputRef.value?.click();
}

function openMediaPrivacyDialog(file: File | null = null): void {
  if (isNostrBuildAuthInProgress.value || isMediaUploadInProgress.value) {
    return;
  }

  if (file) {
    const validationError = validateNostrBuildMediaFile(file);
    if (validationError) {
      $q.notify({
        type: 'warning',
        message: validationError,
        position: 'top',
      });
      return;
    }
  }

  pendingInlineMediaFile.value = file;
  isMediaPrivacyDialogOpen.value = true;
}

function handleMediaConsentCancel(): void {
  if (isNostrBuildAuthInProgress.value) {
    return;
  }

  pendingInlineMediaFile.value = null;
  isMediaPrivacyDialogOpen.value = false;
}

async function handleMediaConsentConfirm(): Promise<void> {
  if (isNostrBuildAuthInProgress.value) {
    return;
  }

  isNostrBuildAuthInProgress.value = true;
  try {
    await nostrStore.ensureNostrBuildUploadAuthentication();
    const inlineFile = pendingInlineMediaFile.value;
    pendingInlineMediaFile.value = null;
    isMediaPrivacyDialogOpen.value = false;
    if (inlineFile) {
      void uploadAndSendMediaFile(inlineFile);
      return;
    }

    void nextTick(() => {
      openMediaFileBrowser();
    });
  } catch (error) {
    reportUiError('Failed to authenticate nostr.build upload', error);
    $q.notify({
      type: 'negative',
      message: error instanceof Error ? error.message : t('errors.failedUploadMedia'),
      position: 'top',
    });
  } finally {
    isNostrBuildAuthInProgress.value = false;
  }
}

async function handleMediaFileInputChange(event: Event): Promise<void> {
  const input = event.target instanceof HTMLInputElement ? event.target : null;
  const file = input?.files?.[0] ?? null;
  resetMediaFileInput();
  if (!file) {
    return;
  }

  const validationError = validateNostrBuildMediaFile(file);
  if (validationError) {
    $q.notify({
      type: 'warning',
      message: validationError,
      position: 'top',
    });
    return;
  }

  await uploadAndSendMediaFile(file);
}

function handleComposerPaste(event: ClipboardEvent): void {
  try {
    const imageFile = readFirstImageTransferFile(event.clipboardData);
    if (!imageFile) {
      return;
    }

    if (!hasTransferText(event.clipboardData)) {
      event.preventDefault();
    }

    openMediaPrivacyDialog(imageFile);
  } catch (error) {
    reportUiError('Failed to handle pasted image', error);
  }
}

function handleComposerDragOver(event: DragEvent): void {
  const transfer = event.dataTransfer;
  if (!hasTransferFiles(transfer)) {
    return;
  }

  event.preventDefault();
  if (transfer) {
    transfer.dropEffect = hasImageTransferFile(transfer) ? 'copy' : 'none';
  }
}

function handleComposerDrop(event: DragEvent): void {
  try {
    const transfer = event.dataTransfer;
    const imageFile = readFirstImageTransferFile(transfer);
    if (!imageFile) {
      if (hasTransferFiles(transfer)) {
        event.preventDefault();
      }
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    openMediaPrivacyDialog(imageFile);
  } catch (error) {
    reportUiError('Failed to handle dropped image', error);
  }
}

async function uploadAndSendMediaFile(file: File): Promise<void> {
  mediaUploadStatus.value = 'uploading';
  mediaUploadError.value = '';
  isMediaUploadInProgress.value = true;
  isMediaUploadDialogOpen.value = true;
  const minProgressDelay = new Promise((resolve) => window.setTimeout(resolve, 2000));

  try {
    const uploadResult = await uploadNostrBuildMedia(file, {
      signUploadAuthHeader: nostrStore.signNostrBuildUploadAuthHeader,
    });
    await minProgressDelay;
    mediaUploadStatus.value = 'sending';
    emit('send-media', {
      attachment: uploadResult.attachment,
    });
    isMediaUploadDialogOpen.value = false;
  } catch (error) {
    await minProgressDelay;
    reportUiError('Failed to upload media to nostr.build', error);
    mediaUploadError.value =
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : t('errors.failedUploadMedia');
  } finally {
    isMediaUploadInProgress.value = false;
  }
}

function handleFileAction(): void {
  isComposerMenuOpen.value = false;
  $q.notify({
    type: 'info',
    message: t('message.fileUploadNotSupportedYet'),
    position: 'top'
  });
}

function handleEmojiAction(): void {
  rememberSelection();
  isComposerMenuOpen.value = false;
  void nextTick(() => {
    isEmojiMenuOpen.value = true;
  });
}

function handleEmojiAutocompleteSelect(emoji: string): void {
  try {
    const match = emojiAutocompleteMatch.value;
    if (!match) {
      return;
    }

    dismissedEmojiAutocompleteToken.value = '';
    const suffix = draft.value.slice(match.end);
    const nextEmoji = suffix.length === 0 ? `${emoji} ` : emoji;
    replaceDraftRange(match.start, match.end, nextEmoji);
  } catch (error) {
    reportUiError('Failed to autocomplete emoji', error);
  }
}

function handleMentionAutocompleteSelect(profile: NostrMentionProfile): void {
  try {
    const match = mentionAutocompleteMatch.value;
    if (!match) {
      return;
    }

    dismissedMentionAutocompleteToken.value = '';
    const suffix = draft.value.slice(match.end);
    const mentionText = suffix.length === 0 ? `@${profile.handle} ` : `@${profile.handle}`;
    replaceDraftRange(match.start, match.end, mentionText);
  } catch (error) {
    reportUiError('Failed to autocomplete mention', error);
  }
}

function handleEnterKey(event: KeyboardEvent): void {
  if (isMentionAutocompleteVisible.value && mentionAutocompleteEntries.value.length > 0) {
    event.preventDefault();
    const entry = mentionAutocompleteEntries.value[activeMentionAutocompleteIndex.value] ?? null;
    if (entry) {
      handleMentionAutocompleteSelect(entry);
    }
    return;
  }

  if (isEmojiAutocompleteVisible.value && emojiAutocompleteEntries.value.length > 0) {
    event.preventDefault();
    const entry = emojiAutocompleteEntries.value[activeEmojiAutocompleteIndex.value] ?? null;
    if (entry) {
      handleEmojiAutocompleteSelect(entry.emoji);
    }
    return;
  }

  if (typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches) {
    return;
  }

  event.preventDefault();
  submitDraft();
}

function handleAutocompleteArrowDown(event: KeyboardEvent): void {
  if (isMentionAutocompleteVisible.value && mentionAutocompleteEntries.value.length > 0) {
    event.preventDefault();
    activeMentionAutocompleteIndex.value =
      (activeMentionAutocompleteIndex.value + 1) % mentionAutocompleteEntries.value.length;
    return;
  }

  if (!isEmojiAutocompleteVisible.value || emojiAutocompleteEntries.value.length === 0) {
    return;
  }

  event.preventDefault();
  activeEmojiAutocompleteIndex.value =
    (activeEmojiAutocompleteIndex.value + 1) % emojiAutocompleteEntries.value.length;
}

function handleAutocompleteArrowUp(event: KeyboardEvent): void {
  if (isMentionAutocompleteVisible.value && mentionAutocompleteEntries.value.length > 0) {
    event.preventDefault();
    activeMentionAutocompleteIndex.value =
      (activeMentionAutocompleteIndex.value - 1 + mentionAutocompleteEntries.value.length) %
      mentionAutocompleteEntries.value.length;
    return;
  }

  if (!isEmojiAutocompleteVisible.value || emojiAutocompleteEntries.value.length === 0) {
    return;
  }

  event.preventDefault();
  activeEmojiAutocompleteIndex.value =
    (activeEmojiAutocompleteIndex.value - 1 + emojiAutocompleteEntries.value.length) %
    emojiAutocompleteEntries.value.length;
}

function handleAutocompleteTab(event: KeyboardEvent): void {
  if (isMentionAutocompleteVisible.value && mentionAutocompleteEntries.value.length > 0) {
    event.preventDefault();
    const entry = mentionAutocompleteEntries.value[activeMentionAutocompleteIndex.value] ?? null;
    if (entry) {
      handleMentionAutocompleteSelect(entry);
    }
    return;
  }

  if (!isEmojiAutocompleteVisible.value || emojiAutocompleteEntries.value.length === 0) {
    return;
  }

  event.preventDefault();
  const entry = emojiAutocompleteEntries.value[activeEmojiAutocompleteIndex.value] ?? null;
  if (entry) {
    handleEmojiAutocompleteSelect(entry.emoji);
  }
}

function handleAutocompleteEscape(event: KeyboardEvent): void {
  if (isMentionAutocompleteVisible.value) {
    event.preventDefault();
    const match = mentionAutocompleteMatch.value;
    if (!match) {
      return;
    }

    dismissedMentionAutocompleteToken.value = `${match.start}:${match.query}`;
    return;
  }

  if (!isEmojiAutocompleteVisible.value) {
    return;
  }

  event.preventDefault();
  const match = emojiAutocompleteMatch.value;
  if (!match) {
    return;
  }

  dismissedEmojiAutocompleteToken.value = `${match.start}:${match.query}`;
}

function shouldKeepKeyboardOpenAfterSend(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
}

function handleSendTouchStart(event: TouchEvent): void {
  if (!shouldKeepKeyboardOpenAfterSend()) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  suppressNextSendClick = true;
  submitDraft();
}

function handleSendClick(): void {
  if (suppressNextSendClick) {
    suppressNextSendClick = false;
    return;
  }

  submitDraft();
}

function submitDraft(): void {
  try {
    const cleanText = serializeMentionDraft(draft.value.trim(), mentionProfiles.value).trim();

    if (!cleanText) {
      return;
    }

    emit('send', { text: cleanText });
    setDraftValue('');
    selectionStart.value = 0;
    selectionEnd.value = 0;
  } catch (error) {
    reportUiError('Failed to submit message input', error);
  }
}

watch(
  activeChatId,
  (nextChatId) => {
    const nextDraft = nextChatId ? chatStore.getComposerDraft(nextChatId) : '';
    setDraftValue(nextDraft, { persist: false });
    selectionStart.value = nextDraft.length;
    selectionEnd.value = nextDraft.length;
    dismissedMentionAutocompleteToken.value = '';
    dismissedEmojiAutocompleteToken.value = '';
    activeMentionAutocompleteIndex.value = 0;
    activeEmojiAutocompleteIndex.value = 0;
    isComposerMenuOpen.value = false;
    isEmojiMenuOpen.value = false;
    isMediaPrivacyDialogOpen.value = false;
    isNostrBuildAuthInProgress.value = false;
    isMediaUploadDialogOpen.value = false;
    isMediaUploadInProgress.value = false;
    pendingInlineMediaFile.value = null;
    mediaUploadError.value = '';
    shouldRefocusAfterEmojiMenuHide.value = false;
  },
  { immediate: true }
);

watch(
  () => props.replyTo?.messageId ?? null,
  (nextMessageId, previousMessageId) => {
    if (!nextMessageId || nextMessageId === previousMessageId) {
      return;
    }

    focusInputAt(draft.value.length);
  }
);

defineExpose({
  focusInputAtEnd: () => focusInputAt(draft.value.length)
});
</script>

<style scoped>
.composer {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 16px;
  padding-bottom: calc(10px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--nc-border);
  background: var(--nc-panel-header-bg);
}

.composer__autocomplete {
  width: min(100%, 360px);
  align-self: flex-start;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border: 1px solid var(--nc-border);
  border-radius: 12px;
  background: var(--nc-panel-sidebar-bg);
  box-shadow: var(--nc-shadow-md);
}

.composer__autocomplete-option {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    background-color 0.16s ease,
    border-color 0.16s ease,
    transform 0.16s ease;
}

.composer__autocomplete-option:hover,
.composer__autocomplete-option--active {
  transform: none;
  border-color: transparent;
  background: var(--nc-hover);
}

.composer__emoji-option-char {
  flex: 0 0 auto;
  font-size: 20px;
  line-height: 1;
}

.composer__emoji-option-label {
  min-width: 0;
  font-size: 13px;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.composer__mention-avatar {
  flex: 0 0 auto;
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  background: var(--q-primary);
  color: white;
  font-size: 11px;
  font-weight: 700;
}

.composer__mention-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.composer__mention-name,
.composer__mention-handle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer__mention-name {
  font-size: 13px;
  font-weight: 700;
}

.composer__mention-handle {
  font-size: 12px;
  color: var(--nc-text-secondary);
}

.composer__autocomplete-empty {
  padding: 8px 10px;
  font-size: 13px;
  color: var(--nc-text-secondary);
}

.composer__reply {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--nc-surface-soft-strong);
}

.composer__reply-accent {
  flex: 0 0 3px;
  align-self: stretch;
  border-radius: 999px;
  background: var(--q-primary);
}

.composer__reply-copy {
  flex: 1;
  min-width: 0;
}

.composer__reply-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--q-primary);
}

.composer__reply-text {
  font-size: 12px;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.8;
}

.composer__reply-close {
  flex: 0 0 auto;
  color: var(--nc-text-secondary);
}

.composer__row {
  width: 100%;
  display: flex;
  align-items: flex-end;
  gap: 10px;
}

.composer__file-input {
  display: none;
}

.composer__input {
  width: 100%;
  flex: 1;
}

.composer__menu-trigger {
  width: 36px;
  min-width: 36px;
  height: 36px;
  padding: 0;
  color: var(--nc-text-secondary);
}

.composer__menu-trigger :deep(.q-icon) {
  font-size: 24px;
  transform: rotate(35deg);
}

.composer__emoji-trigger {
  flex: 0 0 auto;
  width: 42px;
  min-width: 42px;
  height: 42px;
  padding: 0;
  color: var(--nc-text-secondary);
}

.composer__menu-list {
  min-width: 190px;
  padding: 4px;
}

.composer__menu-list :deep(.q-item) {
  min-height: 40px;
  border-radius: 8px;
}

.composer__menu-icon {
  min-width: 34px;
  padding-right: 8px;
  color: var(--nc-text-secondary);
}

.composer__media-warning {
  color: var(--nc-text);
  font-size: 14px;
  line-height: 1.5;
}

.composer__dialog-progress {
  margin-top: 14px;
}

.composer__media-upload {
  color: var(--nc-text);
}

.composer__media-upload-status {
  margin-top: 12px;
  font-size: 14px;
  line-height: 1.5;
}

.composer__send {
  border-radius: 999px;
  min-width: 42px;
  width: 42px;
  height: 42px;
  padding: 0;
  box-shadow: none !important;
}

@media (max-width: 1023px) {
  .composer {
    gap: 5px;
    font-family: var(--nc-mobile-font);
    padding: 3px 10px calc(6px + env(safe-area-inset-bottom));
    border-top: 0;
    background: transparent;
    backdrop-filter: none;
  }

  .composer__reply {
    border-radius: 16px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--nc-panel-header-bg) 94%, transparent);
    box-shadow: 0 8px 24px rgba(23, 35, 52, 0.08);
  }

  .composer__reply-title,
  .composer__reply-text,
  .composer__emoji-option-label,
  .composer__mention-name,
  .composer__mention-handle,
  .composer__autocomplete-empty {
    font-size: var(--nc-mobile-caption-font-size);
    line-height: var(--nc-mobile-caption-line-height);
    letter-spacing: 0;
  }

  .composer__reply-title {
    font-weight: 600;
  }

  .composer__row {
    align-items: flex-end;
    gap: 5px;
    padding: 4px;
    border: 1px solid color-mix(in srgb, var(--nc-border) 92%, #c5d1dc 8%);
    border-radius: 22px;
    background: color-mix(in srgb, var(--nc-panel-header-bg) 99%, rgba(255, 255, 255, 0.96) 1%);
    box-shadow: 0 8px 20px rgba(23, 35, 52, 0.1);
  }

  .composer__input.q-textarea.q-field--dense :deep(.q-field__control) {
    min-height: 36px !important;
    padding-left: 4px !important;
    border-radius: 18px !important;
    background: transparent !important;
    box-shadow: none !important;
  }

  .composer__input.q-textarea.q-field--dense :deep(.q-field__control-container) {
    min-height: 36px;
    padding-left: 8px !important;
    padding-top: 0 !important;
    padding-bottom: 0 !important;
    display: flex;
    align-items: center;
  }

  .composer__input.q-field--outlined :deep(.q-field__control)::before,
  .composer__input.q-field--outlined :deep(.q-field__control)::after,
  .composer__input.q-field--focused :deep(.q-field__control)::before,
  .composer__input.q-field--focused :deep(.q-field__control)::after {
    border-color: transparent !important;
  }

  .composer__input.q-field--focused :deep(.q-field__control) {
    box-shadow: none !important;
  }

  .composer__input.q-textarea.q-field--dense :deep(.q-field__native),
  .composer__input.q-textarea.q-field--dense :deep(.q-field__input) {
    min-height: var(--nc-mobile-ui-line-height) !important;
    padding-top: 0 !important;
    padding-bottom: 0 !important;
    font-family: var(--nc-mobile-font);
    font-size: var(--nc-mobile-ui-font-size);
    font-weight: 400;
    line-height: var(--nc-mobile-ui-line-height) !important;
    letter-spacing: 0;
    display: block;
  }

  .composer__input.q-textarea.q-field--dense :deep(.q-field__native::placeholder),
  .composer__input.q-textarea.q-field--dense :deep(.q-field__input::placeholder) {
    font-size: var(--nc-mobile-ui-font-size);
    font-weight: 400;
    color: #98a4af;
    opacity: 1;
  }

  .composer__input.q-textarea.q-field--dense :deep(textarea.q-field__native) {
    max-height: 132px;
  }

  .composer__input :deep(.q-field__prepend) {
    align-self: flex-end;
    display: flex;
    align-items: flex-end;
    padding-left: 0;
    padding-right: 2px;
    margin-left: 0;
    padding-bottom: 2px;
  }

  .composer__menu-trigger {
    width: 30px;
    min-width: 30px;
    height: 30px;
    padding: 0;
    color: #7c8793 !important;
  }

  .composer__menu-trigger :deep(.q-btn__content) {
    justify-content: center;
  }

  .composer__menu-trigger :deep(.q-icon) {
    font-size: 22px;
  }

  .composer__send {
    align-self: flex-end;
    width: 36px;
    min-width: 36px;
    height: 36px;
    margin-bottom: 0;
    border: 0;
    border-radius: 999px !important;
    overflow: hidden;
    box-shadow: none !important;
  }

  .composer__emoji-trigger {
    align-self: flex-end;
    width: 36px;
    min-width: 36px;
    height: 36px;
    color: var(--nc-text-secondary);
  }

  .composer__emoji-trigger :deep(.q-icon) {
    font-size: 20px;
  }

  .composer__send::before {
    border-radius: 999px !important;
  }

  .composer__send :deep(.q-icon) {
    font-size: 16px;
  }
}

body.body--dark .composer__reply {
  box-shadow: none;
}

@media (max-width: 1023px) {
  body.body--dark .composer {
    background: transparent;
  }

  body.body--dark .composer__row {
    border-color: color-mix(in srgb, var(--nc-border) 90%, #5b738b 10%);
    background: color-mix(in srgb, var(--nc-panel-header-bg) 96%, rgba(13, 20, 27, 0.78) 4%);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
  }

  body.body--dark .composer__reply {
    background: color-mix(in srgb, var(--nc-panel-header-bg) 94%, transparent);
  }

  body.body--dark .composer__menu-trigger {
    color: #a9b8c8 !important;
  }
}
</style>
