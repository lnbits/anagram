// Mock GitHub REST API on 127.0.0.1. Keeps issues in memory; tests can override creation.
import http from 'node:http';

export async function githubServer({ login = 'issue-bot' } = {}) {
  const fixture = { requests: [], issues: [], login, onCreate: null, repos: {} };
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  fixture.create = (repo, { title, body }) => {
    const number = fixture.issues.length + 1;
    const issue = {
      number,
      title,
      body,
      repo,
      state: 'open',
      user: { login: fixture.login },
      html_url: `https://github.com/${repo}/issues/${number}`,
      created_at: new Date().toISOString(),
    };
    fixture.issues.push(issue);
    return issue;
  };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://localhost');
    const request = {
      method: req.method,
      url: req.url,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: raw ? JSON.parse(raw) : undefined,
    };
    fixture.requests.push(request);
    if (req.headers.authorization !== `Bearer ${fixture.token}`)
      return send(res, 401, { message: 'Bad credentials' });
    if (req.method === 'GET' && url.pathname === '/user')
      return send(res, 200, { login: fixture.login });
    if (req.method === 'GET' && url.pathname === '/search/issues') {
      const repo = /repo:(\S+)/.exec(request.query.q)?.[1];
      const words = request.query.q
        .replace(/repo:\S+|is:issue|in:title|OR/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
      const items = fixture.issues.filter(
        (i) => i.repo === repo && words.some((w) => i.title.toLowerCase().includes(w)),
      );
      return send(res, 200, { total_count: items.length, items });
    }
    const match = /^\/repos\/([^/]+)\/([^/]+)(\/issues)?$/.exec(url.pathname);
    if (!match) return send(res, 404, { message: 'Not Found' });
    const repo = `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`;
    if (!match[3] && req.method === 'GET')
      return send(res, 200, {
        full_name: repo,
        has_issues: true,
        archived: false,
        ...fixture.repos[repo],
      });
    if (match[3] && req.method === 'GET') {
      const list = fixture.issues
        .filter(
          (i) =>
            i.repo === repo && (!request.query.creator || i.user.login === request.query.creator),
        )
        .reverse();
      return send(res, 200, list);
    }
    if (match[3] && req.method === 'POST') {
      if (fixture.onCreate)
        return fixture.onCreate(request, res, () => fixture.create(repo, request.body), send);
      return send(res, 201, fixture.create(repo, request.body));
    }
    return send(res, 404, { message: 'Not Found' });
  });
  server.on('connection', (socket) => socket.on('error', () => {}));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixture.port = server.address().port;
  fixture.url = `http://127.0.0.1:${fixture.port}`;
  fixture.token = 'github_pat_TEST_ONLY_0123456789abcdefghijklmnop';
  fixture.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    });
  return fixture;
}
