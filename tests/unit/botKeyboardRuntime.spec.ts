import { describe, expect, it, vi } from 'vitest';
import NostrClient, {
  ClientEvent,
  NostrPrivateKeySigner,
  giftUnwrap,
} from '#src/lib/nostr/client.ts';
import { createBotKeyboardRuntime } from '#src/stores/nostr/botKeyboardRuntime.ts';
import {
  BOT_CONTROL_KIND,
  controlTag,
  keyboardTag,
  parseControl,
  type BotTarget,
} from '#src/stores/nostr/botKeyboardProtocol.ts';
import { readBotInteraction, saveBotInteraction } from '#src/services/botInteractionData.ts';

const keyboard = { inline_keyboard: [[{ text: 'Vote', callback_data: 'vote:a' }]] };
function setup() {
  const own = NostrPrivateKeySigner.generate(),
    bot = NostrPrivateKeySigner.generate();
  let account: string | null = own.pubkey;
  const publish = vi.fn().mockResolvedValue(undefined);
  const authorize = vi.fn().mockResolvedValue({ keyboard });
  const blocked = vi.fn().mockReturnValue(false);
  const runtime = createBotKeyboardRuntime({
    client: new NostrClient(),
    account: () => account,
    blocked,
    signer: async () => own,
    authorize,
    publish,
    containsSecret: () => false,
  });
  const target: BotTarget = {
    type: 'dm',
    chat: bot.pubkey,
    bot: bot.pubkey,
    root: 'a'.repeat(64),
    version: 'a'.repeat(64),
  };
  return {
    own,
    bot,
    runtime,
    target,
    publish,
    authorize,
    blocked,
    setAccount: (v: string | null) => {
      account = v;
    },
  };
}
async function answer(s: ReturnType<typeof setup>, overrides = {}) {
  const row = (await s.runtime.read(s.target))!;
  const event = new ClientEvent(undefined, {
    kind: BOT_CONTROL_KIND,
    pubkey: s.bot.pubkey,
    created_at: Math.floor(Date.now() / 1000),
    content: 'Vote recorded.',
    tags: [
      ['p', s.own.pubkey],
      controlTag({ ...row.request, op: 'answer' }),
      keyboardTag({ inline_keyboard: [[{ text: 'Results', callback_data: 'results' }]] }),
    ],
    ...overrides,
  });
  await event.toNostrEvent();
  return event.rawEvent();
}
describe('encrypted bot interactions', () => {
  it('persists exact ciphertext before publishing and retries without a second operation', async () => {
    const s = setup();
    s.publish.mockImplementation(async () => {
      expect((await s.runtime.read(s.target))?.wrap).toBeDefined();
      throw new Error('No ACK');
    });
    await expect(s.runtime.click(s.target, 'vote:a')).rejects.toThrow('No ACK');
    const original = (await s.runtime.read(s.target))!;
    const decoded = await giftUnwrap(new ClientEvent(undefined, original.wrap!), undefined, s.bot);
    expect(decoded.content).toBe('');
    expect(decoded.pubkey).toBe(s.own.pubkey);
    expect(parseControl(decoded.tags)?.data).toBe('vote:a');
    expect(JSON.stringify(original.wrap)).not.toContain('vote:a');
    s.publish.mockResolvedValue(undefined);
    await s.runtime.click(s.target, 'vote:a', undefined, true);
    expect(s.publish.mock.calls[1][0]).toEqual(s.publish.mock.calls[0][0]);
    expect((await s.runtime.read(s.target))?.request.id).toBe(original.request.id);
  });
  it('accepts only correlated replies and persists personal menus', async () => {
    const s = setup();
    await s.runtime.click(s.target, 'vote:a');
    const response = await answer(s);
    await s.runtime.receive({ ...response, pubkey: 'f'.repeat(64) });
    expect((await s.runtime.read(s.target))?.answer).toBeUndefined();
    await s.runtime.receive(response);
    const persisted = await readBotInteraction(s.own.pubkey, (await s.runtime.read(s.target))!.key);
    expect(persisted?.answer?.text).toBe('Vote recorded.');
    await expect(s.runtime.click(s.target, 'not-a-button', response.id)).rejects.toThrow('menu');
    await s.runtime.click(s.target, 'results', response.id);
    await s.runtime.receive(response);
    expect((await s.runtime.read(s.target))?.answer).toBeUndefined();
  });
  it('discards late account work and blocks unauthorized or changed menus', async () => {
    const s = setup();
    let release!: () => void;
    s.authorize.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ keyboard });
        }),
    );
    const pending = s.runtime.click(s.target, 'vote:a');
    s.setAccount(null);
    s.runtime.reset();
    release();
    await expect(pending).rejects.toThrow('Account');
    expect(s.publish).not.toHaveBeenCalled();
    s.setAccount(s.own.pubkey);
    s.blocked.mockReturnValue(true);
    await expect(s.runtime.click(s.target, 'vote:a')).rejects.toThrow('unavailable');
    s.blocked.mockReturnValue(false);
    s.authorize.mockRejectedValue(new Error('Revoked'));
    await expect(s.runtime.click(s.target, 'vote:a')).rejects.toThrow('Revoked');
  });
  it('uses compare-and-set to keep delayed writes from erasing replies or newer requests', async () => {
    const s = setup();
    await s.runtime.click(s.target, 'vote:a');
    const old = (await s.runtime.read(s.target))!;
    await s.runtime.receive(await answer(s));
    expect(await saveBotInteraction(s.own.pubkey, old, old.request.id)).toBe(false);
    expect((await s.runtime.read(s.target))?.answer).toBeDefined();
    expect(
      await readBotInteraction(NostrPrivateKeySigner.generate().pubkey, old.key),
    ).toBeUndefined();
  });
});

it('rejects private-key-looking callback payloads before signing or publishing', async () => {
  const s = setup(),
    data = `nsec1${'q'.repeat(58)}`;
  s.authorize.mockResolvedValue({
    keyboard: { inline_keyboard: [[{ text: 'Unsafe', callback_data: data }]] },
  });
  await expect(s.runtime.click(s.target, data)).rejects.toThrow('private key');
  expect(s.publish).not.toHaveBeenCalled();
  expect(await s.runtime.read(s.target)).toBeUndefined();
});

it('bounds the account cache while retaining the newest interactions', async () => {
  const s = setup();
  await s.runtime.click(s.target, 'vote:a');
  const original = (await s.runtime.read(s.target))!;
  for (let i = 1; i <= 501; i++) {
    const root = i.toString(16).padStart(64, '0');
    const target = { ...s.target, root, version: root };
    await saveBotInteraction(s.own.pubkey, {
      ...original,
      key: [target.type, target.chat, target.bot, root, root].join(':'),
      updated: original.updated + i,
      request: { ...original.request, id: i.toString(16).padStart(32, '0'), target },
    });
  }
  expect(await s.runtime.read(s.target)).toBeUndefined();
  const first = '1'.padStart(64, '0'),
    last = (501).toString(16).padStart(64, '0');
  expect(await s.runtime.read({ ...s.target, root: first, version: first })).toBeUndefined();
  expect(await s.runtime.read({ ...s.target, root: last, version: last })).toBeDefined();
});
