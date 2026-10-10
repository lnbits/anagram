import type { PublishUserMetadataInput } from '#src/stores/nostrStore.ts';
import type { ContactProfileForm } from '#src/types/contactProfile.ts';

function cleanString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBirthday(
  input: ContactProfileForm['birthday']
): PublishUserMetadataInput['birthday'] {
  const normalized: NonNullable<PublishUserMetadataInput['birthday']> = {};

  if (Number.isInteger(input.year) && Number(input.year) > 0) {
    normalized.year = Number(input.year);
  }

  if (Number.isInteger(input.month) && Number(input.month) >= 1 && Number(input.month) <= 12) {
    normalized.month = Number(input.month);
  }

  if (Number.isInteger(input.day) && Number(input.day) >= 1 && Number(input.day) <= 31) {
    normalized.day = Number(input.day);
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function buildContactProfilePublishPayload(
  profile: ContactProfileForm
): PublishUserMetadataInput {
  const payload: PublishUserMetadataInput = {
    bot: profile.bot,
    group: profile.group,
  };

  const fields: Array<
    keyof Omit<
      ContactProfileForm,
      'bot' | 'group' | 'birthday' | 'relays' | 'sendMessagesToAppRelays'
    >
  > = ['name', 'about', 'picture', 'nip05', 'lud06', 'lud16', 'display_name', 'website', 'banner'];

  for (const field of fields) {
    const fieldValue = cleanString(profile[field]);
    if (fieldValue !== undefined) {
      payload[field] = fieldValue;
    }
  }

  const birthday = normalizeBirthday(profile.birthday);
  if (birthday) {
    payload.birthday = birthday;
  }

  return payload;
}
