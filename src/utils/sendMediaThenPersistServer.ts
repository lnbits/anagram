interface SendMediaThenPersistServerInput<TCreated> {
  send: () => Promise<TCreated | null>;
  // Set only when the successful encrypted upload used a server other than the saved default.
  serverToPersist: string | null | undefined;
  persistServer: (serverUrl: string) => Promise<unknown>;
  onPersistError: (error: unknown) => void;
}

// Persisting the private-media server publishes a signed preference, so it must not start until
// the kind 15 send has fully completed. A send failure rethrows untouched and persists nothing;
// a persist failure is reported separately and never re-sends or fails the already sent message.
export async function sendMediaThenPersistServer<TCreated>({
  send,
  serverToPersist,
  persistServer,
  onPersistError,
}: SendMediaThenPersistServerInput<TCreated>): Promise<TCreated | null> {
  const created = await send();
  if (created && serverToPersist) {
    try {
      await persistServer(serverToPersist);
    } catch (error) {
      onPersistError(error);
    }
  }
  return created;
}
