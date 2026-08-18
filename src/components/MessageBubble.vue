<template>
  <div
    class="bubble-row"
    :class="[
      isMine ? 'bubble-row--mine' : 'bubble-row--their',
      {
        'bubble-row--show-author-mobile': showAuthorOnMobile,
        'bubble-row--desktop-bubbles': isDesktopBubbleLayout
      }
    ]"
  >
    <div class="bubble-stack" :class="isMine ? 'bubble-stack--mine' : 'bubble-stack--their'">
      <button
        v-if="showAuthorName"
        type="button"
        class="bubble__author"
        :class="isMine ? 'bubble__author--mine' : 'bubble__author--their'"
        data-testid="thread-author-profile-link"
        :aria-label="$t('profile.open.aria', { name: authorLabel })"
        @click.stop="handleOpenAuthorProfile"
      >
        <CachedAvatar
          :src="authorAvatarSrc"
          :alt="authorLabel"
          :fallback="authorAvatarFallback"
          class="bubble__author-avatar"
        />
        <span class="bubble__author-name">{{ authorLabel }}</span>
      </button>
      <div
        class="bubble"
        :class="isMine ? 'bubble--mine' : 'bubble--their'"
        @click.stop="openActionMenu"
      >
      <q-menu
        ref="actionMenuRef"
        v-model="isActionMenuOpen"
        no-parent-event
        touch-position
        class="nc-pop-menu"
        :transition-duration="0"
        @hide="handleActionMenuHide"
      >
        <div class="bubble__menu-stack">
          <q-list dense class="nc-pop-menu__list bubble__actions-list">
            <q-item clickable v-close-popup @click="handleReply">
              <q-item-section avatar>
                <q-icon name="reply" />
              </q-item-section>
              <q-item-section>{{ $t('message.reply.action') }}</q-item-section>
            </q-item>
            <q-item clickable v-close-popup @click="handleCopy">
              <q-item-section avatar>
                <q-icon name="content_copy" />
              </q-item-section>
              <q-item-section>{{ $t('common.copy') }}</q-item-section>
            </q-item>
            <q-item v-if="canForwardMessage" clickable v-close-popup @click="handleForward">
              <q-item-section avatar>
                <q-icon name="forward" />
              </q-item-section>
              <q-item-section>{{ $t('common.forward') }}</q-item-section>
            </q-item>
            <q-item clickable v-close-popup @click="handlePin">
              <q-item-section avatar>
                <q-icon name="push_pin" />
              </q-item-section>
              <q-item-section>{{ $t('common.pin') }}</q-item-section>
            </q-item>
            <q-item clickable v-close-popup @click="handleInfo">
              <q-item-section avatar>
                <q-icon name="info" />
              </q-item-section>
              <q-item-section>{{ $t('common.nostrInfo') }}</q-item-section>
            </q-item>
            <q-item v-if="canDeleteMessage" clickable v-close-popup @click="handleDelete">
              <q-item-section avatar>
                <q-icon name="delete" class="text-negative" />
              </q-item-section>
              <q-item-section class="text-negative">{{ $t('common.delete') }}</q-item-section>
            </q-item>
            <q-item
              v-else-if="isDeletedMessage"
              clickable
              v-close-popup
              @click="openDeletedMessageDialog"
            >
              <q-item-section avatar>
                <q-icon name="visibility" />
              </q-item-section>
              <q-item-section>{{ $t('message.viewDeletedMessage') }}</q-item-section>
            </q-item>
          </q-list>

          <div class="bubble__quick-reactions" role="menu" :aria-label="$t('message.quickEmojiReactions')">
            <button
              v-for="entry in quickReactionEntries"
              :key="entry.emoji"
              type="button"
              class="bubble__quick-reaction"
              @click="handleEmojiReaction(entry.emoji)"
              :title="entry.label"
              :aria-label="$t('common.react', { label: entry.label })"
            >
              {{ entry.emoji }}
            </button>

            <button
              type="button"
              class="bubble__quick-reaction bubble__quick-reaction--more"
              :aria-label="$t('message.openMoreEmoji')"
              @click="openEmojiPickerMenu"
            >
              <q-icon name="more_horiz" size="18px" />
            </button>
          </div>
        </div>
      </q-menu>

      <q-menu
        ref="emojiPickerMenuRef"
        v-model="isEmojiPickerMenuOpen"
        no-parent-event
        touch-position
        class="nc-pop-menu"
        :transition-duration="0"
        @show="handleEmojiPickerMenuShow"
      >
        <EmojiPickerPanel
          ref="emojiPickerRef"
          width="264px"
          max-height="232px"
          :columns="5"
          item-min-height="46px"
          item-padding="8px 4px"
          @select="handleEmojiReaction"
        />
      </q-menu>

      <div class="bubble__content">
        <button
          v-if="replyPreview"
          type="button"
          class="bubble__reply-preview"
          :aria-label="$t('message.openRepliedMessage')"
          @click.stop="handleOpenReplyTarget"
        >
          <div class="bubble__reply-preview-accent" aria-hidden="true" />
          <div class="bubble__reply-preview-copy">
            <div class="bubble__reply-preview-title">{{ replyPreview.authorName }}</div>
            <div class="bubble__reply-preview-text">{{ replyPreview.text }}</div>
          </div>
        </button>

        <p
          v-if="shouldShowMessageText"
          class="bubble__text"
          :class="{
            'bubble__text--emoji': isSingleEmojiMessage,
            'bubble__text--deleted': isDeletedMessage
          }"
        >
          <template v-for="part in bubbleMessageTextParts" :key="part.key">
            <button
              v-if="part.type === 'mention'"
              type="button"
              class="bubble__mention"
              data-testid="message-mention-link"
              @click.stop="handleOpenMentionChat(part.publicKey)"
            >
              {{ part.text }}
            </button>
            <button
              v-else-if="part.type === 'url'"
              type="button"
              class="bubble__link"
              data-testid="message-url-link"
              @click.stop="handleOpenMessageLink(part.href)"
            >
              {{ part.text }}
            </button>
            <span v-else>{{ part.text }}</span>
          </template>
        </p>
        <div
          v-if="imageAttachmentItems.length > 0"
          class="bubble__attachments"
          data-testid="message-image-attachments"
        >
          <div
            v-for="item in imageAttachmentItems"
            :key="item.key"
            class="bubble__image-attachment"
            data-testid="message-image-attachment"
            @click.stop
          >
            <div v-if="item.isVisible" class="bubble__image-preview">
              <button
                type="button"
                class="bubble__image-preview-button"
                data-testid="message-image-preview-button"
                :aria-label="resolveImageAttachmentAlt(item.attachment)"
                @click.stop="openImageAttachmentDialog(item.attachment)"
              >
                <img
                  class="bubble__image-preview-media"
                  data-testid="message-image-preview"
                  :src="item.attachment.url"
                  :alt="resolveImageAttachmentAlt(item.attachment)"
                  loading="lazy"
                />
              </button>
              <div class="bubble__image-actions">
                <q-btn
                  flat
                  dense
                  round
                  color="primary"
                  icon="content_copy"
                  class="bubble__image-action bubble__image-copy"
                  data-testid="message-image-copy-link"
                  :aria-label="$t('message.copyImageLink')"
                  @click.stop="handleCopyImageLink(item.attachment.url)"
                >
                  <AppTooltip>{{ $t('message.copyImageLink') }}</AppTooltip>
                </q-btn>
                <q-btn
                  flat
                  dense
                  round
                  color="primary"
                  icon="open_in_new"
                  class="bubble__image-action bubble__image-open"
                  data-testid="message-image-link"
                  :href="item.attachment.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  :aria-label="$t('message.openImageLinkNewTab')"
                  @click.stop
                >
                  <AppTooltip>{{ $t('message.openImageLinkNewTab') }}</AppTooltip>
                </q-btn>
              </div>
            </div>
            <div v-else class="bubble__image-gate" data-testid="message-image-gate">
              <q-icon
                name="image"
                size="20px"
                class="bubble__image-gate-icon"
                aria-hidden="true"
              />
              <div class="bubble__image-actions bubble__image-actions--gate">
                <q-btn
                  flat
                  dense
                  round
                  color="primary"
                  icon="content_copy"
                  class="bubble__image-action bubble__image-copy"
                  data-testid="message-image-copy-link"
                  :aria-label="$t('message.copyImageLink')"
                  @click.stop="handleCopyImageLink(item.attachment.url)"
                >
                  <AppTooltip>{{ $t('message.copyImageLink') }}</AppTooltip>
                </q-btn>
                <q-btn
                  flat
                  dense
                  round
                  color="primary"
                  icon="open_in_new"
                  class="bubble__image-action bubble__image-open"
                  data-testid="message-image-link"
                  :href="item.attachment.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  :aria-label="$t('message.openImageLinkNewTab')"
                  @click.stop
                >
                  <AppTooltip>{{ $t('message.openImageLinkNewTab') }}</AppTooltip>
                </q-btn>
              </div>
              <q-btn
                flat
                dense
                no-caps
                icon="visibility"
                color="primary"
                class="bubble__image-show"
                data-testid="message-image-show"
                :label="$t('message.showImage')"
                @click.stop="revealImageAttachment(item.key)"
              />
              <q-checkbox
                dense
                class="bubble__image-trust"
                data-testid="message-image-trust-sender"
                :model-value="false"
                :label="$t('message.alwaysTrustSender')"
                @click.stop
                @update:model-value="handleTrustSenderUpdate"
              />
            </div>
          </div>
        </div>
        <button
          v-if="canExpandMessage"
          type="button"
          class="bubble__more"
          :aria-expanded="isMessageExpanded ? 'true' : 'false'"
          data-testid="message-text-expand-toggle"
          @click.stop="toggleMessageExpanded"
        >
          {{ isMessageExpanded ? $t('common.less') : $t('common.more') }}
        </button>
      </div>

      <div class="bubble__meta">
        <span class="bubble__time">{{ formattedTime }}</span>
        <div
          v-if="hasRelayStatuses"
          class="bubble__status-hitbox"
          tabindex="0"
          role="button"
          aria-haspopup="dialog"
          :aria-expanded="isStatusDialogOpen ? 'true' : 'false'"
          @click.stop="openStatusDialog"
          @keydown.enter.prevent="openStatusDialog"
          @keydown.space.prevent="openStatusDialog"
        >
          <div
            class="bubble__status"
            :class="{ 'bubble__status--pending': hasPendingRelayStatuses }"
          >
            <span
              v-for="segment in statusSegments"
              :key="segment.key"
              class="bubble__status-segment"
              :class="segment.className"
              :style="{ flex: `${segment.weight} 1 0` }"
            />
          </div>
        </div>
      </div>

      <div v-if="messageReactions.length > 0" class="bubble__reactions">
        <button
          v-for="item in messageReactionItems"
          :key="item.key"
          type="button"
          class="bubble__reaction-chip"
          :class="{
            'bubble__reaction-chip--fresh': isFreshReaction(item.key),
            'bubble__reaction-chip--removable': canRemoveReaction(item.reaction)
          }"
          :aria-label="
            canRemoveReaction(item.reaction)
              ? $t('message.removeReaction', { name: item.reaction.name })
              : $t('message.reactionByName', { name: item.reaction.name })
          "
          @click.stop="handleRemoveReaction(item.reaction)"
        >
          <span class="bubble__reaction-emoji">{{ item.reaction.emoji }}</span>
          <AppTooltip>{{ item.reaction.name }}</AppTooltip>
        </button>
      </div>
    </div>
  </div>
