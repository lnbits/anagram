import {
  androidNotificationPlugin,
  isAndroidNative,
} from '#src/lib/platform/androidNotifications.ts';
import { useNostrStore } from '#src/stores/nostrStore.ts';
import { useCallStore } from '#src/stores/callStore.ts';
import { rememberCallControl } from '#src/services/callReplayCache.ts';
import { CALL_PROTOCOL, type CallSession } from '#src/types/call.ts';
import type { NostrEvent } from '#src/lib/nostr/client.ts';

export interface AndroidCallAction {
  token: string;
  ownerPubkey: string;
  peer: string;
  callId: string;
  expiresAt: number;
  event: NostrEvent;
  relayUrl: string;
  answer: boolean;
}
const native = androidNotificationPlugin<{
  getCallNotificationState(args: {
    ownerPubkey: string;
  }): Promise<{ closed: { peer: string; callId: string }[] }>;
  claimCallAnswer(args: { token: string }): Promise<{ valid: boolean }>;
  syncCallState(args: {
    ownerPubkey: string;
    peer: string;
    callId: string;
    phase: string;
    roomBusy: boolean;
  }): Promise<void>;
}>();

export async function syncClosedAndroidCalls(): Promise<void> {
  if (!isAndroidNative()) return;
  const owner = useNostrStore().getLoggedInPublicKeyHex();
  if (!owner) return;
  const result = await native.getCallNotificationState({ ownerPubkey: owner });
  if (useNostrStore().getLoggedInPublicKeyHex() !== owner) return;
  for (const item of result.closed ?? []) {
    rememberCallControl(owner, item.peer, item.callId);
    const calls = useCallStore();
    const session = calls.session;
    if (
      session?.phase === 'incoming' &&
      session.id === item.callId &&
      session.peerPubkey === item.peer
    )
      await calls.receiveSignal(item.peer, {
        protocol: CALL_PROTOCOL,
        callId: item.callId,
        action: 'end',
        reason: 'cancelled',
        expiresAt: new Date(Date.now() + 1000).toISOString(),
        mode: session.mode,
      });
  }
}

export async function handleAndroidCallAction(action: AndroidCallAction): Promise<void> {
  if (!isAndroidNative()) return;
  const nostr = useNostrStore();
  const validAccount = () => nostr.getLoggedInPublicKeyHex() === action.ownerPubkey;
  if (!validAccount() || action.expiresAt <= Date.now()) return;
  await syncClosedAndroidCalls();
  if (!validAccount()) return;
  await nostr.ingestAndroidRelayNotificationEvent({
    ownerPubkey: action.ownerPubkey,
    relayUrl: action.relayUrl,
    event: action.event,
  });
  const calls = useCallStore();
  // Another ingestion may already be resolving the same invitation. Wait only
  // for this call, bounded by its expiry; never accept a different live session.
  const deadline = Math.min(action.expiresAt, Date.now() + 5000);
  while (validAccount() && Date.now() < deadline && calls.session?.id !== action.callId)
    await new Promise((resolve) => setTimeout(resolve, 50));
  const matching = () =>
    validAccount() &&
    calls.session?.id === action.callId &&
    calls.session.peerPubkey === action.peer &&
    calls.session.phase === 'incoming' &&
    action.expiresAt > Date.now();
  if (!action.answer || !matching()) return;
  const claimed = await native.claimCallAnswer({ token: action.token });
  // A notification tap answers with audio; enabling the camera stays an explicit in-app choice.
  if (claimed.valid && matching()) await calls.accept('audio');
}

let lastState = '';
export function syncAndroidCallActivity(
  owner: string | null,
  session: CallSession | null,
  roomBusy: boolean,
): void {
  if (!isAndroidNative() || !owner) return;
  const args = {
    ownerPubkey: owner,
    peer: session?.peerPubkey ?? '',
    callId: session?.id ?? '',
    phase: session?.phase ?? '',
    roomBusy,
  };
  const signature = JSON.stringify(args);
  if (signature === lastState) return;
  lastState = signature;
  void native.syncCallState(args).catch(() => {
    if (lastState === signature) lastState = '';
  });
}
