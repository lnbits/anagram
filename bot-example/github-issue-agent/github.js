// A minimal client for the GitHub REST API (https://docs.github.com/rest).
// Only five fixed endpoints, one configured host, no redirects, bounded responses.
// Nothing from chat or model output chooses the host or path: repository names are
// validated configuration values, and search words travel only in the query string.
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { publicIP } from './runtime.js';
import { validRepo } from './intent.js';

export const DEFAULT_API_URL = 'https://api.github.com';
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const API_VERSION = '2022-11-28';

// Codes: invalid_config, unauthorized, forbidden, not_found, validation, rate_limited,
// redirect, http, timeout, unavailable, too_large, invalid_response.
// status: HTTP status if a response arrived. sent: whether the whole request left this
// computer. A failure with sent === false proves GitHub never received the request.
export class GitHubError extends Error {
  constructor(code, message, { status = 0, sent = true } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.sent = sent;
  }
}

// Validates GITHUB_API_URL. HTTPS on a public address unless allowLocal (mock servers).
export function parseApiBase(value, { allowLocal = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new GitHubError('invalid_config', 'GITHUB_API_URL must be a valid URL.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.username || url.password || url.search || url.hash)
    throw new GitHubError(
      'invalid_config',
      'GITHUB_API_URL must not contain credentials, a query or a fragment.',
    );
  if (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:'))
    throw new GitHubError('invalid_config', 'GITHUB_API_URL must use https://.');
  if (
    !allowLocal &&
    ((isIP(host) && !publicIP(host)) || host === 'localhost' || host.endsWith('.local'))
  )
    throw new GitHubError(
      'invalid_config',
      'GITHUB_API_URL points at a local or private address. GITHUB_ALLOW_LOCAL=true is for test servers only.',
    );
  return url.href.replace(/\/+$/, '');
}

export function repoPath(repo) {
  if (!validRepo(repo)) throw new GitHubError('invalid_config', 'Invalid repository name.');
  const [owner, name] = repo.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

const STOP_WORDS = new Set(
  'the and for with when from that this not does doesnt dont cant cannot into after before while are was were has have had but its about'.split(
    ' ',
  ),
);
// Up to five distinctive lowercase words of a title, for similarity search.
export function keywords(title) {
  const words = String(title)
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  return [...new Set((words ?? []).filter((w) => w.length >= 3 && !STOP_WORDS.has(w)))].slice(0, 5);
}

export class GitHubClient {
  // The token lives in a private field: it is not enumerable, not in JSON, not in logs.
  #token;
  constructor({
    token,
    url = DEFAULT_API_URL,
    allowLocal = false,
    timeoutMs = 20000,
    lookup = dnsLookup,
  }) {
    if (typeof token !== 'string' || !token)
      throw new GitHubError('invalid_config', 'A GitHub token is required.');
    this.#token = token;
    this.base = parseApiBase(url, { allowLocal });
    this.timeoutMs = timeoutMs;
    // DNS rebinding protection: every connection re-checks the resolved address.
    this.lookup = allowLocal
      ? lookup
      : (host, options, callback) =>
          lookup(host, options, (error, address, family) => {
            const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address];
            if (!error && addresses.some((a) => !publicIP(a)))
              return callback(new Error('Non-public GitHub API address rejected.'));
            callback(error, address, family);
          });
  }

  // The account the token belongs to. Used to find the bot's own issues when reconciling.
  async user() {
    const body = await this.request('GET', '/user');
    if (typeof body?.login !== 'string')
      throw new GitHubError('invalid_response', 'Unexpected /user response.');
    return { login: body.login };
  }

  async repository(repo) {
    const body = await this.request('GET', repoPath(repo));
    if (typeof body?.full_name !== 'string')
      throw new GitHubError('invalid_response', 'Unexpected repository response.');
    return {
      fullName: body.full_name,
      hasIssues: body.has_issues !== false,
      archived: body.archived === true,
    };
  }

  // Issues (open and closed) whose titles share keywords with the given title.
  async searchIssues(repo, title, { limit = 5 } = {}) {
    if (!validRepo(repo)) throw new GitHubError('invalid_config', 'Invalid repository name.');
    const words = keywords(title);
    if (!words.length) return [];
    const q = `repo:${repo} is:issue in:title ${words.join(' OR ')}`;
    const body = await this.request('GET', '/search/issues', { q, per_page: String(limit) });
    if (!Array.isArray(body?.items))
      throw new GitHubError('invalid_response', 'Unexpected search response.');
    return body.items.flatMap((item) =>
      Number.isSafeInteger(item?.number) &&
      typeof item.title === 'string' &&
      typeof item.html_url === 'string'
        ? [{ number: item.number, title: item.title, state: item.state, url: item.html_url }]
        : [],
    );
  }

  // Exactly one POST. Callers must never retry it automatically (see bot.js, publish).
  async createIssue(repo, { title, body }) {
    const result = await this.request('POST', `${repoPath(repo)}/issues`, undefined, {
      title,
      body,
    });
    if (!Number.isSafeInteger(result?.number) || typeof result.html_url !== 'string')
      throw new GitHubError('invalid_response', 'Unexpected issue creation response.');
    return { number: result.number, url: result.html_url };
  }

  // Issues created by `creator` and updated since `since`, newest first, for finding the
  // idempotency marker. complete is false when the page may not contain all matches.
  async recentIssues(repo, { creator, since }) {
    const perPage = 100;
    const body = await this.request('GET', `${repoPath(repo)}/issues`, {
      state: 'all',
      creator,
      since: new Date(since * 1000).toISOString(),
      sort: 'created',
      direction: 'desc',
      per_page: String(perPage),
    });
    if (!Array.isArray(body))
      throw new GitHubError('invalid_response', 'Unexpected issue list response.');
    const issues = body.flatMap((item) =>
      Number.isSafeInteger(item?.number) && typeof item.html_url === 'string' && !item.pull_request
        ? [{ number: item.number, url: item.html_url, body: String(item.body ?? '') }]
        : [],
    );
    return { issues, complete: body.length < perPage };
  }

  async request(method, path, query, payload) {
    const url = new URL(this.base + path);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const data = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let sent = false;
    const failure = (error) => {
      if (error instanceof GitHubError) return error;
      if (controller.signal.aborted)
        return new GitHubError('timeout', 'GitHub request timed out.', { sent });
      return new GitHubError('unavailable', 'GitHub is unreachable.', { sent });
    };
    try {
      return await new Promise((resolve, reject) => {
        const transport = url.protocol === 'https:' ? https : http;
        const request = transport.request(
          url,
          {
            method,
            agent: false,
            lookup: this.lookup,
            signal: controller.signal,
            headers: {
              accept: 'application/vnd.github+json',
              authorization: `Bearer ${this.#token}`,
              'user-agent': 'anagram-github-issue-agent',
              'x-github-api-version': API_VERSION,
              ...(data && { 'content-type': 'application/json', 'content-length': data.length }),
            },
          },
          (response) => {
            sent = true;
            const status = response.statusCode ?? 0;
            const fail = (error) => {
              response.destroy();
              reject(error);
            };
            if (status >= 300 && status < 400)
              return fail(new GitHubError('redirect', 'GitHub redirect rejected.', { status }));
            if (Number(response.headers['content-length']) > MAX_RESPONSE_BYTES)
              return fail(new GitHubError('too_large', 'GitHub response too large.', { status }));
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => {
              size += chunk.length;
              if (size > MAX_RESPONSE_BYTES)
                return fail(new GitHubError('too_large', 'GitHub response too large.', { status }));
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
              const remaining = response.headers['x-ratelimit-remaining'];
              if (status === 429 || (status === 403 && remaining === '0'))
                return reject(new GitHubError('rate_limited', 'GitHub rate limit.', { status }));
              const codes = {
                401: 'unauthorized',
                403: 'forbidden',
                404: 'not_found',
                410: 'not_found',
                422: 'validation',
              };
              if (status < 200 || status >= 300)
                return reject(
                  new GitHubError(codes[status] ?? 'http', `GitHub returned HTTP ${status}.`, {
                    status,
                  }),
                );
              if (body === undefined || body === null || typeof body !== 'object')
                return reject(
                  new GitHubError('invalid_response', 'GitHub returned invalid JSON.', { status }),
                );
              resolve(body);
            });
          },
        );
        // 'finish': the complete request was handed to the operating system. Before this,
        // GitHub cannot have received a complete request, so nothing can have been created.
        request.on('finish', () => {
          sent = true;
        });
        request.on('error', (error) => reject(failure(error)));
        request.end(data);
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

// Whether a failed issue creation certainly did NOT create an issue.
// 3xx/4xx: GitHub refused the request. Not fully sent: GitHub never saw it.
// Everything else (timeouts after sending, 5xx, unreadable 2xx) is uncertain.
export function definitelyNotCreated(error) {
  if (!(error instanceof GitHubError)) return false;
  if (!error.sent) return true;
  return error.status >= 300 && error.status < 500;
}
