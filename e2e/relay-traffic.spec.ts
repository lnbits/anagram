import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { type RelayTrafficSnapshot, startMockRelayProxy } from '../scripts/mock-relay-proxy.cjs';
import {
  acceptFirstRequest,
  addGroupMemberAndPublish,
  bootstrapUser,
  createGroup,
  disposeUsers,
  E2E_RELAY_URL,
  establishAcceptedDirectChat,
  navigateToChat,
  openGroupContact,
  openGroupEpochsTab,
  openRequests,
  readGroupEpochNumbers,
  rotateGroupEpoch,
  sendMessage,
  waitForThreadMessage,
} from './helpers';

function counts(traffic: RelayTrafficSnapshot) {
  return {
    REQ: traffic.frames.filter((frame) => frame.command === 'REQ').length,
    EVENT: traffic.frames.filter((frame) => frame.command === 'EVENT').length,
    connections: traffic.connectionCount,
    maxConcurrentConnections: traffic.maxConcurrentConnections,
  };
}

test('saved state restores once, healthy resume is quiet, and an immediate DM passes a strict relay limit', async ({
  browser,
}, info) => {
  test.setTimeout(300_000);
  const baseline = process.env.TRAFFIC_BASELINE === 'true';
  const proxy = await startMockRelayProxy({
    listenPort: 7010,
    targetUrl: E2E_RELAY_URL,
    ...(baseline ? {} : { rateLimit: { windowMs: 100, maxFrames: 8 } }),
  });
  const aliceAccount = {
    privateKey: randomBytes(32).toString('hex'),
    displayName: 'Traffic Alice',
  };
  const bobAccount = { privateKey: randomBytes(32).toString('hex'), displayName: 'Traffic Bob' };
  const alice = await bootstrapUser(browser, aliceAccount, { relayUrls: [proxy.relayUrl] });
  const bob = await bootstrapUser(browser, bobAccount, { relayUrls: [proxy.relayUrl] });
  let restored: Awaited<ReturnType<typeof bootstrapUser>> | undefined;
  try {
    await establishAcceptedDirectChat(alice, bob);
    const history = `saved-history-${Date.now()}`;
    await sendMessage(alice.page, history, { chatId: bob.session.publicKey });
    const group = await createGroup(alice.page, {
      name: 'Traffic group',
      about: 'Restored roster',
    });
    await disposeUsers(alice, bob);
    proxy.resetTraffic();
    restored = await bootstrapUser(browser, aliceAccount, {
      relayUrls: [proxy.relayUrl],
      passiveRestore: true,
    });
    await expect
      .poll(async () =>
        restored?.page.evaluate(
          async (publicKey) => window.__appE2E__?.isPrivateContactListMember({ publicKey }),
          bob.session.publicKey
        )
      )
      .toBe(true);
    await navigateToChat(restored.page, bob.session.publicKey);
    await waitForThreadMessage(restored.page, history, { chatId: bob.session.publicKey });
    await expect(
      restored.page.locator(`[data-testid="chat-item"][data-chat-public-key="${group}"]`)
    ).toHaveCount(1);
    const fresh = proxy.trafficSnapshot();
    await info.attach('fresh-login-traffic', {
      body: JSON.stringify({ counts: counts(fresh), ...fresh }, null, 2),
      contentType: 'application/json',
    });
    console.log('RELAY_TRAFFIC fresh', counts(fresh));
    if (!baseline) {
      expect(fresh.frames.filter((frame) => frame.command === 'EVENT')).toHaveLength(0);
      expect(fresh.duplicateActiveSignatures).toBe(0);
      expect(fresh.maxConcurrentConnections).toBe(1);
      expect(fresh.rateLimitRejections).toBe(0);
    }

    await restored.page.evaluate(async () => window.__appE2E__?.waitForHistoryRestore());
    const complete = proxy.trafficSnapshot();
    console.log('RELAY_TRAFFIC complete-history', counts(complete));
    await info.attach('complete-history-traffic', {
      body: JSON.stringify({ counts: counts(complete), ...complete }, null, 2),
      contentType: 'application/json',
    });
    proxy.resetTraffic();
    await restored.page.evaluate(async () => {
      await Promise.all([window.__appE2E__?.resumeSession(), window.__appE2E__?.resumeSession()]);
    });
    const resume = proxy.trafficSnapshot();
    await info.attach('lightweight-resume-traffic', {
      body: JSON.stringify({ counts: counts(resume), ...resume }, null, 2),
      contentType: 'application/json',
    });
    console.log('RELAY_TRAFFIC resume', counts(resume));
    if (!baseline) {
      expect(
        resume.frames.filter((frame) => ['REQ', 'CLOSE', 'EVENT'].includes(frame.command))
      ).toHaveLength(0);
      expect(resume.connectionCount).toBe(0);
    }

    proxy.resetTraffic();
    await sendMessage(restored.page, `immediate-${Date.now()}`, { chatId: bob.session.publicKey });
    const sent = proxy.trafficSnapshot();
    const wraps = sent.frames.filter((frame) => frame.command === 'EVENT' && frame.kind === 1059);
    console.log('RELAY_TRAFFIC immediate-send', counts(sent));
    if (!baseline) {
      expect(wraps).toHaveLength(2);
      expect(new Set(wraps.map((frame) => frame.eventId)).size).toBe(2);
      expect(sent.rateLimitRejections).toBe(0);
    }
  } finally {
    if (restored) await disposeUsers(restored);
    await disposeUsers(alice, bob);
    await proxy.close();
  }
});

