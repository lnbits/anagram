import NDK, { NDKEvent, NDKKind, NDKPrivateKeySigner, NDKRelaySet } from '@nostr-dev-kit/ndk';
import { expect, test } from '@playwright/test';
import { startMockRelayProxy } from '../../scripts/mock-relay-proxy.cjs';
import { PRIVATE_CONTACT_LIST_D_TAG } from '../../src/stores/nostr/constants';
import {
  type BootstrappedUser,
  bootstrapUser,
  disposeUsers,
  E2E_RELAY_URL,
  navigateToChat,
  waitForThreadMessage,
} from '../helpers';

test('step 16 starts after slow live EOSE and downloads old gift wraps across 90 days', async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const receiver = NDKPrivateKeySigner.generate();
  const sender = NDKPrivateKeySigner.generate();
  const ndk = new NDK({
    explicitRelayUrls: [E2E_RELAY_URL],
    signer: receiver,
    enableOutboxModel: false,
  });
  const proxy = await startMockRelayProxy({
    listenPort: 7016,
    targetUrl: E2E_RELAY_URL,
    eoseDelayMs: 3500,
    rateLimit: { windowMs: 100, maxFrames: 8 },
  });
  let restored: BootstrappedUser | undefined;
  const unavailableRelayUrl = 'ws://127.0.0.1:7017';
  const history: Array<{ text: string; eventId: string; createdAt: number }> = [];
  try {
    await ndk.connect(5_000);
    const relaySet = NDKRelaySet.fromRelayUrls([E2E_RELAY_URL], ndk, false);
    const recipient = await receiver.user();
    const now = Math.floor(Date.now() / 1000);
    const contactList = new NDKEvent(ndk, {
      kind: NDKKind.FollowSet,
      pubkey: receiver.pubkey,
      created_at: now - 100 * 24 * 60 * 60,
      tags: [['d', PRIVATE_CONTACT_LIST_D_TAG]],
      content: await receiver.encrypt(recipient, JSON.stringify([['p', sender.pubkey]]), 'nip44'),
    });
    await contactList.publish(relaySet);

    for (const daysAgo of [5, 30, 80]) {
      const createdAt = now - daysAgo * 24 * 60 * 60;
      const text = `history-${daysAgo}-days-${receiver.pubkey.slice(0, 8)}`;
      const rumor = new NDKEvent(ndk, {
        kind: NDKKind.PrivateDirectMessage,
        pubkey: sender.pubkey,
        created_at: createdAt,
        tags: [['p', receiver.pubkey]],
        content: text,
      });
      // Both the rumor and the outer gift wrap must be old. Backdating only the rumor
      // would still deliver the fixture through the recent live subscription.
      const seal = new NDKEvent(ndk, {
        kind: NDKKind.GiftWrapSeal,
        created_at: createdAt,
        tags: [],
        content: JSON.stringify(await rumor.toNostrEvent()),
      });
      await seal.encrypt(recipient, sender, 'nip44');
      await seal.sign(sender);
      const wrapperSigner = NDKPrivateKeySigner.generate();
      const wrapper = new NDKEvent(ndk, {
        kind: NDKKind.GiftWrap,
        created_at: createdAt,
        tags: [['p', receiver.pubkey]],
        content: JSON.stringify(await seal.toNostrEvent()),
      });
      await wrapper.encrypt(recipient, wrapperSigner, 'nip44');
      await wrapper.sign(wrapperSigner);
      await wrapper.publish(relaySet);
      history.push({ text, eventId: wrapper.id, createdAt });
    }

    restored = await bootstrapUser(
      browser,
      {
        privateKey: receiver.privateKey,
        displayName: 'History restore receiver',
      },
      { relayUrls: [proxy.relayUrl, unavailableRelayUrl], passiveRestore: true }
    );
    // Stay off the chat view so restoring an unread message does not mark it read.
    await restored.page.goto('/#/settings/developer');
    // The available relay sends live EOSE after the initial 2.5-second wait. History
    // must start and continue while the second configured relay remains unavailable.
    await expect
      .poll(
        () =>
          proxy
            .trafficSnapshot()
            .receivedFrames.some((frame) => frame.eventId === history[0]?.eventId),
        { timeout: 40_000 }
      )
      .toBe(true);
    // Only the initial snapshot needs the deliberate delay to reproduce the stall.
    proxy.config.eoseDelayMs = 0;
    await restored.page.evaluate(async () => window.__appE2E__?.waitForHistoryRestore());
    const traffic = proxy.trafficSnapshot();
    // Opening the unread chat is a local read-cursor mutation, outside passive restore.
    await navigateToChat(restored.page, sender.pubkey);
    for (const message of history) {
      await waitForThreadMessage(restored.page, message.text, { chatId: sender.pubkey });
    }
    for (const message of history) {
      const received = traffic.receivedFrames.find((frame) => frame.eventId === message.eventId);
      const request = traffic.frames.find(
        (frame) => frame.command === 'REQ' && frame.subscriptionId === received?.subscriptionId
      );
      expect(request?.subscriptionName).toBe('private-messages-history');
      expect(request?.filters?.[0]?.since).toBeLessThanOrEqual(message.createdAt);
      expect(request?.filters?.[0]?.until).toBeGreaterThanOrEqual(message.createdAt);
    }
    expect(traffic.frames.filter((frame) => frame.command === 'EVENT')).toHaveLength(0);
    expect(traffic.duplicateActiveSignatures).toBe(0);
    expect(traffic.rateLimitRejections).toBe(0);
    await info.attach('old-message-history-traffic', {
      body: JSON.stringify(traffic),
      contentType: 'application/json',
    });
  } finally {
    if (restored) await disposeUsers(restored);
    for (const relay of ndk.pool.relays.values()) relay.disconnect();
    await proxy.close();
  }
});
