import type { MessageRelayStatus } from '#src/types/chat.ts';

export type RelayCommand = 'EVENT' | 'REQ' | 'COUNT';
type RelayTrafficLane = RelayCommand | 'CONNECT';
export type RelayFailureKind = 'rate-limited' | 'auth' | 'terminal' | 'transient';

/** Shared by wire handling, query recovery and the persisted outbox. */
export function relayFailureKind(reason: unknown): RelayFailureKind {
  const text = (reason instanceof Error ? reason.message : String(reason ?? ''))
    .trim()
    .replace(/^error:\s*/i, '');
  if (/^rate-limited:|^banned:.*rate[ -]?limit/i.test(text)) return 'rate-limited';
  if (/^auth-required:/i.test(text)) return 'auth';
  if (/^(blocked|restricted|invalid|unsupported|pow|duplicate|banned|relay-rejected):/i.test(text))
    return 'terminal';
  return 'transient';
}

const DEFAULT_RATE_LIMIT_MS = 60_000;
const BAN_RETRY_MS = 5 * 60_000;

export function relayStatusRetryAt(
  status: Pick<MessageRelayStatus, 'retry_after' | 'detail' | 'updated_at'>,
): number {
  const explicit = Date.parse(status.retry_after ?? '');
  if (Number.isFinite(explicit)) return explicit;
  // Older persisted statuses have no structured retry deadline.
  if (relayFailureKind(status.detail) !== 'rate-limited') return 0;
  const updated = Date.parse(status.updated_at);
  return Number.isFinite(updated) ? updated + BAN_RETRY_MS : 0;
}

/** One instance per relay, shared by the account and its epoch clients.
 * Reconnects retain it; existing query/outbox owners decide what is still wanted. */
export class RelayTrafficPolicy {
  private connectionQueue: Promise<unknown> = Promise.resolve();
  private nextConnectionAt = 0;
  private banned = false;

  // Serialize handshakes and spread group startup. Callers recheck their session
  // and the existing connection backoff immediately before opening a socket.
  connect<T>(attempt: () => Promise<T>, validate: () => void): Promise<T> {
    const pending = this.connectionQueue.then(async () => {
      validate();
      const wait = Math.max(0, this.nextConnectionAt - Date.now());
      if (wait) await new Promise<void>((resolve) => setTimeout(resolve, wait));
      validate();
      const blocked = this.connectionBlockReason();
      if (blocked) throw new Error(blocked);
      this.nextConnectionAt = Date.now() + 250;
      return attempt();
    });
    this.connectionQueue = pending.catch(() => {});
    return pending;
  }

  ban(): void {
    this.banned = true;
  }

  connectionBlockReason(): string | undefined {
    if (this.banned) return 'banned: Relay refused further connections.';
    // A relay-wide pause (NOTICE or rate-limit ban) must also prevent opening
    // another socket to that relay. Command-specific pauses remain independent.
    const pause = Math.max(
      this.delay('CONNECT'),
      Math.min(this.delay('EVENT'), this.delay('REQ'), this.delay('COUNT')),
    );
    return pause > 0 ? 'rate-limited: Relay requested a pause before reconnecting.' : undefined;
  }

  private lanes = new Map<
    RelayTrafficLane,
    { until: number; interval: number; next: number; failures: number }
  >();

  retryAt(command: RelayTrafficLane): number {
    return this.lanes.get(command)?.until ?? 0;
  }

  delay(command: RelayTrafficLane): number {
    return Math.max(0, this.retryAt(command) - Date.now());
  }

  rateLimited(command: RelayTrafficLane, reason: string, hint?: unknown): void {
    const previous = this.lanes.get(command);
    if (previous && Date.now() > previous.until + BAN_RETRY_MS) previous.failures = 0;
    const parsed =
      typeof hint === 'number' || (typeof hint === 'string' && /^\d+$/.test(hint))
        ? Number(hint)
        : NaN;
    const failures = Math.min(5, (previous?.failures ?? 0) + 1);
    const fallback = /^(?:error:\s*)?banned:/i.test(reason.trim())
      ? BAN_RETRY_MS
      : DEFAULT_RATE_LIMIT_MS;
    const delay =
      Number.isSafeInteger(parsed) && parsed > 0 && parsed < 8.64e15 - Date.now()
        ? parsed
        : Math.min(15 * 60_000, fallback * 2 ** (failures - 1));
    this.lanes.set(command, {
      until: Math.max(previous?.until ?? 0, Date.now() + delay),
      // Spread the recovery burst, even when the transport is replaced.
      interval: Math.min(1000, 250 * failures),
      next: previous?.next ?? 0,
      failures,
    });
  }

  spacingDelay(command: RelayCommand): number {
    const lane = this.lanes.get(command);
    if (lane && Date.now() > lane.until + BAN_RETRY_MS) {
      this.lanes.delete(command);
      return 0;
    }
    return Math.max(0, (lane?.next ?? 0) - Date.now());
  }

  sent(command: RelayCommand): void {
    const lane = this.lanes.get(command);
    if (lane) lane.next = Date.now() + lane.interval;
  }

  blockReason(command: RelayCommand): string | undefined {
    if (this.banned) return 'banned: Relay refused further requests.';
    const delay = this.delay(command);
    return delay > 0
      ? `rate-limited: Relay requested a pause; retry in ${Math.ceil(delay / 1000)}s.`
      : undefined;
  }
}
