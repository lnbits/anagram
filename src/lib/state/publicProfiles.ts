import { shallowReactive } from '@vue/reactivity';
import type { Readable } from 'svelte/store';
import { observe } from '#src/lib/state/store.ts';

// Display-only whitelist. Contact metadata can contain encrypted group keys and
// must never be copied wholesale into the frontend profile cache.
export interface PublicProfile {
  name: string;
  picture: string;
  createdAt?: number;
  eventId?: string;
}
const PROFILE_CACHE_LIMIT = 5000;
const observers = new Map<string, number>();
const profiles = shallowReactive(new Map<string, PublicProfile>());
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
export const getPublicProfile = (publicKey: string) => profiles.get(publicKey);
function trimProfiles(): void {
  if (profiles.size <= PROFILE_CACHE_LIMIT) return;
  for (const key of profiles.keys()) {
    if (!observers.has(key)) profiles.delete(key);
    if (profiles.size <= PROFILE_CACHE_LIMIT) break;
  }
}
export function observePublicProfile(publicKey: string): Readable<PublicProfile | undefined> {
  return {
    subscribe(run) {
      observers.set(publicKey, (observers.get(publicKey) ?? 0) + 1);
      const stop = observe(() => profiles.get(publicKey)).subscribe(run);
      return () => {
        stop();
        const remaining = (observers.get(publicKey) ?? 1) - 1;
        if (remaining) observers.set(publicKey, remaining);
        else observers.delete(publicKey);
        trimProfiles();
      };
    },
  };
}
export const clearPublicProfiles = () => profiles.clear();

export function rememberPublicProfile(
  publicKey: string,
  metadata: {
    name?: unknown;
    display_name?: unknown;
    displayName?: unknown;
    picture?: unknown;
    image?: unknown;
  },
  createdAt?: number,
  eventId?: string,
): void {
  if (!/^[a-f0-9]{64}$/.test(publicKey)) return;
  const previous = profiles.get(publicKey);
  if (previous?.createdAt !== undefined) {
    if (createdAt === undefined || createdAt < previous.createdAt) return;
    if (createdAt === previous.createdAt) {
      // Cached contacts lack event ids. Never replace a signed snapshot with a
      // same-age disk copy; NIP-01 selects the lowest id on a timestamp tie.
      if (previous.eventId && (!eventId || eventId >= previous.eventId)) return;
    }
  }
  const picture = text(metadata.picture) || text(metadata.image);
  const next: PublicProfile = {
    name: (text(metadata.display_name) || text(metadata.displayName) || text(metadata.name)).slice(
      0,
      300,
    ),
    picture: picture.length <= 4096 && /^https?:\/\//i.test(picture) ? picture : '',
    createdAt,
    eventId,
  };
  if (createdAt === undefined && !next.name && !next.picture) return;
  if (createdAt === undefined && previous) {
    next.name ||= previous.name;
    next.picture ||= previous.picture;
  }
  if (
    !previous ||
    Object.keys(next).some(
      (key) => next[key as keyof PublicProfile] !== previous[key as keyof PublicProfile],
    )
  )
    profiles.set(publicKey, next);
  trimProfiles();
}
