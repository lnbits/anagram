import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLoopback,
  MAX_RESPONSE_BYTES,
  OllamaClient,
  OllamaError,
  parseEndpoint,
  stripThinking,
} from '../ollama.js';
import { chat, closedPort, json, ollamaServer } from './ollama-server.js';

const messages = [
  { role: 'system', content: 'Be brief.' },
  { role: 'user', content: 'Explain Bitcoin mining in simple terms.' },
];
async function server(t, handler) {
  const fixture = await ollamaServer(handler);
  t.after(fixture.close);
  return fixture;
}
async function failsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof OllamaError, `expected OllamaError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('chat sends the documented /api/chat request with no tools and a token limit', async (t) => {
  const ollama = await server(t);
  const client = new OllamaClient({ url: ollama.url, model: 'llama3.2', maxTokens: 321 });
  const answer = await client.chat(messages);
  assert.deepEqual(answer, { text: 'Mock answer.', truncated: false });
  assert.equal(ollama.requests.length, 1);
  const [request] = ollama.requests;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/api/chat');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.deepEqual(request.body, {
    model: 'llama3.2',
    messages,
    stream: false,
    options: { num_predict: 321 },
  });
});

test('successful answers drop reasoning blocks and report length cut-offs', async (t) => {
  const ollama = await server(t, (request, res) =>
    chat(res, '<think>private reasoning</think>\nMining secures the network.', {
      done_reason: 'length',
    }),
  );
  const client = new OllamaClient({ url: ollama.url, model: 'm' });
  assert.deepEqual(await client.chat(messages), {
    text: 'Mining secures the network.',
    truncated: true,
  });
  assert.equal(stripThinking('<think>never closed'), '');
});

test('connection failures, timeouts and cancellation are reported, not thrown raw', async (t) => {
  const port = await closedPort();
  await failsWith(
    new OllamaClient({ url: `http://127.0.0.1:${port}`, model: 'm' }).chat(messages),
    'unavailable',
  );
  const silent = await server(t, () => {}); // Accepts the request and never answers.
  const started = Date.now();
  await failsWith(
    new OllamaClient({ url: silent.url, model: 'm', timeoutMs: 200 }).chat(messages),
    'timeout',
  );
  assert.ok(Date.now() - started < 3000);
  // Headers arrive, then the body stalls: the same overall deadline applies.
  const stalled = await server(t, (request, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"message":');
  });
  await failsWith(
    new OllamaClient({ url: stalled.url, model: 'm', timeoutMs: 200 }).chat(messages),
    'timeout',
  );
  const controller = new AbortController();
  const pending = new OllamaClient({ url: silent.url, model: 'm' }).chat(messages, {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await failsWith(pending, 'aborted');
});

