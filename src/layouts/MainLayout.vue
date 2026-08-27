<template>
  <q-layout view="lHh Lpr lFf">
    <q-page-container
      class="main-layout__page-container"
      :class="{ 'main-layout__page-container--mobile-overlay-nav': showMobileNav }"
    >
      <router-view />
      <div
        v-if="showMobileNavigationMask"
        class="main-layout__mobile-nav-mask"
        aria-hidden="true"
      />
    </q-page-container>

    <q-footer v-if="showMobileNav" class="mobile-nav">
      <div class="mobile-nav__inner">
        <q-btn
          flat
          no-caps
          class="mobile-nav__btn"
          :class="{ 'mobile-nav__btn--active': activeSection === 'chats' }"
          @click="goToSection('chats')"
        >
          <span class="mobile-nav__content">
            <span class="mobile-nav__icon-shell">
              <q-icon name="chat" class="mobile-nav__icon" />
              <q-badge
                v-if="unreadChatCount > 0"
                rounded
                color="primary"
                class="mobile-nav__badge"
                :label="unreadChatBadgeLabel"
              />
            </span>
            <span class="mobile-nav__label">{{ $t('chat.chats') }}</span>
          </span>
        </q-btn>
        <q-btn
          flat
          no-caps
          class="mobile-nav__btn"
          :class="{ 'mobile-nav__btn--active': activeSection === 'contacts' }"
          @click="goToSection('contacts')"
        >
          <span class="mobile-nav__content">
            <span class="mobile-nav__icon-shell">
              <q-icon name="contacts" class="mobile-nav__icon" />
            </span>
            <span class="mobile-nav__label">{{ $t('contacts.contacts.label') }}</span>
          </span>
        </q-btn>
        <q-btn
          flat
          no-caps
          class="mobile-nav__btn"
          :class="{ 'mobile-nav__btn--active': activeSection === 'settings' }"
          @click="goToSection('settings')"
        >
          <span class="mobile-nav__content">
            <span class="mobile-nav__icon-shell">
              <q-icon name="settings" class="mobile-nav__icon" />
              <q-badge
                v-if="hasUpdateAvailable"
                rounded
                color="primary"
                class="mobile-nav__badge"
                label="1"
              />
            </span>
            <span class="mobile-nav__label">{{ $t('settings.settings') }}</span>
          </span>
        </q-btn>
      </div>
    </q-footer>
  </q-layout>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { useRoute, useRouter } from 'vue-router';
import {
  loadChatsPage,
  loadContactsPage,
  loadSettingsPage
} from 'src/router/pageLoaders';
import { useVisibleViewportHeight } from 'src/composables/useVisibleViewportHeight';
import {
  refreshAndroidPushRegistration,
  resolveAndroidPushNotificationRoute,
  startAndroidPushNotificationListeners
} from 'src/services/androidPushNotificationService';
import { inputSanitizerService } from 'src/services/inputSanitizerService';
import { useAppUpdateStore } from 'src/stores/appUpdateStore';
import { useChatStore } from 'src/stores/chatStore';
import { useNostrStore } from 'src/stores/nostrStore';
import { useRelayStore } from 'src/stores/relayStore';
import { formatUnreadChatBadgeLabel } from 'src/utils/unreadChatBadge';
import { reportUiError } from 'src/utils/uiErrorHandler';

