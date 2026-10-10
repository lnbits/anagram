import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPublicProfiles,
  getPublicProfile,
  observePublicProfile,
  rememberPublicProfile,
} from '#src/lib/state/publicProfiles.ts';

const key = 'a'.repeat(64);
describe('shared public profile display cache', () => {
  beforeEach(clearPublicProfiles);
  it('shares late metadata across already-mounted consumers without exposing extra fields', async () => {
    const one = vi.fn(),
      two = vi.fn();
    const stopOne = observePublicProfile(key).subscribe(one);
    const stopTwo = observePublicProfile(key).subscribe(two);
    const metadata = {
      name: 'handle',
      display_name: 'Name',
      picture: 'https://images.test/me.png',
      group_private_key_encrypted: 'never-render',
    };
    rememberPublicProfile(key, metadata, 100, 'b');
    await vi.waitFor(() =>
      expect(one.mock.calls.at(-1)?.[0]).toEqual({
        name: 'Name',
        picture: metadata.picture,
        createdAt: 100,
        eventId: 'b',
      }),
    );
    expect(two.mock.calls.at(-1)?.[0]).toEqual(one.mock.calls.at(-1)?.[0]);
    expect(getPublicProfile(key)).not.toHaveProperty('group_private_key_encrypted');
    stopOne();
    stopTwo();
  });
  it('rejects stale disk/roster snapshots and resolves equal timestamps by event id', () => {
    rememberPublicProfile(key, { name: 'New', picture: 'https://images.test/new' }, 20, 'b');
    rememberPublicProfile(key, { name: 'Old' }, 10, 'a');
    rememberPublicProfile(key, { name: 'Disk' }, 20);
    rememberPublicProfile(key, { name: 'Roster' });
    rememberPublicProfile(key, { name: 'Tie loser' }, 20, 'c');
    expect(getPublicProfile(key)?.name).toBe('New');
    rememberPublicProfile(key, { name: 'Tie winner' }, 20, 'a');
    expect(getPublicProfile(key)).toMatchObject({ name: 'Tie winner', picture: '' });
  });
  it('supports metadata removal and account cache clearing', () => {
    rememberPublicProfile(key, { name: 'Cached', picture: 'https://images.test/cached' }, 1);
    rememberPublicProfile(key, {}, 2, 'b');
    expect(getPublicProfile(key)).toMatchObject({ name: '', picture: '' });
    clearPublicProfiles();
    expect(getPublicProfile(key)).toBeUndefined();
    rememberPublicProfile(key, { name: 'Name', picture: 'javascript:bad' });
    expect(getPublicProfile(key)?.picture).toBe('');
  });
});

it('evicts unused profiles while preserving mounted avatars and allows rehydration', () => {
  clearPublicProfiles();
  const observed = 'f'.repeat(64),
    old = 'e'.repeat(64);
  rememberPublicProfile(observed, { name: 'Visible' }, 1);
  rememberPublicProfile(old, { name: 'Old' }, 1);
  const stop = observePublicProfile(observed).subscribe(() => {});
  try {
    for (let i = 1; i <= 6000; i++)
      rememberPublicProfile(i.toString(16).padStart(64, '0'), { name: `Profile ${i}` }, 1);
    expect(getPublicProfile(old)).toBeUndefined();
    expect(getPublicProfile(observed)?.name).toBe('Visible');
    rememberPublicProfile(old, { name: 'Restored' }, 2);
    expect(getPublicProfile(old)?.name).toBe('Restored');
  } finally {
    stop();
    clearPublicProfiles();
  }
});
