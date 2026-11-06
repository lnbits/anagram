// Test-only guard: no automated test may reach the network beyond this computer.
//
// Every TCP connection (WebSocket relays, fetch, TLS) goes through net.Socket#connect,
// and every host name through dns.lookup. Both refuse anything but loopback, so a default
// relay list, a relay hint or a mistyped URL fails the test instead of reaching a public
// relay. Imported first by test/helpers.js and passed to spawned bots with --import.
import dns from 'node:dns';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
export const loopback = (host) =>
  host === undefined ||
  host === null ||
  host === '' ||
  LOOPBACK_NAMES.has(host) ||
  /^127\.\d+\.\d+\.\d+$/.test(host);

function blocked(target) {
  const message = `[no-network] blocked connection to ${target}`;
  process.stderr.write(`${message}\n`);
  return Object.assign(new Error(message), { code: 'ENETUNREACH' });
}

if (!globalThis.__anagramNoNetwork) {
  globalThis.__anagramNoNetwork = true;

  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    // Node calls this with (options[, cb]), (port[, host][, cb]), (path[, cb]) or with an
    // internal normalized array whose first item is the options object.
    let options = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (typeof options !== 'object' || options === null)
      options =
        typeof options === 'string' && Number.isNaN(Number(options))
          ? { path: options }
          : { port: options, host: typeof args[1] === 'string' ? args[1] : undefined };
    if (!options.path && !loopback(options.host)) {
      const error = blocked(`${options.host}:${options.port}`);
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return connect.apply(this, args);
  };

  const refuse = (host) => blocked(`${host} (DNS lookup)`);
  const lookup = dns.lookup;
  dns.lookup = function (host, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    if (!loopback(host)) return process.nextTick(() => done(refuse(host)));
    return lookup.call(this, host, options, callback);
  };
  const lookupAsync = dns.promises.lookup;
  dns.promises.lookup = function (host, ...rest) {
    if (!loopback(host)) return Promise.reject(refuse(host));
    return lookupAsync.call(this, host, ...rest);
  };
  // Modules that imported { lookup } from 'node:dns' see the guarded function too.
  syncBuiltinESMExports();
}