test('missing models, HTTP errors and malformed responses fail gracefully', async (t) => {
  const responses = [
    (res) => json(res, 404, { error: 'model "nope" not found, try pulling it first' }),
    (res) => json(res, 500, { error: 'out of memory' }),
    (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{not json');
    },
    (res) => json(res, 200, { done: true }),
    (res) => json(res, 200, { message: { role: 'user', content: 'wrong role' } }),
    (res) => json(res, 200, { message: { role: 'assistant', content: 42 } }),
    (res) => chat(res, '   '),
    (res) => json(res, 200, null),
  ];
  const expected = [
    'model_not_found',
    'http',
    'invalid_response',
    'invalid_response',
    'invalid_response',
    'invalid_response',
    'invalid_response',
    'invalid_response',
  ];
  let index = 0;
  const ollama = await server(t, (request, res) => responses[index++](res));
  const client = new OllamaClient({ url: ollama.url, model: 'nope' });
  for (const code of expected) await failsWith(client.chat(messages), code);
});

test('oversized responses are cut off, with or without a Content-Length header', async (t) => {
  const huge = 'x'.repeat(MAX_RESPONSE_BYTES + 10);
  let declared = true;
  const ollama = await server(t, (request, res) => {
    if (declared) res.writeHead(200, { 'content-length': String(huge.length) });
    else res.writeHead(200);
    // Streamed in chunks so the limit must be enforced while reading.
    for (let i = 0; i < huge.length; i += 65536) res.write(huge.slice(i, i + 65536));
    res.end();
  });
  const client = new OllamaClient({ url: ollama.url, model: 'm' });
  await failsWith(client.chat(messages), 'too_large');
  declared = false;
  await failsWith(client.chat(messages), 'too_large');
});

test('redirects are rejected and never followed', async (t) => {
  const target = await server(t);
  const ollama = await server(t, (request, res) => {
    res.writeHead(302, { location: `${target.url}/api/chat` });
    res.end();
  });
  await failsWith(new OllamaClient({ url: ollama.url, model: 'm' }).chat(messages), 'http');
  assert.equal(target.requests.length, 0);
});

test('endpoint validation allows loopback by default and remote hosts only by opt-in', () => {
  assert.deepEqual(parseEndpoint('http://127.0.0.1:11434'), {
    base: 'http://127.0.0.1:11434',
    local: true,
  });
  assert.equal(parseEndpoint('http://localhost:11434/').base, 'http://localhost:11434');
  assert.equal(parseEndpoint('http://[::1]:11434').local, true);
  assert.equal(parseEndpoint('http://127.8.9.10:11434').local, true);
  for (const bad of [
    'http://192.168.1.20:11434',
    'http://10.0.0.5:11434',
    'http://169.254.169.254/',
    'http://0.0.0.0:11434',
    'https://ollama.example.com',
    'http://localhost.example.com:11434',
    'http://[::ffff:8.8.8.8]:11434',
    'file:///etc/passwd',
    'ftp://127.0.0.1/',
    'http://user:pass@127.0.0.1:11434',
    'http://127.0.0.1:11434/?x=1',
    'http://127.0.0.1:11434/#x',
    'not a url',
  ])
    assert.throws(() => parseEndpoint(bad), OllamaError, bad);
  assert.equal(parseEndpoint('https://ollama.example.com', { allowRemote: true }).local, false);
  assert.throws(() => parseEndpoint('file:///x', { allowRemote: true }), OllamaError);
  assert.throws(() => new OllamaClient({ url: 'http://10.0.0.5:11434', model: 'm' }));
  assert.throws(() => new OllamaClient({ url: 'http://127.0.0.1:11434', model: ' ' }));
  for (const address of ['127.0.0.1', '127.255.0.1', '::1', '::ffff:127.0.0.1'])
    assert.equal(isLoopback(address), true, address);
  for (const address of ['10.0.0.1', '0.0.0.0', '::', '::ffff:10.0.0.1', 'localhost'])
    assert.equal(isLoopback(address), false, address);
});

test('a loopback host name cannot be rebound to another address', async (t) => {
  const ollama = await server(t);
  const fakeDNS = (address) => (hostname, options, callback) =>
    options?.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4);
  const rebound = new OllamaClient({
    url: `http://localhost:${ollama.port}`,
    model: 'm',
    lookup: fakeDNS('93.184.216.34'),
  });
  await failsWith(rebound.chat(messages), 'unavailable');
  assert.equal(ollama.requests.length, 0);
  const honest = new OllamaClient({
    url: `http://localhost:${ollama.port}`,
    model: 'm',
    lookup: fakeDNS('127.0.0.1'),
  });
  assert.equal((await honest.chat(messages)).text, 'Mock answer.');
});

test('model check lists installed models and accepts the implicit :latest tag', async (t) => {
  const ollama = await server(t, (request, res) =>
    json(res, 200, { models: [{ name: 'llama3.2:latest' }, { name: 'qwen3:8b' }] }),
  );
  assert.equal(await new OllamaClient({ url: ollama.url, model: 'llama3.2' }).hasModel(), true);
  assert.equal(await new OllamaClient({ url: ollama.url, model: 'qwen3:8b' }).hasModel(), true);
  assert.equal(await new OllamaClient({ url: ollama.url, model: 'mistral' }).hasModel(), false);
  assert.equal(ollama.requests[0].method, 'GET');
  assert.equal(ollama.requests[0].url, '/api/tags');
});
