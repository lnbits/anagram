import { describe, expect, it } from 'vitest';
import { diagnosticJson } from '#src/utils/diagnosticExport.ts';
import { generateSecretKey, nip19 } from 'nostr-tools';
describe('diagnostic exports', () => {
  it('redacts key material and private message data in nested metadata and errors', () => {
    const key = generateSecretKey(),
      nsec = nip19.nsecEncode(key),
      hex = Buffer.from(key).toString('hex');
    const json = diagnosticJson({
      privateMessagesSubscription: { active: true },
      nested: {
        group_private_key_encrypted: 'encrypted-key',
        credentials: 'credential-value',
        lastMessage: 'private message',
        details: { error: `error ${nsec} ${hex}`, profile: { about: nsec }, bytes: key },
      },
    });
    for (const value of [nsec, hex, 'encrypted-key', 'credential-value', 'private message'])
      expect(json).not.toContain(value);
    expect(JSON.parse(json).privateMessagesSubscription.active).toBe(true);
    expect(JSON.parse(json).nested.details.bytes).toBe('[redacted-bytes]');
  });
  it('redacts secret-bearing field names and safely handles cyclic diagnostic objects', () => {
    const secret = nip19.nsecEncode(generateSecretKey());
    const input: Record<string, unknown> = { [secret]: 'value' };
    input.self = input;
    const result = diagnosticJson(input);
    expect(result).not.toContain(secret);
    expect(result).toContain('[circular]');
  });
  it('removes credentials in relay URLs while retaining useful diagnostic counts', () => {
    const result = diagnosticJson({
      url: 'wss://user:password@example.com/',
      attempts: 12,
      phase: 'connected',
    });
    expect(result).not.toContain('user:password');
    expect(JSON.parse(result)).toMatchObject({ attempts: 12, phase: 'connected' });
  });
});

it('removes complete keys, URL query/fragment credentials, pairing tokens and parser snippets', () => {
  const hex = Buffer.from(generateSecretKey()).toString('hex');
  const result = diagnosticJson({
    key: hex,
    error: new SyntaxError('Unexpected token in "private message snippet"'),
    urls: [
      'wss://user:pass@relay.test/path?authorization=relay-credential#secret-fragment',
      'https://signer.test/auth?token=signer-credential',
      'bunker://' + 'a'.repeat(64) + '?secret=bunker-credential',
      'nostrconnect://' + 'b'.repeat(64) + '?secret=pairing-credential',
    ],
  });
  for (const secret of [
    hex,
    hex.slice(0, 8),
    'user:pass',
    'relay-credential',
    'secret-fragment',
    'signer-credential',
    'bunker-credential',
    'pairing-credential',
    'private message snippet',
  ])
    expect(result).not.toContain(secret);
});
