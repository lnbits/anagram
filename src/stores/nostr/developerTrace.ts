import { developerTraceDataService } from 'src/services/developerTraceDataService';
import { hasStorage } from 'src/stores/nostr/shared';
import type { DeveloperTraceEntry, DeveloperTraceLevel } from 'src/stores/nostr/types';
import type { Ref } from 'vue';

interface DeveloperTraceRuntimeState {
  developerTraceCounter: number;
}

interface DeveloperTraceRuntimeDeps {
  developerDiagnosticsEnabled: Ref<boolean>;
  developerDiagnosticsVersion: Ref<number>;
  developerTraceState: DeveloperTraceRuntimeState;
  developerTraceVersion: Ref<number>;
  developerDiagnosticsStorageKey: string;
  getLoggedInPublicKeyHex: () => string | null;
}

export function readDeveloperDiagnosticsEnabledFromStorage(
  developerDiagnosticsStorageKey: string
): boolean {
  if (!hasStorage()) {
    return true;
  }

  return window.localStorage.getItem(developerDiagnosticsStorageKey) !== '0';
}

export function createDeveloperTraceRuntime({
  developerDiagnosticsEnabled,
  developerDiagnosticsVersion,
  getLoggedInPublicKeyHex,
  developerTraceState,
  developerTraceVersion,
  developerDiagnosticsStorageKey,
}: DeveloperTraceRuntimeDeps) {
  const pendingEntries = new Map<string, DeveloperTraceEntry>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingOwner: string | null = null;
  let persistence = Promise.resolve();
  let generation = 0;

  function flushTraceBatch(): Promise<void> {
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    if (pendingOwner !== getLoggedInPublicKeyHex()) pendingEntries.clear();
    const entries = [...pendingEntries.values()];
    pendingEntries.clear();
    if (!entries.length) return persistence;
    const currentGeneration = generation;
    persistence = persistence
      .then(async () => {
        if (currentGeneration !== generation) return;
        await developerTraceDataService.appendEntries(entries);
        if (currentGeneration === generation) bumpDeveloperTraceVersion();
      })
      .catch((error) => console.error('Failed to persist developer trace batch.', error));
    return persistence;
  }

  function readDeveloperDiagnosticsEnabled(): boolean {
    return readDeveloperDiagnosticsEnabledFromStorage(developerDiagnosticsStorageKey);
  }

  function bumpDeveloperDiagnosticsVersion(): void {
    developerDiagnosticsVersion.value += 1;
  }

  function bumpDeveloperTraceVersion(): void {
    developerTraceVersion.value += 1;
  }

  function toOptionalIsoTimestampFromUnix(value: number | null | undefined): string | null {
    if (!Number.isInteger(value) || Number(value) <= 0) {
      return null;
    }

    return new Date(Number(value) * 1000).toISOString();
  }

  function serializeDeveloperTraceValue(value: unknown, depth = 0): unknown {
    if (depth > 4) {
      return '[max-depth]';
    }

    if (
      value === null ||
      value === undefined ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value ?? null;
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack ?? null,
      };
    }

    if (Array.isArray(value)) {
      return value.slice(0, 30).map((entry) => serializeDeveloperTraceValue(entry, depth + 1));
    }

    if (typeof value === 'object') {
      const result: Record<string, unknown> = {};

      for (const [key, entryValue] of Object.entries(value as Record<string, unknown>).slice(
        0,
        50
      )) {
        result[key] = serializeDeveloperTraceValue(entryValue, depth + 1);
      }

      return result;
    }

    return String(value);
  }

  function normalizeDeveloperTraceDetails(
    details: Record<string, unknown>
  ): Record<string, unknown> {
    const normalized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(details)) {
      normalized[key] = serializeDeveloperTraceValue(value);
    }

    return normalized;
  }

  function shouldEchoDeveloperTraceToConsole(scope: string, phase: string): boolean {
    if (scope.startsWith('subscription:')) {
      return (
        phase === 'start' ||
        phase === 'req' ||
        phase === 'backfill-window-subscribe' ||
        phase === 'epoch-history-subscribe'
      );
    }

    return (
      scope === 'inbound' &&
      (phase === 'epoch-ticket-received' ||
        phase === 'group-message-received' ||
        phase === 'private-message-received')
    );
  }

  function buildConsoleTracePrefixArgs(
    scope: string,
    phase: string,
    details: Record<string, unknown>
  ): unknown[] {
    if (scope !== 'subscription:private-messages' || phase !== 'req') {
      return [];
    }

    const prefixArgs: unknown[] = [];
    const relayUrls = Array.isArray(details.relayUrls)
      ? details.relayUrls.filter(
          (relayUrl): relayUrl is string =>
            typeof relayUrl === 'string' && relayUrl.trim().length > 0
        )
      : [];
    if (relayUrls.length > 0) {
      prefixArgs.push(`relays=${relayUrls.join(', ')}`);
    }

    if (Array.isArray(details.reqStatement)) {
      prefixArgs.push(`reqStatement=${JSON.stringify(details.reqStatement)}`);
    }

    return prefixArgs;
  }

  function echoDeveloperTraceToConsole(
    level: DeveloperTraceLevel,
    scope: string,
    phase: string,
    details: Record<string, unknown>
  ): void {
    const label = `[${scope}] ${phase}`;
    const prefixArgs = buildConsoleTracePrefixArgs(scope, phase, details);
    if (level === 'error') {
      console.error(label, ...prefixArgs, details);
      return;
    }

    if (level === 'warn') {
      console.warn(label, ...prefixArgs, details);
      return;
    }

    console.info(label, ...prefixArgs, details);
  }

  function logDeveloperTrace(
    level: DeveloperTraceLevel,
    scope: string,
    phase: string,
    details: Record<string, unknown> = {}
  ): void {
    const normalizedDetails = normalizeDeveloperTraceDetails(details);
    if (shouldEchoDeveloperTraceToConsole(scope, phase)) {
      echoDeveloperTraceToConsole(level, scope, phase, normalizedDetails);
    }

    if (!developerDiagnosticsEnabled.value || !getLoggedInPublicKeyHex()) {
      return;
    }

    const owner = getLoggedInPublicKeyHex();
    if (owner !== pendingOwner) {
      pendingEntries.clear();
      pendingOwner = owner;
    }
    // Relay errors may carry changing connection counters and stack frames. Group
    // by the actionable error and relay, preserving the first context and totals.
    const error = normalizedDetails.error;
    const errorMessage =
      error && typeof error === 'object' && 'message' in error ? error.message : error;
    const key = JSON.stringify([
      level,
      scope,
      phase,
      scope === 'relay' || scope === 'relay-connect'
        ? [
            normalizedDetails.url ?? normalizedDetails.relayUrl,
            errorMessage,
            normalizedDetails.reason,
          ]
        : normalizedDetails,
    ]);
    const existing = pendingEntries.get(key);
    if (existing) {
      existing.details.repeatCount = Number(existing.details.repeatCount ?? 1) + 1;
      existing.details.lastSeenAt = new Date().toISOString();
    } else {
      developerTraceState.developerTraceCounter += 1;
      pendingEntries.set(key, {
        id: `${Date.now()}-${developerTraceState.developerTraceCounter}`,
        timestamp: new Date().toISOString(),
        level,
        scope,
        phase,
        details: { ...normalizedDetails, repeatCount: 1 },
      });
    }
    if (pendingEntries.size >= 256) void flushTraceBatch();
    else if (flushTimer === null)
      flushTimer = setTimeout(() => {
        void flushTraceBatch();
      }, 250);
  }

  async function listDeveloperTraceEntries(): Promise<DeveloperTraceEntry[]> {
    await flushTraceBatch();
    return developerTraceDataService.listEntries();
  }

  async function clearDeveloperTraceEntries(): Promise<void> {
    generation += 1;
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    pendingEntries.clear();
    pendingOwner = null;
    await persistence;
    await developerTraceDataService.clearEntries();
    bumpDeveloperTraceVersion();
  }

  function setDeveloperDiagnosticsEnabled(enabled: boolean): void {
    developerDiagnosticsEnabled.value = enabled;

    if (hasStorage()) {
      window.localStorage.setItem(developerDiagnosticsStorageKey, enabled ? '1' : '0');
    }

    if (!enabled) {
      void clearDeveloperTraceEntries().catch((error) => {
        console.error('Failed to clear developer trace entries.', error);
      });
    }

    developerDiagnosticsVersion.value += 1;
  }

  return {
    bumpDeveloperDiagnosticsVersion,
    bumpDeveloperTraceVersion,
    clearDeveloperTraceEntries,
    buildConsoleTracePrefixArgs,
    echoDeveloperTraceToConsole,
    listDeveloperTraceEntries,
    logDeveloperTrace,
    normalizeDeveloperTraceDetails,
    readDeveloperDiagnosticsEnabled,
    serializeDeveloperTraceValue,
    setDeveloperDiagnosticsEnabled,
    shouldEchoDeveloperTraceToConsole,
    toOptionalIsoTimestampFromUnix,
  };
}
