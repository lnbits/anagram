const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

// Local tests use the actual Iroh relay behind TLS, matching production browser networking.
async function startIrohTestProxy() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anagram-iroh-test-'));
  const key = path.join(directory, 'key.pem');
  const cert = path.join(directory, 'cert.pem');
  try {
    execFileSync(process.env.OPENSSL || 'openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout', key, '-out', cert], { stdio: 'ignore' });
    const sockets = new Set();
    const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (request, response) => {
      response.setHeader('Access-Control-Allow-Origin', '*');
      if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
      const upstream = http.request({ host: '127.0.0.1', port: 7003, method: request.method,
        path: request.url, headers: request.headers }, (reply) => {
        response.writeHead(reply.statusCode || 502, { ...reply.headers, 'access-control-allow-origin': '*' });
        reply.pipe(response);
      });
      upstream.on('error', () => { response.writeHead(502); response.end(); });
      request.pipe(upstream);
    });
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('upgrade', (request, socket, head) => {
      const upstream = net.connect(7003, '127.0.0.1', () => {
        const headers = Object.entries(request.headers).map(([name, value]) => `${name}: ${value}`).join('\r\n');
        upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy());
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(7004, '127.0.0.1', resolve); });
    return async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(directory, { recursive: true, force: true });
    };
  } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
}

module.exports = { startIrohTestProxy };
