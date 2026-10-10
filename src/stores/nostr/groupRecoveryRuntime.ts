import { groupTicketTemplate } from '#src/stores/nostr/groupMessageAuthorization.ts';
import NostrClient, {
  ClientEvent,
  NostrPrivateKeySigner,
  NostrUser,
} from '#src/lib/nostr/client.ts';
import { contactsService } from '#src/services/contactsService.ts';
import type { GroupIdentitySecretContent, RelayPublishStatusesResult } from './types.ts';
import {
  deriveGroupIdentityKey,
  deriveGroupEpochKey,
  groupEntropyFromPhrase,
  groupPhraseFromEntropy,
  GROUP_RECOVERY_TAG,
  GENESIS_REVISION,
  newGroupRevision,
  normalizeRecoveryState,
  recoveryHeads,
  safeRecoveryMembers,
  type GroupRecoveryState,
  type GroupRecoveryRecord,
} from './groupRecovery.ts';

class RecoveryUnavailableError extends Error {}

interface Dependencies {
  ndk: NostrClient;
  account: () => string | null;
  connect: (relays: string[]) => Promise<void>;
  encrypt: (secret: GroupIdentitySecretContent) => Promise<string>;
  decrypt: (ciphertext: string) => Promise<GroupIdentitySecretContent | null>;
  saveContact: (
    key: string,
    ciphertext: string,
    profile: { name?: string; about?: string },
  ) => Promise<boolean>;
  persistEpoch: (
    group: string,
    epoch: number,
    key: string,
    options?: {
      accepted?: boolean;
      fallbackName?: string;
      seedRelayUrls?: string[];
      invitationCreatedAt?: string;
      invitationProof?: string;
      invitationEventId?: string;
      allowRecoveryFork?: boolean;
    },
  ) => Promise<void>;
  publish: (
    event: ClientEvent,
    relays: string[],
    scope?: 'recipient' | 'self',
  ) => Promise<RelayPublishStatusesResult>;
  publishAccountBackup: (key: string, ciphertext: string, relays: string[]) => Promise<unknown>;
  changed: () => void;
  defaultRelays: () => string[];
}

