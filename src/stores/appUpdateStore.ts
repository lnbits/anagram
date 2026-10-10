import { defineStore } from '#src/lib/state/store.ts';
import {
  type AppBuildInfo,
  CURRENT_APP_BUILD_INFO,
  canReachAppServer,
  canRegisterAppShellServiceWorker,
  clearAppShellCaches,
  type ForceRefreshResult,
  fetchServerBuildInfo,
  hasDifferentBundle,
  isAppShellRuntimeEnabled,
  registerAppShellServiceWorker,
  unregisterAppShellServiceWorkers,
} from '#src/services/appShellService.ts';
import { computed, ref } from '#src/lib/state/reactivity.ts';

const UPDATE_CHECK_THROTTLE_MS = 30_000;

export const useAppUpdateStore = defineStore('appUpdateStore', () => {
  const currentBuildInfo = ref<AppBuildInfo>(CURRENT_APP_BUILD_INFO);
  const serverBuildInfo = ref<AppBuildInfo | null>(null);
  const isCheckingForUpdate = ref(false);
  const isForceRefreshing = ref(false);
  const lastCheckedAt = ref<string | null>(null);
  const lastCheckFailed = ref(false);
  const runtimeStarted = ref(false);
  let lastCheckStartedAt = 0;

  const isAppShellEnabled = computed(() => isAppShellRuntimeEnabled());
  const canUseServiceWorker = computed(() => canRegisterAppShellServiceWorker());
  const hasUpdateAvailable = computed(() =>
    hasDifferentBundle(currentBuildInfo.value, serverBuildInfo.value)
  );

  async function startRuntime(): Promise<void> {
    if (runtimeStarted.value) {
      return;
    }

    runtimeStarted.value = true;
    document.addEventListener('visibilitychange', handleVisibilityChange);

    if (canUseServiceWorker.value) {
      await registerAppShellServiceWorker().catch((error) => {
        console.warn('Failed to register the app shell service worker.', error);
      });
    }

    await checkForUpdate({ force: true });
  }

  function stopRuntime(): void {
    if (!runtimeStarted.value) {
      return;
    }

    runtimeStarted.value = false;
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  }

  function handleVisibilityChange(): void {
    if (document.visibilityState !== 'visible') {
      return;
    }

    void checkForUpdate();
  }

  async function checkForUpdate(options: { force?: boolean } = {}): Promise<AppBuildInfo | null> {
    if (!isAppShellEnabled.value) {
      return null;
    }

    const now = Date.now();
    if (!options.force && now - lastCheckStartedAt < UPDATE_CHECK_THROTTLE_MS) {
      return serverBuildInfo.value;
    }

    lastCheckStartedAt = now;
    isCheckingForUpdate.value = true;

    try {
      const nextBuildInfo = await fetchServerBuildInfo();
      if (nextBuildInfo) {
        serverBuildInfo.value = nextBuildInfo;
      }
      lastCheckedAt.value = new Date().toISOString();
      lastCheckFailed.value = nextBuildInfo === null;
      return nextBuildInfo;
    } finally {
      isCheckingForUpdate.value = false;
    }
  }

  async function forceRefresh(): Promise<ForceRefreshResult> {
    if (isForceRefreshing.value) {
      return { ok: false, reason: 'refresh-in-progress' };
    }

    if (typeof window === 'undefined') {
      return { ok: false, reason: 'browser-unsupported' };
    }

    isForceRefreshing.value = true;

    try {
      const serverReachable = await canReachAppServer();
      if (!serverReachable) {
        return { ok: false, reason: 'server-unreachable' };
      }

      await unregisterAppShellServiceWorkers();
      await clearAppShellCaches();
      window.location.reload();
      return { ok: true };
    } finally {
      isForceRefreshing.value = false;
    }
  }

  return {
    currentBuildInfo,
    serverBuildInfo,
    isAppShellEnabled,
    canUseServiceWorker,
    isCheckingForUpdate,
    isForceRefreshing,
    lastCheckedAt,
    lastCheckFailed,
    hasUpdateAvailable,
    startRuntime,
    stopRuntime,
    checkForUpdate,
    forceRefresh,
  };
});