</div>

  <AppDialog
    v-if="hasRelayStatuses"
    v-model="isStatusDialogOpen"
    :title="statusDialogTitle"
    plain
    max-width="460px"
  >
    <div v-if="statusSections.length === 0" class="bubble__status-empty">
      {{ $t('relays.relayStatusRecordedYet') }}
    </div>
    <template v-else-if="isMine">
      <q-tabs
        v-model="statusDialogTab"
        dense
        no-caps
        align="justify"
        active-color="primary"
        indicator-color="primary"
        class="bubble__status-tabs"
      >
        <q-tab
          v-for="section in statusSections"
          :key="section.key"
          :name="section.key"
          :label="section.tabLabel ?? section.title"
          :data-testid="`relay-status-tab-${section.key}`"
        />
      </q-tabs>

      <q-tab-panels
        v-model="statusDialogTab"
        animated
        class="bubble__status-tab-panels"
      >
        <q-tab-panel
          v-for="section in statusSections"
          :key="section.key"
          :name="section.key"
          class="bubble__status-tab-panel"
          :data-testid="`relay-status-panel-${section.key}`"
        >
          <ul class="bubble__status-list bubble__status-list--dialog">
            <li
              v-for="item in section.items"
              :key="item.key"
              class="bubble__status-list-item bubble__status-list-item--dialog"
            >
              <span class="bubble__status-list-item-main">
                <span class="bubble__status-list-dot" :class="item.dotClass" aria-hidden="true" />
                <span class="bubble__status-list-copy">
                  <span class="bubble__status-list-text">{{ item.relayUrl }}</span>
                  <span v-if="item.detail" class="bubble__status-list-detail">{{
                    item.detail
                  }}</span>
                </span>
              </span>
              <q-btn
                v-if="item.retryable"
                flat
                dense
                no-caps
                size="sm"
                color="primary"
                :label="$t('common.retry')"
                class="bubble__status-retry"
                :loading="isRetrying(item)"
                :disable="isRetrying(item) || !item.retryable"
                @click.stop="retryRelay(item)"
              />
            </li>
            <li
              v-if="section.items.length === 0"
              class="bubble__status-list-item bubble__status-list-item--empty"
            >
              {{ section.emptyLabel }}
            </li>
          </ul>
          <div
            v-if="
              section.key === statusDialogTab &&
              typeof section.retryableCount === 'number' &&
              section.retryableCount > 0
            "
            class="bubble__status-actions"
          >
            <q-btn
              flat
              dense
              no-caps
              icon="refresh"
              color="primary"
              :label="$t('relays.retryFailed')"
              class="bubble__status-retry-all"
              data-testid="relay-status-retry-all-button"
              :loading="isRetryingFailedRelays"
              :disable="isRetryingFailedRelays || section.retryableCount === 0"
              @click.stop="retryFailedRelays(section)"
            />
          </div>
        </q-tab-panel>
      </q-tab-panels>
    </template>
    <template v-else>
      <div
        v-for="(section, sectionIndex) in statusSections"
        :key="section.key"
        class="bubble__status-section"
      >
        <div v-if="sectionIndex > 0" class="bubble__status-section-separator" />
        <div class="bubble__status-section-title">{{ section.title }}</div>
        <ul class="bubble__status-list bubble__status-list--dialog">
          <li
            v-for="item in section.items"
            :key="item.key"
            class="bubble__status-list-item bubble__status-list-item--dialog"
          >
            <span class="bubble__status-list-item-main">
              <span class="bubble__status-list-dot" :class="item.dotClass" aria-hidden="true" />
              <span class="bubble__status-list-copy">
                <span class="bubble__status-list-text">{{ item.relayUrl }}</span>
                <span v-if="item.detail" class="bubble__status-list-detail">{{ item.detail }}</span>
              </span>
            </span>
            <q-btn
              v-if="item.retryable"
              flat
              dense
              no-caps
              size="sm"
              color="primary"
              :label="$t('common.retry')"
              class="bubble__status-retry"
              :loading="isRetrying(item)"
              :disable="isRetrying(item) || !item.retryable"
              @click.stop="retryRelay(item)"
            />
          </li>
          <li
            v-if="section.items.length === 0"
            class="bubble__status-list-item bubble__status-list-item--empty"
          >
            {{ section.emptyLabel }}
          </li>
        </ul>
        <div
          v-if="section.key === 'recipient' && retryableStatusItems.length > 0"
          class="bubble__status-actions"
        >
          <q-btn
            flat
            dense
            no-caps
            icon="refresh"
            color="primary"
            :label="$t('relays.retryFailed')"
            class="bubble__status-retry-all"
            data-testid="relay-status-retry-all-button"
            :loading="isRetryingFailedRelays"
            :disable="isRetryingFailedRelays || retryableStatusItems.length === 0"
            @click.stop="retryFailedRelays()"
          />
        </div>
      </div>
    </template>
  </AppDialog>

  <AppDialog
    v-model="isInfoDialogOpen"
    max-width="460px"
  >
    <template #title>
      <div class="bubble__info-dialog-title">
        <q-btn
          v-if="isEventJsonViewOpen"
          flat
          dense
          no-caps
          icon="arrow_back"
          :label="$t('common.back')"
          class="bubble__info-back"
          @click="handleBackToInfo"
        />
        <div class="bubble__info-dialog-title-text">{{ $t('common.nostrInfo') }}</div>
      </div>
    </template>

    <div v-if="!isEventJsonViewOpen" class="bubble__info">
      <div class="bubble__info-row">
        <div class="bubble__info-label">{{ $t('common.sent') }}</div>
        <div class="bubble__info-value">{{ formattedInfoTime }}</div>
      </div>
      <div class="bubble__info-row">
        <div class="bubble__info-label">{{ $t('message.sender') }}</div>
        <div class="bubble__info-value">{{ isMine ? $t('common.you') : $t('contacts.contact.label') }}</div>
      </div>
      <div class="bubble__info-row">
        <div class="bubble__info-label">{{ $t('contacts.authorPubkey') }}</div>
        <div class="bubble__info-value bubble__info-value--mono">{{ message.authorPublicKey }}</div>
      </div>
      <div class="bubble__info-row">
        <div class="bubble__info-label">{{ $t('message.eventId') }}</div>
        <div class="bubble__info-value bubble__info-value--mono">
          {{ message.eventId || $t('common.notAvailable') }}
        </div>
      </div>
      <div class="bubble__info-row">
        <div class="bubble__info-label">{{ $t('message.message') }}</div>
        <div class="bubble__info-value">{{ baseVisibleMessageText }}</div>
      </div>
      <q-btn
        flat
        no-caps
        color="primary"
        :label="$t('message.showEventJson')"
        class="bubble__info-json-button"
        @click="handleShowEventJson"
      />
    </div>

    <div v-else class="bubble__event-json-panel">
      <pre v-if="formattedEventJson" class="bubble__event-json">{{ formattedEventJson }}</pre>
      <div v-else class="bubble__event-json-empty">
        {{ $t('message.eventJsonAvailableMessage') }}
      </div>
    </div>
  </AppDialog>

  <AppDialog
    v-model="isDeletedMessageDialogOpen"
    :title="$t('message.deletedMessage')"
    max-width="460px"
  >
    <div class="bubble__deleted-message-dialog">{{ message.text }}</div>
  </AppDialog>

  <q-dialog v-model="isImageDialogOpen" maximized class="bubble__image-dialog">
    <q-card class="bubble__image-dialog-card">
      <div class="bubble__image-dialog-toolbar">
        <a
          v-if="fullscreenImageAttachment"
          class="bubble__image-dialog-action"
          :href="fullscreenImageAttachment.url"
          target="_blank"
          rel="noopener noreferrer"
          :aria-label="$t('common.open')"
          :title="$t('common.open')"
          @click.stop
        >
          <q-icon name="open_in_new" size="20px" />
        </a>
        <q-btn
          flat
          dense
          round
          icon="close"
          color="white"
          :aria-label="$t('common.closeDialog')"
          class="bubble__image-dialog-close"
          @click="closeImageAttachmentDialog"
        />
      </div>
      <div class="bubble__image-dialog-body">
        <img
          v-if="fullscreenImageAttachment"
          class="bubble__image-dialog-media"
          data-testid="message-image-fullscreen"
          :src="fullscreenImageAttachment.url"
          :alt="resolveImageAttachmentAlt(fullscreenImageAttachment)"
        />
      </div>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, toRef, watch } from 'vue';
