import { createAppClientOptions } from '#src/stores/nostr/clientOptions.ts';
import { describe, expect, it } from 'vitest';

describe('NostrClient options', () => {
  it('keeps the outbox model enabled by default', () => {
    expect(createAppClientOptions({})).toEqual({
      enableOutboxModel: true,
    });
  });

  it('disables the outbox model when local e2e requests it', () => {
    expect(createAppClientOptions({ APP_E2E_DISABLE_NDK_OUTBOX: 'true' })).toEqual({
      enableOutboxModel: false,
    });
    expect(createAppClientOptions({ APP_E2E_DISABLE_NDK_OUTBOX: true })).toEqual({
      enableOutboxModel: false,
    });
  });

  it('does not disable the outbox model for other env values', () => {
    expect(createAppClientOptions({ APP_E2E_DISABLE_NDK_OUTBOX: 'false' })).toEqual({
      enableOutboxModel: true,
    });
  });
});