const $q = useQuasar();
const route = useRoute();
const router = useRouter();
const appUpdateStore = useAppUpdateStore();
const chatStore = useChatStore();
const nostrStore = useNostrStore();
const relayStore = useRelayStore();
const isMobile = computed(() => $q.screen.lt.sm);
const isNativeMobile = computed(() => $q.platform.is.nativeMobile === true);
const NATIVE_KEYBOARD_INSET_THRESHOLD_PX = 80;
const nativeViewportBaselineHeight = ref(0);
const hasNativeFocusedTextControl = ref(false);
const {
  visibleViewportHeight,
  visibleViewportOffsetTop,
  visibleViewportKeyboardInset,
  isVisualViewportKeyboardVisible
} = useVisibleViewportHeight(() => $q.screen.height);
const nativeLayoutKeyboardInset = computed(() => {
  return Math.max(0, nativeViewportBaselineHeight.value - readGlobalViewportHeight());
});
const isNativeKeyboardVisible = computed(() => {
  if (!isMobile.value || !isNativeMobile.value) {
    return false;
  }

  return (
    isVisualViewportKeyboardVisible.value ||
    (hasNativeFocusedTextControl.value &&
      nativeLayoutKeyboardInset.value >= NATIVE_KEYBOARD_INSET_THRESHOLD_PX)
  );
});

type NavigationSection = 'chats' | 'contacts' | 'settings';
type RouteLoader = () => Promise<unknown>;

const NATIVE_KEYBOARD_VISIBLE_CLASS = 'nc-native-keyboard-visible';
const pendingDialogFocusTimeoutIds = new Set<number>();
const pendingNativeKeyboardScrollResetTimeoutIds = new Set<number>();

const activeSection = computed<NavigationSection>(() => {
  const routeName = String(route.name ?? '');

  if (routeName === 'contacts') {
    return 'contacts';
  }

  if (routeName === 'settings' || routeName.startsWith('settings-')) {
    return 'settings';
  }

  return 'chats';
});
const pendingMobileSection = ref<NavigationSection | null>(null);
const showMobileNavigationMask = computed(() => isMobile.value && pendingMobileSection.value !== null);

const routeLoaders: Record<NavigationSection, RouteLoader> = {
  chats: loadChatsPage,
  contacts: loadContactsPage,
  settings: loadSettingsPage
};
const unreadChatCount = computed(() => chatStore.unreadChatCount);
const unreadChatBadgeLabel = computed(() => formatUnreadChatBadgeLabel(unreadChatCount.value));
const hasUpdateAvailable = computed(() => appUpdateStore.hasUpdateAvailable);

function hasActivePubkeyParam(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => typeof entry === 'string' && entry.trim().length > 0);
  }

  return typeof value === 'string' && value.trim().length > 0;
}

const showMobileNav = computed(() => {
  if (!isMobile.value) {
    return false;
  }

  if (route.name === 'chats') {
    return !hasActivePubkeyParam(route.params.pubkey);
  }

  if (route.name === 'contacts') {
    return !hasActivePubkeyParam(route.params.pubkey);
  }

  if (route.name === 'settings') {
    return true;
  }

  return false;
});

const routeChatId = computed(() => {
  if (route.name !== 'chats') {
    return null;
  }

  if (typeof route.params.pubkey !== 'string') {
    return null;
  }

  const chatId = route.params.pubkey.trim().toLowerCase();
  return chatId || null;
});

watch(
  routeChatId,
  (chatId) => {
    nostrStore.setAppLifecycleRouteChatId(chatId);
  },
  { immediate: true }
);

watch(
  [unreadChatCount, unreadChatBadgeLabel],
  ([count, label]) => {
    if (typeof window === 'undefined') {
      return;
    }

    window.desktopRuntime?.setUnreadChatBadge(count, label);
  },
  { immediate: true }
);

const removeAfterEachHook = router.afterEach(() => {
  pendingMobileSection.value = null;
});
let mobilePreloadTimeoutId: number | null = null;
let startupRestoreFrameId: number | null = null;
let nativeFocusOutTimeoutId: number | null = null;
let removeDesktopNotificationOpenListener: (() => void) | null = null;