export function createGroupRecoveryRuntime(d: Dependencies) {
  const pending = new Map<string, Promise<unknown>>();
  // Contact/profile hydration may replay an older encrypted account snapshot.
  // Keep the locally verified journal baseline separately (never cache the master).
  const installed = new Map<string, GroupRecoveryRecord>();
  // Verified journal records survive lagging replicas within this account session.
  const observed = new Map<string, Map<string, GroupRecoveryRecord>>();
  let installedAccount: string | null = null;
  function session() {
    const account = d.account();
    if (!account) throw new Error('Sign in before managing a group.');
    if (installedAccount !== account) {
      installed.clear();
      observed.clear();
      installedAccount = account;
    }
    return () => {
      if (d.account() !== account) throw new Error('The active account changed. Reopen the group.');
    };
  }
  async function exclusive<T>(group: string, action: () => Promise<T>): Promise<T> {
    const key = `${d.account()}:${group}`;
    if (pending.has(key)) throw new Error('A group update is already running. Please wait.');
    const task = (async () => {
      // Web Locks also serialize tabs. Other devices use the authenticated revision check.
      if (typeof navigator !== 'undefined' && navigator.locks) {
        return navigator.locks.request(`anagram:group:${key}`, action);
      }
      return action();
    })();
    pending.set(key, task);
    try {
      return await task;
    } finally {
      if (pending.get(key) === task) pending.delete(key);
    }
  }
  function relays(values: string[]): string[] {
    const urls = [
      ...new Set(
        values.map((value) => {
          const url = new URL(value);
          if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password)
            throw new Error('Invalid recovery relay URL.');
          return url.href;
        }),
      ),
    ];
    if (!urls.length || urls.length > 32)
      throw new Error('Choose between one and 32 group recovery relays.');
    return urls;
  }
  async function secretFor(group: string) {
    const check = session();
    const contact = await contactsService.getContactByPublicKey(group);
    const secret = contact?.meta.group_private_key_encrypted
      ? await d.decrypt(contact.meta.group_private_key_encrypted)
      : null;
    check();
    if (
      !secret?.recovery_entropy ||
      new NostrPrivateKeySigner(deriveGroupIdentityKey(secret.recovery_entropy)).pubkey !== group
    ) {
      throw new Error('Import this group’s recovery phrase to manage it.');
    }
    const record = installed.get(group);
    return record ? secretFromState(secret.recovery_entropy, record) : secret;
  }
  // Require real EOSE from responding replicas; an unavailable replica is not
  // evidence that history is empty and does not veto another completed read.
  async function page(
    group: string,
    relay: string,
    until: number | undefined,
    limit: number,
    probeId?: string,
    signal?: AbortSignal,
  ) {
    return new Promise<ClientEvent[]>((resolve, reject) => {
      if (signal?.aborted) return reject(new RecoveryUnavailableError('Recovery read cancelled.'));
      const events = new Map<string, ClientEvent>();
      const sub = d.ndk.subscribe(
        {
          kinds: [30078],
          authors: [group],
          ...(probeId ? { ids: [probeId] } : { '#t': [GROUP_RECOVERY_TAG] }),
          limit,
          ...(until === undefined ? {} : { until }),
        },
        { relayUrls: [relay], closeOnEose: true },
        undefined,
        false,
      );
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        sub.stop();
        if (error) reject(error);
        else resolve([...events.values()]);
      };
      const abort = () => finish(new RecoveryUnavailableError('Recovery read cancelled.'));
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              'A group recovery relay did not finish responding. Retry when it is available.',
            ),
          ),
        12000,
      );
      sub.on('event', (event: ClientEvent) => {
        if (
          event.pubkey === group &&
          event.kind === 30078 &&
          event.verifySignature() &&
          (probeId
            ? event.id === probeId
            : event.tags.some((t) => t[0] === 't' && t[1] === GROUP_RECOVERY_TAG))
        )
          events.set(event.id, event);
      });
      sub.on('eose', () => finish());
      sub.on('closed', () =>
        finish(
          new Error('A group recovery relay is unavailable. No membership changes were made.'),
        ),
      );
      sub.start();
    });
  }
  async function fetchRecords(
    entropy: string,
    urls: string[],
    completed?: Set<string>,
    allowEmpty = false,
  ) {
    const check = session();
    const signer = new NostrPrivateKeySigner(deriveGroupIdentityKey(entropy), d.ndk);
    await d.connect(relays(urls));
    check();
    const events = new Map<string, ClientEvent>();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ready!: () => void;
    const available = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let finished = 0;
    const reads = relays(urls).map(async (relay) => {
      let until: number | undefined;
      let limit = 128;
      const seen = new Set<string>();
      for (;;) {
        check();
        let batch: ClientEvent[];
        for (let attempt = 0; ; attempt++) {
          try {
            batch = await page(signer.pubkey, relay, until, limit, undefined, controller.signal);
            break;
          } catch (error) {
            if (
              controller.signal.aborted ||
              attempt >= 2 ||
              !(error instanceof Error) ||
              !error.message.includes('relay is unavailable')
            )
              throw error;
            // Keep the existing reconnect allowance, without holding up a healthy replica.
            await new Promise((resolve) => setTimeout(resolve, attempt ? 1000 : 250));
            check();
            if (controller.signal.aborted) throw error;
            await d.connect([relay]);
          }
        }
        check();
        let fresh = 0;
        for (const event of batch) {
          if (!seen.has(event.id)) fresh++;
          seen.add(event.id);
          events.set(event.id, event);
        }
        if (batch.length < limit) break;
        const oldest = Math.min(...batch.map((e) => e.created_at));
        if (oldest === until || fresh === 0) {
          if (limit >= 8192)
            throw new Error(
              'Too many group updates at the same timestamp. Recovery history is incomplete.',
            );
          limit *= 2;
        } else {
          until = oldest;
          limit = 128;
        }
      }
      completed?.add(relay);
      finished++;
      // Give other healthy replicas a short chance to contribute known conflicts.
      // Empty replies do not outrun a replica that actually holds this group.
      if ((seen.size || allowEmpty) && timer === undefined) timer = setTimeout(ready, 300);
    });
    await Promise.race([Promise.allSettled(reads), available]);
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    check();
    if (!finished)
      throw new RecoveryUnavailableError(
        'No relay completed the group recovery check. Check your relay connections and try again.',
      );
    const records: GroupRecoveryRecord[] = [];
    for (const event of events.values()) {
      const content = await signer.decrypt(
        new NostrUser({ pubkey: signer.pubkey }),
        event.content,
        'nip44',
      );
      check();
      const state = normalizeRecoveryState(JSON.parse(content));
      if (
        event.tags.filter((t) => t[0] === 'd').length !== 1 ||
        event.tags.find((t) => t[0] === 'd')?.[1] !== `${GROUP_RECOVERY_TAG}:${state.revision}`
      ) {
        throw new Error('Invalid signed group recovery record.');
      }
      records.push({ id: event.id, state, event: event.rawEvent() });
    }
    const contact = await contactsService.getContactByPublicKey(signer.pubkey);
    check();
    // Merge after the asynchronous contact read: another operation may have
    // verified a newer revision while this read was waiting on storage.
    const merged = new Map(observed.get(signer.pubkey));
    for (const record of records) merged.set(record.id, record);
    const verified = [...merged.values()];
    const heads = recoveryHeads(verified); // Still require a complete, signed chain back to genesis.
    const knownConflicts = contact?.meta.group_recovery_conflicts ?? [];
    if (knownConflicts.some((id) => !merged.has(id)))
      throw new Error(
        'Known conflicting group recovery records are missing. Refresh recovery using another relay.',
      );
    // Publish the merged graph before yielding again, so overlapping reads
    // cannot replace it with an older snapshot.
    observed.set(signer.pubkey, merged);
    if (contact && (heads.length > 1 || knownConflicts.length)) {
      await contactsService.updateContact(contact.id, {
        metaBase: contact.meta,
        meta: {
          ...contact.meta,
          group_recovery_conflicts: heads.length > 1 ? heads.map((head) => head.id) : [],
        },
      });
      check();
    }
    return [...observed.get(signer.pubkey)!.values()];
  }
  async function readJournal(entropy: string, initial: string[]) {
    let records = await fetchRecords(entropy, initial);
    // Old backup files and account snapshots can point several moves behind.
    // Preserve every observed branch while following signed relay pointers.
    const visited = new Set<string>([JSON.stringify(relays(initial).sort())]);
    for (let hop = 0; hop < 32; hop++) {
      const urls = [...new Set(recoveryHeads(records).flatMap((r) => r.state.relays))].sort();
      if (!urls.length) return records;
      const key = JSON.stringify(urls);
      if (visited.has(key)) return records;
      visited.add(key);
      let next: GroupRecoveryRecord[];
      try {
        next = await fetchRecords(entropy, urls);
      } catch (error) {
        if (error instanceof RecoveryUnavailableError && records.length) return records;
        throw error;
      }
      records = [...new Map([...records, ...next].map((record) => [record.id, record])).values()];
    }
    throw new Error('Too many group relay changes to verify safely. Use a recent recovery backup.');
  }
  async function publishState(
    entropy: string,
    state: GroupRecoveryState,
    additionalRelays: string[] = [],
    historical: GroupRecoveryRecord[] = [],
  ): Promise<GroupRecoveryRecord> {
    const check = session();
    normalizeRecoveryState(state);
    const signer = new NostrPrivateKeySigner(deriveGroupIdentityKey(entropy), d.ndk);
    const event = new ClientEvent(d.ndk, {
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: signer.pubkey,
      tags: [
        ['d', `${GROUP_RECOVERY_TAG}:${state.revision}`],
        ['t', GROUP_RECOVERY_TAG],
      ],
      content: await signer.encrypt(
        new NostrUser({ pubkey: signer.pubkey }),
        JSON.stringify(state),
        'nip44',
      ),
    });
    check();
    await event.sign(signer);
    const record = { id: event.id, state, event: event.rawEvent() };
    const chain = [...historical, record];
    // Try every replica. At least one current recovery relay must acknowledge
    // the whole chain, not different fragments scattered across different relays.
    await replicate(chain, state.relays);
    check();
    // Advertise a move on old relays only after a new relay holds the full chain.
    const previous = additionalRelays.filter((url) => !state.relays.includes(url));
    if (previous.length)
      void replicate(chain, previous).catch(() => {
        /* Best-effort pointers. */
      });
    const merged = new Map(observed.get(signer.pubkey));
    for (const entry of chain) merged.set(entry.id, entry);
    observed.set(signer.pubkey, merged);
    return record;
  }

  function secretFromState(
    entropy: string,
    record: GroupRecoveryRecord,
  ): GroupIdentitySecretContent {
    const groupKey = deriveGroupIdentityKey(entropy);
    return {
      version: 2,
      group_pubkey: new NostrPrivateKeySigner(groupKey).pubkey,
      group_privkey: groupKey,
      recovery_entropy: entropy,
      recovery_state_id: record.id,
      recovery_state: record.state,
      epoch_number: record.state.epoch,
      epoch_privkey: deriveGroupEpochKey(entropy, record.state.epoch, record.state.epoch_revision),
      name: record.state.name,
      about: record.state.about,
    };
  }
  async function install(
    entropy: string,
    record: GroupRecoveryRecord,
    historical: GroupRecoveryRecord[] = [],
  ) {
    const check = session();
    const secret = secretFromState(entropy, record);
    const graph = observed.get(secret.group_pubkey);
    const heads = recoveryHeads(graph ? [...graph.values()] : [record, ...historical]);
    const ciphertext = await d.encrypt(secret);
    check();
    await d.saveContact(secret.group_pubkey, ciphertext, secret);
    check();
    installed.set(secret.group_pubkey, record);
    const contact = await contactsService.getContactByPublicKey(secret.group_pubkey);
    if (contact)
      await contactsService.updateContact(contact.id, {
        metaBase: contact.meta,
        relays: record.state.relays.map((url) => ({ url, read: true, write: true })),
        meta: {
          ...contact.meta,
          group_recovery_conflicts: heads.length > 1 ? heads.map((head) => head.id) : [],
          group_members: record.state.members
            .filter((p) => p !== d.account())
            .map((public_key) => ({ public_key, name: '', given_name: '', picture: '' })),
        },
      });
    // Install newest first; the existing history runtime pages each recipient.
    for (const entry of [
      record,
      ...historical.filter((r) => r.id !== record.id).sort((a, b) => b.state.epoch - a.state.epoch),
    ]) {
      check();
      const epochKey = deriveGroupEpochKey(entropy, entry.state.epoch, entry.state.epoch_revision);
      // Master recovery grants reading keys. Only an explicitly listed member gets a posting ticket.
      const account = d.account();
      let ticket: ClientEvent | null = null;
      if (account && entry.state.members.includes(account)) {
        ticket = new ClientEvent(
          d.ndk,
          groupTicketTemplate(
            {
              groupPublicKey: secret.group_pubkey,
              epochNumber: entry.state.epoch,
              epochPublicKey: new NostrPrivateKeySigner(epochKey).pubkey,
              epochPrivateKey: epochKey,
            },
            account,
            entry.event?.created_at ?? Math.floor(Date.now() / 1000),
          ),
        );
        await ticket.sign(new NostrPrivateKeySigner(secret.group_privkey, d.ndk));
        check();
      }
      await d.persistEpoch(secret.group_pubkey, entry.state.epoch, epochKey, {
        accepted: true,
        fallbackName: secret.name,
        seedRelayUrls: entry.state.relays,
        allowRecoveryFork: true,
        ...(ticket
          ? {
              invitationCreatedAt: new Date(ticket.created_at! * 1000).toISOString(),
              invitationProof: ticket.sig,
              invitationEventId: ticket.id,
            }
          : {}),
      });
    }
    check();
    d.changed();
    // Encrypted account backup is a convenience. The group recovery journal is authoritative.
    await d.publishAccountBackup(secret.group_pubkey, ciphertext, record.state.relays);
    check();
    return secret;
  }
  async function selectCreationRelays(entropy: string, candidates: string[]) {
    const check = session();
    const readable = new Set<string>();
    const existing = await fetchRecords(entropy, candidates, readable, true);
    if (existing.length)
      throw new Error('This recovery phrase already belongs to a group. Use Restore group.');
    // A relay may permit reading but reject group-authored NIP-78 writes.
    // Probe outside the journal before fixing the group's authoritative relay set.
    const signer = new NostrPrivateKeySigner(deriveGroupIdentityKey(entropy), d.ndk);
    const probe = new ClientEvent(d.ndk, {
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: signer.pubkey,
      tags: [
        ['d', `${GROUP_RECOVERY_TAG}:relay-check`],
        ['t', `${GROUP_RECOVERY_TAG}-relay-check`],
      ],
      content: await signer.encrypt(
        new NostrUser({ pubkey: signer.pubkey }),
        'Group recovery relay check',
        'nip44',
      ),
    });
    check();
    await probe.sign(signer);
    const result = await d.publish(probe, [...readable], 'self');
    check();
    const accepted = new Set(
      result.relayStatuses
        .filter((status) => status.status === 'published')
        .map((status) => new URL(status.relay_url).href),
    );
    const verified = await Promise.allSettled(
      [...readable]
        .filter((url) => accepted.has(url))
        .map(async (url) => {
          const stored = await page(signer.pubkey, url, undefined, 1, probe.id);
          check();
          if (!stored.some((event) => event.id === probe.id))
            throw new Error('Relay did not retain the recovery check.');
          return url;
        }),
    );
    check();
    const selected = verified.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    if (!selected.length)
      throw new Error(
        'None of your available relays could store and return group recovery records. Check your relays and try again.',
      );
    return selected;
  }
  async function create(phrase: string, name: string, about: string, relayUrls: string[]) {
    const entropy = groupEntropyFromPhrase(phrase);
    const group = new NostrPrivateKeySigner(deriveGroupIdentityKey(entropy)).pubkey;
    return exclusive(group, async () => {
      const urls = await selectCreationRelays(entropy, relays(relayUrls));
      const state: GroupRecoveryState = {
        version: 1,
        revision: GENESIS_REVISION,
        epoch_revision: GENESIS_REVISION,
        epoch: 0,
        parents: [],
        members: [d.account()!],
        owners: [d.account()!],
        relays: urls,
        name,
        about,
      };
      const record = await publishState(entropy, state);
      return install(entropy, record);
    });
  }
  async function inspect(phrase: string, relayUrls: string[] = []) {
    const entropy = groupEntropyFromPhrase(phrase);
    const initial = relays(relayUrls.length ? relayUrls : d.defaultRelays());
    const check = session();
    const group = new NostrPrivateKeySigner(deriveGroupIdentityKey(entropy)).pubkey;
    const advertised = await d.ndk.fetchEvents(
      { kinds: [10002, 10050], authors: [group] },
      { relayUrls: initial },
    );
    check();
    const discovered = [...advertised]
      .filter((event) => event.pubkey === group && event.verifySignature())
      .flatMap((event) =>
        event.tags.filter((tag) => tag[0] === 'r' || tag[0] === 'relay').map((tag) => tag[1]),
      )
      .filter((url) => {
        try {
          const u = new URL(url);
          return ['ws:', 'wss:'].includes(u.protocol) && !u.username && !u.password;
        } catch {
          return false;
        }
      });
    const records = await readJournal(
      entropy,
      [...new Set([...initial, ...discovered])].slice(0, 32),
    );
    if (!records.length)
      throw new Error(
        'No group recovery records found. Add the original group relay or import its recovery file.',
      );
    const heads = recoveryHeads(records);
    if (!heads.length) throw new Error('Group recovery history is unavailable.');
    return {
      entropy,
      records,
      heads,
      group: new NostrPrivateKeySigner(deriveGroupIdentityKey(entropy)).pubkey,
    };
  }
  async function restore(phrase: string, relayUrls: string[] = []) {
    const found = await inspect(phrase, relayUrls);
    return exclusive(found.group, async () => {
      const secret = await install(found.entropy, found.heads[0], found.records);
      if (found.heads.length === 1 && !secret.recovery_state!.owners.includes(d.account()!)) {
        return update(found.group, secret.recovery_state!.members);
      }
      return secret;
    });
  }
  async function update(
    group: string,
    members: string[],
    reconcile = false,
    forceRotation = false,
  ) {
    const secret = await secretFor(group);
    if (!secret.recovery_state || !secret.recovery_state_id)
      throw new Error('Restore the group recovery state first.');
    const records = await readJournal(secret.recovery_entropy!, secret.recovery_state.relays);
    const heads = recoveryHeads(records);
    if (!heads.length) throw new Error('Group recovery state is missing.');
    if (!reconcile && heads.length !== 1)
      throw new Error(
        'Conflicting group recovery updates. Reconcile recovery before changing membership.',
      );
    if (!reconcile && heads[0].id !== secret.recovery_state_id) {
      throw new Error(
        'Group recovery state has changed. Close this form and refresh members before saving again.',
      );
    }
    const nextMembers = reconcile ? safeRecoveryMembers(heads) : [...new Set(members)].sort();
    const rotate =
      forceRotation ||
      reconcile ||
      heads.some((h) => h.state.members.some((p) => !nextMembers.includes(p)));
    const next: GroupRecoveryState = {
      ...heads[0].state,
      revision: newGroupRevision(),
      epoch: Math.max(...heads.map((h) => h.state.epoch)) + (rotate ? 1 : 0),
      epoch_revision: rotate ? newGroupRevision() : heads[0].state.epoch_revision,
      parents: heads.map((h) => h.id),
      members: nextMembers,
      owners: [...new Set([...heads.flatMap((h) => h.state.owners), d.account()!])],
    };
    const record = await publishState(secret.recovery_entropy!, next, [], records);
    const after = recoveryHeads(
      await readAfterPublish(secret.recovery_entropy!, next.relays, [...records, record]),
    );
    if (after.length !== 1 || after[0].id !== record.id) {
      throw new Error(
        'Concurrent owner updates detected. Reconcile group recovery before sending invitations.',
      );
    }
    return install(secret.recovery_entropy!, record, records);
  }
  async function readAfterPublish(entropy: string, urls: string[], records: GroupRecoveryRecord[]) {
    try {
      return await fetchRecords(entropy, urls);
    } catch (error) {
      if (error instanceof RecoveryUnavailableError) return records;
      throw error;
    }
  }
  async function replicate(records: GroupRecoveryRecord[], targets: string[]) {
    const check = session();
    // Other replica attempts keep running after the first complete copy succeeds.
    // Each continuation checks the originating account before another write.
    const attempts = relays(targets).map(async (url) => {
      await d.connect([url]);
      check();
      for (const record of records) {
        check();
        if (!record.event)
          throw new Error('Missing signed recovery record. Refresh before retrying.');
        const result = await d.publish(new ClientEvent(d.ndk, record.event), [url], 'self');
        check();
        if (
          !result.relayStatuses.some(
            (status) => status.status === 'published' && new URL(status.relay_url).href === url,
          )
        )
          throw new Error('Recovery relay did not acknowledge the update.');
      }
    });
    try {
      await Promise.any(attempts);
    } catch {
      check();
      throw new Error(
        'No recovery relay saved the complete group update. Check your relays and retry.',
      );
    }
    check();
  }
  async function moveRelays(group: string, nextRelayUrls: string[]) {
    return exclusive(group, async () => {
      const secret = await secretFor(group);
      const targets = relays(nextRelayUrls);
      const old = secret.recovery_state!.relays;
      if (JSON.stringify([...old].sort()) === JSON.stringify([...targets].sort())) return;
      const records = await readJournal(secret.recovery_entropy!, old);
      const heads = recoveryHeads(records);
      if (heads.length !== 1 || heads[0].id !== secret.recovery_state_id)
        throw new Error(
          'Another owner changed the group. Refresh recovery before changing relays.',
        );
      const next: GroupRecoveryState = {
        ...heads[0].state,
        revision: newGroupRevision(),
        parents: [heads[0].id],
        relays: targets,
      };
      // Keep a signed pointer on the old relays so an older recovery file can find the new location.
      const record = await publishState(secret.recovery_entropy!, next, old, records);
      const observed = recoveryHeads(
        await readAfterPublish(
          secret.recovery_entropy!,
          [...new Set([...old, ...targets])],
          [...records, record],
        ),
      );
      if (observed.length !== 1 || observed[0].id !== record.id)
        throw new Error(
          'Concurrent owner updates detected. Reconcile recovery before changing relays.',
        );
      await install(secret.recovery_entropy!, record);
    });
  }
  async function refresh(group: string, reconcile = false) {
    return exclusive(group, async () => {
      const secret = await secretFor(group);
      const records = await readJournal(secret.recovery_entropy!, secret.recovery_state!.relays);
      const heads = recoveryHeads(records);
      if (heads.length !== 1 && !reconcile)
        throw new Error(
          'Conflicting owner updates. Reconcile keeps only members present in every conflicting update.',
        );
      if (reconcile) return update(group, [], true);
      if (!heads.length) throw new Error('Group recovery history is unavailable.');
      await replicate(records, heads[0].state.relays);
      return install(secret.recovery_entropy!, heads[0], records);
    });
  }
  async function backup(group: string) {
    const secret = await secretFor(group);
    return {
      phrase: groupPhraseFromEntropy(secret.recovery_entropy!),
      relays: secret.recovery_state!.relays,
    };
  }
  async function current(group: string, expectedStateId?: string) {
    const check = session();
    const secret = await secretFor(group);
    const records = await readJournal(secret.recovery_entropy!, secret.recovery_state!.relays);
    const heads = recoveryHeads(records);
    check();
    const baseline = installed.get(group);
    if (
      heads.length !== 1 ||
      (expectedStateId && heads[0].id !== expectedStateId) ||
      (baseline && !records.some((record) => record.id === baseline.id))
    ) {
      throw new Error(
        'Group ownership state changed. Refresh or reconcile recovery before sending.',
      );
    }
    // Preserve the verified baseline when account-backup hydration replays an older snapshot.
    // This does not update an already reviewed form or install a new writable epoch.
    installed.set(group, heads[0]);
    return secretFromState(secret.recovery_entropy!, heads[0]);
  }
  async function issueOwnInvitation(group: string, epochPublicKey: string) {
    const check = session();
    const account = d.account()!;
    const contact = await contactsService.getContactByPublicKey(group);
    check();
    if (!contact?.meta.group_private_key_encrypted) return null;

    // Possession of the master permits signing, but does not implicitly join this account.
    const secret = await current(group);
    check();
    if (!secret.recovery_state!.members.includes(account))
      throw new Error('This account is not a group member. Join the group before sending.');
    if (new NostrPrivateKeySigner(secret.epoch_privkey!).pubkey !== epochPublicKey)
      throw new Error('The group epoch changed. Refresh group recovery before sending.');

    const invitedAt = Math.floor(Date.now() / 1000);
    const ticket = new ClientEvent(
      d.ndk,
      groupTicketTemplate(
        {
          groupPublicKey: group,
          epochNumber: secret.epoch_number!,
          epochPublicKey,
          epochPrivateKey: secret.epoch_privkey!,
        },
        account,
        invitedAt,
      ),
    );
    await ticket.sign(new NostrPrivateKeySigner(secret.group_privkey, d.ndk));
    check();
    await d.persistEpoch(group, secret.epoch_number!, secret.epoch_privkey!, {
      invitationCreatedAt: new Date(invitedAt * 1000).toISOString(),
      invitationProof: ticket.sig,
      invitationEventId: ticket.id,
    });
    check();
    return { proof: ticket.sig, invitedAt };
  }
  async function assertCanSend(group: string, epochPublicKey: string) {
    const check = session();
    const secret = await secretFor(group);
    const contact = await contactsService.getContactByPublicKey(group);
    check();
    if (contact?.meta.group_recovery_conflicts?.length)
      throw new Error(
        'Group ownership state changed. Refresh or reconcile recovery before sending.',
      );
    const records = observed.get(group);
    if (records) {
      const heads = recoveryHeads([...records.values()]);
      if (heads.length !== 1 || heads[0].id !== secret.recovery_state_id)
        throw new Error(
          'Group ownership state changed. Refresh or reconcile recovery before sending.',
        );
    }
    if (
      !secret.recovery_state!.members.includes(d.account()!) ||
      new NostrPrivateKeySigner(secret.epoch_privkey!).pubkey !== epochPublicKey
    ) {
      throw new Error(
        'The group epoch changed. Refresh group recovery and invitations before sending.',
      );
    }
  }
  async function assertCurrent(group: string) {
    const secret = await secretFor(group);
    const heads = recoveryHeads(
      await readJournal(secret.recovery_entropy!, secret.recovery_state!.relays),
    );
    if (heads.length !== 1 || heads[0].id !== secret.recovery_state_id)
      throw new Error(
        'Group ownership state changed. Refresh or reconcile recovery before sending.',
      );
  }
  return {
    create,
    inspect,
    restore,
    update,
    refresh,
    backup,
    assertCurrent,
    assertCanSend,
    issueOwnInvitation,
    current,
    exclusive,
    secretFor,
    moveRelays,
  };
}
