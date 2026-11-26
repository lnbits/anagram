import NostrClient, { NostrPrivateKeySigner } from '#src/lib/nostr/client.ts';

export interface PrivateMessageRelayLease {
  client: NostrClient;
  release: () => void;
}

// NIP-42 authentication belongs to a socket. Group reads authenticate as the
// epoch recipient without replacing the account signer used for messages/invites.
export function createPrivateMessageRelayClients(deps: {
  client: NostrClient;
  owner: () => string | null;
  epochPrivateKey: (recipient: string) => Promise<string | null>;
  configureClient: (client: NostrClient) => () => void;
}) {
  type Entry = { users: number; client: Promise<NostrClient>; resolved?: NostrClient };
  const entries = new Map<string, Entry>();
  let generation = 0;
  const cleanups = new WeakMap<NostrClient, () => void>();

  function close(client: NostrClient): void {
    cleanups.get(client)?.();
    cleanups.delete(client);
    client.signer = undefined;
    client.relayConnectionFilter = () => false;
    // A connection that was already opening can finish after logout/release.
    client.pool.on('relay:connect', (relay) => relay.disconnect());
    for (const relay of client.pool.relays.values()) {
      client.cancelRelayTraffic(relay.url);
      // nostr-tools defers CLOSE writes to a microtask. Let subscription
      // cleanup finish before closing the socket; new work is already blocked.
      queueMicrotask(() => relay.disconnect());
    }
  }

  function dispose(entry: Entry): void {
    if (entry.resolved) close(entry.resolved);
    else void entry.client.then(close, () => {});
  }

  function reset(): void {
    generation++;
    for (const entry of entries.values()) dispose(entry);
    entries.clear();
  }

  async function acquire(recipient: string): Promise<PrivateMessageRelayLease> {
    const owner = deps.owner();
    if (!owner) throw new Error('Private message session unavailable');
    if (recipient === owner) return { client: deps.client, release: () => {} };
    const token = generation;
    const key = `${owner}:${recipient}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        users: 0,
        client: (async () => {
          const privateKey = await deps.epochPrivateKey(recipient);
          if (generation !== token || deps.owner() !== owner)
            throw new Error('Private message session changed');
          if (!privateKey) throw new Error('Group epoch key unavailable');
          const signer = new NostrPrivateKeySigner(privateKey);
          if (signer.pubkey !== recipient) throw new Error('Group epoch key mismatch');
          const client = new NostrClient({
            signer,
            relayTrafficPolicy: (url) => deps.client.relayTrafficPolicy(url),
          });
          client.relayConnectionFilter = (url) =>
            generation === token &&
            deps.owner() === owner &&
            deps.client.relayConnectionFilter?.(url) !== false;
          cleanups.set(client, deps.configureClient(client));
          entry!.resolved = client;
          return client;
        })(),
      };
      entries.set(key, entry);
    }
    const active = entry;
    active.users++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (--active.users === 0 && entries.get(key) === active) {
        entries.delete(key);
        dispose(active);
      }
    };
    try {
      const client = await active.client;
      if (generation !== token || deps.owner() !== owner)
        throw new Error('Private message session changed');
      return { client, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  return { acquire, reset };
}
