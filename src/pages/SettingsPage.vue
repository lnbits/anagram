<template>
  <q-page class="settings-page" :style-fn="settingsPageStyleFn">
    <div
      ref="shellRef"
      class="settings-shell"
      :class="{ 'settings-shell--mobile': isMobile }"
      :style="shellStyle"
    >
      <aside v-if="!isMobile || isSettingsListView" class="settings-sidebar">
        <div class="settings-sidebar__top">
          <div class="settings-sidebar__header">
            <div class="settings-sidebar__title">{{ $t('settings.settings') }}</div>
            <div class="settings-sidebar__actions">
              <q-btn
                flat
                dense
                round
                icon="refresh"
                :aria-label="$t('settings.forceRefresh')"
                class="settings-sidebar__action"
                data-testid="settings-force-refresh-button"
                :loading="appUpdateStore.isForceRefreshing"
                @click="openForceRefreshDialog"
              >
                <q-badge
                  v-if="appUpdateStore.hasUpdateAvailable"
                  rounded
                  color="primary"
                  class="settings-sidebar__action-badge"
                  label="1"
                />
                <AppTooltip>{{ $t('settings.forceRefresh') }}</AppTooltip>
              </q-btn>
            </div>
          </div>

          <ReconnectHealingBanner />
          <StartupHistoryBanner />
        </div>

        <q-list class="settings-menu">
          <q-item
            v-for="item in settingsItems"
            :key="item.key"
            clickable
            class="settings-menu__item"
            :data-testid="`settings-${item.key}-item`"
            :class="{ 'settings-menu__item--danger': item.action === 'logout' }"
            :active="item.routeName ? activeSettingKey === item.key : false"
            active-class="settings-menu__item--active"
            @click="handleSettingsItemClick(item)"
          >
            <q-item-section avatar>
              <q-icon :name="item.icon" />
            </q-item-section>

            <q-item-section>
              <q-item-label>{{ $t(item.labelKey) }}</q-item-label>
            </q-item-section>
          </q-item>
        </q-list>
        <AppNavRail
          v-if="!isMobile"
          class="settings-sidebar__nav"
          active="settings"
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

      <section v-if="!isMobile || !isSettingsListView" class="settings-content-panel">
        <router-view />
      </section>
    </div>

    <AppDialog
      v-model="isLogoutDialogOpen"
      :title="$t('settings.logOut')"
      :subtitle="$t('settings.logout.confirmation')"
      :persistent="isLoggingOut"
      :show-close="!isLoggingOut"
      max-width="460px"
    >
      <div class="settings-logout-dialog__body">
        {{ $t('settings.logout.redirectNotice') }}
      </div>

      <template #actions>
        <q-btn
          flat
          no-caps
          :label="$t('common.cancel')"
          :disable="isLoggingOut"
          @click="isLogoutDialogOpen = false"
        />
        <q-btn
          unelevated
          no-caps
          color="negative"
          :label="$t('settings.logOut')"
          data-testid="settings-logout-confirm"
          :loading="isLoggingOut"
          @click="handleConfirmLogout"
        />
      </template>
    </AppDialog>

    <AppDialog
      v-model="isForceRefreshDialogOpen"
      :title="$t('settings.forceRefresh')"
      :subtitle="$t('settings.forceRefresh.newVersionNotice')"
      :persistent="appUpdateStore.isForceRefreshing"
      :show-close="!appUpdateStore.isForceRefreshing"
      max-width="460px"
    >
      <div class="settings-force-refresh-dialog__body">
        {{ $t('settings.forceRefreshOnlyStart') }}
      </div>

      <template #actions>
        <q-btn
          flat
          no-caps
          :label="$t('common.cancel')"
          :disable="appUpdateStore.isForceRefreshing"
          @click="isForceRefreshDialogOpen = false"
        />
        <q-btn
          unelevated
          no-caps
          color="primary"
          :label="$t('settings.forceRefresh')"
          data-testid="settings-force-refresh-confirm"
          :loading="appUpdateStore.isForceRefreshing"
          @click="handleConfirmForceRefresh"
        />
      </template>
    </AppDialog>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useQuasar } from 'quasar';
