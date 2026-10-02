import { CALL_PROTOCOL, CALL_RING_TIMEOUT_MS, type CallSignal } from 'src/types/call';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const END_REASONS = new Set(['hangup', 'declined', 'busy', 'timeout', 'failed', 'cancelled']);
export const CALL_MIME_TYPES = ['video/webm;codecs=vp8,opus', 'audio/webm;codecs=opus'] as const;

// Do not trust encrypted payloads: peers can still send malformed or stale signals.
export function parseCallSignal(
  content: string,
  createdAt: number | undefined,
  now = Date.now()
): CallSignal | null {
  if (content.length > 4096 || !createdAt || !Number.isSafeInteger(createdAt)) return null;
  const age = now - createdAt * 1000;
  if (age < -10_000 || age > CALL_RING_TIMEOUT_MS) return null;
  try {
    const value = JSON.parse(content);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      value.protocol !== CALL_PROTOCOL ||
      typeof value.callId !== 'string' ||
      !UUID.test(value.callId) ||
      !['invite', 'accept', 'end'].includes(value.action) ||
      !['audio', 'video'].includes(value.mode) ||
      typeof value.expiresAt !== 'string'
    )
      return null;
    const expiration = Date.parse(value.expiresAt);
    if (
      !Number.isFinite(expiration) ||
      expiration <= now ||
      expiration > createdAt * 1000 + CALL_RING_TIMEOUT_MS + 1000
    )
      return null;
    if (value.action === 'end') {
      if (!END_REASONS.has(value.reason)) return null;
    } else {
      if (
        !value.address ||
        typeof value.address.id !== 'string' ||
        !/^[a-z0-9]{52,64}$/.test(value.address.id) ||
        typeof value.address.relayUrl !== 'string' ||
        value.address.relayUrl.length > 512 ||
        !CALL_MIME_TYPES.some((mime) => mime === value.mimeType) ||
        (value.mode === 'video' && !value.mimeType.startsWith('video/')) ||
        (value.mode === 'audio' && !value.mimeType.startsWith('audio/'))
      )
        return null;
      const relay = new URL(value.address.relayUrl);
      if (
        relay.protocol !== 'https:' ||
        !relay.hostname ||
        relay.username ||
        relay.password ||
        relay.hash ||
        relay.search
      )
        return null;
      value.address = { id: value.address.id, relayUrl: relay.href };
    }
    return {
      protocol: CALL_PROTOCOL,
      callId: value.callId,
      action: value.action,
      expiresAt: new Date(expiration).toISOString(),
      mode: value.mode,
      ...(value.action === 'end'
        ? { reason: value.reason }
        : { address: value.address, mimeType: value.mimeType }),
    };
  } catch {
    return null;
  }
}