onMounted(() => {
  nostrStore.startAppLifecycleRuntime();
  startAndroidPushNotificationListeners((recipientPubkey) => {
    void openAndroidPushNotification(recipientPubkey);
  });
  syncNativeViewportCssVariables();
  document.addEventListener('focusin', handleNativeDialogFocusIn);
  document.addEventListener('focusout', handleNativeFocusOut);

  if (
    typeof window !== 'undefined' &&
    typeof window.desktopRuntime?.onOpenChatFromNotification === 'function'
  ) {
    removeDesktopNotificationOpenListener = window.desktopRuntime.onOpenChatFromNotification(
      (chatPubkey) => {
        void openChatFromDesktopNotification(chatPubkey);
      }
    );
  }

  startupRestoreFrameId = window.requestAnimationFrame(() => {
    startupRestoreFrameId = null;
    void restoreStartupState();
  });

  if (!isMobile.value) {
    return;
  }

  mobilePreloadTimeoutId = window.setTimeout(() => {
    mobilePreloadTimeoutId = null;
    void preloadMobileSections();
  }, 900);
});

onBeforeUnmount(() => {
  nostrStore.stopAppLifecycleRuntime();
  removeAfterEachHook();
  removeDesktopNotificationOpenListener?.();
  removeDesktopNotificationOpenListener = null;
  document.removeEventListener('focusin', handleNativeDialogFocusIn);
  document.removeEventListener('focusout', handleNativeFocusOut);
  clearPendingDialogFocusScrolls();
  clearPendingNativeKeyboardScrollResets();
  resetNativeViewportCssVariables();

  if (mobilePreloadTimeoutId !== null) {
    window.clearTimeout(mobilePreloadTimeoutId);
  }

  if (startupRestoreFrameId !== null) {
    window.cancelAnimationFrame(startupRestoreFrameId);
  }

  if (nativeFocusOutTimeoutId !== null) {
    window.clearTimeout(nativeFocusOutTimeoutId);
    nativeFocusOutTimeoutId = null;
  }
});

watch(
  [
    isMobile,
    isNativeMobile,
    hasNativeFocusedTextControl,
    visibleViewportHeight,
    visibleViewportOffsetTop,
    visibleViewportKeyboardInset,
    isVisualViewportKeyboardVisible
  ],
  () => {
    syncNativeViewportCssVariables();
    if (isNativeKeyboardVisible.value) {
      scheduleNativeKeyboardScrollReset();
    }
  },
  { immediate: true }
);

watch(isNativeKeyboardVisible, (isVisible) => {
  if (isVisible) {
    scheduleNativeKeyboardScrollReset();
    scheduleFocusedDialogControlIntoView(document.activeElement);
    return;
  }

  clearPendingNativeKeyboardScrollResets();
});

watch(
  [
    () => nostrStore.contactListVersion,
    () => relayStore.relayEntries.map((entry) => `${entry.url}:${entry.read ? 'r' : '-'}:${entry.write ? 'w' : '-'}`).join('|')
  ],
  () => {
    void refreshAndroidPushRegistration().catch((error) => {
      console.warn('Failed to refresh Android push registration.', error);
    });
  }
);

function readGlobalViewportHeight(): number {
  if (typeof window === 'undefined') {
    return $q.screen.height;
  }

  return visibleViewportHeight.value ?? window.visualViewport?.height ?? window.innerHeight ?? $q.screen.height;
}

function syncNativeViewportCssVariables(): void {
  if (typeof document === 'undefined') {
    return;
  }

  updateNativeViewportBaseline();

  const viewportHeight = Math.max(0, Math.round(readGlobalViewportHeight()));
  const viewportOffsetTop = Math.max(0, Math.round(visibleViewportOffsetTop.value));
  const keyboardInset = isMobile.value
    ? Math.max(0, Math.round(visibleViewportKeyboardInset.value))
    : 0;
  const effectiveKeyboardInset = isNativeKeyboardVisible.value ? keyboardInset : 0;

  document.documentElement.style.setProperty('--nc-visual-viewport-height', `${viewportHeight}px`);
  document.documentElement.style.setProperty('--nc-visual-viewport-offset-top', `${viewportOffsetTop}px`);
  document.documentElement.style.setProperty('--nc-mobile-keyboard-inset', `${effectiveKeyboardInset}px`);
  document.documentElement.classList.toggle(NATIVE_KEYBOARD_VISIBLE_CLASS, isNativeKeyboardVisible.value);
  document.body.classList.toggle(NATIVE_KEYBOARD_VISIBLE_CLASS, isNativeKeyboardVisible.value);
}

