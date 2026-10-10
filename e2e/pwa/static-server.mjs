// Test the actual deployable static output, without Vite's SSR preview server.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve('build');
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    // Match serve's clean-URL redirect used by the VPS deployment.
    if (pathname === '/index.html' || /^\/join\/(chat|call)\.html$/.test(pathname)) {
      response
        .writeHead(301, { Location: pathname.slice(0, -5), 'Cache-Control': 'no-cache' })
        .end();
      return;
    }
    const sharePath = /^\/join\/(chat|call)\/?$/.exec(pathname);
    let file = resolve(root, '.' + (sharePath ? `/join/${sharePath[1]}.html` : pathname));
    if (file !== root && !file.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }
    let content;
    try {
      content = await readFile(file);
    } catch {
      file = resolve(root, 'index.html');
      content = await readFile(file);
    }
    response.writeHead(200, {
      'Content-Type': types[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch {
    response.writeHead(500).end();
  }
}).listen(5189, '127.0.0.1');
