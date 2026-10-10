import NostrClient, {
  type NostrRelay,
  type NostrRelayConnectionStats,
  NostrRelayStatus,
  normalizeRelayUrl,
} from '#src/lib/nostr/client.ts';
import type { DeveloperRelaySnapshot, DeveloperTraceLevel } from '#src/stores/nostr/types.ts';

interface DeveloperRelayRuntimeDeps {
  logDeveloperTrace: (
    level: DeveloperTraceLevel,
    scope: string,
    phase: string,
    details: Record<string, unknown>
  ) => void;
  ndk: NostrClient;
}

export function createDeveloperRelayRuntime({ logDeveloperTrace, ndk }: DeveloperRelayRuntimeDeps) {
  function getRelayStatusName(status: number): string {
    return NostrRelayStatus[status] ?? 'UNKNOWN';
  }

  function buildRelayConnectionStatsSnapshot(
    stats: NostrRelayConnectionStats | undefined
  ): Pick<
    DeveloperRelaySnapshot,
    | 'attempts'
    | 'success'
    | 'connectedAt'
    | 'nextReconnectAt'
    | 'validationRatio'
    | 'lastDurationMs'
  > {
    if (!stats) {
      return {
        attempts: null,
        success: null,
        connectedAt: null,
        nextReconnectAt: null,
        validationRatio: null,
        lastDurationMs: null,
      };
    }

    return {
      attempts: stats.attempts,
      success: stats.success,
      connectedAt: stats.connectedAt ?? null,
      nextReconnectAt: stats.nextReconnectAt ?? null,
      validationRatio: stats.validationRatio ?? null,
      lastDurationMs:
        stats.durations.length > 0 ? stats.durations[stats.durations.length - 1] : null,
    };
  }

  function buildRelaySnapshot(relay: NostrRelay | null | undefined): DeveloperRelaySnapshot {
    if (!relay) {
      return {
        present: false,
        url: null,
        connected: false,
        status: null,
        statusName: null,
        attempts: null,
        success: null,
        connectedAt: null,
        nextReconnectAt: null,
        validationRatio: null,
        lastDurationMs: null,
      };
    }

    return {
      present: true,
      url: relay.url,
      connected: relay.connected,
      status: relay.status,
      statusName: getRelayStatusName(relay.status),
      ...buildRelayConnectionStatsSnapshot(relay.connectionStats),
    };
  }

  function getRelaySnapshots(relayUrls: string[]): DeveloperRelaySnapshot[] {
    return relayUrls.map((relayUrl) => {
      const normalizedRelayUrl = normalizeRelayUrl(relayUrl);
      return buildRelaySnapshot(ndk.pool.getRelay(normalizedRelayUrl, false));
    });
  }

  function logRelayLifecycle(eventName: string, relay: NostrRelay): void {
    logDeveloperTrace('info', 'relay', eventName, {
      ...buildRelaySnapshot(relay),
      pool: ndk.pool.stats(),
    });
  }

  function logMessageRelayDiagnostics(
    phase: string,
    details: Record<string, unknown>,
    level: DeveloperTraceLevel = 'info'
  ): void {
    logDeveloperTrace(level, 'message-relays', phase, details);
  }

  return {
    buildRelaySnapshot,
    getRelaySnapshots,
    logMessageRelayDiagnostics,
    logRelayLifecycle,
  };
}