import { useRoute, useRouter } from 'vue-router';
import AppDialog from 'src/components/AppDialog.vue';
import AppNavRail from 'src/components/AppNavRail.vue';
import AppTooltip from 'src/components/AppTooltip.vue';
import ReconnectHealingBanner from 'src/components/ReconnectHealingBanner.vue';
import StartupHistoryBanner from 'src/components/StartupHistoryBanner.vue';
import { useSectionShell } from 'src/composables/useSectionShell';
import { disableAndroidRelayNotifications } from 'src/services/androidRelayNotificationService';
import { useAppUpdateStore } from 'src/stores/appUpdateStore';
import { useNostrStore } from 'src/stores/nostrStore';
import { schedulePendingLogoutCleanup } from 'src/utils/logoutCleanup';
import { reportUiError } from 'src/utils/uiErrorHandler';
import { t } from 'src/i18n';

const $q = useQuasar();
const route = useRoute();
const router = useRouter();
const appUpdateStore = useAppUpdateStore();
const nostrStore = useNostrStore();

const {
  isMobile,
  shellRef,
  shellStyle,
  sidebarWidth,
  minSidebarWidth,
  maxSidebarWidth,
  startSidebarResize,
  handleSidebarResizeKeydown,
  buildPageStyle: settingsPageStyleFn,
  handleRailSelect
} = useSectionShell({
  activeSection: 'settings',
  errorContext: 'Failed to navigate from settings rail'
});
const isSettingsListView = computed(() => route.name === 'settings');
const isLogoutDialogOpen = ref(false);
const isLoggingOut = ref(false);
const isForceRefreshDialogOpen = ref(false);

type SettingsRouteName =
  | 'settings-profile'
  | 'settings-theme'
  | 'settings-relays'
  | 'settings-language'
  | 'settings-notifications'
  | 'settings-media-data-storage'
  | 'settings-developer';

interface SettingsItem {
  key: string;
  labelKey: string;
  icon: string;
  routeName?: SettingsRouteName;
  action?: 'logout';
}

const settingsItems: SettingsItem[] = [
  { key: 'profile', labelKey: 'profile.profile', icon: 'face', routeName: 'settings-profile' },
  { key: 'relays', labelKey: 'relays.title', icon: 'satellite_alt', routeName: 'settings-relays' },
  {
    key: 'notifications',
    labelKey: 'notifications.notifications',
    icon: 'notifications',
    routeName: 'settings-notifications'
  },
  {
    key: 'media-data-storage',
    labelKey: 'mediaDataStorage.title',
    icon: 'storage',
    routeName: 'settings-media-data-storage'
  },
  { key: 'theme', labelKey: 'settings.appearance', icon: 'wallpaper', routeName: 'settings-theme' },
  { key: 'language', labelKey: 'settings.language.titlePlural', icon: 'language', routeName: 'settings-language' },
  {
    key: 'developer',
    labelKey: 'developer.developer',
    icon: 'terminal',
    routeName: 'settings-developer'
  },
  { key: 'logout', labelKey: 'settings.logOut', icon: 'logout', action: 'logout' }
];

const activeSettingKey = computed(() => {
  const match = settingsItems.find((item) => item.routeName === route.name);
  return match?.key ?? null;
});

watch(
  [isMobile, () => route.name],
  ([mobile, routeName]) => {
    if (!mobile && routeName === 'settings') {
      void router.replace({ name: 'settings-profile' });
    }
  },
  { immediate: true }
);

onMounted(() => {
  void appUpdateStore.checkForUpdate({ force: true });
});

function goToSetting(routeName: SettingsRouteName): void {
  try {
    void router.push({ name: routeName });
  } catch (error) {
    reportUiError('Failed to open settings section', error);
  }
}

