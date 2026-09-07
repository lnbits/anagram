import { describe, expect, it } from 'vitest';
import { uncoveredHistoryWindows } from 'src/stores/nostr/historyCoverage';

describe('epoch history gaps', () => {
  it('does not requery a window covered by global backfill', () => {
    expect(uncoveredHistoryWindows({ since: 10, until: 100 }, [{ since: 0, until: 100 }])).toEqual([]);
  });
  it('queries only uncovered inclusive gaps across persisted and active windows', () => {
    expect(uncoveredHistoryWindows({ since: 10, until: 100 }, [{ since: 0, until: 30 }, { since: 50, until: 80 }])).toEqual([{ since: 31, until: 49 }, { since: 81, until: 100 }]);
  });
});
