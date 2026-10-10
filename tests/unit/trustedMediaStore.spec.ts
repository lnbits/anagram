import {
  isTrustedImageSenderValue,
  normalizeTrustedImageSenderPublicKey,
  normalizeTrustedImageSenderPublicKeys,
} from '#src/stores/trustedMediaStore.ts';
import { describe, expect, it } from 'vitest';

describe('trustedMediaStore helpers', () => {
  const alice = 'a'.repeat(64);
  const bob = 'b'.repeat(64);

  it('normalizes trusted sender public keys', () => {
    expect(normalizeTrustedImageSenderPublicKey(` ${alice.toUpperCase()} `)).toBe(alice);
    expect(normalizeTrustedImageSenderPublicKey('not-a-pubkey')).toBeNull();
    expect(normalizeTrustedImageSenderPublicKeys([alice.toUpperCase(), alice, bob, 'bad'])).toEqual(
      [alice, bob]
    );
  });

  it('trusts the logged-in pubkey by default and otherwise uses the stored sender list', () => {
    expect(isTrustedImageSenderValue(alice, [], alice.toUpperCase())).toBe(true);
    expect(isTrustedImageSenderValue(alice, [bob], bob)).toBe(false);
    expect(isTrustedImageSenderValue(alice.toUpperCase(), [alice], bob)).toBe(true);
  });
});
