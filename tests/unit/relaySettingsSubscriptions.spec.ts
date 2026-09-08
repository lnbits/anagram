import { watchRelaySettingsSubscriptions } from 'src/stores/nostr/relaySettingsSubscriptions';
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

describe('relay settings orchestration', () => {
  it('ignores hydration and startup changes and uses one path for real settings changes', () => {
    const signature = ref('');
    let restoring = false;
    const refresh = vi.fn();
    const stop = watchRelaySettingsSubscriptions({
      hydrate: () => {
        signature.value = 'hydrated';
      },
      signature: () => signature.value,
      isRestoring: () => restoring,
      hasSessionSubscriptions: () => true,
      refresh,
    });
    expect(refresh).not.toHaveBeenCalled();
    restoring = true;
    signature.value = 'restored';
    restoring = false;
    signature.value = 'restored';
    expect(refresh).not.toHaveBeenCalled();
    signature.value = 'local mutation';
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });
});
