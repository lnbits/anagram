import { describe, expect, it } from 'vitest';
import {
  createInitialStartupStepSnapshots,
  getStartupHistoryStepsValue,
} from '#src/stores/nostr/startupState.ts';

describe('startup history steps', () => {
  it('omits unscheduled pending steps and uses the startup dependency order', () => {
    const snapshots = createInitialStartupStepSnapshots();
    const originalOrder = snapshots.map((step) => step.id);
    const steps = getStartupHistoryStepsValue(snapshots);

    expect(steps.map((step) => step.id)).toEqual([
      'my-relays-restore',
      'my-relays-subscribe',
      'outbound-message-replay',
      'private-preferences',
      'private-contact-list-restore',
      'group-identity-secrets',
      'contact-cursor-state',
      'private-contact-list-subscribe',
      'contact-profile-subscribe',
      'contact-relay-list-subscribe',
      'private-messages-subscribe',
      'group-rosters-subscribe',
      'message-history-restore',
    ]);
    expect(steps.every((step) => step.status === 'pending')).toBe(true);
    expect(snapshots.map((step) => step.id)).toEqual(originalOrder);
  });

  it('keeps failed, partial and explicitly started work visible', () => {
    const snapshots = createInitialStartupStepSnapshots();
    const failed = snapshots.find((step) => step.id === 'my-relays-restore')!;
    const partial = snapshots.find((step) => step.id === 'private-messages-subscribe')!;
    const manual = snapshots.find((step) => step.id === 'group-relay-lists-refresh')!;
    failed.status = 'error';
    partial.status = 'partial';
    manual.status = 'in_progress';

    const steps = getStartupHistoryStepsValue(snapshots);
    expect(steps).toHaveLength(14);
    expect(steps).toContain(failed);
    expect(steps).toContain(partial);
    expect(steps.at(-1)).toBe(manual);
  });

  it('keeps standalone internal work visible even when its parent is pending', () => {
    const snapshots = createInitialStartupStepSnapshots();
    const profile = snapshots.find((step) => step.id === 'logged-in-contact-profile')!;
    profile.internalTasks.push({
      id: 'logged-in-profile',
      label: 'startup.loggedInUserProfileMetadata',
      status: 'in_progress',
      startedAt: 1,
      completedAt: null,
      durationMs: null,
      errorMessage: null,
      eventCount: null,
    });

    expect(getStartupHistoryStepsValue(snapshots)).toContain(profile);
  });
});
