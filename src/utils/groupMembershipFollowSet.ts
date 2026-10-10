import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';

function normalizeExcludedPubkeys(excludedPubkeys: string[]): Set<string> {
  return new Set(
    excludedPubkeys
      .map((pubkey) => inputSanitizerService.normalizeHexKey(pubkey))
      .filter((pubkey): pubkey is string => Boolean(pubkey))
  );
}

export function normalizeGroupMembershipSnapshotPubkeys(
  pubkeys: string[],
  excludedPubkeys: string[] = []
): string[] {
  const excludedPubkeySet = normalizeExcludedPubkeys(excludedPubkeys);

  return Array.from(
    new Set(
      pubkeys
        .map((pubkey) => inputSanitizerService.normalizeHexKey(pubkey))
        .filter((pubkey): pubkey is string => Boolean(pubkey))
        .filter((pubkey) => !excludedPubkeySet.has(pubkey))
    )
  ).sort((first, second) => first.localeCompare(second));
}

export function buildGroupMembershipFollowSetPrivateTags(
  pubkeys: string[],
  excludedPubkeys: string[] = []
): string[][] {
  return normalizeGroupMembershipSnapshotPubkeys(pubkeys, excludedPubkeys).map((pubkey) => [
    'p',
    pubkey,
  ]);
}

export function parseGroupMembershipFollowSetPrivateTags(
  value: unknown,
  excludedPubkeys: string[] = []
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const pubkeys = value
    .map((entry) => {
      if (!Array.isArray(entry) || entry[0] !== 'p') {
        return null;
      }

      return inputSanitizerService.normalizeHexKey(String(entry[1] ?? ''));
    })
    .filter((pubkey): pubkey is string => Boolean(pubkey));

  return normalizeGroupMembershipSnapshotPubkeys(pubkeys, excludedPubkeys);
}