function handleSettingsItemClick(item: SettingsItem): void {
  if (item.action === 'logout') {
    isLogoutDialogOpen.value = true;
    return;
  }

  if (item.routeName) {
    goToSetting(item.routeName);
  }
}

function openForceRefreshDialog(): void {
  isForceRefreshDialogOpen.value = true;
}

async function handleConfirmForceRefresh(): Promise<void> {
  const result = await appUpdateStore.forceRefresh();
  if (result.ok === true) {
    return;
  }

  if (result.reason === 'server-unreachable') {
    $q.notify({
      type: 'negative',
      message: t('settings.serverReachableForceRefresh'),
      position: 'top'
    });
    return;
  }

  if (result.reason === 'browser-unsupported') {
    $q.notify({
      type: 'negative',
      message: t('settings.forceRefreshSupportedBrowser'),
      position: 'top'
    });
  }
}

async function handleConfirmLogout(): Promise<void> {
  if (isLoggingOut.value) {
    return;
  }

  isLoggingOut.value = true;

  try {
    await disableAndroidRelayNotifications().catch((error) => {
      console.warn('Failed to stop Android relay notifications during logout.', error);
    });
    await nostrStore.logout();
    await router.replace({ name: 'auth' });
    schedulePendingLogoutCleanup();
    window.location.reload();
  } catch (error) {
    isLoggingOut.value = false;
    reportUiError('Failed to log out', error, t('errors.failedLogOut'));
  }
}
</script>

<style scoped>
.settings-page {
  height: calc(100vh - env(safe-area-inset-top));
  padding: 0;
  overflow: hidden;
  width: 100%;
  max-width: 100%;
  background: var(--nc-app-background);
}

.settings-shell {
  display: grid;
  grid-template-columns: var(--desktop-sidebar-width, 360px) 0px minmax(0, 1fr);
  gap: 0;
  height: 100%;
  min-height: 0;
  width: 100%;
  max-width: 100%;
  background: var(--nc-panel-thread-bg);
}

.settings-shell--mobile {
  grid-template-columns: 1fr;
}

.settings-sidebar,
.settings-content-panel {
  overflow: hidden;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}

.settings-sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--nc-panel-sidebar-bg);
  border-right: 0;
}

.settings-sidebar__top {
  position: relative;
  padding: 12px;
  border-bottom: 1px solid var(--nc-border);
  background: var(--nc-panel-header-bg);
}

.settings-sidebar__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.settings-sidebar__title {
  font-size: 20px;
  font-weight: 600;
  line-height: 1.2;
}

.settings-sidebar__actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.settings-sidebar__action {
  position: relative;
}

.settings-sidebar__action-badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  z-index: 1;
}

.settings-menu {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.settings-menu__item {
  border-radius: 0;
  min-height: 56px;
  margin-bottom: 0;
  border: 0;
  border-bottom: 1px solid var(--nc-border);
  transition:
    background-color 0.2s ease,
    border-color 0.2s ease;
}

.settings-menu__item:hover {
  transform: none;
  background: var(--nc-hover);
}

.settings-menu__item--active {
  background: var(--nc-active);
  color: var(--nc-active-text);
}

.settings-menu__item--danger {
  margin-top: 0;
  color: #f39aa0;
}

.settings-menu__item--danger:hover {
  background: rgba(239, 107, 115, 0.12);
}

.settings-logout-dialog__body {
  font-size: 14px;
  line-height: 1.5;
  color: color-mix(in srgb, currentColor 78%, #64748b 22%);
}

.settings-force-refresh-dialog__body {
  font-size: 14px;
  line-height: 1.5;
  color: color-mix(in srgb, currentColor 78%, #64748b 22%);
}

.settings-content-panel {
  background: transparent;
  min-height: 0;
}

body.body--dark .settings-menu__item--danger {
  color: #f7a7ad;
}

.settings-sidebar__nav {
  border-top: 1px solid var(--nc-border);
}

@media (--nc-mobile-viewport) {
  .settings-sidebar,
  .settings-content-panel {
    border-right: 0;
  }
}
</style>
