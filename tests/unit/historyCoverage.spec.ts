import { historyCoverageScope, uncoveredHistoryWindows } from 'src/stores/nostr/historyCoverage';
import { describe, expect, it } from 'vitest';

describe('epoch history gaps', () => {
  it('retains coverage for normalized routes and leaves new relays uncovered', () => {
    expect(historyCoverageScope('recipient', ['wss://a.test'])).toBe(
      historyCoverageScope('recipient', ['wss://a.test/'])
    );
    expect(historyCoverageScope('recipient', ['wss://a.test'])).not.toBe(
      historyCoverageScope('recipient', ['wss://b.test'])
    );
  });
  it('does not requery a window covered by global backfill', () => {
    expect(uncoveredHistoryWindows({ since: 10, until: 100 }, [{ since: 0, until: 100 }])).toEqual(
      []
    );
  });
  it('queries only uncovered inclusive gaps across persisted and active windows', () => {
    expect(
      uncoveredHistoryWindows({ since: 10, until: 100 }, [
        { since: 0, until: 30 },
        { since: 50, until: 80 },
      ])
    ).toEqual([
      { since: 31, until: 49 },
      { since: 81, until: 100 },
    ]);
  });
});