function resetNativeViewportCssVariables(): void {
  if (typeof document === 'undefined') {
    return;
  }

  document.documentElement.style.removeProperty('--nc-visual-viewport-height');
  document.documentElement.style.removeProperty('--nc-visual-viewport-offset-top');
  document.documentElement.style.removeProperty('--nc-mobile-keyboard-inset');
  document.documentElement.classList.remove(NATIVE_KEYBOARD_VISIBLE_CLASS);
  document.body.classList.remove(NATIVE_KEYBOARD_VISIBLE_CLASS);
}

function clearPendingDialogFocusScrolls(): void {
  pendingDialogFocusTimeoutIds.forEach((timeoutId) => {
    window.clearTimeout(timeoutId);
  });
  pendingDialogFocusTimeoutIds.clear();
}

function clearPendingNativeKeyboardScrollResets(): void {
  pendingNativeKeyboardScrollResetTimeoutIds.forEach((timeoutId) => {
    window.clearTimeout(timeoutId);
  });
  pendingNativeKeyboardScrollResetTimeoutIds.clear();
}

function resetNativeKeyboardScrollPosition(): void {
  if (
    !isNativeKeyboardVisible.value ||
    !isMobile.value ||
    !isNativeMobile.value ||
    $q.platform.is.android !== true ||
    typeof window === 'undefined' ||
    typeof document === 'undefined'
  ) {
    return;
  }

  document.scrollingElement?.scrollTo({ left: 0, top: 0, behavior: 'auto' });
  document.documentElement.scrollTop = 0;
  document.documentElement.scrollLeft = 0;
  document.body.scrollTop = 0;
  document.body.scrollLeft = 0;
  window.scrollTo({ left: 0, top: 0, behavior: 'auto' });
}

function scheduleNativeKeyboardScrollReset(): void {
  if (
    !isMobile.value ||
    !isNativeMobile.value ||
    $q.platform.is.android !== true ||
    typeof window === 'undefined'
  ) {
    return;
  }

  clearPendingNativeKeyboardScrollResets();

  [0, 80, 220, 420].forEach((delay) => {
    const timeoutId = window.setTimeout(() => {
      pendingNativeKeyboardScrollResetTimeoutIds.delete(timeoutId);
      resetNativeKeyboardScrollPosition();
    }, delay);
    pendingNativeKeyboardScrollResetTimeoutIds.add(timeoutId);
  });
}

function scheduleFocusedDialogControlIntoView(target: EventTarget | null): void {
  if (!isMobile.value || !isNativeMobile.value || typeof window === 'undefined') {
    return;
  }

  const targetElement = target instanceof HTMLElement ? target : null;
  const focusedElement =
    targetElement ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const dialogElement = focusedElement?.closest<HTMLElement>('.q-dialog');
  if (!focusedElement || !dialogElement) {
    return;
  }

  const scrollTarget = focusedElement.closest<HTMLElement>('.q-field') ?? focusedElement;
  clearPendingDialogFocusScrolls();

  [80, 220, 420].forEach((delay) => {
    const timeoutId = window.setTimeout(() => {
      pendingDialogFocusTimeoutIds.delete(timeoutId);
      scrollTarget.scrollIntoView({
        block: 'center',
        inline: 'nearest',
        behavior: 'smooth'
      });
    }, delay);
    pendingDialogFocusTimeoutIds.add(timeoutId);
  });
}

function handleNativeDialogFocusIn(event: FocusEvent): void {
  updateNativeFocusedTextControl(event.target);
  scheduleFocusedDialogControlIntoView(event.target);
}