test('reconnecting one failed relay target reuses the persisted wrapper without publishing to unrelated relays', async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const first = await startMockRelayProxy({
    listenPort: 7011,
    targetUrl: E2E_RELAY_URL,
    rateLimit: { windowMs: 100, maxFrames: 8 },
  });
  const second = await startMockRelayProxy({
    listenPort: 7012,
    targetUrl: 'ws://127.0.0.1:7001',
    rateLimit: { windowMs: 100, maxFrames: 8 },
  });
  const alice = await bootstrapUser(
    browser,
    { privateKey: randomBytes(32).toString('hex'), displayName: 'Retry Alice' },
    { relayUrls: [first.relayUrl, second.relayUrl] }
  );
  const bob = await bootstrapUser(
    browser,
    { privateKey: randomBytes(32).toString('hex'), displayName: 'Retry Bob' },
    { relayUrls: [first.relayUrl] }
  );
  try {
    await establishAcceptedDirectChat(alice, bob);
    first.resetTraffic();
    second.resetTraffic();
    const sent = await alice.page.evaluate(
      async (chatId) =>
        window.__appE2E__?.sendMessages({ chatId, texts: ['Stable retry ciphertext'] }),
      bob.session.publicKey
    );
    const original = first
      .trafficSnapshot()
      .frames.filter((frame) => frame.command === 'EVENT' && frame.kind === 1059)
      .map((frame) => frame.eventId);
    const eventId = sent?.[0]?.eventId;
    if (!eventId) throw new Error('Sent message event id is missing');
    first.resetTraffic();
    second.resetTraffic();
    await alice.page.evaluate(
      async (options) => window.__appE2E__?.seedFailedOutboundRelay(options),
      { eventId, relayUrl: `${first.relayUrl}/` }
    );
    first.disconnectClients();
    await expect
      .poll(
        () =>
          first
            .trafficSnapshot()
            .frames.filter((frame) => frame.command === 'EVENT' && frame.kind === 1059).length,
        { timeout: 25_000 }
      )
      .toBe(1);
    await alice.page.evaluate(async () =>
      Promise.all([window.__appE2E__?.resumeSession(), window.__appE2E__?.resumeSession()])
    );
    const retryFrames = first
      .trafficSnapshot()
      .frames.filter((frame) => frame.command === 'EVENT' && frame.kind === 1059);
    expect(retryFrames).toHaveLength(1);
    expect(original).toContain(retryFrames[0]?.eventId);
    expect(
      second.trafficSnapshot().frames.filter((frame) => frame.command === 'EVENT')
    ).toHaveLength(0);
    expect(first.trafficSnapshot().rateLimitRejections).toBe(0);
    await info.attach('targeted-retry-traffic', {
      body: JSON.stringify(
        { connected: first.trafficSnapshot(), unrelated: second.trafficSnapshot() },
        null,
        2
      ),
      contentType: 'application/json',
    });
  } finally {
    await disposeUsers(alice, bob);
    await first.close();
    await second.close();
  }
});