import { useQuasar } from 'quasar';
import AppDialog from 'src/components/AppDialog.vue';
import AppTooltip from 'src/components/AppTooltip.vue';
import CachedAvatar from 'src/components/CachedAvatar.vue';
import EmojiPickerPanel from 'src/components/EmojiPickerPanel.vue';
import {
  isRetryableStatusScope,
  type StatusListItem,
  type StatusSection,
  useMessageBubbleStatus
} from 'src/composables/useMessageBubbleStatus';
import { getEmojiEntryByValue, type EmojiOption } from 'src/data/topEmojis';
import type {
  DeletedMessageMetadata,
  Message,
  MessageAttachmentMetadata,
  MessageReaction,
  MessageReplyPreview
} from 'src/types/chat';
import { useNostrStore } from 'src/stores/nostrStore';
import { useTrustedMediaStore } from 'src/stores/trustedMediaStore';
import { openExternalHttpUrl } from 'src/utils/externalLinks';
import type { DesktopMessageLayoutPreference } from 'src/utils/themeStorage';
import { readImageAttachmentsFromMeta } from 'src/utils/messageAttachments';
import { isReactionUnseenForAuthor } from 'src/utils/messageReactions';
import { buildMessageTextParts } from 'src/utils/messageTextParts';
import {
  shouldCollapseMessageText,
  truncateCollapsedMessageText,
} from 'src/utils/messageTextExpansion';
import {
  type NostrMentionProfile,
} from 'src/utils/nostrMentions';
import { reportUiError } from 'src/utils/uiErrorHandler';
import { getDateTimeLocale, t } from 'src/i18n';

const props = defineProps<{
  message: Message;
  authorAvatarFallback?: string;
  authorAvatarSrc?: string;
  authorLabel?: string;
  contactName?: string;
  contactRelayUrls?: string[];
  isMessageExpanded?: boolean;
  mentionProfiles?: NostrMentionProfile[];
  showAuthorName?: boolean;
  showAuthorOnMobile?: boolean;
  desktopMessageLayout?: DesktopMessageLayoutPreference;
}>();

const emit = defineEmits<{
  (event: 'reply', message: Message): void;
  (event: 'open-reply-target', messageId: string, referenceSentAt?: string): void;
  (event: 'open-profile', publicKey: string): void;
  (event: 'open-mention-chat', publicKey: string): void;
  (event: 'forward', message: Message): void;
  (event: 'react', payload: { message: Message; emoji: string }): void;
  (event: 'delete-message', message: Message): void;
  (event: 'remove-reaction', payload: { message: Message; reaction: MessageReaction }): void;
  (event: 'update-message-expanded', payload: { message: Message; expanded: boolean }): void;
}>();

const $q = useQuasar();
const nostrStore = useNostrStore();
const trustedMediaStore = useTrustedMediaStore();
const isMine = computed(() => props.message.sender === 'me');
const isDesktopBubbleLayout = computed(() => props.desktopMessageLayout === 'bubbles');
const showAuthorOnMobile = computed(() => props.showAuthorOnMobile === true);
const loggedInPublicKey = computed(() => nostrStore.getLoggedInPublicKeyHex()?.toLowerCase() ?? '');
const actionMenuRef = ref<{ show: (evt?: Event) => void } | null>(null);
const emojiPickerMenuRef = ref<{ show: (evt?: Event) => void } | null>(null);
const isActionMenuOpen = ref(false);
const isEmojiPickerMenuOpen = ref(false);
const isInfoDialogOpen = ref(false);
const isEventJsonViewOpen = ref(false);
const isDeletedMessageDialogOpen = ref(false);
const shouldOpenEmojiPickerAfterActionMenu = ref(false);
const lastActionMenuClickPosition = ref<{ left: number; top: number } | null>(null);
const emojiPickerRef = ref<{ reset: () => void } | null>(null);
const revealedImageAttachmentKeys = ref<string[]>([]);
const isImageDialogOpen = ref(false);
const fullscreenImageAttachment = ref<MessageAttachmentMetadata | null>(null);