function handleNativeFocusOut(): void {
  if (typeof window === 'undefined') {
    return;
  }

  if (nativeFocusOutTimeoutId !== null) {
    window.clearTimeout(nativeFocusOutTimeoutId);
  }

  nativeFocusOutTimeoutId = window.setTimeout(() => {
    nativeFocusOutTimeoutId = null;
    updateNativeFocusedTextControl(document.activeElement);
    syncNativeViewportCssVariables();
  }, 0);
}

function isTextInputElement(element: HTMLElement): boolean {
  const tagName = element.tagName.toLowerCase();
  if (tagName === 'input' || tagName === 'textarea') {
    return true;
  }

  return element.isContentEditable || element.closest('[contenteditable="true"]') !== null;
}

function updateNativeFocusedTextControl(target: EventTarget | null): void {
  if (!isMobile.value || !isNativeMobile.value || typeof document === 'undefined') {
    hasNativeFocusedTextControl.value = false;
    return;
  }

  const targetElement = target instanceof HTMLElement ? target : null;
  const focusedElement =
    targetElement ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  hasNativeFocusedTextControl.value = Boolean(focusedElement && isTextInputElement(focusedElement));
}

function updateNativeViewportBaseline(): void {
  const viewportHeight = Math.max(0, Math.round(readGlobalViewportHeight()));
  if (!isMobile.value || !isNativeMobile.value) {
    nativeViewportBaselineHeight.value = viewportHeight;
    return;
  }

  if (nativeViewportBaselineHeight.value <= 0) {
    nativeViewportBaselineHeight.value = viewportHeight;
    return;
  }

  if (!hasNativeFocusedTextControl.value && !isVisualViewportKeyboardVisible.value) {
    nativeViewportBaselineHeight.value = viewportHeight;
    return;
  }

  const layoutKeyboardInset = Math.max(0, nativeViewportBaselineHeight.value - viewportHeight);
  const shouldHoldBaseline =
    hasNativeFocusedTextControl.value &&
    layoutKeyboardInset >= NATIVE_KEYBOARD_INSET_THRESHOLD_PX;

  if (!shouldHoldBaseline && viewportHeight > nativeViewportBaselineHeight.value) {
    nativeViewportBaselineHeight.value = viewportHeight;
  }
}

async function restoreStartupState(): Promise<void> {
  try {
    relayStore.init();
    await nostrStore.restoreStartupState(relayStore.relays);
  } catch (error) {
    console.error('Failed to restore app state on startup', error);
  }
}

async function preloadMobileSections(): Promise<void> {
  const sections = Object.entries(routeLoaders)
    .filter(([section]) => section !== activeSection.value)
    .map(([, loader]) => loader());

  const results = await Promise.allSettled(sections);
  const failedCount = results.filter((result) => result.status === 'rejected').length;
  if (failedCount > 0) {
    console.warn(`Failed to preload ${failedCount} mobile navigation page(s).`);
  }
}

async function openChatFromDesktopNotification(chatPubkey: string): Promise<void> {
  const normalizedChatPubkey = inputSanitizerService.normalizeHexKey(chatPubkey);
  if (!normalizedChatPubkey) {
    console.warn('Ignored desktop notification open request for invalid chat pubkey.');
    return;
  }

  if (route.name === 'chats' && routeChatId.value === normalizedChatPubkey) {
    return;
  }

  try {
    await router.push({
      name: 'chats',
      params: {
        pubkey: normalizedChatPubkey,
      },
    });
  } catch (error) {
    reportUiError('Failed to open chat from desktop notification', error);
  }
}

async function openAndroidPushNotification(recipientPubkey: string | null): Promise<void> {
  try {
    await router.push(await resolveAndroidPushNotificationRoute(recipientPubkey));
  } catch (error) {
    reportUiError('Failed to open chat from Android notification', error);
  }
}

function navigateToSection(
  section: NavigationSection,
  routeName: 'chats' | 'contacts' | 'settings'
): void {
  if (isMobile.value && section !== activeSection.value) {
    pendingMobileSection.value = section;
  }

  void router.push({ name: routeName }).catch((error) => {
    pendingMobileSection.value = null;
    reportUiError(`Failed to navigate to ${section}`, error);
  });
}