test('an epoch transition adds its recipient while retaining personal DM and roster listeners', async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const proxy = await startMockRelayProxy({
    listenPort: 7013,
    targetUrl: E2E_RELAY_URL,
    rateLimit: { windowMs: 100, maxFrames: 8 },
  });
  const relayUrls = [proxy.relayUrl];
  const alice = await bootstrapUser(
    browser,
    { privateKey: randomBytes(32).toString('hex'), displayName: 'Epoch Alice' },
    { relayUrls }
  );
  const bob = await bootstrapUser(
    browser,
    { privateKey: randomBytes(32).toString('hex'), displayName: 'Epoch Bob' },
    { relayUrls }
  );
  try {
    const group = await createGroup(alice.page, {
      name: 'Traffic epoch',
      about: 'Scoped transition',
    });
    await addGroupMemberAndPublish(alice.page, bob.session.publicKey);
    await openRequests(bob.page, { publicKey: group });
    await acceptFirstRequest(bob.page, { publicKey: group });
    await expect
      .poll(
        () =>
          new Set(
            proxy
              .trafficSnapshot()
              .frames.filter(
                (frame) =>
                  frame.command === 'REQ' &&
                  frame.subscriptionName === 'group-roster' &&
                  frame.filters?.some((filter) =>
                    (filter.authors as string[] | undefined)?.includes(group)
                  )
              )
              .map((frame) => frame.connectionId)
          ).size
      )
      .toBe(2);
    const before = proxy.trafficSnapshot();
    const retained = before.frames.filter(
      (frame) =>
        frame.command === 'REQ' &&
        (frame.subscriptionName === 'group-roster' ||
          (frame.subscriptionName === 'private-messages-live' &&
            frame.filters?.some((filter) =>
              (filter['#p'] as string[] | undefined)?.some((key) =>
                [alice.session.publicKey, bob.session.publicKey].includes(key)
              )
            )))
    );
    expect(retained.length).toBeGreaterThan(0);
    proxy.resetTraffic();
    await rotateGroupEpoch(alice.page, group, [bob.session.publicKey], relayUrls);
    await openGroupContact(bob.page, group);
    await openGroupEpochsTab(bob.page);
    await expect.poll(() => readGroupEpochNumbers(bob.page), { timeout: 12_000 }).toEqual([1, 0]);
    await navigateToChat(alice.page, group);
    const text = `new-epoch-${Date.now()}`;
    await sendMessage(alice.page, text, { chatId: group });
    await navigateToChat(bob.page, group);
    await waitForThreadMessage(bob.page, text, { chatId: group });
    const after = proxy.trafficSnapshot();
    await info.attach('epoch-transition-traffic', {
      body: JSON.stringify({ before, after }, null, 2),
      contentType: 'application/json',
    });
    for (const prior of retained) {
      expect(
        after.frames.some(
          (frame) =>
            frame.command === 'CLOSE' &&
            frame.connectionId === prior.connectionId &&
            frame.subscriptionId === prior.subscriptionId
        )
      ).toBe(false);
    }
    expect(
      after.frames.filter(
        (frame) => frame.command === 'REQ' && frame.subscriptionName === 'group-roster'
      )
    ).toHaveLength(0);
    expect(after.duplicateActiveSignatures).toBe(0);
    expect(after.rateLimitRejections).toBe(0);
    await info.attach('epoch-transition-traffic', {
      body: JSON.stringify(after, null, 2),
      contentType: 'application/json',
    });
  } finally {
    await disposeUsers(alice, bob);
    await proxy.close();
  }
});

test('fresh login can send immediately while background history is restoring', async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const proxy = await startMockRelayProxy({
    listenPort: 7014,
    targetUrl: E2E_RELAY_URL,
    rateLimit: { windowMs: 100, maxFrames: 8 },
  });
  const relayUrls = [proxy.relayUrl];
  const account = { privateKey: randomBytes(32).toString('hex'), displayName: 'Immediate Alice' };
  const alice = await bootstrapUser(browser, account, { relayUrls });
  const bob = await bootstrapUser(
    browser,
    { privateKey: randomBytes(32).toString('hex'), displayName: 'Immediate Bob' },
    { relayUrls }
  );
  let restored: Awaited<ReturnType<typeof bootstrapUser>> | undefined;
  try {
    await establishAcceptedDirectChat(alice, bob);
    await disposeUsers(alice, bob);
    proxy.resetTraffic();
    restored = await bootstrapUser(browser, account, { relayUrls, passiveRestore: true });
    // No history completion wait or settle delay before sending.
    await restored.page.evaluate(
      async (chatId) =>
        window.__appE2E__?.sendMessages({ chatId, texts: ['Sent immediately after login'] }),
      bob.session.publicKey
    );
    await expect
      .poll(
        () =>
          proxy
            .trafficSnapshot()
            .receivedFrames.filter((frame) => frame.command === 'OK' && frame.accepted).length
      )
      .toBe(2);
    const traffic = proxy.trafficSnapshot();
    const wraps = traffic.frames.filter(
      (frame) => frame.command === 'EVENT' && frame.kind === 1059
    );
    expect(wraps).toHaveLength(2);
    expect(new Set(wraps.map((frame) => frame.eventId)).size).toBe(2);
    expect(traffic.rateLimitRejections).toBe(0);
    expect(traffic.maxConcurrentConnections).toBe(1);
    await info.attach('login-immediate-send-traffic', {
      body: JSON.stringify(traffic, null, 2),
      contentType: 'application/json',
    });
  } finally {
    if (restored) await disposeUsers(restored);
    await disposeUsers(alice, bob);
    await proxy.close();
  }
});