interface MessageReactionItem {
  key: string;
  reaction: MessageReaction;
  isFreshCandidate: boolean;
}

interface ImageAttachmentItem {
  key: string;
  attachment: MessageAttachmentMetadata;
  isVisible: boolean;
}

function isMessageReaction(value: unknown): value is MessageReaction {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<MessageReaction>;
  return (
    typeof candidate.emoji === 'string' &&
    candidate.emoji.trim().length > 0 &&
    typeof candidate.name === 'string' &&
    candidate.name.trim().length > 0 &&
    typeof candidate.reactorPublicKey === 'string' &&
    candidate.reactorPublicKey.trim().length > 0
  );
}

function isMessageReplyPreview(value: unknown): value is MessageReplyPreview {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<MessageReplyPreview>;
  return (
    typeof candidate.messageId === 'string' &&
    typeof candidate.text === 'string' &&
    (candidate.sender === 'me' || candidate.sender === 'them') &&
    typeof candidate.authorName === 'string' &&
    typeof candidate.authorPublicKey === 'string' &&
    typeof candidate.sentAt === 'string' &&
    (typeof candidate.eventId === 'string' || candidate.eventId === null)
  );
}

function isDeletedMessageMetadata(value: unknown): value is DeletedMessageMetadata {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<DeletedMessageMetadata>;
  return (
    typeof candidate.deletedAt === 'string' &&
    candidate.deletedAt.trim().length > 0 &&
    typeof candidate.deletedByPublicKey === 'string' &&
    candidate.deletedByPublicKey.trim().length > 0 &&
    typeof candidate.deletedEventKind === 'number'
  );
}

const isStatusDialogOpen = ref(false);
const statusDialogTab = ref('recipient');
const showAuthorName = computed(() => props.showAuthorName === true);
const authorLabel = computed(() => {
  const explicitLabel = props.authorLabel?.trim();
  if (explicitLabel) {
    return explicitLabel;
  }

  if (isMine.value) {
    return t('common.you');
  }

  return props.contactName?.trim() || t('contacts.contact.label');
});
const authorAvatarSrc = computed(() => props.authorAvatarSrc?.trim() || '');
const authorAvatarFallback = computed(() => {
  const explicitFallback = props.authorAvatarFallback?.trim();
  if (explicitFallback) {
    return explicitFallback;
  }

  return authorLabel.value;
});
const {
  hasPendingRelayStatuses,
  hasRelayStatuses,
  statusDialogTitle,
  statusSections,
  statusSegments
} = useMessageBubbleStatus({
  contactName: computed(() => props.contactName?.trim() || ''),
  contactRelayUrls: computed(() => props.contactRelayUrls ?? []),
  isMine,
  message: toRef(props, 'message')
});
const retryingRelayKeys = ref<string[]>([]);
const isRetryingFailedRelays = ref(false);
const replyPreview = computed(() => {
  const candidate = props.message.meta.reply;
  return isMessageReplyPreview(candidate) ? candidate : null;
});
const messageReactions = computed<MessageReaction[]>(() => {
  const candidate = props.message.meta.reactions;
  if (!Array.isArray(candidate)) {
    return [];
  }

  return candidate.filter(isMessageReaction);
});

function buildMessageReactionBaseKey(reaction: MessageReaction): string {
  const normalizedEventId =
    typeof reaction.eventId === 'string' ? reaction.eventId.trim().toLowerCase() : '';
  if (normalizedEventId) {
    return normalizedEventId;
  }

  return [
    reaction.emoji.trim(),
    reaction.name.trim().toLowerCase(),
    reaction.reactorPublicKey.trim().toLowerCase()
  ].join('::');
}

const messageReactionItems = computed<MessageReactionItem[]>(() => {
  const reactionCounts = new Map<string, number>();

  return messageReactions.value.map((reaction) => {
    const baseKey = buildMessageReactionBaseKey(reaction);
    const occurrence = reactionCounts.get(baseKey) ?? 0;
    reactionCounts.set(baseKey, occurrence + 1);

    return {
      key: `${baseKey}::${occurrence}`,
      reaction,
      isFreshCandidate:
        isMine.value && isReactionUnseenForAuthor(reaction, props.message.authorPublicKey)
    };
  });
});

const freshReactionKeys = ref<Set<string>>(new Set());
const freshReactionTimers = new Map<string, ReturnType<typeof setTimeout>>();
const hasReactionSnapshot = ref(false);

function markReactionFresh(key: string): void {
  const existingTimer = freshReactionTimers.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const nextKeys = new Set(freshReactionKeys.value);
  nextKeys.add(key);
  freshReactionKeys.value = nextKeys;

  const timerId = setTimeout(() => {
    freshReactionTimers.delete(key);
    const pendingKeys = new Set(freshReactionKeys.value);
    pendingKeys.delete(key);
    freshReactionKeys.value = pendingKeys;
  }, 5000);

  freshReactionTimers.set(key, timerId);
}

function isFreshReaction(key: string): boolean {
  return freshReactionKeys.value.has(key);
}

function canRemoveReaction(reaction: MessageReaction): boolean {
  return reaction.reactorPublicKey.trim().toLowerCase() === loggedInPublicKey.value;
}
const deletedMessageMeta = computed<DeletedMessageMetadata | null>(() => {
  const candidate = props.message.meta.deleted;
  return isDeletedMessageMetadata(candidate) ? candidate : null;
});
const isDeletedMessage = computed(() => deletedMessageMeta.value !== null);
const canDeleteMessage = computed(() => {
  return isMine.value && !isDeletedMessage.value && Boolean(props.message.eventId);
});
const localMessageExpanded = ref(false);
const isMessageExpanded = computed(() => props.isMessageExpanded ?? localMessageExpanded.value);

const baseVisibleMessageText = computed(() => {
  if (!isDeletedMessage.value) {
    return props.message.text;
  }

  const [firstLine = ''] = props.message.text.split(/\r?\n/u);
  return firstLine;
});

const imageAttachments = computed(() => {
  if (isDeletedMessage.value) {
    return [];
  }

  return readImageAttachmentsFromMeta(props.message.meta);
});

function removeImageAttachmentUrls(text: string, attachments: MessageAttachmentMetadata[]): string {
  let nextText = text;
  const urls = Array.from(
    new Set(attachments.map((attachment) => attachment.url.trim()).filter(Boolean))
  );

  for (const url of urls) {
    nextText = nextText.split(url).join('');
  }

  return nextText
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n[ \t]+/gu, '\n')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

const visibleMessageText = computed(() => {
  if (imageAttachments.value.length === 0) {
    return baseVisibleMessageText.value;
  }

  return removeImageAttachmentUrls(baseVisibleMessageText.value, imageAttachments.value);
});

const shouldShowMessageText = computed(() => {
  return isDeletedMessage.value || visibleMessageText.value.length > 0;
});

const canForwardMessage = computed(() => {
  return !isDeletedMessage.value && props.message.text.trim().length > 0;
});

const DEFAULT_QUICK_REACTION_EMOJIS = ['👍', '👎', '🙏', '❤️', '😂'] as const;

const quickReactionEntries = DEFAULT_QUICK_REACTION_EMOJIS
  .map((emoji) => getEmojiEntryByValue(emoji))
  .filter((entry): entry is EmojiOption => entry !== null);
