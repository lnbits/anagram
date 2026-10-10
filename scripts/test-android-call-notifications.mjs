// Run after building/installing the debug app and androidTest APK on an emulator.
// Uses only deterministic test identities, an isolated local relay, and no media.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { getPublicKey, nip59, verifyEvent } from 'nostr-tools';
import { randomUUID } from 'node:crypto';
const serial = process.env.ANDROID_SERIAL ?? 'emulator-5582';
if (!serial.startsWith('emulator-'))
  throw new Error('This test replaces app notification settings; use an emulator.');
const caller = Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? 1 : 0));
const callee = Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? 2 : 0));
const id = randomUUID();
const received = new Set();
const server = createServer((_request, response) =>
  response.end(received.has('ringing') && received.has('declined') ? '1' : '0'),
);
const sockets = new WebSocketServer({ server });
let invitation;
sockets.on('connection', (socket) =>
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message[0] === 'REQ') {
      invitation ??= nip59.wrapEvent(
        {
          kind: 21117,
          created_at: Math.floor(Date.now() / 1000),
          pubkey: getPublicKey(caller),
          tags: [['p', getPublicKey(callee)]],
          content: JSON.stringify({
            protocol: 'anagram/iroh-call/1',
            callId: id,
            action: 'invite',
            mode: 'audio',
            mediaVersion: 2,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            mimeType: 'audio/webm;codecs=opus',
            address: { id: 'a'.repeat(64), relayUrl: 'https://relay.example/' },
          }),
        },
        caller,
        getPublicKey(callee),
      );
      socket.send(JSON.stringify(['EVENT', message[1], invitation]));
      socket.send(JSON.stringify(['EOSE', message[1]]));
    } else if (message[0] === 'EVENT') {
      const event = message[1];
      if (!verifyEvent(event)) throw new Error('Invalid native signature');
      const rumor = nip59.unwrapEvent(event, caller);
      const signal = JSON.parse(rumor.content);
      if (rumor.pubkey !== getPublicKey(callee) || rumor.kind !== 21117 || signal.callId !== id)
        throw new Error('Native reply identity or call mismatch');
      received.add(signal.action === 'end' ? signal.reason : signal.action);
      socket.send(JSON.stringify(['OK', event.id, true, '']));
    }
  }),
);
await new Promise((resolve) => server.listen(7018, '127.0.0.1', resolve));
try {
  const adb = process.env.ANDROID_HOME ? `${process.env.ANDROID_HOME}/platform-tools/adb` : 'adb';
  const child = spawn(adb, [
    '-s',
    serial,
    'shell',
    'am',
    'instrument',
    '-w',
    '-e',
    'realRelay',
    'true',
    '-e',
    'class',
    'com.nostr.anagram.CallNotificationsDeviceTest#backgroundListenerReceivesAndDeclinesThroughRelay',
    'com.nostr.anagram.test/androidx.test.runner.AndroidJUnitRunner',
  ]);
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.pipe(process.stderr);
  const timer = setTimeout(() => child.kill(), 45000);
  const code = await new Promise((resolve) => child.once('close', resolve));
  clearTimeout(timer);
  if (
    code !== 0 ||
    !output.includes('OK (1 test)') ||
    !received.has('ringing') ||
    !received.has('declined')
  )
    throw new Error('Background call relay test failed');
} finally {
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  server.close();
}
