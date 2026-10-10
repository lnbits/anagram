import { type WatchStopHandle, watch } from '#src/lib/state/reactivity.ts';

export function watchRelaySettingsSubscriptions(options: {
  hydrate: () => void;
  signature: () => string;
  isRestoring: () => boolean;
  hasSessionSubscriptions: () => boolean;
  refresh: () => void;
}): WatchStopHandle {
  // Hydration is local input to the startup owner, never a second refresh path.
  options.hydrate();
  return watch(
    options.signature,
    () => {
      if (!options.isRestoring() && options.hasSessionSubscriptions()) options.refresh();
    },
    {}
  );
}
