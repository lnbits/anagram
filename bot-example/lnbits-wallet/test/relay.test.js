// Integration: real WebSocket relay with NIP-42 AUTH, real gift wraps, restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrapEvent, wrapEvent } from 'nostr-tools/nip59';
import { WalletBot } from '../bot.js';
import { Network, now, State } from '../vendor/runtime.js';
import { relay, until } from './relay.js';
import { alice, defer, linked, mallory, tempDir } from './helpers.js';

test(
  'over real relay sockets: linked person answered, stranger ignored, restart safe',
  { timeout: 60000 },
  async (t) => {
    const local = await relay();
    local.requireAuth = true;
    const dir = tempDir(t, 'relay');
    let bot;
    const start = async () => {
      bot = new WalletBot({
        store: new State(dir),
        net: new Network([local.url]),
        wallets: linked(),
        log() {},
        onFatal: (error) => {
          throw error;
        },
      });
      await bot.start();
    };
    defer(t, async () => {
      await bot?.close();
      await local.close();
    });
    await start();
    const replies = (key) =>
      [...local.events.values()]
        .filter((e) => e.kind === 1059)
        .flatMap((event) => {
          try {
            const message = unwrapEvent(event, key);
            return message.pubkey === bot.pubkey ? [message] : [];
          } catch {
            return [];
          }
        });
    let offset = 0;
    const send = (key, content) =>
      local.emit(
        wrapEvent(
          { kind: 14, tags: [['p', bot.pubkey]], content, created_at: now() + offset++ },
          key,
          bot.pubkey,
        ),
      );

    send(alice, '/help');
    await until(() => replies(alice).length === 1, 'reply to alice');
    assert.match(replies(alice)[0].content, /Alice test wallet/);
    send(mallory, '/help');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(replies(mallory).length, 0);

    // The relay keeps every gift wrap and resends them to the restarted bot.
    await bot.close();
    await start();
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(replies(alice).length, 1, 'not answered again after restart');
    send(alice, 'help');
    await until(() => replies(alice).length === 2, 'second reply');
  },
);
