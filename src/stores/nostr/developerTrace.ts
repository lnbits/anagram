import { diagnosticText } from '#src/utils/diagnosticExport.ts';
import { developerTraceDataService } from '#src/services/developerTraceDataService.ts';
import { hasStorage } from '#src/stores/nostr/shared.ts';
import type { DeveloperTraceEntry, DeveloperTraceLevel } from '#src/stores/nostr/types.ts';
import type { Ref } from '#src/lib/state/reactivity.ts';

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
  developerDiagnosticsStorageKey: string,
): boolean {
  if (!hasStorage()) {
    return false;
  }

  return window.localStorage.getItem(developerDiagnosticsStorageKey) === '1';
}

export function createDeveloperTraceRuntime({
  developerDiagnosticsEnabled,
  developerDiagnosticsVersion,
  getLoggedInPublicKeyHex,
  developerTraceState,
  developerTraceVersion,
  developerDiagnosticsStorageKey,
}: DeveloperTraceRuntimeDeps) {
  // Diagnostics are lossy under overload; they must never queue behind history forever.
  let pendingWrites = 0;
  let droppedEntries = 0;
  let consoleWindowAt = 0;
  let consoleCount = 0;
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
    if (depth > 5) return '[max-depth]';
    // Public IDs and private hex keys cannot be distinguished here: redact both.
    if (typeof value === 'string') return diagnosticText(value);
    if (value instanceof SyntaxError)
      return { name: 'SyntaxError', message: '[redacted-parser-error]' };
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error)
      return {
        name: diagnosticText(value.name),
        message: serializeDeveloperTraceValue(value.message, depth + 1),
      };
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[redacted-bytes]';
    if (Array.isArray(value))
      return value.slice(0, 30).map((entry) => serializeDeveloperTraceValue(entry, depth + 1));
    if (typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, 50)
          .map(([key, entry]) => [
            diagnosticText(key),
            /private|secret|nsec|password|token|credential|payload|content|tags|signer|seed|messageText|lastMessage/i.test(
              key,
            )
              ? '[redacted]'
              : serializeDeveloperTraceValue(entry, depth + 1),
          ]),
      );
    return '[unsupported]';
  }

  function normalizeDeveloperTraceDetails(
    details: Record<string, unknown>,
  ): Record<string, unknown> {
    return serializeDeveloperTraceValue(details) as Record<string, unknown>;
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
    details: Record<string, unknown>,
  ): unknown[] {
    if (scope !== 'subscription:private-messages' || phase !== 'req') {
      return [];
    }

    const prefixArgs: unknown[] = [];
    const relayUrls = Array.isArray(details.relayUrls)
      ? details.relayUrls.filter(
          (relayUrl): relayUrl is string =>
            typeof relayUrl === 'string' && relayUrl.trim().length > 0,
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
    details: Record<string, unknown>,
  ): void {
    const now = Date.now();
    if (now - consoleWindowAt >= 10000) {
      consoleWindowAt = now;
      consoleCount = 0;
    }
    if (consoleCount++ >= 20) return;
    const label = `[${diagnosticText(scope)}] ${diagnosticText(phase)}`;
    const prefixArgs = buildConsoleTracePrefixArgs(scope, phase, details);
    const snapshot = `${label} ${prefixArgs.join(' ')} ${JSON.stringify(details)}`;
    if (level === 'error') {
      console.error(snapshot);
      return;
    }

    if (level === 'warn') {
      console.warn(snapshot);
      return;
    }

    console.info(snapshot);
  }

  function logDeveloperTrace(
    level: DeveloperTraceLevel,
    scope: string,
    phase: string,
    details: Record<string, unknown> = {},
  ): void {
    if (!developerDiagnosticsEnabled.value || !getLoggedInPublicKeyHex()) return;
    if (pendingWrites >= 200) {
      droppedEntries++;
      return;
    }
    const normalizedDetails = normalizeDeveloperTraceDetails(details);
    if (droppedEntries) {
      normalizedDetails.droppedTraceEntries = droppedEntries;
      droppedEntries = 0;
    }
    if (shouldEchoDeveloperTraceToConsole(scope, phase)) {
      echoDeveloperTraceToConsole(level, scope, phase, normalizedDetails);
    }

    if (!developerDiagnosticsEnabled.value || !getLoggedInPublicKeyHex()) {
      return;
    }

    developerTraceState.developerTraceCounter += 1;
    const entry: DeveloperTraceEntry = {
      id: `${Date.now()}-${developerTraceState.developerTraceCounter}`,
      timestamp: new Date().toISOString(),
      level,
      scope: diagnosticText(scope),
      phase: diagnosticText(phase),
      details: normalizedDetails,
    };

    pendingWrites++;
    void developerTraceDataService
      .appendEntry(entry)
      .then(() => {
        bumpDeveloperTraceVersion();
      })
      .catch(() => {
        console.error('Failed to persist developer trace entry.');
      })
      .finally(() => {
        pendingWrites--;
      });
  }

  async function listDeveloperTraceEntries(): Promise<DeveloperTraceEntry[]> {
    return (await developerTraceDataService.listEntries()).map((entry) => ({
      ...entry,
      details: normalizeDeveloperTraceDetails(entry.details),
    }));
  }

  async function clearDeveloperTraceEntries(): Promise<void> {
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
