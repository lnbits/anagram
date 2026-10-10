import type { ClientEvent } from '#src/lib/nostr/client.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import type { ContactProfileEventState, ContactRelayListEventState } from '#src/stores/nostr/types.ts';

export function createTrackedContactStateRuntime() {
  const lastContactProfileEventStateByPubkey = new Map<string, ContactProfileEventState>();
  const lastContactRelayListEventStateByPubkey = new Map<string, ContactRelayListEventState>();
  let lastPrivateContactListCreatedAt = 0;
  let lastPrivateContactListEventId = '';

  function shouldApplyPrivateContactListEvent(event: ClientEvent): boolean {
    const createdAt = Number(event.created_at ?? 0);
    if (createdAt > lastPrivateContactListCreatedAt) {
      return true;
    }

    if (createdAt < lastPrivateContactListCreatedAt) {
      return false;
    }

    const eventId = event.id?.trim() ?? '';
    if (!eventId) {
      return lastPrivateContactListEventId.length === 0;
    }

    return eventId !== lastPrivateContactListEventId;
  }

  function markPrivateContactListEventApplied(event: Pick<ClientEvent, 'created_at' | 'id'>): void {
    lastPrivateContactListCreatedAt = Number(event.created_at ?? 0);
    lastPrivateContactListEventId = event.id?.trim() ?? '';
  }

  function buildContactRelayListEventState(
    event: Pick<ClientEvent, 'created_at' | 'id'>
  ): ContactRelayListEventState {
    return {
      createdAt: Number(event.created_at ?? 0),
      eventId: event.id?.trim() ?? '',
    };
  }

  function pruneTrackedContactRelayListEventState(activePubkeys: string[]): void {
    const activePubkeySet = new Set(activePubkeys);
    for (const pubkey of lastContactRelayListEventStateByPubkey.keys()) {
      if (!activePubkeySet.has(pubkey)) {
        lastContactRelayListEventStateByPubkey.delete(pubkey);
      }
    }
  }

  function shouldApplyContactRelayListEvent(
    event: Pick<ClientEvent, 'created_at' | 'id' | 'pubkey'>
  ): boolean {
    const normalizedPubkey = inputSanitizerService.normalizeHexKey(event.pubkey);
    if (!normalizedPubkey) {
      return false;
    }

    const nextState = buildContactRelayListEventState(event);
    const previousState = lastContactRelayListEventStateByPubkey.get(normalizedPubkey);
    if (!previousState) {
      return true;
    }

    if (nextState.createdAt > previousState.createdAt) {
      return true;
    }

    if (nextState.createdAt < previousState.createdAt) {
      return false;
    }

    return nextState.eventId !== previousState.eventId;
  }

  function markContactRelayListEventApplied(
    pubkeyHex: string,
    eventState: ContactRelayListEventState
  ): void {
    lastContactRelayListEventStateByPubkey.set(pubkeyHex, eventState);
  }

  function buildContactProfileEventState(
    event: Pick<ClientEvent, 'created_at' | 'id'>
  ): ContactProfileEventState {
    return {
      createdAt: Number(event.created_at ?? 0),
      eventId: event.id?.trim() ?? '',
    };
  }

  function pruneTrackedContactProfileEventState(activePubkeys: string[]): void {
    const activePubkeySet = new Set(activePubkeys);
    for (const pubkey of lastContactProfileEventStateByPubkey.keys()) {
      if (!activePubkeySet.has(pubkey)) {
        lastContactProfileEventStateByPubkey.delete(pubkey);
      }
    }
  }

  function shouldApplyContactProfileEvent(
    event: Pick<ClientEvent, 'created_at' | 'id' | 'pubkey'>
  ): boolean {
    const normalizedPubkey = inputSanitizerService.normalizeHexKey(event.pubkey);
    if (!normalizedPubkey) {
      return false;
    }

    const nextState = buildContactProfileEventState(event);
    const previousState = lastContactProfileEventStateByPubkey.get(normalizedPubkey);
    if (!previousState) {
      return true;
    }

    if (nextState.createdAt > previousState.createdAt) {
      return true;
    }

    if (nextState.createdAt < previousState.createdAt) {
      return false;
    }

    return nextState.eventId !== previousState.eventId;
  }

  function markContactProfileEventApplied(
    pubkeyHex: string,
    eventState: ContactProfileEventState
  ): void {
    lastContactProfileEventStateByPubkey.set(pubkeyHex, eventState);
  }

  function resetTrackedContactEventState(): void {
    lastContactProfileEventStateByPubkey.clear();
    lastContactRelayListEventStateByPubkey.clear();
    lastPrivateContactListCreatedAt = 0;
    lastPrivateContactListEventId = '';
  }

  return {
    buildContactProfileEventState,
    buildContactRelayListEventState,
    markContactProfileEventApplied,
    markContactRelayListEventApplied,
    markPrivateContactListEventApplied,
    pruneTrackedContactProfileEventState,
    pruneTrackedContactRelayListEventState,
    resetTrackedContactEventState,
    shouldApplyContactProfileEvent,
    shouldApplyContactRelayListEvent,
    shouldApplyPrivateContactListEvent,
  };
}
