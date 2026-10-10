import { CALL_PROTOCOL, type CallSignal } from '#src/types/call.ts';
import { parseCallSignal } from '#src/utils/callSignal.ts';
import { describe, expect, it } from 'vitest';

const now = Date.parse('2026-10-01T12:00:00Z');
const signal: CallSignal = {
  protocol: CALL_PROTOCOL,
  callId: '3ef5dc58-8b01-44d6-8c68-804eac6e93a1',
  action: 'invite',
  mode: 'video',
  expiresAt: new Date(now + 60_000).toISOString(),
  address: { id: 'a'.repeat(64), relayUrl: 'https://relay.example/' },
  mimeType: 'video/webm;codecs=vp8,opus',
};
const parse = (overrides = {}, timestamp = now / 1000) =>
  parseCallSignal(JSON.stringify({ ...signal, ...overrides }), timestamp, now);

describe('private call signal validation', () => {
  it('accepts a fresh versioned invite and normalizes its expiration and relay', () => {
    expect(parse()).toEqual(signal);
    expect(
      parse({ address: { id: 'a'.repeat(64), relayUrl: 'https://RELAY.example' } })?.address
        ?.relayUrl
    ).toBe('https://relay.example/');
  });
  it.each([
    { callId: 'reused-or-invalid' },
    { protocol: 'future-protocol' },
    { mode: 'screen' },
    { action: 'offer' },
    { mimeType: 'video/webm;codecs=vp9' },
    { mimeType: 'audio/webm;codecs=opus' },
    { expiresAt: new Date(now).toISOString() },
    { expiresAt: new Date(now + 120_000).toISOString() },
    { expiresAt: 'invalid' },
    { address: null },
    { address: { id: 'a'.repeat(64), relayUrl: 'http://relay.example' } },
    { address: { id: 'a'.repeat(64), relayUrl: 'https://user:secret@relay.example' } },
    { address: { id: 'bad', relayUrl: 'https://relay.example' } },
  ])('drops malformed or unsafe signaling payloads: %j', (overrides) => {
    expect(parse(overrides)).toBeNull();
  });
  it('rejects old, future, oversized and invalid JSON rumors', () => {
    expect(parse({}, now / 1000 - 61)).toBeNull();
    expect(parse({}, now / 1000 + 11)).toBeNull();
    expect(parseCallSignal('x'.repeat(4097), now / 1000, now)).toBeNull();
    expect(parseCallSignal('{', now / 1000, now)).toBeNull();
  });
  it('accepts hangups without an endpoint and rejects unknown reasons', () => {
    expect(
      parse({ action: 'end', reason: 'hangup', address: undefined, mimeType: undefined })?.reason
    ).toBe('hangup');
    expect(parse({ action: 'end', reason: 'unknown' })).toBeNull();
  });
  it('accepts a ringing acknowledgement without an endpoint and preserves negotiated media capabilities', () => {
    expect(
      parse({
        action: 'ringing',
        address: undefined,
        mimeType: undefined,
        mediaVersion: 2,
        videoSupported: true,
      })
    ).toEqual({
      protocol: CALL_PROTOCOL,
      callId: signal.callId,
      action: 'ringing',
      mode: 'video',
      expiresAt: signal.expiresAt,
      mediaVersion: 2,
      videoSupported: true,
    });
    expect(parse({ mediaVersion: 3 })).toBeNull();
    expect(parse({ videoSupported: 'yes' })).toBeNull();
    expect(parse({ action: 'end', reason: 'unsupported' })?.reason).toBe('unsupported');
  });
});