function goToSection(section: NavigationSection): void {
  if (section === 'chats') {
    const hasActiveChatParam = hasActivePubkeyParam(route.params.pubkey);
    if (route.name !== 'chats' || hasActiveChatParam) {
      navigateToSection('chats', 'chats');
    }
    return;
  }

  if (section === 'contacts') {
    const hasActiveContactParam = hasActivePubkeyParam(route.params.pubkey);
    if (route.name !== 'contacts' || hasActiveContactParam) {
      navigateToSection('contacts', 'contacts');
    }
    return;
  }

  if (route.name !== 'settings' || String(route.name ?? '').startsWith('settings-')) {
    navigateToSection('settings', 'settings');
  }
}
</script>

<style scoped>
.main-layout__page-container {
  position: relative;
}

.main-layout__page-container--mobile-overlay-nav {
  padding-bottom: 0 !important;
}

.main-layout__mobile-nav-mask {
  position: absolute;
  inset: 0;
  z-index: 5;
  background: var(--nc-overlay);
  pointer-events: auto;
}

.mobile-nav {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 30;
  padding: 0 18px max(12px, env(safe-area-inset-bottom));
  background: transparent;
  border-top: 0;
  box-shadow: none;
  backdrop-filter: none;
  pointer-events: none;
}

.mobile-nav::before {
  content: '';
  display: none;
  position: absolute;
  pointer-events: none;
}

.mobile-nav__inner {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: center;
  gap: 4px;
  width: min(326px, 100%);
  margin: 0 auto;
  padding: 4px;
  border: 1px solid color-mix(in srgb, var(--nc-border) 88%, #bdcad7 12%);
  border-radius: 999px;
  background: color-mix(in srgb, var(--nc-panel-header-bg) 96%, rgba(255, 255, 255, 0.9) 4%);
  box-shadow:
    0 8px 22px rgba(27, 45, 66, 0.12),
    0 1px 0 rgba(255, 255, 255, 0.72) inset;
  backdrop-filter: saturate(170%) blur(16px);
  pointer-events: auto;
}

.mobile-nav__btn {
  color: var(--nc-text-secondary);
  border-radius: 999px;
  min-height: 44px;
  padding: 4px 2px;
  border: 0;
  background: transparent !important;
  box-shadow: none !important;
  transition:
    background-color 0.2s ease,
    color 0.2s ease;
}

.mobile-nav__badge {
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  position: absolute;
  top: -7px;
  left: calc(100% - 4px);
  z-index: 1;
}

.mobile-nav__content {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 100%;
}

.mobile-nav__icon-shell {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  min-width: 22px;
  min-height: 22px;
}

.mobile-nav__icon {
  font-size: 19px;
}

.mobile-nav__label {
  min-width: 0;
  font-size: 9px;
  font-weight: 600;
  line-height: 1;
}

.mobile-nav__btn :deep(.q-btn__content) {
  justify-content: center;
  flex-direction: column;
  gap: 2px;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0;
  width: 100%;
}

.mobile-nav__btn:hover {
  background: transparent !important;
}

.mobile-nav__btn--active {
  background: #eaf6ff !important;
  color: var(--q-primary) !important;
}

body.body--dark .mobile-nav__btn {
  color: var(--nc-text-secondary);
  background: transparent !important;
}

body.body--dark .mobile-nav {
  background: transparent;
}

body.body--dark .mobile-nav__inner {
  border-color: color-mix(in srgb, var(--nc-border) 88%, #62798f 12%);
  background: color-mix(in srgb, var(--nc-panel-header-bg) 95%, rgba(13, 20, 27, 0.78) 5%);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
}

body.body--dark .mobile-nav__btn--active {
  background: rgba(100, 181, 246, 0.16) !important;
  color: #8ed3ff !important;
}
</style>
