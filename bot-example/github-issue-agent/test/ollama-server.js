// Mock Ollama server on 127.0.0.1. Tests choose each response; no real model is needed.
import http from 'node:http';

export async function ollamaServer(handler = (request, res) => chat(res, 'Mock answer.')) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const request = { method: req.method, url: req.url, headers: req.headers, body };
    requests.push(request);
    await fixture.handler(request, res);
  });
  const fixture = { requests, handler, server };
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixture.port = server.address().port;
  fixture.url = `http://127.0.0.1:${fixture.port}`;
  fixture.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  return fixture;
}

export function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// The non-streaming /api/chat response shape documented by Ollama.
export function chat(res, content, extra = {}) {
  json(res, 200, {
    model: 'test-model',
    created_at: new Date().toISOString(),
    message: { role: 'assistant', content },
    done: true,
    done_reason: 'stop',
    ...extra,
  });
}

// A port nothing listens on, for connection-refused tests.
export async function closedPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
