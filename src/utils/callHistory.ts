import type { CallEndReason, CallMode, CallSession } from 'src/types/call';

export interface CallHistory {
  id: string;
  mode: CallMode;
  reason: CallEndReason;
  duration: number;
  connected: boolean;
}
const reasons = ['hangup', 'declined', 'busy', 'timeout', 'failed', 'cancelled', 'unsupported'];
export function readCallHistory(value: unknown): CallHistory | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as CallHistory;
  if (
    typeof v.id !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(v.id) ||
    !['audio', 'video'].includes(v.mode) ||
    !reasons.includes(v.reason) ||
    !Number.isSafeInteger(v.duration) ||
    v.duration < 0 ||
    v.duration > 604800 ||
    typeof v.connected !== 'boolean' ||
    (!v.connected && v.duration !== 0)
  )
    return null;
  return { id: v.id, mode: v.mode, reason: v.reason, duration: v.duration, connected: v.connected };
}
export function callHistoryFromSession(session: CallSession): CallHistory {
  return {
    id: session.id,
    mode: session.mode,
    reason: session.endReason ?? 'failed',
    connected: session.startedAt !== null,
    duration: session.startedAt
      ? Math.min(
          604800,
          Math.max(0, Math.floor((Date.now() - Date.parse(session.startedAt)) / 1000))
        )
      : 0,
  };
}
export function callHistoryTag(history: CallHistory): string[] {
  return [
    'anagram-call',
    '1',
    history.id,
    history.mode,
    history.reason,
    String(history.duration),
    history.connected ? '1' : '0',
  ];
}
export function callHistoryFromTags(tags: string[][]): CallHistory | null {
  const matches = tags.filter((tag) => tag[0] === 'anagram-call');
  if (matches.length !== 1) return null;
  const tag = matches[0];
  if (
    !tag ||
    tag.length !== 7 ||
    tag[1] !== '1' ||
    !/^\d{1,6}$/.test(tag[5] ?? '') ||
    !['0', '1'].includes(tag[6] ?? '')
  )
    return null;
  return readCallHistory({
    id: tag[2],
    mode: tag[3],
    reason: tag[4],
    duration: Number(tag[5]),
    connected: tag[6] === '1',
  });
}
export function callHistoryDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
export function callHistoryText(history: CallHistory): string {
  const mode = history.mode === 'video' ? 'Video call' : 'Audio call';
  const outcome = history.connected
    ? callHistoryDuration(history.duration)
    : {
        hangup: 'Ended',
        declined: 'Declined',
        busy: 'Busy',
        timeout: 'No answer',
        failed: 'Failed',
        cancelled: 'Cancelled',
        unsupported: 'Calls unavailable',
      }[history.reason];
  return `${mode} · ${outcome}`;
}
