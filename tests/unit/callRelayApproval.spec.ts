import { guardCallRelay } from 'src/services/callRelayApproval';
import type { CallEndpoint } from 'src/types/call';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dialogs = vi.hoisted(() => ({
  create: vi.fn(),
  ok: () => {},
  dismiss: () => {},
  hide: vi.fn(),
}));
vi.mock('quasar', () => ({ Dialog: { create: dialogs.create } }));

function harness(configured: string[] = []) {
  const endpoint: CallEndpoint = {
    online: vi.fn().mockResolvedValue(undefined),
    id: () => 'peer',
    relay_url: () => 'https://iroh.nostr.com/',
    connect: vi.fn().mockResolvedValue({}),
    accept: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { endpoint, guarded: guardCallRelay(endpoint, configured) };
}
beforeEach(() => {
  vi.clearAllMocks();
  const dialog = {
    onOk(callback: () => void) {
      dialogs.ok = callback;
      return dialog;
    },
    onDismiss(callback: () => void) {
      dialogs.dismiss = callback;
      return dialog;
    },
    hide: dialogs.hide,
  };
  dialogs.create.mockReturnValue(dialog);
});

describe('peer relay approval at the shared call transport boundary', () => {
  it('allows normalized shared and explicitly configured LAN relays without prompting', async () => {
    const { guarded, endpoint } = harness(['https://192.168.1.2:8443/']);
    await guarded.connect('peer', 'HTTPS://IROH.NOSTR.COM:443', 'call');
    await guarded.connect('peer', 'https://192.168.1.2:8443/', 'call');
    expect(dialogs.create).not.toHaveBeenCalled();
    expect(endpoint.connect).toHaveBeenNthCalledWith(1, 'peer', 'https://iroh.nostr.com/', 'call');
    expect(endpoint.connect).toHaveBeenCalledTimes(2);
  });

  it.each([
    'https://unfamiliar.example/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://iroh.nostr.com:8443/',
    'https://iroh.nostr.com.attacker.example/',
  ])('does not contact %s before explicit approval', async (url) => {
    const { guarded, endpoint } = harness();
    const connection = guarded.connect('peer', url, 'call');
    expect(endpoint.connect).not.toHaveBeenCalled();
    expect(dialogs.create.mock.calls[0]?.[0].message).toContain(url);
    dialogs.ok();
    dialogs.dismiss();
    await connection;
    expect(endpoint.connect).toHaveBeenCalledWith('peer', url, 'call');
  });

  it('declining does not connect or remember approval', async () => {
    const { guarded, endpoint } = harness();
    const connection = guarded.connect('peer', 'https://other.example/', 'call');
    dialogs.dismiss();
    await expect(connection).rejects.toThrow('not approved');
    expect(endpoint.connect).not.toHaveBeenCalled();
  });

  it('does not persist one-time approval for subsequent connections', async () => {
    const { guarded } = harness();
    const first = guarded.connect('peer', 'https://other.example/', 'call');
    dialogs.ok();
    dialogs.dismiss();
    await first;
    const second = guarded.connect('peer', 'https://other.example/', 'call2');
    expect(dialogs.create).toHaveBeenCalledTimes(2);
    dialogs.dismiss();
    await expect(second).rejects.toThrow('not approved');
  });

  it('ending a call dismisses approval and prevents late approval from connecting', async () => {
    const { guarded, endpoint } = harness();
    const connection = guarded.connect('peer', 'https://other.example/', 'call');
    await guarded.close();
    dialogs.ok();
    await expect(connection).rejects.toThrow('not approved');
    expect(dialogs.hide).toHaveBeenCalledOnce();
    expect(endpoint.close).toHaveBeenCalledOnce();
    expect(endpoint.connect).not.toHaveBeenCalled();
    await expect(guarded.connect('peer', 'https://iroh.nostr.com/', 'call')).rejects.toThrow();
  });

  it.each([
    'http://host/',
    'https://user:pass@host/',
    'https://host/path',
    'https://host/?query',
  ])('rejects malformed relay %s without contacting it or asking for approval', async (url) => {
    const { guarded, endpoint } = harness();
    await expect(guarded.connect('peer', url, 'call')).rejects.toThrow();
    expect(endpoint.connect).not.toHaveBeenCalled();
    expect(dialogs.create).not.toHaveBeenCalled();
  });
});