const SINGLE_EMOJI_PATTERN =
  /^(?:\p{Regional_Indicator}{2}|(?:[#*0-9]\uFE0F?\u20E3)|\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?(?:\p{Emoji_Modifier})?)*)$/u;
const isSingleEmojiMessage = computed(() => {
  if (isDeletedMessage.value) {
    return false;
  }

  const trimmedText = visibleMessageText.value.trim();
  return trimmedText.length > 0 && SINGLE_EMOJI_PATTERN.test(trimmedText);
});
const canExpandMessage = computed(() => {
  return (
    !isDeletedMessage.value &&
    !isSingleEmojiMessage.value &&
    shouldCollapseMessageText(visibleMessageText.value)
  );
});
const bubbleMessageText = computed(() => {
  if (!canExpandMessage.value || isMessageExpanded.value) {
    return visibleMessageText.value;
  }

  return truncateCollapsedMessageText(visibleMessageText.value);
});
const bubbleMessageTextParts = computed(() => {
  return buildMessageTextParts(bubbleMessageText.value, props.mentionProfiles ?? []);
});

function buildImageAttachmentKey(attachment: MessageAttachmentMetadata, index: number): string {
  return `${props.message.id}::${index}::${attachment.url}`;
}

const isSenderTrustedForImages = computed(() => {
  return (
    isMine.value ||
    trustedMediaStore.isImageSenderTrusted(props.message.authorPublicKey, loggedInPublicKey.value)
  );
});

const imageAttachmentItems = computed<ImageAttachmentItem[]>(() => {
  return imageAttachments.value.map((attachment, index) => {
    const key = buildImageAttachmentKey(attachment, index);
    return {
      key,
      attachment,
      isVisible: isSenderTrustedForImages.value || revealedImageAttachmentKeys.value.includes(key)
    };
  });
});

function revealImageAttachment(key: string): void {
  if (revealedImageAttachmentKeys.value.includes(key)) {
    return;
  }

  revealedImageAttachmentKeys.value = [...revealedImageAttachmentKeys.value, key];
}

function handleTrustSenderUpdate(value: boolean): void {
  if (!value) {
    return;
  }

  trustedMediaStore.trustImageSender(props.message.authorPublicKey);
}

function resolveImageAttachmentAlt(attachment: MessageAttachmentMetadata): string {
  return attachment.name?.trim() || t('message.imageAttachment');
}

function openImageAttachmentDialog(attachment: MessageAttachmentMetadata): void {
  fullscreenImageAttachment.value = attachment;
  isImageDialogOpen.value = true;
}

function closeImageAttachmentDialog(): void {
  isImageDialogOpen.value = false;
}

function openStatusDialog(): void {
  if (!hasRelayStatuses.value) {
    return;
  }

  const hasRecipientTab = statusSections.value.some((section) => section.key === 'recipient');
  statusDialogTab.value = hasRecipientTab ? 'recipient' : (statusSections.value[0]?.key ?? 'recipient');
  isStatusDialogOpen.value = true;
}

function openActionMenu(event: MouseEvent): void {
  if (event.button !== 0) {
    return;
  }

  lastActionMenuClickPosition.value = {
    left: event.clientX,
    top: event.clientY
  };
  shouldOpenEmojiPickerAfterActionMenu.value = false;
  isEmojiPickerMenuOpen.value = false;
  actionMenuRef.value?.show(event);
}

function openEmojiPickerMenu(): void {
  shouldOpenEmojiPickerAfterActionMenu.value = true;
  isActionMenuOpen.value = false;
}

function handleActionMenuHide(): void {
  if (!shouldOpenEmojiPickerAfterActionMenu.value) {
    return;
  }

  shouldOpenEmojiPickerAfterActionMenu.value = false;
  const positionEvent = createMenuPositionEvent();
  if (positionEvent) {
    emojiPickerMenuRef.value?.show(positionEvent);
    return;
  }

  isEmojiPickerMenuOpen.value = true;
}

function handleEmojiPickerMenuShow(): void {
  void nextTick(() => {
    emojiPickerRef.value?.reset();
  });
}

function createMenuPositionEvent(): MouseEvent | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const position = lastActionMenuClickPosition.value;
  if (!position) {
    return null;
  }

  return new MouseEvent('click', {
    bubbles: true,
    button: 0,
    clientX: position.left,
    clientY: position.top,
    view: window
  });
}

function notifyUnimplemented(label: string): void {
  $q.notify({
    type: 'info',
    message: t('common.notImplementedLabel', { label }),
    position: 'top',
    timeout: 1800
  });
}

async function copyText(value: string): Promise<void> {
  const text = value.trim();
  if (!text) {
    return;
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === 'undefined') {
    throw new Error('Clipboard is not available.');
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'absolute';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function handleReply(): void {
  emit('reply', props.message);
}

function handleForward(): void {
  if (!canForwardMessage.value) {
    return;
  }

  emit('forward', props.message);
}

function handleOpenAuthorProfile(): void {
  const publicKey = props.message.authorPublicKey.trim();
  if (!publicKey) {
    return;
  }

  try {
    emit('open-profile', publicKey);
  } catch (error) {
    reportUiError('Failed to open author profile from message bubble', error);
  }
}

function handleOpenMentionChat(publicKey?: string): void {
  const normalizedPublicKey = publicKey?.trim();
  if (!normalizedPublicKey) {
    return;
  }

  try {
    emit('open-mention-chat', normalizedPublicKey);
  } catch (error) {
    reportUiError('Failed to open mentioned chat from message bubble', error);
  }
}

function handleOpenReplyTarget(): void {
  if (!replyPreview.value) {
    return;
  }

  emit('open-reply-target', replyPreview.value.messageId, props.message.sentAt);
}

function handleEmojiReaction(emoji: string): void {
  try {
    isActionMenuOpen.value = false;
    isEmojiPickerMenuOpen.value = false;
    emit('react', {
      message: props.message,
      emoji
    });
  } catch (error) {
    reportUiError('Failed to emit message reaction', error, t('errors.failedAddReaction'));
  }
}

function handleRemoveReaction(reaction: MessageReaction): void {
  if (!canRemoveReaction(reaction)) {
    return;
  }

  try {
    emit('remove-reaction', {
      message: props.message,
      reaction
    });
  } catch (error) {
    reportUiError('Failed to emit message reaction removal', error, t('errors.failedRemoveReaction'));
  }
}

async function handleCopy(): Promise<void> {
  try {
    await copyText(baseVisibleMessageText.value);
    $q.notify({
      type: 'positive',
      message: t('message.messageCopied'),
      position: 'top',
      timeout: 1600
    });
  } catch (error) {
    reportUiError('Failed to copy message text', error, t('errors.failedCopyMessage'));
  }
}

async function handleCopyImageLink(url: string): Promise<void> {
  try {
    await copyText(url);
    $q.notify({
      type: 'positive',
      message: t('message.imageLinkCopied'),
      position: 'top',
      timeout: 1600
    });
  } catch (error) {
    reportUiError('Failed to copy image link', error, t('errors.failedCopyImageLink'));
  }
}

async function handleOpenMessageLink(url: string): Promise<void> {
  try {
    await openExternalHttpUrl(url);
  } catch (error) {
    reportUiError('Failed to open message link', error, t('errors.failedOpenLink'));
  }
}

function handlePin(): void {
  notifyUnimplemented(t('common.pin'));
}

function handleInfo(): void {
  isEventJsonViewOpen.value = false;
  isInfoDialogOpen.value = true;
}

function handleShowEventJson(): void {
  isEventJsonViewOpen.value = true;
}

function handleBackToInfo(): void {
  isEventJsonViewOpen.value = false;
}

function handleDelete(): void {
  if (!canDeleteMessage.value) {
    return;
  }

  emit('delete-message', props.message);
}

function openDeletedMessageDialog(): void {
  if (!isDeletedMessage.value) {
    return;
  }

  isDeletedMessageDialogOpen.value = true;
}

function setMessageExpanded(expanded: boolean): void {
  if (props.isMessageExpanded === undefined) {
    localMessageExpanded.value = expanded;
  }

  emit('update-message-expanded', {
    message: props.message,
    expanded,
  });
}

function toggleMessageExpanded(): void {
  setMessageExpanded(!isMessageExpanded.value);
}

function isRetrying(item: StatusListItem): boolean {
  return retryingRelayKeys.value.includes(item.key);
}

const activeStatusSection = computed(() => {
  return (
    statusSections.value.find((section) => section.key === statusDialogTab.value) ??
    statusSections.value[0] ??
    null
  );
});

function retryableStatusItemsForSection(section: StatusSection | null): StatusListItem[] {
  return (
    section?.items.filter((item) => item.retryable && isRetryableStatusScope(item.scope)) ?? []
  );
}

const retryableStatusItems = computed(() =>
  retryableStatusItemsForSection(activeStatusSection.value)
);

async function retryRelay(item: StatusListItem): Promise<void> {
  const messageId = Number.parseInt(props.message.id, 10);
  if (
    !Number.isInteger(messageId) ||
    messageId <= 0 ||
    !item.retryable ||
    !isRetryableStatusScope(item.scope) ||
    isRetrying(item)
  ) {
    return;
  }

  retryingRelayKeys.value = [...retryingRelayKeys.value, item.key];
  try {
    await nostrStore.retryDirectMessageRelay(messageId, item.relayUrl, item.scope);
  } catch (error) {
    reportUiError('Failed to retry direct message relay publish', error, t('errors.failedRetryRelay'));
  } finally {
    retryingRelayKeys.value = retryingRelayKeys.value.filter((key) => key !== item.key);
  }
}

async function retryFailedRelays(section: StatusSection | null = activeStatusSection.value): Promise<void> {
  if (isRetryingFailedRelays.value) {
    return;
  }

  const retryItems = retryableStatusItemsForSection(section).filter((item) => !isRetrying(item));
  if (retryItems.length === 0) {
    return;
  }

  isRetryingFailedRelays.value = true;
  try {
    await Promise.all(retryItems.map((item) => retryRelay(item)));
  } finally {
    isRetryingFailedRelays.value = false;
  }
}

const formattedTime = computed(() => {
  return new Intl.DateTimeFormat(getDateTimeLocale(), {
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(props.message.sentAt));
});

const formattedInfoTime = computed(() => {
  return new Intl.DateTimeFormat(getDateTimeLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(props.message.sentAt));
});

const formattedEventJson = computed(() => {
  const event = props.message.nostrEvent?.event;
  if (!event) {
    return '';
  }

  try {
    return JSON.stringify(event, null, 2);
  } catch {
    return '';
  }
});

watch(
  () => messageReactionItems.value.map((item) => item.key),
  (nextKeys, previousKeys) => {
    if (!hasReactionSnapshot.value) {
      hasReactionSnapshot.value = true;
      return;
    }

    const previousKeySet = new Set(previousKeys ?? []);
    messageReactionItems.value.forEach((item) => {
      if (item.isFreshCandidate && !previousKeySet.has(item.key)) {
        markReactionFresh(item.key);
      }
    });
  }
);

watch(
  () => [props.message.id, props.message.text, isDeletedMessage.value],
  () => {
    localMessageExpanded.value = false;
    revealedImageAttachmentKeys.value = [];
    closeImageAttachmentDialog();
  }
);

watch(isInfoDialogOpen, (isOpen) => {
  if (!isOpen) {
    isEventJsonViewOpen.value = false;
  }
});

watch(isImageDialogOpen, (isOpen) => {
  if (!isOpen) {
    fullscreenImageAttachment.value = null;
  }
});

onBeforeUnmount(() => {
  freshReactionTimers.forEach((timerId) => {
    clearTimeout(timerId);
  });
  freshReactionTimers.clear();
});
</script>

<style scoped>
.bubble-row,
.bubble-stack,
.bubble {
  --bubble-author-avatar-size: 36px;
  --bubble-author-gap: 10px;
  --bubble-author-indent: calc(var(--bubble-author-avatar-size) + var(--bubble-author-gap));
}

.bubble-row {
  display: flex;
  width: 100%;
  margin-bottom: 2px;
}

.bubble-stack {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 100%;
}

.bubble-stack--mine {
  align-items: flex-start;
}

.bubble-stack--their {
  align-items: flex-start;
}

.bubble-row--mine {
  justify-content: flex-start;
}

.bubble-row--their {
  justify-content: flex-start;
}

.bubble {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  width: 100%;
  max-width: 100%;
  padding: 2px 10px 2px 0;
  border-radius: 0;
  box-shadow: none;
  background: transparent;
  animation: bubble-in 180ms ease both;
  transition: background-color 0.2s ease;
  cursor: pointer;
  z-index: 0;
}

.bubble::before {
  content: '';
  position: absolute;
  inset: 0 0 0 calc(var(--bubble-author-indent) - 3px);
  background: var(--nc-hover);
  border-radius: inherit;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
}

.bubble__author {
  display: inline-flex;
  align-items: center;
  gap: var(--bubble-author-gap);
  margin: 0 0 4px;
  padding: 0;
  border: 0;
  background: transparent;
  opacity: 1;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.bubble__author:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--q-primary) 58%, transparent);
  outline-offset: 3px;
}

.bubble__author--mine {
  color: var(--nc-text-secondary);
}

.bubble__author--their {
  color: #79c0ff;
}

.bubble__author-avatar {
  width: var(--bubble-author-avatar-size);
  height: var(--bubble-author-avatar-size);
  min-width: var(--bubble-author-avatar-size);
  min-height: var(--bubble-author-avatar-size);
  font-size: 14px;
}

.bubble__author-name {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  line-height: 1.2;
}

.bubble:hover::before,
.bubble:focus-within::before {
  opacity: 1;
}

.bubble--mine {
  background: transparent;
}

.bubble--their {
  background: transparent;
}

.bubble__text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  cursor: pointer;
  color: var(--nc-text);
  line-height: 1.5;
}

.bubble__mention {
  display: inline;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--q-primary);
  font: inherit;
  font-weight: 700;
  line-height: inherit;
  cursor: pointer;
}

.bubble__mention:hover {
  text-decoration: underline;
}

.bubble__link {
  display: inline;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--q-primary);
  cursor: pointer;
  font: inherit;
  line-height: inherit;
  overflow-wrap: anywhere;
  text-decoration: none;
}

