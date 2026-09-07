import { inputSanitizerService } from 'src/services/inputSanitizerService';
import type { SubscribePrivateMessagesOptions } from 'src/stores/nostr/types';

interface SubscriptionRefreshRuntimeDeps {
  isStartupRestoring?: () => boolean;
  getPendingPrivateMessagesEpochSubscriptionRefreshOptions: () => SubscribePrivateMessagesOptions | null;
  getPrivateMessagesEpochSubscriptionRefreshQueue: () => Promise<void>;
  getPrivateMessagesEpochSubscriptionRefreshTimerId: () => ReturnType<
    typeof globalThis.setTimeout
  > | null;
  normalizeRelayStatusUrls: (relayUrls: string[]) => string[];
  normalizeThrottleMs: (value: number | undefined) => number;
  privateMessagesEpochSubscriptionRefreshDebounceMs: number;
  setPendingPrivateMessagesEpochSubscriptionRefreshOptions: (
    options: SubscribePrivateMessagesOptions | null
  ) => void;
  setPrivateMessagesEpochSubscriptionRefreshQueue: (queue: Promise<void>) => void;
  setPrivateMessagesEpochSubscriptionRefreshTimerId: (
    timerId: ReturnType<typeof globalThis.setTimeout> | null
  ) => void;
  subscribeContactProfileUpdates: (seedRelayUrls?: string[], force?: boolean) => Promise<void>;
  subscribeContactRelayListUpdates: (seedRelayUrls?: string[], force?: boolean) => Promise<void>;
  subscribeGroupMembershipRosterUpdates: (
    seedRelayUrls?: string[],
    force?: boolean
  ) => Promise<void>;
  subscribePrivateMessagesForLoggedInUser: (
    force?: boolean,
    options?: SubscribePrivateMessagesOptions
  ) => Promise<void>;
}

