<template>
  <router-view />
  <transition name="foreground-message-banner">
    <div
      v-if="foregroundMessageBanner"
      class="foreground-message-banner"
      role="button"
      tabindex="0"
      @click="openForegroundMessageBannerChat"
      @keydown.enter.prevent="openForegroundMessageBannerChat"
      @keydown.space.prevent="openForegroundMessageBannerChat"
    >
      <CachedAvatar
        class="foreground-message-banner__avatar"
        :src="foregroundMessageBanner.iconUrl"
        :alt="foregroundMessageBanner.title"
        :fallback="foregroundMessageBannerAvatarFallback"
      />
      <span class="foreground-message-banner__content">
        <span class="foreground-message-banner__title">{{ foregroundMessageBanner.title }}</span>
        <span class="foreground-message-banner__caption">{{ foregroundMessageBannerMessage }}</span>
      </span>
      <q-btn
        class="foreground-message-banner__close"
        flat
        round
        dense
        icon="close"
        :aria-label="$t('common.dismiss')"
        @click.stop="dismissForegroundMessageBanner"
      />
    </div>
  </transition>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { Notify, useQuasar } from 'quasar';
import CachedAvatar from 'src/components/CachedAvatar.vue';
import {
  FOREGROUND_MESSAGE_ACTIVITY_EVENT,
  readForegroundMessageActivityDetail,
  type ForegroundMessageActivityDetail,
} from 'src/services/foregroundMessageActivityService';
import { useAppUpdateStore } from 'src/stores/appUpdateStore';
import { installAppE2EBridge } from 'src/testing/e2eBridge';
import { buildAvatarText } from 'src/utils/avatarText';
import { readDarkModePreference } from 'src/utils/themeStorage';
import { useRouter } from 'vue-router';
import { t } from 'src/i18n';

const $q = useQuasar();
const router = useRouter();
const appUpdateStore = useAppUpdateStore();
Notify.setDefaults({
  position: 'top',
  actions: [
    {
      icon: 'close',
      round: true,
      dense: true,
      flat: true,
      color: 'white',
      'aria-label': t('common.dismiss'),
    },
  ],
});
const savedDarkMode = readDarkModePreference();
const foregroundMessageBanner = ref<ForegroundMessageActivityDetail | null>(null);
const foregroundMessageBannerAvatarFallback = computed(() =>
  buildAvatarText(foregroundMessageBanner.value?.title ?? 'Anagram')
);
const foregroundMessageBannerMessage = computed(() => {
  const messageText = foregroundMessageBanner.value?.messageText.replace(/\s+/g, ' ').trim() ?? '';
  return messageText || t('message.message');
});
let foregroundMessageBannerTimeoutId: number | null = null;

if (savedDarkMode !== null) {
  $q.dark.set(savedDarkMode);
}

function clearForegroundMessageBannerTimeout(): void {
  if (foregroundMessageBannerTimeoutId === null) {
    return;
  }

  window.clearTimeout(foregroundMessageBannerTimeoutId);
  foregroundMessageBannerTimeoutId = null;
}

function dismissForegroundMessageBanner(): void {
  clearForegroundMessageBannerTimeout();
  foregroundMessageBanner.value = null;
}

function showForegroundMessageBanner(detail: ForegroundMessageActivityDetail): void {
  if (!detail.showBanner) {
    return;
  }

  clearForegroundMessageBannerTimeout();
  foregroundMessageBanner.value = {
    chatPubkey: detail.chatPubkey,
    iconUrl: detail.iconUrl,
    messageText: detail.messageText,
    title: detail.title || t('app.name'),
    showBanner: true,
  };
  foregroundMessageBannerTimeoutId = window.setTimeout(() => {
    foregroundMessageBanner.value = null;
    foregroundMessageBannerTimeoutId = null;
  }, 5000);
}

function handleForegroundMessageActivity(event: Event): void {
  const detail = readForegroundMessageActivityDetail(event);
  if (!detail) {
    return;
  }

  showForegroundMessageBanner(detail);
}

async function openForegroundMessageBannerChat(): Promise<void> {
  const banner = foregroundMessageBanner.value;
  if (!banner) {
    return;
  }

  dismissForegroundMessageBanner();
  await router.push({ name: 'chats', params: { pubkey: banner.chatPubkey } });
}

onMounted(() => {
  window.addEventListener(FOREGROUND_MESSAGE_ACTIVITY_EVENT, handleForegroundMessageActivity);
  void appUpdateStore.startRuntime();

  if (process.env.DEV) {
    installAppE2EBridge();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener(FOREGROUND_MESSAGE_ACTIVITY_EVENT, handleForegroundMessageActivity);
  appUpdateStore.stopRuntime();
  clearForegroundMessageBannerTimeout();
});
</script>

<style scoped>
.foreground-message-banner {
  position: fixed;
  z-index: 6000;
  top: calc(env(safe-area-inset-top, 0px) + 12px);
  left: 50%;
  display: flex;
  align-items: center;
  gap: 12px;
  width: min(calc(100vw - 24px), 420px);
  min-height: 58px;
  padding: 10px 10px 10px 14px;
  color: var(--nc-text);
  background: color-mix(in srgb, var(--nc-panel-header-bg) 96%, var(--nc-app-background) 4%);
  border: 1px solid color-mix(in srgb, var(--nc-border) 88%, var(--nc-text-secondary) 12%);
  border-radius: 8px;
  box-shadow: var(--nc-shadow-md);
  transform: translateX(-50%);
  cursor: pointer;
  backdrop-filter: blur(var(--nc-glass-blur-soft));
}

.foreground-message-banner:focus-visible {
  outline: 2px solid var(--q-primary);
  outline-offset: 2px;
}

.foreground-message-banner__avatar {
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  font-size: 0.86rem;
}

.foreground-message-banner__content {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.foreground-message-banner__title,
.foreground-message-banner__caption {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.foreground-message-banner__title {
  font-size: 0.95rem;
  font-weight: 700;
}

.foreground-message-banner__caption {
  margin-top: 2px;
  font-size: 0.78rem;
  color: var(--nc-text-secondary);
  opacity: 0.88;
}

.foreground-message-banner__close {
  color: var(--nc-text-secondary);
}

.foreground-message-banner-enter-active,
.foreground-message-banner-leave-active {
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}

.foreground-message-banner-enter-from,
.foreground-message-banner-leave-to {
  opacity: 0;
  transform: translate(-50%, -10px);
}
</style>