.bubble__more {
  margin-top: 6px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--q-primary);
  font-size: 0.88rem;
  font-weight: 600;
  line-height: 1.2;
  cursor: pointer;
}

.bubble__more:hover {
  text-decoration: underline;
}

.bubble__attachments {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 6px;
}

.bubble__image-attachment {
  max-width: min(100%, 360px);
}

.bubble__image-preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.bubble__image-preview-button {
  display: block;
  width: fit-content;
  max-width: min(100%, 360px);
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: zoom-in;
}

.bubble__image-preview-media {
  display: block;
  width: auto;
  max-width: min(100%, 360px);
  max-height: 320px;
  border: 1px solid var(--nc-border);
  border-radius: 8px;
  background: var(--nc-surface-soft-strong);
  object-fit: contain;
}

.bubble__image-preview-button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--q-primary) 54%, transparent);
  outline-offset: 3px;
  border-radius: 8px;
}

.bubble__image-gate {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px;
  border: 1px solid var(--nc-border);
  border-radius: 8px;
  background: var(--nc-surface-soft-strong);
}

.bubble__image-gate-icon {
  color: var(--nc-text-secondary);
}

.bubble__image-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.bubble__image-action {
  min-height: 30px;
}

.bubble__image-copy,
.bubble__image-open {
  width: 30px;
  height: 30px;
  min-width: 30px;
  min-height: 30px;
}

.bubble__image-show {
  min-height: 30px;
}

.bubble__image-trust {
  grid-column: 2 / -1;
  min-width: 0;
  color: var(--nc-text-secondary);
}

.bubble__image-trust :deep(.q-checkbox__label) {
  font-size: 12px;
  line-height: 1.3;
}

.bubble__image-dialog :deep(.q-dialog__inner) {
  padding: 0;
}