export function createSubscriptionRefreshRuntime({
  isStartupRestoring = () => false,
  getPendingPrivateMessagesEpochSubscriptionRefreshOptions,
  getPrivateMessagesEpochSubscriptionRefreshQueue,
  getPrivateMessagesEpochSubscriptionRefreshTimerId,
  normalizeRelayStatusUrls,
  normalizeThrottleMs,
  privateMessagesEpochSubscriptionRefreshDebounceMs,
  setPendingPrivateMessagesEpochSubscriptionRefreshOptions,
  setPrivateMessagesEpochSubscriptionRefreshQueue,
  setPrivateMessagesEpochSubscriptionRefreshTimerId,
  subscribeContactProfileUpdates,
  subscribeContactRelayListUpdates,
  subscribeGroupMembershipRosterUpdates,
  subscribePrivateMessagesForLoggedInUser,
}: SubscriptionRefreshRuntimeDeps) {
  function queueContactRelayListSubscriptionRefresh(
    seedRelayUrls: string[] = [],
    force = false
  ): void {
    void subscribeContactRelayListUpdates(seedRelayUrls, force).catch((error) => {
      console.warn('Failed to refresh contact relay list subscription', error);
    });
  }

  function queueContactProfileSubscriptionRefresh(
    seedRelayUrls: string[] = [],
    force = false
  ): void {
    void subscribeContactProfileUpdates(seedRelayUrls, force).catch((error) => {
      console.warn('Failed to refresh contact profile subscription', error);
    });
  }

  function queueGroupMembershipRosterSubscriptionRefresh(
    seedRelayUrls: string[] = [],
    force = false
  ): void {
    void subscribeGroupMembershipRosterUpdates(seedRelayUrls, force).catch((error) => {
      console.warn('Failed to refresh group roster subscription', error);
    });
  }

  function queuePrivateMessagesSubscriptionRefresh(
    force = false,
    options: SubscribePrivateMessagesOptions = {}
  ): void {
    void subscribePrivateMessagesForLoggedInUser(force, options).catch((error) => {
      console.warn('Failed to refresh private messages subscription', error);
    });
  }

  function mergeSubscribePrivateMessagesOptions(
    first: SubscribePrivateMessagesOptions,
    second: SubscribePrivateMessagesOptions
  ): SubscribePrivateMessagesOptions {
    const mergedSeedRelayUrls = normalizeRelayStatusUrls([
      ...inputSanitizerService.normalizeStringArray(first.seedRelayUrls ?? []),
      ...inputSanitizerService.normalizeStringArray(second.seedRelayUrls ?? []),
    ]);
    const firstSinceOverride =
      Number.isInteger(first.sinceOverride) && Number(first.sinceOverride) >= 0
        ? Math.floor(Number(first.sinceOverride))
        : null;
    const secondSinceOverride =
      Number.isInteger(second.sinceOverride) && Number(second.sinceOverride) >= 0
        ? Math.floor(Number(second.sinceOverride))
        : null;
    const mergedSinceOverride =
      firstSinceOverride === null
        ? secondSinceOverride
        : secondSinceOverride === null
          ? firstSinceOverride
          : Math.min(firstSinceOverride, secondSinceOverride);
    const mergedRestoreThrottleMs = Math.max(
      normalizeThrottleMs(first.restoreThrottleMs),
      normalizeThrottleMs(second.restoreThrottleMs)
    );

    return {
      ...(mergedRestoreThrottleMs > 0 ? { restoreThrottleMs: mergedRestoreThrottleMs } : {}),
      ...(mergedSeedRelayUrls.length > 0 ? { seedRelayUrls: mergedSeedRelayUrls } : {}),
      ...(mergedSinceOverride !== null ? { sinceOverride: mergedSinceOverride } : {}),
      ...(first.startupTrackStep === true || second.startupTrackStep === true
        ? { startupTrackStep: true }
        : {}),
    };
  }

  function queueEpochDrivenPrivateMessagesSubscriptionRefresh(
    options: SubscribePrivateMessagesOptions = {}
  ): void {
    if (isStartupRestoring()) return;
    const pendingOptions = getPendingPrivateMessagesEpochSubscriptionRefreshOptions();
    setPendingPrivateMessagesEpochSubscriptionRefreshOptions(
      pendingOptions === null
        ? mergeSubscribePrivateMessagesOptions({}, options)
        : mergeSubscribePrivateMessagesOptions(pendingOptions, options)
    );

    const activeTimerId = getPrivateMessagesEpochSubscriptionRefreshTimerId();
    if (activeTimerId !== null) {
      globalThis.clearTimeout(activeTimerId);
    }

    setPrivateMessagesEpochSubscriptionRefreshTimerId(
      globalThis.setTimeout(() => {
        setPrivateMessagesEpochSubscriptionRefreshTimerId(null);
        const refreshOptions = getPendingPrivateMessagesEpochSubscriptionRefreshOptions() ?? {};
        setPendingPrivateMessagesEpochSubscriptionRefreshOptions(null);
        setPrivateMessagesEpochSubscriptionRefreshQueue(
          getPrivateMessagesEpochSubscriptionRefreshQueue()
            .then(() => subscribePrivateMessagesForLoggedInUser(false, refreshOptions))
            .then(() =>
              subscribeGroupMembershipRosterUpdates(refreshOptions.seedRelayUrls ?? [], false)
            )
            .catch((error) => {
              console.warn('Failed to refresh subscriptions after epoch ticket update', error);
            })
        );
      }, privateMessagesEpochSubscriptionRefreshDebounceMs)
    );
  }

  function queueTrackedContactSubscriptionsRefresh(
    seedRelayUrls: string[] = [],
    force = false
  ): void {
    if (isStartupRestoring()) return;
    queueContactProfileSubscriptionRefresh(seedRelayUrls, force);
    queueGroupMembershipRosterSubscriptionRefresh(seedRelayUrls, force);
    queuePrivateMessagesSubscriptionRefresh(force, { seedRelayUrls });
  }

  return {
    mergeSubscribePrivateMessagesOptions,
    queueContactProfileSubscriptionRefresh,
    queueContactRelayListSubscriptionRefresh,
    queueEpochDrivenPrivateMessagesSubscriptionRefresh,
    queueGroupMembershipRosterSubscriptionRefresh,
    queuePrivateMessagesSubscriptionRefresh,
    queueTrackedContactSubscriptionsRefresh,
  };
}
