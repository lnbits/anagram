import {
  type LoadedMessageIdentity,
  type MessageWindowRow,
  resolveMessageWindowMerge,
} from '#src/utils/messageWindowRange.ts';
import { describe, expect, it } from 'vitest';

function buildRow(id: number): MessageWindowRow {
  return { id };
}

function buildLoadedMessage(id: string): LoadedMessageIdentity {
  return { id };
}

describe('messageWindowRange', () => {
  it('returns null when the target message does not exist in storage', () => {
    expect(
      resolveMessageWindowMerge([buildRow(2), buildRow(3)], [buildLoadedMessage('2')], 1)
    ).toBe(null);
  });

  it('returns the full older gap when the target is before the loaded window', () => {
    const result = resolveMessageWindowMerge(
      [buildRow(1), buildRow(2), buildRow(3), buildRow(4), buildRow(5)],
      [buildLoadedMessage('4'), buildLoadedMessage('5')],
      2
    );

    expect(result).toEqual({
      direction: 'older',
      targetIndex: 1,
      targetRow: buildRow(2),
      rowsToMerge: [buildRow(2), buildRow(3)],
      oldestRow: buildRow(2),
      newestRow: null,
      hasOlder: true,
      hasNewer: null,
    });
  });

  it('returns the full newer gap when the target is after the loaded window', () => {
    const result = resolveMessageWindowMerge(
      [buildRow(1), buildRow(2), buildRow(3), buildRow(4), buildRow(5)],
      [buildLoadedMessage('1'), buildLoadedMessage('2')],
      4
    );

    expect(result).toEqual({
      direction: 'newer',
      targetIndex: 3,
      targetRow: buildRow(4),
      rowsToMerge: [buildRow(3), buildRow(4)],
      oldestRow: null,
      newestRow: buildRow(4),
      hasOlder: null,
      hasNewer: true,
    });
  });

  it('returns only the target row when the target is already inside the loaded window', () => {
    const result = resolveMessageWindowMerge(
      [buildRow(1), buildRow(2), buildRow(3), buildRow(4)],
      [buildLoadedMessage('2'), buildLoadedMessage('4')],
      3
    );

    expect(result).toEqual({
      direction: 'inside',
      targetIndex: 2,
      targetRow: buildRow(3),
      rowsToMerge: [buildRow(3)],
      oldestRow: null,
      newestRow: null,
      hasOlder: null,
      hasNewer: null,
    });
  });

  it('falls back to a single target row when no messages are currently loaded', () => {
    const result = resolveMessageWindowMerge([buildRow(1), buildRow(2), buildRow(3)], [], 2);

    expect(result).toEqual({
      direction: 'inside',
      targetIndex: 1,
      targetRow: buildRow(2),
      rowsToMerge: [buildRow(2)],
      oldestRow: null,
      newestRow: null,
      hasOlder: null,
      hasNewer: null,
    });
  });

  it('treats invalid loaded message ids as missing window anchors', () => {
    const result = resolveMessageWindowMerge(
      [buildRow(1), buildRow(2), buildRow(3)],
      [buildLoadedMessage('bad-id')],
      1
    );

    expect(result?.direction).toBe('inside');
    expect(result?.rowsToMerge).toEqual([buildRow(1)]);
  });
});