.bubble__image-dialog-card {
  position: relative;
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  max-width: none;
  max-height: 100vh;
  max-height: 100dvh;
  border-radius: 0;
  background: rgba(3, 7, 18, 0.96);
  color: white;
  overflow: hidden;
}

.bubble__image-dialog-toolbar {
  position: absolute;
  z-index: 2;
  top: max(12px, env(safe-area-inset-top));
  right: max(12px, env(safe-area-inset-right));
  display: flex;
  align-items: center;
  gap: 8px;
}

.bubble__image-dialog-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 999px;
  background: rgba(15, 23, 42, 0.72);
  color: white;
  text-decoration: none;
}

.bubble__image-dialog-close {
  background: rgba(15, 23, 42, 0.72);
  color: white;
}

.bubble__image-dialog-body {
  box-sizing: border-box;
  display: grid;
  place-items: center;
  width: 100vw;
  height: 100vh;
  height: 100dvh;
  min-width: 0;
  min-height: 0;
  padding: calc(max(56px, env(safe-area-inset-top)) + 12px)
    max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom))
    max(16px, env(safe-area-inset-left));
  overflow: hidden;
}

.bubble__image-dialog-media {
  display: block;
  max-width: 100%;
  max-height: 100%;
  min-width: 0;
  min-height: 0;
  object-fit: contain;
  border-radius: 6px;
}

.bubble__text--deleted {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  filter: blur(4px);
  user-select: none;
}

.bubble__text--emoji {
  font-size: clamp(2.4rem, 5vw, 3.8rem);
  line-height: 1.1;
}

.bubble__content {
  display: flex;
  flex: 0 1 auto;
  flex-direction: column;
  min-width: 0;
  margin-left: var(--bubble-author-indent);
  max-width: min(82%, 560px);
  cursor: inherit;
  position: relative;
  z-index: 1;
}

.bubble__reply-preview {
  display: flex;
  width: 100%;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 8px;
  padding: 0;
  border: 0;
  border-radius: 0;
  color: inherit;
  text-align: left;
  background: transparent;
  cursor: pointer;
}

.bubble__menu-stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 6px;
}

.bubble__actions-list {
  padding: 0;
  min-width: 204px;
}

.bubble__quick-reactions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border-radius: 12px;
  background: var(--nc-surface-soft-strong);
  border: 1px solid var(--nc-border);
}

.bubble__quick-reaction {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: transparent;
  box-shadow: none;
  color: inherit;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  transition:
    transform 0.18s ease,
    color 0.18s ease,
    opacity 0.18s ease;
}

.bubble__quick-reaction:hover {
  transform: none;
  color: var(--q-primary);
  opacity: 1;
}

.bubble__quick-reaction:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--q-primary) 54%, transparent);
  outline-offset: 2px;
}

.bubble__quick-reaction--more {
  color: var(--nc-text-secondary);
  font-size: 0;
}

.bubble__reactions {
  display: flex;
  flex: 0 0 100%;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: 6px;
  margin-top: 0;
  padding-left: var(--bubble-author-indent);
  position: relative;
  z-index: 1;
}

.bubble__reaction-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--nc-btn-round-border);
  border-radius: 999px;
  background: var(--nc-btn-round-bg);
  transition:
    transform 0.18s ease,
    background-color 0.18s ease,
    border-color 0.18s ease,
    color 0.18s ease;
}

.bubble__reaction-chip--fresh {
  background: var(--nc-reaction-accent-bg);
  border-color: var(--nc-reaction-accent-border);
  color: var(--nc-reaction-accent-text);
  transform-origin: center;
  animation: bubble-reaction-fresh-shake 720ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.bubble__reaction-chip--removable {
  cursor: pointer;
}

.bubble__reaction-chip--removable:hover {
  transform: none;
  background: var(--nc-chip-hover-bg);
}

.bubble__reaction-emoji {
  font-size: 16px;
  line-height: 1;
}

@keyframes bubble-reaction-fresh-shake {
  0%,
  100% {
    transform: translateX(0) rotate(0deg);
  }

  15% {
    transform: translateX(-2px) rotate(-5deg);
  }

  30% {
    transform: translateX(2px) rotate(5deg);
  }

  45% {
    transform: translateX(-2px) rotate(-4deg);
  }

  60% {
    transform: translateX(2px) rotate(4deg);
  }

  75% {
    transform: translateX(-1px) rotate(-2deg);
  }
}

.bubble__deleted-message-dialog {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
}

.bubble__reply-preview-accent {
  flex: 0 0 3px;
  align-self: stretch;
  border-radius: 999px;
  background: var(--q-primary);
}

.bubble__reply-preview-copy {
  min-width: 0;
  flex: 1;
}

.bubble__reply-preview-title {
  font-size: 11px;
  font-weight: 700;
  line-height: 1.25;
  color: var(--q-primary);
}

.bubble__reply-preview-text {
  font-size: 11px;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--nc-text-secondary);
}

.bubble__meta {
  display: flex;
  align-items: center;
  align-self: flex-end;
  margin-left: auto;
  gap: 6px;
  padding-bottom: 2px;
  white-space: nowrap;
  position: relative;
  z-index: 1;
}

@media (min-width: 1024px) {
  .bubble-row--desktop-bubbles {
    margin-bottom: 8px;
  }

  .bubble-row--desktop-bubbles.bubble-row--mine {
    justify-content: flex-start;
  }

  .bubble-row--desktop-bubbles.bubble-row--their {
    justify-content: flex-start;
  }

  .bubble-row--desktop-bubbles .bubble-stack {
    width: auto;
    max-width: min(76%, 640px);
  }

  .bubble-row--desktop-bubbles .bubble-stack--mine {
    align-items: flex-start;
  }

  .bubble-row--desktop-bubbles .bubble-stack--their {
    align-items: flex-start;
  }

  .bubble-row--desktop-bubbles .bubble {
    display: block;
    width: auto;
    max-width: 100%;
    padding: 8px 42px 7px 11px;
    border-radius: 16px;
  }

  .bubble-row--desktop-bubbles .bubble::before {
    display: none;
  }

  .bubble-row--desktop-bubbles .bubble--mine {
    background: var(--nc-sent);
    border-bottom-right-radius: 16px;
    border-bottom-left-radius: 6px;
  }

  .bubble-row--desktop-bubbles .bubble--their {
    background: var(--nc-received);
    border-bottom-left-radius: 6px;
  }

  .bubble-row--desktop-bubbles .bubble__content {
    display: block;
    flex: none;
    margin-left: 0;
    max-width: none;
  }

  .bubble-row--desktop-bubbles .bubble__reply-preview {
    padding: 6px 8px;
    border-radius: 12px;
    background: var(--nc-surface-soft-strong);
  }

  .bubble-row--desktop-bubbles .bubble__reactions {
    flex: none;
    margin-top: -8px;
    padding-left: 0;
  }

  .bubble-row--desktop-bubbles.bubble-row--mine .bubble__reactions {
    justify-content: flex-start;
  }

  .bubble-row--desktop-bubbles .bubble__meta {
    align-self: auto;
    justify-content: flex-end;
    margin-top: 4px;
    margin-left: 0;
    padding-bottom: 0;
  }
}

