import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleAndroidCallAction,
  syncClosedAndroidCalls,
  type AndroidCallAction,
} from '#src/services/androidCallNotificationService.ts';
import type { CallSession } from '#src/types/call.ts';

const mock = vi.hoisted(() => ({
  android: true,
  owner: 'a'.repeat(64),
  session: null as CallSession | null,
  closed: [] as { peer: string; callId: string }[],
  claim: vi.fn(async () => ({ valid: true })),
  ingest: vi.fn(async () => true),
  accept: vi.fn(async () => {}),
  receive: vi.fn(async () => {}),
  remember: vi.fn(),
}));
vi.mock('#src/lib/platform/androidNotifications.ts', () => ({
  isAndroidNative: () => mock.android,
  androidNotificationPlugin: () => ({
    getCallNotificationState: async () => ({ closed: mock.closed }),
    claimCallAnswer: mock.claim,
  }),
}));
vi.mock('#src/stores/nostrStore.ts', () => ({
  useNostrStore: () => ({
    getLoggedInPublicKeyHex: () => mock.owner,
    ingestAndroidRelayNotificationEvent: mock.ingest,
  }),
}));
vi.mock('#src/stores/callStore.ts', () => ({
  useCallStore: () => ({
    get session() {
      return mock.session;
    },
    accept: mock.accept,
    receiveSignal: mock.receive,
  }),
}));
vi.mock('#src/services/callReplayCache.ts', () => ({ rememberCallControl: mock.remember }));

const action = (): AndroidCallAction => ({
  ownerPubkey: mock.owner,
  peer: 'b'.repeat(64),
  callId: '12345678-1234-4123-8123-123456789abc',
  token: 'native-token',
  expiresAt: Date.now() + 60_000,
  relayUrl: 'wss://relay.example',
  answer: true,
  event: {
    id: 'c'.repeat(64),
    pubkey: 'd'.repeat(64),
    sig: 'e'.repeat(128),
    kind: 1059,
    tags: [],
    content: 'encrypted',
    created_at: 1700000000,
  },
});
beforeEach(() => {
  vi.clearAllMocks();
  mock.android = true;
  mock.owner = 'a'.repeat(64);
  mock.closed = [];
  mock.claim.mockImplementation(async () => ({ valid: true }));
  const a = action();
  mock.session = {
    id: a.callId,
    peerPubkey: a.peer,
    peerName: 'Caller',
    phase: 'incoming',
    mode: 'audio',
    direction: 'incoming',
    startedAt: null,
    microphoneMuted: false,
    cameraMuted: true,
  };
});
describe('Android notification call handoff', () => {
  it('ingests the encrypted invitation and claims the matching call before answering', async () => {
    const a = action();
    await handleAndroidCallAction(a);
    expect(mock.ingest).toHaveBeenCalledWith({
      ownerPubkey: a.ownerPubkey,
      relayUrl: a.relayUrl,
      event: a.event,
    });
    expect(mock.claim).toHaveBeenCalledWith({ token: a.token });
    expect(mock.accept).toHaveBeenCalledWith('audio');
  });
  it('opens a content tap without automatically answering', async () => {
    await handleAndroidCallAction({ ...action(), answer: false });
    expect(mock.ingest).toHaveBeenCalledOnce();
    expect(mock.accept).not.toHaveBeenCalled();
    expect(mock.claim).not.toHaveBeenCalled();
  });
  it('rejects a cancelled, expired, or already claimed native action', async () => {
    mock.claim.mockResolvedValue({ valid: false });
    await handleAndroidCallAction(action());
    expect(mock.accept).not.toHaveBeenCalled();
  });
  it('never opens media for a different account or expired invitation', async () => {
    await handleAndroidCallAction({ ...action(), ownerPubkey: 'f'.repeat(64) });
    await handleAndroidCallAction({ ...action(), expiresAt: Date.now() - 1 });
    expect(mock.ingest).not.toHaveBeenCalled();
    expect(mock.accept).not.toHaveBeenCalled();
  });
  it('checks cancellation and account switching again after the native claim', async () => {
    mock.claim.mockImplementation(async () => {
      mock.session!.phase = 'ended';
      return { valid: true };
    });
    await handleAndroidCallAction(action());
    expect(mock.accept).not.toHaveBeenCalled();
    mock.session!.phase = 'incoming';
    mock.claim.mockImplementation(async () => {
      mock.owner = 'f'.repeat(64);
      return { valid: true };
    });
    await handleAndroidCallAction(action());
    expect(mock.accept).not.toHaveBeenCalled();
  });
  it('imports native cancellation tombstones and ends a matching ringing UI', async () => {
    const a = action();
    mock.closed = [{ peer: a.peer, callId: a.callId }];
    await syncClosedAndroidCalls();
    expect(mock.remember).toHaveBeenCalledWith(a.ownerPubkey, a.peer, a.callId);
    expect(mock.receive).toHaveBeenCalledWith(
      a.peer,
      expect.objectContaining({ action: 'end', callId: a.callId }),
    );
    mock.session!.phase = 'active';
    mock.receive.mockClear();
    await syncClosedAndroidCalls();
    expect(mock.receive).not.toHaveBeenCalled();
  });
  it('does not change browser calls', async () => {
    mock.android = false;
    await handleAndroidCallAction(action());
    await syncClosedAndroidCalls();
    expect(mock.ingest).not.toHaveBeenCalled();
    expect(mock.accept).not.toHaveBeenCalled();
  });
});
