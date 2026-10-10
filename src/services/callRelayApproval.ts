import { Dialog } from '#src/lib/platform/ui.ts';
import { t } from '#src/i18n.ts';
import type { CallEndpoint } from '#src/types/call.ts';
import {
  defaultIrohRelays,
  normalizeIrohRelayUrl,
  SHARED_IROH_RELAYS,
} from '#src/utils/irohRelays.ts';

// Wrap the shared transport boundary so direct and group calls use the same policy.
export function guardCallRelay(endpoint: CallEndpoint, configuredRelays: string[]): CallEndpoint {
  const trusted = new Set(
    [...SHARED_IROH_RELAYS, ...defaultIrohRelays(), ...configuredRelays]
      .map(normalizeIrohRelayUrl)
      .filter((url): url is string => url !== null),
  );
  const pending = new Set<() => void>();
  let closed = false;
  return {
    online: () => endpoint.online(),
    id: () => endpoint.id(),
    relay_url: () => endpoint.relay_url(),
    accept: (peer, call) => endpoint.accept(peer, call),
    async connect(peer, relay, call) {
      const url = normalizeIrohRelayUrl(relay);
      if (closed || !url) throw new Error('Invalid or closed call relay connection');
      if (!trusted.has(url)) {
        const allowed = await new Promise<boolean>((resolve) => {
          const dialog = Dialog.create({
            title: t('call.relayApproval.title'),
            message: t('call.relayApproval.message', { url }),
            ok: { label: t('call.relayApproval.allow') },
            cancel: { label: t('call.relayApproval.cancel'), flat: true },
            persistent: true,
            callRelay: true,
          });
          const cancel = () => {
            resolve(false);
            dialog.hide();
          };
          pending.add(cancel);
          dialog
            .onOk(() => resolve(true))
            .onDismiss(() => {
              pending.delete(cancel);
              resolve(false);
            });
        });
        if (!allowed || closed) throw new Error('Call relay connection not approved');
      }
      return endpoint.connect(peer, url, call);
    },
    close() {
      closed = true;
      for (const cancel of pending) cancel();
      pending.clear();
      return endpoint.close();
    },
  };
}
