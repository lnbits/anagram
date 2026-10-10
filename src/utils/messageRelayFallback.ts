import type { QVueGlobals } from '#src/lib/platform/ui.ts';
import { contactsService } from '#src/services/contactsService.ts';
import { inputSanitizerService } from '#src/services/inputSanitizerService.ts';
import { useNostrStore } from '#src/stores/nostrStore.ts';

export const CONTACT_RELAY_FALLBACK_MESSAGE =
  'No relays found for this contact. Do you want to use the application default relays?';

const REMEMBER_THIS_OPTION = 'remember-this';

export interface AppRelayFallbackDecision {
  shouldUseAppRelays: boolean;
  rememberThis: boolean;
}

export function confirmUseAppRelaysDialog($q: QVueGlobals): Promise<AppRelayFallbackDecision> {
  return new Promise((resolve) => {
    let settled = false;

    const settle = (value: AppRelayFallbackDecision): void => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(value);
    };

    $q.dialog({
      title: 'Use App Relays',
      message: CONTACT_RELAY_FALLBACK_MESSAGE,
      persistent: true,
      options: {
        type: 'checkbox',
        model: [] as string[],
        items: [
          {
            label: 'Remember this',
            value: REMEMBER_THIS_OPTION,
            color: 'primary',
          },
        ],
      },
      ok: {
        label: 'Yes',
        color: 'primary',
        noCaps: true,
      },
      cancel: {
        label: 'No',
        flat: true,
        noCaps: true,
      },
    })
      .onOk((selectedValues: unknown) =>
        settle({
          shouldUseAppRelays: true,
          rememberThis:
            Array.isArray(selectedValues) && selectedValues.includes(REMEMBER_THIS_OPTION),
        })
      )
      .onCancel(() =>
        settle({
          shouldUseAppRelays: false,
          rememberThis: false,
        })
      )
      .onDismiss(() =>
        settle({
          shouldUseAppRelays: false,
          rememberThis: false,
        })
      );
  });
}

export async function resolveContactAppRelayFallback(
  $q: QVueGlobals,
  contactPublicKey: string,
  appRelayUrls: string[],
  options: {
    fallbackName?: string;
  } = {}
): Promise<string[] | null> {
  const decision = await confirmUseAppRelaysDialog($q);
  if (!decision.shouldUseAppRelays) {
    return null;
  }

  const normalizedRelayUrls = inputSanitizerService.normalizeStringArray(appRelayUrls);
  if (normalizedRelayUrls.length === 0) {
    $q.notify({
      type: 'warning',
      message: 'No app relays configured.',
      position: 'top',
    });
    return null;
  }

  if (decision.rememberThis) {
    try {
      await contactsService.init();
      const existingContact = await contactsService.getContactByPublicKey(contactPublicKey);
      if (!existingContact) {
        const nostrStore = useNostrStore();
        await nostrStore.ensureRespondedPubkeyIsContact(
          contactPublicKey,
          options.fallbackName ?? ''
        );
      }

      const updatedContact = await contactsService.updateSendMessagesToAppRelays(
        contactPublicKey,
        true
      );
      if (!updatedContact) {
        throw new Error('Contact not found.');
      }
    } catch (error) {
      console.warn(
        'Failed to save app relay fallback preference for contact',
        contactPublicKey,
        error
      );
      $q.notify({
        type: 'warning',
        message: 'Could not save this preference. App relays will be used this time only.',
        position: 'top',
      });
    }
  }

  return normalizedRelayUrls;
}