@media (max-width: 1023px) {
  .bubble-row,
  .bubble-stack,
  .bubble {
    --bubble-author-indent: 0px;
  }

  .bubble-row {
    width: auto;
    margin-bottom: 10px;
  }

  .bubble-stack {
    width: auto;
    max-width: min(82%, 560px);
  }

  .bubble-stack--mine {
    align-items: flex-end;
  }

  .bubble-stack--their {
    align-items: flex-start;
  }

  .bubble-row--mine {
    justify-content: flex-end;
  }

  .bubble-row--their {
    justify-content: flex-start;
  }

  .bubble {
    display: block;
    width: auto;
    max-width: 100%;
    font-family: var(--nc-mobile-font);
    border-radius: 16px;
    padding: 8px 42px 7px 11px;
    box-shadow: none;
  }

  .bubble::before {
    display: none;
  }

  .bubble--mine {
    background: var(--nc-sent);
    border-bottom-right-radius: 6px;
  }

  .bubble--their {
    background: var(--nc-received);
    border-bottom-left-radius: 6px;
  }

  .bubble__author {
    display: none;
  }

  .bubble-row--show-author-mobile .bubble__author {
    display: inline-flex;
    gap: 8px;
    margin-bottom: 6px;
  }

  .bubble-row--show-author-mobile .bubble__author-avatar {
    width: 28px;
    height: 28px;
    min-width: 28px;
    min-height: 28px;
    font-size: 12px;
  }

  .bubble-row--show-author-mobile .bubble__author-name {
    font-size: var(--nc-mobile-caption-font-size);
    font-weight: 600;
    line-height: var(--nc-mobile-caption-line-height);
    letter-spacing: 0;
  }

  .bubble__content {
    display: block;
    flex: none;
    margin-left: 0;
    max-width: none;
  }

  .bubble__reply-preview {
    padding: 6px 8px;
    border-radius: 12px;
    background: var(--nc-surface-soft-strong);
  }

  .bubble__reply-preview-title,
  .bubble__reply-preview-text {
    font-size: var(--nc-mobile-caption-font-size);
    line-height: var(--nc-mobile-caption-line-height);
    letter-spacing: 0;
  }

  .bubble__reply-preview-title {
    font-weight: 600;
  }

  .bubble__text {
    font-size: var(--nc-mobile-message-font-size);
    font-weight: 400;
    line-height: var(--nc-mobile-message-line-height);
    letter-spacing: 0;
  }

  .bubble__text--emoji {
    font-size: clamp(2.4rem, 12vw, 3.8rem);
    line-height: 1.1;
  }

  .bubble__more {
    font-size: var(--nc-mobile-caption-font-size);
    line-height: var(--nc-mobile-caption-line-height);
  }

  .bubble__image-attachment,
  .bubble__image-preview-media {
    max-width: 100%;
  }

  .bubble__image-gate {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .bubble__image-show,
  .bubble__image-trust {
    grid-column: 1 / -1;
  }

  .bubble__image-trust :deep(.q-checkbox__label) {
    font-size: var(--nc-mobile-caption-font-size);
    line-height: var(--nc-mobile-caption-line-height);
    letter-spacing: 0;
  }

  .bubble__reactions {
    flex: none;
    margin-top: -8px;
    padding-left: 0;
  }

  .bubble__meta {
    align-self: auto;
    justify-content: flex-end;
    margin-top: 4px;
    margin-left: 0;
    padding-bottom: 0;
  }
}

.bubble__time {
  font-size: 11px;
  color: var(--nc-text-secondary);
}

@media (max-width: 1023px) {
  .bubble__time {
    font-size: var(--nc-mobile-small-font-size);
    font-weight: 400;
    line-height: var(--nc-mobile-small-line-height);
    letter-spacing: 0;
  }
}

.bubble__status {
  display: inline-flex;
  align-items: center;
  width: 28px;
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
  box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.08);
  cursor: pointer;
}

.bubble__status-hitbox {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  min-height: 16px;
  padding: 5px 0;
  margin: -5px 0;
  cursor: pointer;
}

.bubble__status--pending {
  animation: bubble-status-pulse 1.8s ease-in-out infinite;
  transform-origin: center;
}

.bubble__status-segment {
  display: block;
  height: 100%;
  min-width: 4px;
}

.bubble__status-segment--green {
  flex: 2 1 0;
  background: #16a34a;
}

.bubble__status-segment--blue {
  flex: 2 1 0;
  background: #2563eb;
}

.bubble__status-segment--gray {
  flex: 1 1 0;
  background: rgba(100, 116, 139, 0.5);
}

.bubble__status-segment--red {
  flex: 1 1 0;
  background: #dc2626;
}

.bubble__status-list {
  margin: 0;
  padding-left: 16px;
}

.bubble__status-section-title {
  font-size: 10px;
  font-weight: 700;
  margin-bottom: 4px;
}

.bubble__status-section-separator {
  height: 1px;
  margin: 7px 0;
  background: rgba(148, 163, 184, 0.2);
}

.bubble__status-tabs {
  min-height: 34px;
  margin: -4px 0 8px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.2);
}

:deep(.bubble__status-tabs .q-tab) {
  min-height: 34px;
  padding: 0 8px;
}

:deep(.bubble__status-tabs .q-tab__label) {
  font-size: 12px;
  line-height: 1.2;
  white-space: normal;
  text-align: center;
}

.bubble__status-tab-panels {
  background: transparent;
  color: inherit;
}

.bubble__status-tab-panel {
  padding: 4px 0 0;
}

.bubble__status-list-item {
  font-size: 10px;
  line-height: 1.35;
}

.bubble__status-list--dialog {
  list-style: none;
  padding-left: 0;
}

.bubble__status-list-item--dialog {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 7px;
}

.bubble__status-list-item--dialog + .bubble__status-list-item--dialog {
  margin-top: 4px;
}

.bubble__status-list-item-main {
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 7px;
}

.bubble__status-list-copy {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.bubble__status-list-item--empty {
  list-style: none;
  color: var(--nc-text-secondary);
  opacity: 1;
  padding-left: 0;
}

.bubble__status-list-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  margin-top: 3px;
  border-radius: 999px;
}

.bubble__status-list-dot--green {
  background: #16a34a;
}

.bubble__status-list-dot--blue {
  background: #2563eb;
}

.bubble__status-list-dot--red {
  background: #dc2626;
}

.bubble__status-list-dot--gray {
  background: rgba(100, 116, 139, 0.75);
}

.bubble__status-list-text {
  min-width: 0;
  word-break: break-word;
}

.bubble__status-list-detail {
  min-width: 0;
  color: var(--nc-text-secondary);
  word-break: break-word;
}

.bubble__status-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}

.bubble__status-retry-all {
  min-height: 28px;
}

.bubble__status-retry {
  flex: 0 0 auto;
  min-height: 22px;
}

.bubble__status-empty {
  font-size: 12px;
  line-height: 1.45;
  color: var(--nc-text-secondary);
}

.bubble__info-dialog-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.bubble__info-dialog-title-text {
  min-width: 0;
  font-family: var(--nc-title-font);
  font-size: 17px;
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: 0.02em;
  color: var(--nc-text);
}

.bubble__info-back {
  flex: 0 0 auto;
}

.bubble__info {
  display: grid;
  gap: 12px;
}

.bubble__info-row {
  display: grid;
  gap: 4px;
}

.bubble__info-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--nc-text-secondary);
  opacity: 1;
}

.bubble__info-value {
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
}

.bubble__info-value--mono {
  font-family: 'SFMono-Regular', 'Menlo', 'Consolas', monospace;
  font-size: 12px;
}

.bubble__info-json-button {
  justify-self: start;
  align-self: start;
}

.bubble__event-json-panel {
  display: grid;
}

.bubble__event-json {
  margin: 0;
  padding: 12px;
  border-radius: 16px;
  overflow: auto;
  max-height: min(56vh, 460px);
  background: var(--nc-surface-soft-strong);
  border: 1px solid var(--nc-border);
  font-family: 'SFMono-Regular', 'Menlo', 'Consolas', monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.bubble__event-json-empty {
  font-size: 14px;
  line-height: 1.5;
  color: var(--nc-text-secondary);
}

@media (hover: none) {
  .bubble__menu-trigger {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0);
  }
}

@keyframes bubble-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes bubble-status-pulse {
  0%,
  100% {
    opacity: 0.72;
    box-shadow:
      inset 0 0 0 1px rgba(15, 23, 42, 0.08),
      0 0 0 0 rgba(100, 116, 139, 0.08);
  }

  50% {
    opacity: 1;
    box-shadow:
      inset 0 0 0 1px rgba(15, 23, 42, 0.08),
      0 0 0 4px rgba(100, 116, 139, 0.18);
  }
}
</style>
