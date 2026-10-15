// A small client for Ollama's documented HTTP API (https://docs.ollama.com/api).
// It only sends chat text to one configured server: no tools, no streaming, no redirects,
// and every request is bounded in time and size. Copied from the Ollama Bridge example;
// the only change is the optional `format` (a JSON schema for structured output).
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const MAX_RESPONSE_BYTES = 1024 * 1024;

// `code` lets callers choose a user-facing message without parsing error text:
// invalid_endpoint, unavailable, timeout, aborted, model_not_found, http,
// too_large, invalid_response.
export class OllamaError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');
export function isLoopback(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return loopback.check(mapped[1], 'ipv4');
  if (isIP(address) === 4) return loopback.check(address, 'ipv4');
  if (isIP(address) === 6) return loopback.check(address, 'ipv6');
  return false;
}

// Validates OLLAMA_URL. Only loopback servers are accepted unless allowRemote is set.
export function parseEndpoint(value, { allowRemote = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new OllamaError(
      'invalid_endpoint',
      'OLLAMA_URL must be a valid http:// or https:// URL.',
    );
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new OllamaError('invalid_endpoint', 'OLLAMA_URL must use http:// or https://.');
  if (url.username || url.password)
    throw new OllamaError(
      'invalid_endpoint',
      'OLLAMA_URL must not contain a username or password.',
    );
  if (url.search || url.hash)
    throw new OllamaError('invalid_endpoint', 'OLLAMA_URL must not contain a query or fragment.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const local = isIP(host) ? isLoopback(host) : host === 'localhost';
  if (!local && !allowRemote)
    throw new OllamaError(
      'invalid_endpoint',
      'OLLAMA_URL must point to this computer (127.0.0.1, [::1] or localhost). ' +
        'Set OLLAMA_ALLOW_REMOTE=true to use another host.',
    );
  return { base: url.href.replace(/\/+$/, ''), local };
}

// DNS rebinding protection: for a loopback endpoint given by name (localhost), check the
// address actually being connected to, on every connection, not just once at startup.
export function loopbackLookup(lookup = dnsLookup) {
  return (hostname, options, callback) => {
    lookup(hostname, options, (error, address, family) => {
      if (error) return callback(error);
      const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address];
      if (addresses.some((a) => !isLoopback(a)))
        return callback(
          new OllamaError('unavailable', 'Ollama host resolved to a non-loopback address.'),
        );
      callback(null, address, family);
    });
  };
}

// Removes reasoning blocks some models (e.g. deepseek-r1, qwen3) include in their answer.
export function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim();
}

export class OllamaClient {
  constructor({
    url = DEFAULT_OLLAMA_URL,
    model,
    timeoutMs = 120000,
    maxTokens = 1024,
    allowRemote = false,
    lookup = dnsLookup,
  }) {
    if (typeof model !== 'string' || !model.trim())
      throw new OllamaError('invalid_endpoint', 'An Ollama model name is required.');
    const endpoint = parseEndpoint(url, { allowRemote });
    this.base = endpoint.base;
    this.local = endpoint.local;
    this.model = model.trim();
    this.timeoutMs = timeoutMs;
    this.maxTokens = maxTokens;
    // Remote mode trusts the configured host's DNS; the operator opted into that host.
    this.lookup = endpoint.local ? loopbackLookup(lookup) : lookup;
  }

  // messages: [{ role: 'system' | 'user' | 'assistant', content: string }]
  // format: optional JSON schema; Ollama then constrains the answer to matching JSON.
  // Returns { text, truncated }. Throws OllamaError.
  async chat(messages, { signal, format } = {}) {
    const body = await this.request(
      'POST',
      '/api/chat',
      {
        model: this.model,
        messages,
        stream: false,
        ...(format && { format }),
        // Bounds generation time and length. The bot also truncates the text it sends.
        options: { num_predict: this.maxTokens },
      },
      signal,
    );
    const message = body?.message;
    if (message?.role !== 'assistant' || typeof message.content !== 'string')
      throw new OllamaError('invalid_response', 'Ollama returned an unexpected chat response.');
    const text = stripThinking(message.content);
    if (!text) throw new OllamaError('invalid_response', 'Ollama returned an empty answer.');
    return { text, truncated: body.done_reason === 'length' };
  }

  // Names of locally installed models, e.g. ['llama3.2:latest'].
  async models({ signal } = {}) {
    const body = await this.request('GET', '/api/tags', undefined, signal);
    if (!Array.isArray(body?.models))
      throw new OllamaError('invalid_response', 'Ollama returned an unexpected model list.');
    return body.models.map((m) => m?.name).filter((name) => typeof name === 'string');
  }

  async hasModel(options) {
    const names = await this.models(options);
    return names.includes(this.model) || names.includes(`${this.model}:latest`);
  }

  async request(method, path, payload, signal) {
    const data = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) controller.abort();
    // Classify an aborted request as a shutdown/cancel or as our own timeout.
    const failure = (error) => {
      if (error instanceof OllamaError) return error;
      if (signal?.aborted) return new OllamaError('aborted', 'Ollama request cancelled.');
      if (controller.signal.aborted) return new OllamaError('timeout', 'Ollama request timed out.');
      return new OllamaError('unavailable', 'Ollama server is unreachable.');
    };
    try {
      return await new Promise((resolve, reject) => {
        const url = new URL(this.base + path);
        const transport = url.protocol === 'https:' ? https : http;
        const request = transport.request(
          url,
          {
            method,
            agent: false,
            lookup: this.lookup,
            signal: controller.signal,
            headers: {
              accept: 'application/json',
              ...(data && { 'content-type': 'application/json', 'content-length': data.length }),
            },
          },
          (response) => {
            const status = response.statusCode ?? 0;
            const fail = (error) => {
              response.destroy();
              reject(error);
            };
            // Node's http client never follows redirects; refuse them explicitly.
            if (status >= 300 && status < 400)
              return fail(new OllamaError('http', 'Ollama redirect rejected.'));
            if (Number(response.headers['content-length']) > MAX_RESPONSE_BYTES)
              return fail(new OllamaError('too_large', 'Ollama response is too large.'));
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => {
              size += chunk.length;
              if (size > MAX_RESPONSE_BYTES)
                return fail(new OllamaError('too_large', 'Ollama response is too large.'));
              chunks.push(chunk);
            });
            response.on('error', (error) => reject(failure(error)));
            response.on('end', () => {
              let body;
              try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              } catch {
                body = undefined;
              }
              if (status === 404 && /not found/i.test(String(body?.error)))
                return reject(new OllamaError('model_not_found', 'Ollama model is not installed.'));
              if (status !== 200)
                return reject(new OllamaError('http', `Ollama returned HTTP ${status}.`));
              if (body === undefined || body === null || typeof body !== 'object')
                return reject(new OllamaError('invalid_response', 'Ollama returned invalid JSON.'));
              resolve(body);
            });
          },
        );
        request.on('error', (error) => reject(failure(error)));
        request.end(data);
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
}
