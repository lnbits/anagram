import type { AbstractRelay } from 'nostr-tools/abstract-relay';

/** Contain nostr-tools' fire-and-forget AUTH callback at the transport boundary.
 * Explicit AUTH callers still reject; a failed automatic challenge closes only
 * this relay so query owners can retry without claiming EOSE or authentication. */
export function guardRelayAuthentication(
  relay: Pick<AbstractRelay, 'auth' | 'onauth' | 'close'>,
  callbacks: { authenticated: () => void; failed: () => void },
  timeoutMs = 15000,
): void {
  const authenticate = relay.auth.bind(relay);
  relay.auth = (signer) => {
    const automatic = signer === relay.onauth;
    const attempt = (async () => {
      let active = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let failSigner!: (error: Error) => void;
      const signerFailure = new Promise<never>((_, reject) => {
        failSigner = reject;
      });
      try {
        const result = await Promise.race([
          authenticate(async (event) => {
            try {
              const signed = await signer(event);
              if (!active) throw new Error('Relay authentication expired');
              return signed;
            } catch {
              // Some nostr-tools versions swallow signer failures inside auth().
              const error = new Error('Relay authentication signing failed');
              failSigner(error);
              throw error;
            }
          }),
          signerFailure,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Relay authentication timed out')),
              timeoutMs,
            );
          }),
        ]);
        callbacks.authenticated();
        return result;
      } catch {
        // No success event, and no auth rejection escapes the automatic handler.
        try {
          callbacks.failed();
        } finally {
          relay.close();
        }
        throw new Error('Relay authentication failed; will retry');
      } finally {
        active = false;
        clearTimeout(timer);
      }
    })();
    return automatic ? attempt.catch(() => '') : attempt;
  };
}
