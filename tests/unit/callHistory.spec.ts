import {
  type CallHistory,
  callHistoryFromTags,
  callHistoryTag,
  callHistoryText,
  readCallHistory,
} from '#src/utils/callHistory.ts';
import { describe, expect, it } from 'vitest';

const history: CallHistory = {
  id: '12345678-1234-1234-1234-123456789012',
  mode: 'audio',
  reason: 'hangup',
  duration: 65,
  connected: true,
};
describe('private call history extension', () => {
  it('round trips inside rumor tags with a readable plain-text fallback', () => {
    expect(callHistoryFromTags([['p', 'a'.repeat(64)], callHistoryTag(history)])).toEqual(history);
    expect(callHistoryText(history)).toBe('Audio call · 1:05');
    expect(callHistoryText({ ...history, connected: false, duration: 0, reason: 'timeout' })).toBe(
      'Audio call · No answer'
    );
  });
  it('rejects malformed, ambiguous and unsupported tags', () => {
    const tag = callHistoryTag(history);
    expect(callHistoryFromTags([tag, tag])).toBeNull();
    expect(callHistoryFromTags([['anagram-call', '2', ...tag.slice(2)]])).toBeNull();
    for (const change of [
      { id: 'javascript:alert(1)' },
      { mode: 'screen' },
      { reason: 'other' },
      { duration: -1 },
      { duration: Infinity },
      { duration: 604801 },
      { duration: 1.5 },
      { connected: false },
    ]) {
      expect(readCallHistory({ ...history, ...change })).toBeNull();
    }
    expect(callHistoryFromTags([['anagram-call']])).toBeNull();
  });
});
