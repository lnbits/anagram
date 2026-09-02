import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
} from '@playwright/test';
import type { DeveloperDiagnosticsSnapshot } from 'src/stores/nostr/types';

export interface TestAccount {
  privateKey: string;
  displayName: string;
}

export interface BrowserErrorEntry {
  source: 'console' | 'pageerror';
  text: string;
}

export interface BootstrappedUser {
  account: TestAccount;
  browserErrors: BrowserErrorEntry[];
  context: BrowserContext;
  page: Page;
  session: {
    publicKey: string;
    npub: string | null;
    relayUrls: string[];
  };
}

type ChatRequestItemMatch = string | RegExp | { publicKey: string };

export interface SeededMessageSnapshot {
  id: string;
  chatId: string;
  text: string;
  sentAt: string;
  authorPublicKey: string;
  eventId: string | null;
}

export interface BootstrapUserOptions {
  relayUrls?: string[];
}

export interface BootstrapExtensionUserOptions extends BootstrapUserOptions {
  disableBrowserNotificationsPrompt?: boolean;
}

export const E2E_RELAY_URL = process.env.E2E_RELAY_URL ?? 'ws://127.0.0.1:7000';
export const E2E_RELAY_URL_TWO = process.env.E2E_RELAY_URL_TWO ?? 'ws://127.0.0.1:7001';
export const E2E_RELAY_URL_HANG = process.env.E2E_RELAY_URL_HANG ?? 'ws://127.0.0.1:65534';
export const E2E_RELAY_URL_DELAYED = process.env.E2E_RELAY_URL_DELAYED ?? 'ws://127.0.0.1:7002';
export const E2E_DUAL_RELAY_URLS = [E2E_RELAY_URL, E2E_RELAY_URL_TWO];
export const E2E_HANG_RELAY_PORT = Number.parseInt(new URL(E2E_RELAY_URL_HANG).port, 10) || 7002;

export const TEST_ACCOUNTS = {
  startupRestoreAlice: {
    privateKey: '17109060832c2b13b1280c20c929e17a8b013e1dcb770b9d83ca511d9626e5cb',
    displayName: 'Alice Startup',
  },
  startupRestoreBob: {
    privateKey: 'cefa6999263a9310fa7facb77ef6cfcbc0301e9388fc2316c5158a38ef14f0dc',
    displayName: 'Bob Startup',
  },
  requestAlice: {
    privateKey: 'e0e3310b05ea1dd89ed2ce5bfaf1fdb95a646e45d5812e670c3fa4e98b2f3d47',
    displayName: 'Alice Request',
  },
  requestBob: {
    privateKey: 'c61c6cde623a6acd20f6b4f6e9c6d707226b16e3704d162dd9f79ad996031f25',
    displayName: 'Bob Request',
  },
  actionsAlice: {
    privateKey: '995653b67023e74f41c7b293af1acb99c785b0bf1a727ab457ce92a4142b9956',
    displayName: 'Alice Actions',
  },
  actionsBob: {
    privateKey: 'c25694028321c053f174245104441935f681ce5117a89b27e4263e4360d05433',
    displayName: 'Bob Actions',
  },
  forwardAlice: {
    privateKey: '1111111111111111111111111111111111111111111111111111111111111111',
    displayName: 'Alice Forward',
  },
  forwardBob: {
    privateKey: '2222222222222222222222222222222222222222222222222222222222222222',
    displayName: 'Bob Forward',
  },
  forwardCharlie: {
    privateKey: '3333333333333333333333333333333333333333333333333333333333333333',
    displayName: 'Charlie Forward',
  },
  editAlice: {
    privateKey: '31961dfca6ede2be402f55b0e8c9a224ee208e8cf9500fb4fd4445c56332e875',
    displayName: 'Alice Edit',
  },
  editBob: {
    privateKey: 'e60da1ec37e515453e1a7c692de57e3cafde5873efb84182835401adc6aaed8a',
    displayName: 'Bob Edit',
  },
  markReadAlice: {
    privateKey: '2cdd0f6d4a47bb4502993a61cb0b3cf86cded94311aa87eb0e08652d6d93cd15',
    displayName: 'Alice Mark Read',
  },
  markReadBob: {
    privateKey: 'fe57584f9d6ce2869c1f55fb3c8419fe89e6222cf5f92a019f89a2669482b3dd',
    displayName: 'Bob Mark Read',
  },
  markReadCharlie: {
    privateKey: '8b345418bf7c7cf7cf6f4dc1c4d1a9f3f4a762ec5b8fdf8cbd2f9e4f3cd06dea',
    displayName: 'Charlie Mark Read',
  },
  backgroundUnreadAlice: {
    privateKey: '51673d4b5a0e2bc7f1d9e4c3b2a187650f1e2d3c4b5a69788796a5b4c3d2e101',
    displayName: 'Alice Background Unread',
  },
  backgroundUnreadBob: {
    privateKey: '2c4e6f8091a2b3c4d5e6f70819283746a5b4c3d2e1f001122334455667788990',
    displayName: 'Bob Background Unread',
  },
  reactionReloadAlice: {
    privateKey: 'ed0d7a4610d16dd4ffb0a14fe92cfad11ad2bd575f53dcfc0bbfd799a098ce8e',
    displayName: 'Alice Reactions Reload',
  },
  reactionReloadBob: {
    privateKey: '84fd8f703d01d4f3d724861dd092f6c9c0d9301c56bfda7051be388d6c183ff8',
    displayName: 'Bob Reactions Reload',
  },
  reactionReloadCharlie: {
    privateKey: '31fddc6cddc81e1558b99f4824a0e937da76e2cbf6805ae0e21978b5de29ea11',
    displayName: 'Charlie Reactions Reload',
  },
  profileRefreshAlice: {
    privateKey: 'efe5f8abdf1e13ca96afd16c73bf39c518a98bb4215903b4c64e29ccde36f37c',
    displayName: 'Alice Contact Refresh',
  },
  profileRefreshBob: {
    privateKey: '0d13b78191d3023697245897ff5ca68a7d0616e0d28f44e19122a81722750cd6',
    displayName: 'Bob Contact Refresh',
  },
  relaySettingsAlice: {
    privateKey: 'f0c9fa56ec5c7f9170c5dbf4f3ded6f2f24b02885e8f5e71b95d6a3c5954176f',
    displayName: 'Alice Relay Settings',
  },
  relaySettingsBob: {
    privateKey: '68da0a59c381ef5c80e64a5cbca770c90c06fdd57b39b75c80fc17a4a217de99',
    displayName: 'Bob Relay Settings',
  },
  slowRelayAlice: {
    privateKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    displayName: 'Alice Slow Relay',
  },
  slowRelayBob: {
    privateKey: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    displayName: 'Bob Slow Relay',
  },
  delayedRelayAlice: {
    privateKey: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    displayName: 'Alice Delayed Relay',
  },
  delayedRelayBob: {
    privateKey: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    displayName: 'Bob Delayed Relay',
  },
  groupAlice: {
    privateKey: 'eeb0542ecef525deee036b1865dc872bcda25df86016403ef25a730f330115b2',
    displayName: 'Alice Group',
  },
  groupBob: {
    privateKey: '31eecc51589b4de8f72f07b36cd888c95f339e1caf4f868f88c8ab8cf9f69587',
    displayName: 'Bob Group',
  },
  groupCharlie: {
    privateKey: '55a9153bb5fc61f56063c7984c7e5cdc29aaf157c294a1f495de673b4b74b07f',
    displayName: 'Charlie Group',
  },
  groupRosterOwner: {
    privateKey: '1fd6615ac78925451c2141da6f8571a7c5bf0f2fd2d867dcfbb7d9ee41174950',
    displayName: 'Owner Roster',
  },
  groupRosterBob: {
    privateKey: '4a679b4a47d5481dc7054d48a0c6311f6cf6263f20bdb06ca27453ce38d9f5b6',
    displayName: 'Bob Roster',
  },
  groupRosterCharlie: {
    privateKey: '25e32ef7475673c3bd4dff29bcd91cc0ce355a60431f39183f92cf2d1dcf8fd4',
    displayName: 'Charlie Roster',
  },
  groupRemovalOwner: {
    privateKey: '93b14eb63c3a5da797dc6aa64cade4398866def096f7ae83835024986127c7ce',
    displayName: 'Owner Removal',
  },
  groupRemovalBob: {
    privateKey: '7330a002e102edae7539020f26b90cef6e0f45fff3a50d402f8bcf461d1cd7ad',
    displayName: 'Bob Removal',
  },
  groupRemovalCharlie: {
    privateKey: '68f656c523ca35f7364365d78888e4e64ea8ea92cb1c2ff095ffd697f9914155',
    displayName: 'Charlie Removal',
  },
  groupRestartAlice: {
    privateKey: 'd0648961ad953ab6ff4eb540df0be00016dff25823907f4194a5cd8a1253ed21',
    displayName: 'Alice Restart',
  },
  groupRestartBob: {
    privateKey: 'dab1a69c14f05653be2fcf725d04068cd85214f9dbe09c2ac0fadbd1f9545d4c',
    displayName: 'Bob Restart',
  },
  groupRelayAlice: {
    privateKey: '2483f2c5443f2a4992e6ada11e76d603fbcf52fa97633b315e4c3e3d53ede5bc',
    displayName: 'Alice Relay',
  },
  groupRelayBob: {
    privateKey: '4ace9d0cf7d76251894bfc88418367135d12b3ed9c78b4cd191f04ac17fcec20',
    displayName: 'Bob Relay',
  },
  groupInviteRelayAlice: {
    privateKey: 'c0f1e2d3a4b5c697887766554433221100ffeeddccbbaa998877665544332211',
    displayName: 'Alice Invite Relay',
  },
  groupInviteRelayBob: {
    privateKey: '1f2e3d4c5b6a79888796a5b4c3d2e1f00112233445566778899aabbccddeeff0',
    displayName: 'Bob Invite Relay',
  },
  groupEpochAlice: {
    privateKey: 'f540818766397792222a9722e94b73b780ea7f746aaf2ac763509663246530d4',
    displayName: 'Alice Epoch',
  },
  groupEpochBob: {
    privateKey: 'b646572a31e22409692be6f6d7840812687525e71f4b2abb8673889f9a8507ba',
    displayName: 'Bob Epoch',
  },
  groupEpochHistoryAlice: {
    privateKey: 'c1b0d6e5f2a34789b1c2d3e4f5061728394a5b6c7d8e9fa0b1c2d3e4f5061728',
    displayName: 'Alice Epoch History',
  },
  groupEpochHistoryBob: {
    privateKey: '7a91b4c6d8e0f1234567890abcdef1234567890abcdef1234567890abcdef123',
    displayName: 'Bob Epoch History',
  },
  groupRotateAlice: {
    privateKey: '5b31c34552ff63d834cf3159bd69b42177f6b8e164baec19c4c2aff641bb468a',
    displayName: 'Alice Rotate',
  },
  groupRotateBob: {
    privateKey: 'a225a891658fe37b69b13ea988a098a3687b73760d8bb401e2475e5536613367',
    displayName: 'Bob Rotate',
  },
  dmRestartAlice: {
    privateKey: '6d6a6c562ef4c89ff66e8964e9c424ebb3a3ac59b130cdf118c3caab8a456272',
    displayName: 'Alice DM Restart',
  },
  dmRestartBob: {
    privateKey: '431f4956e15695984eb56874ec8454ddb35260d09c6b3d1857c36b55467f2c7a',
    displayName: 'Bob DM Restart',
  },
  threadSearchAlice: {
    privateKey: '6f7d5ad4b06b9f9ae11e2af7c22f09d16c5b3c1d2aef8b49739b2f0c4da78561',
    displayName: 'Alice Thread Search',
  },
  threadSearchBob: {
    privateKey: '1386d7887d6a2bf6aef9bc97a0fdbf64d127af6eb9f4261d86bc8b2d4fbe2391',
    displayName: 'Bob Thread Search',
  },
  threadPaginationAlice: {
    privateKey: '4444444444444444444444444444444444444444444444444444444444444444',
    displayName: 'Alice Thread Pagination',
  },
  threadPaginationBob: {
    privateKey: '5555555555555555555555555555555555555555555555555555555555555555',
    displayName: 'Bob Thread Pagination',
  },
  isolationAlice: {
    privateKey: '558033f49171bc9bbc4654b411ad5228b5ba3da15326ed16691824a9db03b628',
    displayName: 'Alice Isolation',
  },
  isolationBob: {
    privateKey: '60a6bba9ddf6eaa5ce72df047678d754f43bce4b7f85b412ed3e787e5855fdce',
    displayName: 'Bob Isolation',
  },
  isolationCharlie: {
    privateKey: '600318cd43cd7c80ce7b366dec6b61b1f4c89379adf553d0989d1536797d358d',
    displayName: 'Charlie Isolation',
  },
  mediaSettingsAlice: {
    privateKey: '6666666666666666666666666666666666666666666666666666666666666666',
    displayName: 'Alice Media Settings',
  },
  mediaViewerAlice: {
    privateKey: '7777777777777777777777777777777777777777777777777777777777777777',
    displayName: 'Alice Media Viewer',
  },
  mediaViewerBob: {
    privateKey: '8888888888888888888888888888888888888888888888888888888888888888',
    displayName: 'Bob Media Viewer',
  },
  blockAlice: {
    privateKey: '732cc8f4c9bb1542b025b94aa494a706c9991bbf2dd23ce589cf51f99b0652ff',
    displayName: 'Alice Block',
  },
  blockBob: {
    privateKey: '4d517870c8adca0a6dd678a15ef2c715c55e976a580bac9254e1ffd742141a32',
    displayName: 'Bob Block',
  },
  catchupAlice: {
    privateKey: 'd1994d3490b9bfb6a34196038311697a903150169d67b5bd9fd34bfe21ee2738',
    displayName: 'Alice Catchup',
  },
  catchupBob: {
    privateKey: 'e537a186c1bd3971a314c0d89d3a584cdc451c0649bb8e9152e8ef1707c4bc9b',
    displayName: 'Bob Catchup',
  },
  liveReconnectAlice: {
    privateKey: '1313131313131313131313131313131313131313131313131313131313131313',
    displayName: 'Alice Live Reconnect',
  },
  liveReconnectBob: {
    privateKey: '2424242424242424242424242424242424242424242424242424242424242424',
    displayName: 'Bob Live Reconnect',
  },
  inviteReloadAlice: {
    privateKey: '05f4dc8f76fd7d74ee878ef474d72bf438aadf9b260885efc9808397a1767e21',
    displayName: 'Alice Invite Reload',
  },
  inviteReloadBob: {
    privateKey: '5a8d5cf1ecf2bf8b91b365fe786f6ebed08e575f3c047ae13e23ecf7175f6d2a',
    displayName: 'Bob Invite Reload',
  },
  dedupeAlice: {
    privateKey: '8c81c7aa41878e0d6bc0dc17338550d4b2b4d53ab8f6b5fd59f0e11de079e0fb',
    displayName: 'Alice Dedupe',
  },
  dedupeBob: {
    privateKey: '1572f0a6094f6f5a35b841af4c4414dfa195f4ba597bcdbf287d26d19b56b01b',
    displayName: 'Bob Dedupe',
  },
  pendingAlice: {
    privateKey: '3e711a787707af66dfd5fc8c9f0ac675db8b36e8607974664918db20844d8790',
    displayName: 'Alice Pending',
  },
  pendingBob: {
    privateKey: 'd50a826f2c0aa3df6e6c5271779b2a35cc2310a74ef5c4a03fe9f2bcb724ca6f',
    displayName: 'Bob Pending',
  },
  replyRepairAlice: {
    privateKey: '111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000',
    displayName: 'Alice Reply Repair',
  },
  replyRepairBob: {
    privateKey: '0000ffffeeeeddddccccbbbbaaaa999988887777666655554444333322221111',
    displayName: 'Bob Reply Repair',
  },
  reactionRepairAlice: {
    privateKey: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    displayName: 'Alice Reaction Repair',
  },
  reactionRepairBob: {
    privateKey: 'fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321',
    displayName: 'Bob Reaction Repair',
  },
  groupReplyRepairOwner: {
    privateKey: '0123456789abcdeffedcba98765432100123456789abcdeffedcba9876543210',
    displayName: 'Owner Reply Repair',
  },
  groupReplyRepairBob: {
    privateKey: '89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567',
    displayName: 'Bob Group Reply Repair',
  },
  groupAddOwner: {
    privateKey: '9c7d9d7d4be1da67a61a15403d5a33ad655b2671a6ab33096a3b0a286cc94601',
    displayName: 'Owner Add Member',
  },
  groupAddBob: {
    privateKey: 'd6e5cdb44b4ff964f1c95e66c245bc0c8f0d7e0680e7e4d5ab1ca0e805a67112',
    displayName: 'Bob Add Member',
  },
  groupAddCharlie: {
    privateKey: '8b93e19a369b0d2b8d2e2740f67d9ef4e5ad78631228008b28cdbac8f4e92613',
    displayName: 'Charlie Add Member',
  },
  groupRemovalReloadOwner: {
    privateKey: '4898bf4298bd3344f8ef4e62ecf80732af868b8d632e71c3e1b5b0902efb75e5',
    displayName: 'Owner Removal Reload',
  },
  groupRemovalReloadBob: {
    privateKey: '5b285e2f96de3060a7be8221aa54ff2dcf9fd555bb23868479d5b618312ab7b6',
    displayName: 'Bob Removal Reload',
  },
  groupRemovalReloadCharlie: {
    privateKey: 'cf35636e7f76073095ebcc917fd671660fbaad12dcbe2f31466a4c8129a93f98',
    displayName: 'Charlie Removal Reload',
  },
  nip07Alice: {
    privateKey: '76ec52db82ff04779c1ebfdf67ee2e27b8e8bccfd4f0d4f6fd1fe2ac8f59b882',
    displayName: 'Alice NIP07',
  },
  nip07Bob: {
    privateKey: '49df67d0df4b2a827eb96611db2390d2f34bf220cf86cbc85d8f0dabfb84847c',
    displayName: 'Bob NIP07',
  },
} as const;

const dockerComposeArgs = ['compose', '-f', 'docker-compose.e2e.yml'];
const dockerCommand = process.platform === 'win32' ? 'docker.exe' : 'docker';
const commandEnv = buildCommandEnv();
const pendingLogoutCleanupSessionKey = 'nostr-chat-pending-logout-cleanup';
const relayPortsByService = {
  relay: 7000,
  'relay-two': 7001,
} as const;

function buildCommandEnv(): NodeJS.ProcessEnv {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extraPathEntries: string[] = [];

  if (process.platform === 'darwin') {
    extraPathEntries.push(
      '/Applications/Docker.app/Contents/Resources/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin'
    );
  }

  return {
    ...process.env,
    PATH: [
      ...new Set([...extraPathEntries.filter((entry) => fs.existsSync(entry)), ...pathEntries]),
    ].join(path.delimiter),
  };
}

function createRelayEntries(relayUrls: string[]) {
  return relayUrls.map((url) => ({
    url,
    read: true,
    write: true,
  }));
}

function attachBrowserErrorTracking(page: Page): BrowserErrorEntry[] {
  const browserErrors: BrowserErrorEntry[] = [];

  page.on('console', (message) => {
    if (message.type() !== 'error') {
      return;
    }

    browserErrors.push({
      source: 'console',
      text: message.text(),
    });
  });

  page.on('pageerror', (error) => {
    browserErrors.push({
      source: 'pageerror',
      text: error.message,
    });
  });

  return browserErrors;
}

function runDockerCompose(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      dockerCommand,
      [...dockerComposeArgs, ...args],
      {
        env: commandEnv,
      },
      (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      }
    );

    child.stdin?.end();
  });
}

function waitForTcpPort(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  return new Promise<void>((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.createConnection({
        host: '127.0.0.1',
        port,
      });

      socket.once('connect', () => {
        socket.end();
        resolve();
      });

      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`Timed out waiting for relay port ${port}.`));
          return;
        }

        globalThis.setTimeout(tryConnect, 400);
      });
    };

    tryConnect();
  });
}

async function seedRelayStorage(
  context: BrowserContext,
  relayUrls: string[],
  options: {
    disableBrowserNotificationsPrompt?: boolean;
  } = {}
): Promise<void> {
  const relayEntries = createRelayEntries(relayUrls);
  await context.addInitScript(
    ({ nextRelayEntries, disableBrowserNotificationsPrompt, pendingLogoutCleanupKey }) => {
      const storedRelays = window.localStorage.getItem('relays');
      if (
        window.sessionStorage.getItem(pendingLogoutCleanupKey) !== '1' &&
        (!storedRelays || storedRelays.trim().length === 0)
      ) {
        window.localStorage.setItem('relays', JSON.stringify(nextRelayEntries));
      }
      if (disableBrowserNotificationsPrompt) {
        const notificationMock = Object.assign(function NotificationMock() {}, {
          permission: 'denied' as NotificationPermission,
          requestPermission: async (): Promise<NotificationPermission> => 'denied',
        });

        Object.defineProperty(window, 'Notification', {
          configurable: true,
          value: notificationMock,
        });
      }
    },
    {
      nextRelayEntries: relayEntries,
      disableBrowserNotificationsPrompt: options.disableBrowserNotificationsPrompt === true,
      pendingLogoutCleanupKey: pendingLogoutCleanupSessionKey,
    }
  );
}

async function installNip07Mock(
  context: BrowserContext,
  account: TestAccount,
  relayUrls: string[]
): Promise<void> {
  const { NDKPrivateKeySigner, NDKUser } = await import('@nostr-dev-kit/ndk');
  const signer = new NDKPrivateKeySigner(account.privateKey);
  const relayMap = Object.fromEntries(
    relayUrls.map((relayUrl) => [
      relayUrl,
      {
        read: true,
        write: true,
      },
    ])
  );

  await context.exposeFunction('__e2eNip07GetPublicKey', async () => signer.pubkey);
  await context.exposeFunction('__e2eNip07SignEvent', async (event: Record<string, unknown>) => {
    const sig = await signer.sign(event as never);
    return { sig };
  });
  await context.exposeFunction(
    '__e2eNip07Encrypt',
    async (recipientPubkey: string, value: string, scheme?: 'nip04' | 'nip44') => {
      return signer.encrypt(new NDKUser({ pubkey: recipientPubkey }), value, scheme ?? 'nip44');
    }
  );
  await context.exposeFunction(
    '__e2eNip07Decrypt',
    async (senderPubkey: string, value: string, scheme?: 'nip04' | 'nip44') => {
      return signer.decrypt(new NDKUser({ pubkey: senderPubkey }), value, scheme ?? 'nip44');
    }
  );
  await context.exposeFunction('__e2eNip07GetRelays', async () => relayMap);
  await context.addInitScript(() => {
    const nip04 = {
      decrypt: (pubkey: string, value: string) => window.__e2eNip07Decrypt(pubkey, value, 'nip04'),
      encrypt: (pubkey: string, value: string) => window.__e2eNip07Encrypt(pubkey, value, 'nip04'),
    };
    const nip44 = {
      decrypt: (pubkey: string, value: string) => window.__e2eNip07Decrypt(pubkey, value, 'nip44'),
      encrypt: (pubkey: string, value: string) => window.__e2eNip07Encrypt(pubkey, value, 'nip44'),
    };

    Object.defineProperty(window, 'nostr', {
      configurable: true,
      value: {
        getPublicKey: () => window.__e2eNip07GetPublicKey(),
        getRelays: () => window.__e2eNip07GetRelays(),
        nip04,
        nip44,
        signEvent: (event: Record<string, unknown>) => window.__e2eNip07SignEvent(event),
      },
    });
  });
}

function composerInput(page: Page) {
  return page.getByPlaceholder('Write a message');
}

function threadSearchInput(page: Page) {
  return page.getByTestId('thread-search-input');
}

function contactLookupIdentifierInput(page: Page) {
  return page.getByLabel('Identifier or Public key');
}

function contactLookupGivenNameInput(page: Page) {
  return page.getByLabel('Given Name');
}

function threadMessages(page: Page, text: string) {
  return page.locator('.thread-message-entry').filter({ hasText: text });
}

function resolveChatItem(page: Page, match?: string | RegExp) {
  const chatItems = page.getByTestId('chat-item');
  if (typeof match === 'undefined') {
    return chatItems.first();
  }

  return chatItems.filter({ hasText: match }).first();
}

function groupMemberListItem(page: Page, memberPublicKey: string) {
  return page
    .locator('.profile-members-list .q-item')
    .filter({ hasText: memberPublicKey.slice(0, 16) })
    .first();
}

function chatRequestItem(page: Page, match?: ChatRequestItemMatch) {
  const requestItems = page.getByTestId('chat-request-item');
  if (typeof match === 'undefined') {
    return requestItems.first();
  }

  if (typeof match === 'object' && 'publicKey' in match) {
    return page
      .locator(
        `[data-testid="chat-request-item"][data-chat-public-key="${match.publicKey.trim().toLowerCase()}"]`
      )
      .first();
  }

  return requestItems.filter({ hasText: match }).first();
}

function isTransientClickError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /element was detached|element is not stable|element is not enabled|Timeout .* exceeded|Timed out|Received: disabled|unexpected value "disabled"/.test(
    message
  );
}

async function clickEnabledLocator(
  page: Page,
  locate: () => Locator,
  options: { attempts?: number; timeoutMs?: number } = {}
): Promise<void> {
  const attempts = options.attempts ?? 4;
  const timeoutMs = options.timeoutMs ?? 6_000;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const locator = locate();
    try {
      await expect(locator).toBeVisible({ timeout: timeoutMs });
      await expect(locator).toBeEnabled({ timeout: timeoutMs });
      await locator.click({ timeout: timeoutMs });
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientClickError(error) || attempt === attempts - 1) {
        throw error;
      }
      await page.waitForTimeout(250 * (attempt + 1));
    }
  }

  throw lastError;
}

export function threadMessage(page: Page, text: string) {
  return threadMessages(page, text).last();
}

async function waitForChatsShell(page: Page): Promise<void> {
  const startNewChatButton = page.getByTestId('start-new-chat-button');

  await page.goto('/#/chats');
  await waitForAppBridge(page);

  try {
    await expect(startNewChatButton).toBeVisible({ timeout: 15_000 });
  } catch {
    await refreshSession(page);
    await page.goto('/#/chats');
    await waitForAppBridge(page);
    await expect(startNewChatButton).toBeVisible({ timeout: 30_000 });
  }
}

export async function bootstrapSessionOnPage(
  page: Page,
  account: TestAccount,
  options: BootstrapUserOptions = {}
): Promise<BootstrappedUser['session']> {
  const relayUrls =
    Array.isArray(options.relayUrls) && options.relayUrls.length > 0
      ? options.relayUrls
      : [E2E_RELAY_URL];

  await seedRelayStorage(page.context(), relayUrls, {
    disableBrowserNotificationsPrompt: true,
  });
  await page.goto('/#/login');

  const bootstrapResult = await evaluateWithAppBridgeRetry(
    page,
    async ({ privateKey, relayUrls }) => {
      const bridge = window.__appE2E__;
      if (!bridge) {
        return { ok: false, message: 'E2E bridge is not available.' };
      }

      try {
        await bridge.bootstrapSession({
          privateKey,
          relayUrls,
        });
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }

      return { ok: true };
    },
    {
      privateKey: account.privateKey,
      relayUrls,
    }
  );

  if (!bootstrapResult.ok) {
    throw new Error(`E2E bootstrap failed: ${bootstrapResult.message}`);
  }

  const session = await evaluateWithAppBridgeRetry(
    page,
    async () => {
      const bridge = window.__appE2E__;
      if (!bridge) {
        throw new Error('E2E bridge is not available.');
      }

      return bridge.getSessionSnapshot();
    },
    null
  );

  await waitForChatsShell(page);

  return session;
}

export async function bootstrapUser(
  browser: Browser,
  account: TestAccount,
  options: BootstrapUserOptions = {}
): Promise<BootstrappedUser> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const browserErrors = attachBrowserErrorTracking(page);
  const session = await bootstrapSessionOnPage(page, account, options);

  return {
    account,
    browserErrors,
    context,
    page,
    session,
  };
}

export async function bootstrapExtensionUser(
  browser: Browser,
  account: TestAccount,
  options: BootstrapExtensionUserOptions = {}
): Promise<BootstrappedUser> {
  const relayUrls =
    Array.isArray(options.relayUrls) && options.relayUrls.length > 0
      ? options.relayUrls
      : [E2E_RELAY_URL];
  const context = await browser.newContext();
  await seedRelayStorage(context, relayUrls, {
    disableBrowserNotificationsPrompt: options.disableBrowserNotificationsPrompt !== false,
  });
  await installNip07Mock(context, account, relayUrls);
  const page = await context.newPage();
  const browserErrors = attachBrowserErrorTracking(page);

  await page.goto('/#/login');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await page.getByRole('button', { name: 'Login with Extension', exact: true }).click();
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="auth-onboarding-relays-next-button"]')),
    undefined,
    { timeout: 30_000 }
  );
  await page.getByTestId('auth-onboarding-relays-next-button').click();

  await page.waitForFunction(
    () =>
      Boolean(
        document.querySelector('[data-testid="auth-onboarding-continue-button"]') ||
          document.querySelector('[data-testid="auth-onboarding-profile-start-button"]') ||
          document.querySelector('[data-testid="auth-onboarding-skip-button"]')
      ),
    undefined,
    { timeout: 30_000 }
  );

  const continueButton = page.getByTestId('auth-onboarding-continue-button');
  if (await continueButton.isVisible()) {
    await continueButton.click();
  } else if (await page.getByTestId('auth-onboarding-profile-start-button').isVisible()) {
    await page.getByTestId('auth-onboarding-profile-start-button').click();
  } else {
    await page.getByTestId('auth-onboarding-skip-button').click();
  }

  if (await page.getByText('Enable Browser Notifications', { exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Not now', exact: true }).click();
  }

  await expect.poll(() => page.url(), { timeout: 30_000 }).toMatch(/#\/chats$/);

  await waitForChatsShell(page);

  const session = await page.evaluate(async () => {
    const bridge = window.__appE2E__;
    if (!bridge) {
      throw new Error('E2E bridge is not available.');
    }

    return bridge.getSessionSnapshot();
  });

  return {
    account,
    browserErrors,
    context,
    page,
    session,
  };
}

export async function disposeUsers(...users: BootstrappedUser[]): Promise<void> {
  await Promise.all(
    users.map(async (user) => {
      try {
        await user.context.close();
      } catch {
        // Playwright may already have closed the context after a timeout.
      }
    })
  );
}

export async function waitForAppBridge(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(window.__appE2E__), undefined, {
    timeout: 30_000,
  });

  await page.evaluate(async () => {
    const bridge = window.__appE2E__;
    if (!bridge) {
      throw new Error('E2E bridge is not available.');
    }

    await bridge.waitForAppReady();
  });
}

function isRetryableReloadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('ERR_CONNECTION_REFUSED') ||
    message.includes('ERR_CONNECTION_RESET') ||
    message.includes('ERR_ABORTED')
  );
}

function isRetryableExecutionContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Execution context was destroyed') ||
    message.includes('Cannot find context with specified id') ||
    message.includes('Most likely because of a navigation')
  );
}

async function evaluateWithAppBridgeRetry<Arg, Result>(
  page: Page,
  pageFunction: (arg: Arg) => Promise<Result> | Result,
  arg: Arg
): Promise<Result> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitForAppBridge(page);

    try {
      return await page.evaluate(pageFunction as never, arg);
    } catch (error) {
      lastError = error;
      if (!isRetryableExecutionContextError(error) || attempt === 2) {
        throw error;
      }

      await page.waitForTimeout(250 * (attempt + 1));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to evaluate in the app bridge context.');
}

export async function reloadAndWaitForApp(page: Page): Promise<void> {
  const currentUrl = page.url();
  const fallbackUrl = currentUrl && currentUrl !== 'about:blank' ? currentUrl : '/';
  let lastError: unknown = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (attempt === 0) {
        await page.reload();
      } else {
        await page.goto(fallbackUrl, {
          waitUntil: 'load',
        });
      }
      await waitForAppBridge(page);
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableReloadError(error) || attempt === 2) {
        throw error;
      }

      await page.waitForTimeout(500 * (attempt + 1));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to reload and wait for the app.');
}

export async function expectNoUnexpectedBrowserErrors(
  users: BootstrappedUser | BootstrappedUser[],
  options: {
    allowPatterns?: RegExp[];
  } = {}
): Promise<void> {
  const allowPatterns = Array.isArray(options.allowPatterns) ? options.allowPatterns : [];
  const userList = Array.isArray(users) ? users : [users];
  const unexpectedErrors = userList.flatMap((user) =>
    user.browserErrors.filter((entry) => !allowPatterns.some((pattern) => pattern.test(entry.text)))
  );

  expect(unexpectedErrors.map((entry) => `${entry.source}: ${entry.text}`)).toEqual([]);
}

export async function refreshSession(page: Page, chatId?: string): Promise<void> {
  await evaluateWithAppBridgeRetry(
    page,
    async ({ nextChatId }) => {
      const bridge = window.__appE2E__;
      if (!bridge) {
        throw new Error('E2E bridge is not available.');
      }

      await bridge.refreshSession({
        chatId: nextChatId,
      });
    },
    { nextChatId: chatId ?? null }
  );
}

export async function getDeveloperDiagnosticsSnapshot(
  page: Page
): Promise<DeveloperDiagnosticsSnapshot> {
  return evaluateWithAppBridgeRetry(
    page,
    async () => {
      const bridge = window.__appE2E__;
      if (!bridge) {
        throw new Error('E2E bridge is not available.');
      }

      return bridge.getDeveloperDiagnosticsSnapshot();
    },
    null
  );
}

export async function refreshPrivateMessagesLiveReconnect(
  page: Page,
  options: {
    forceRecreate?: boolean;
  } = {}
): Promise<DeveloperDiagnosticsSnapshot> {
  return evaluateWithAppBridgeRetry(
    page,
    async ({ nextForceRecreate }) => {
      const bridge = window.__appE2E__;
      if (!bridge) {
        throw new Error('E2E bridge is not available.');
      }

      return bridge.refreshPrivateMessagesLiveReconnect({
        forceRecreate: nextForceRecreate,
      });
    },
    {
      nextForceRecreate: options.forceRecreate,
    }
  );
}

export async function setAppVisibility(
  page: Page,
  options: {
    visibilityState: 'visible' | 'hidden';
    hasFocus: boolean;
  }
): Promise<void> {
  await page.evaluate(
    ({ nextVisibilityState, nextHasFocus }) => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => nextVisibilityState,
      });
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => nextVisibilityState !== 'visible',
      });
      Object.defineProperty(document, 'hasFocus', {
        configurable: true,
        value: () => nextHasFocus,
      });

      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event(nextHasFocus ? 'focus' : 'blur'));
    },
    {
      nextVisibilityState: options.visibilityState,
      nextHasFocus: options.hasFocus,
    }
  );
}

export async function pullToRefresh(page: Page, testId: string): Promise<void> {
  const pullArea = page.getByTestId(testId);
  await expect(pullArea).toBeVisible();

  const bounds = await pullArea.boundingBox();
  if (!bounds) {
    throw new Error(`Pull-to-refresh area ${testId} has no visible bounds.`);
  }

  const startX = bounds.x + bounds.width / 2;
  const startY = bounds.y + Math.min(32, bounds.height / 4);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + 100, { steps: 10 });
  await page.mouse.up();
}

export async function openDirectChatFromIdentifier(
  page: Page,
  identifier: string,
  givenName: string
): Promise<void> {
  await page.getByTestId('start-new-chat-button').click();
  await page.getByTestId('start-new-chat-menu-item').click();
  await expect(contactLookupIdentifierInput(page)).toBeVisible();
  await contactLookupIdentifierInput(page).fill(identifier);
  await contactLookupGivenNameInput(page).fill(givenName);
  await page.getByTestId('contact-lookup-submit').click();
  await page.waitForURL(new RegExp(`#\\/chats\\/${identifier}$`));
  await expect(composerInput(page)).toBeVisible();
}

export async function createGroup(
  page: Page,
  options: {
    name: string;
    about: string;
  }
): Promise<string> {
  await page.getByTestId('start-new-chat-button').click();
  await page.getByTestId('start-new-group-menu-item').click();
  await expect(page.getByTestId('create-group-dialog')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill(options.name);
  await page.getByLabel('About', { exact: true }).fill(options.about);
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await page.waitForURL(/#\/contacts\/([0-9a-f]{64})/, { timeout: 20_000 });

  const match = page.url().match(/#\/contacts\/([0-9a-f]{64})/);
  if (!match?.[1]) {
    throw new Error('Failed to read the created group public key from the URL.');
  }

  return match[1];
}

export async function openGroupContact(page: Page, groupPublicKey: string): Promise<void> {
  await page.evaluate(
    async ({ nextGroupPublicKey }) => {
      const bridge = window.__appE2E__;
      if (!bridge) {
        throw new Error('E2E bridge is not available.');
      }

      await bridge.waitForAppReady({
        contactPublicKey: nextGroupPublicKey,
      });
    },
    { nextGroupPublicKey: groupPublicKey }
  );
  await page.goto(`/#/contacts/${groupPublicKey}`);
  await page.evaluate(
    async ({ nextGroupPublicKey }) => {
      const bridge = window.__appE2E__;
      if (!bridge) {
        throw new Error('E2E bridge is not available.');
      }

      await bridge.waitForAppReady({
        contactPublicKey: nextGroupPublicKey,
      });
    },
    { nextGroupPublicKey: groupPublicKey }
  );
  await expect(page.getByTestId('contact-profile-epochs-tab')).toBeVisible();
}

export async function acceptAppRelayFallbackIfVisible(page: Page): Promise<boolean> {
  try {
    await page.getByText('Use App Relays', { exact: true }).waitFor({
      state: 'visible',
      timeout: 1_500,
    });
  } catch {
    return false;
  }

  await page.getByText('Remember this', { exact: true }).click();
  await page.getByRole('button', { name: 'Yes' }).click();
  return true;
}

export async function waitForThreadMessage(
  page: Page,
  text: string,
  options: {
    chatId?: string;
    attempts?: number;
    timeoutMs?: number;
  } = {}
): Promise<void> {
  const message = threadMessage(page, text);
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 12_000;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await expect(message).toBeVisible({ timeout: timeoutMs });
      return;
    } catch (error) {
      if (attempt === attempts - 1) {
        throw error;
      }

      await refreshSession(page, options.chatId);
    }
  }
}

export async function sendMessage(
  page: Page,
  text: string,
  options: {
    chatId?: string;
    attempts?: number;
    timeoutMs?: number;
  } = {}
): Promise<void> {
  await expect(composerInput(page)).toBeVisible();
  await composerInput(page).fill(text);
  await page.getByTestId('message-composer-send').click();
  await acceptAppRelayFallbackIfVisible(page);
  await waitForThreadMessage(page, text, options);
}

export async function sendMessageAndMeasureOptimisticRender(
  page: Page,
  text: string
): Promise<number> {
  await expect(composerInput(page)).toBeVisible();
  await composerInput(page).fill(text);

  return page.getByTestId('message-composer-send').evaluate(async (button, expectedText) => {
    const startedAt = performance.now();
    (button as HTMLButtonElement).click();
    while (performance.now() - startedAt < 500) {
      const hasMessage = Array.from(
        document.querySelectorAll<HTMLElement>('.thread-message-entry')
      ).some((entry) => entry.textContent?.includes(expectedText));
      if (hasMessage) {
        return performance.now() - startedAt;
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    throw new Error('The optimistic message did not render within 500ms.');
  }, text);
}

export async function sendMessagesViaBridge(
  page: Page,
  chatId: string,
  texts: string[],
  options: {
    createdAts?: string[];
  } = {}
): Promise<SeededMessageSnapshot[]> {
  return evaluateWithAppBridgeRetry(
    page,
    async ({ nextChatId, nextTexts, nextCreatedAts }) => {
      const bridge = window.__appE2E__;
      if (!bridge) {
        throw new Error('E2E bridge is not available.');
      }

      return bridge.sendMessages({
        chatId: nextChatId,
        texts: nextTexts,
        createdAts: nextCreatedAts,
      });
    },
    {
      nextChatId: chatId,
      nextTexts: texts,
      nextCreatedAts: options.createdAts ?? [],
    }
  );
}

export async function removeStoredMessageByEventId(
  page: Page,
  chatId: string,
  eventId: string
): Promise<void> {
  const removed = await evaluateWithAppBridgeRetry(
    page,
    async ({ nextChatId, nextEventId }) => {
      const bridge = window.__appE2E__;
      if (!bridge) {
        throw new Error('E2E bridge is not available.');
      }

      return bridge.removeStoredMessageByEventId({
        chatId: nextChatId,
        eventId: nextEventId,
      });
    },
    {
      nextChatId: chatId,
      nextEventId: eventId,
    }
  );

  expect(removed).toBe(true);
}

export async function openThreadSearch(page: Page): Promise<void> {
  await page.getByTestId('thread-search-open-button').click();
  await expect(threadSearchInput(page)).toBeVisible();
}

export async function searchThreadMessages(page: Page, query: string): Promise<void> {
  await openThreadSearch(page);
  await threadSearchInput(page).fill(query);
}

export async function waitForThreadSearchStatus(page: Page, statusText: string): Promise<void> {
  await expect(page.getByTestId('thread-search-status')).toHaveText(statusText, {
    timeout: 12_000,
  });
}

export async function openPreviousThreadSearchResult(page: Page): Promise<void> {
  await page.getByTestId('thread-search-prev-button').click();
}

export async function openNextThreadSearchResult(page: Page): Promise<void> {
  await page.getByTestId('thread-search-next-button').click();
}

export async function waitForThreadSearchFocusedMessage(page: Page, text: string): Promise<void> {
  const message = threadMessage(page, text);
  await expect(message).toBeVisible({ timeout: 12_000 });
  await expect(message).toHaveClass(/thread-message-entry--target-search/, {
    timeout: 12_000,
  });
}

export async function openRequests(page: Page, match?: ChatRequestItemMatch): Promise<void> {
  const requestItem = chatRequestItem(page, match);
  await page.goto('/#/chats/requests');

  try {
    await expect(requestItem).toBeVisible({ timeout: 12_000 });
  } catch {
    await refreshSession(page);
    await page.goto('/#/chats/requests');
  }

  await expect(requestItem).toBeVisible({ timeout: 12_000 });
}

export async function acceptFirstRequest(page: Page, match?: ChatRequestItemMatch): Promise<void> {
  const requestItem = chatRequestItem(page, match);
  await requestItem.getByTestId('chat-request-accept-button').click();
  if (typeof match !== 'undefined') {
    await expect(requestItem).toHaveCount(0);
    return;
  }

  await expect(page.getByTestId('chat-request-item')).toHaveCount(0);
}

export async function expectPrivateContactListMember(page: Page, publicKey: string): Promise<void> {
  await expect
    .poll(
      async () =>
        evaluateWithAppBridgeRetry(
          page,
          async ({ nextPublicKey }) => {
            const bridge = window.__appE2E__;
            if (!bridge) {
              throw new Error('E2E bridge is not available.');
            }

            return bridge.isPrivateContactListMember({ publicKey: nextPublicKey });
          },
          { nextPublicKey: publicKey }
        ),
      { timeout: 12_000 }
    )
    .toBe(true);
}

export async function navigateToChat(page: Page, publicKey: string): Promise<void> {
  await page.goto(`/#/chats/${publicKey}`);
  await expect(composerInput(page)).toBeVisible();
}

export async function waitForChatPreview(
  page: Page,
  previewText: string,
  match?: string | RegExp
): Promise<void> {
  await expect(resolveChatItem(page, match)).toContainText(previewText, {
    timeout: 12_000,
  });
}

export async function waitForChatUnreadCount(
  page: Page,
  count: number,
  match?: string | RegExp
): Promise<void> {
  await expect(resolveChatItem(page, match).locator('.chat-item__meta .q-badge')).toHaveText(
    String(count),
    {
      timeout: 12_000,
    }
  );
}

export async function waitForChatUnreadBadge(page: Page, match?: string | RegExp): Promise<void> {
  await expect(resolveChatItem(page, match).locator('.chat-item__meta .q-badge')).toBeVisible({
    timeout: 12_000,
  });
}

export async function waitForNoChatUnreadBadge(page: Page, match?: string | RegExp): Promise<void> {
  await expect(resolveChatItem(page, match).locator('.chat-item__meta .q-badge')).toHaveCount(0, {
    timeout: 12_000,
  });
}

export async function waitForUnreadChatTotalBadge(page: Page, count: number): Promise<void> {
  await expect(page.locator('.nav-rail__badge, .mobile-nav__badge').first()).toHaveText(
    String(count),
    {
      timeout: 12_000,
    }
  );
}

export async function waitForNoUnreadChatTotalBadge(page: Page): Promise<void> {
  await expect(page.locator('.nav-rail__badge, .mobile-nav__badge')).toHaveCount(0, {
    timeout: 12_000,
  });
}

export async function waitForChatReactionBadge(
  page: Page,
  count: number,
  match?: string | RegExp
): Promise<void> {
  await expect(resolveChatItem(page, match).locator('.chat-item__reaction-badge')).toHaveAttribute(
    'aria-label',
    `${count} unseen reactions`,
    {
      timeout: 12_000,
    }
  );
}

export async function openChatActions(page: Page, match?: string | RegExp): Promise<void> {
  const actionsButton = resolveChatItem(page, match).getByTestId('chat-item-actions-button');
  await expect(actionsButton).toBeVisible({ timeout: 12_000 });
  await actionsButton.scrollIntoViewIfNeeded();

  try {
    await actionsButton.click({ timeout: 12_000 });
  } catch {
    await actionsButton.dispatchEvent('click');
  }
}

export async function markChatAsRead(page: Page, match?: string | RegExp): Promise<void> {
  await openChatActions(page, match);
  await page.getByText('Mark as Read', { exact: true }).click();
  await waitForNoChatUnreadBadge(page, match);
}

export async function reactToMessage(
  page: Page,
  text: string,
  reactionLabel = 'thumbs up'
): Promise<void> {
  await openMessageActions(page, text);
  await page.getByLabel(`React with ${reactionLabel}`).click();
  await acceptAppRelayFallbackIfVisible(page);
}

async function openMessageActions(page: Page, text: string): Promise<void> {
  await threadMessage(page, text).locator('.bubble').click({ button: 'right' });
}

export async function waitForReaction(
  page: Page,
  reactionLabel: RegExp,
  options: {
    chatId?: string;
  } = {}
): Promise<void> {
  const reaction = page.getByLabel(reactionLabel).first();

  try {
    await expect(reaction).toBeVisible({ timeout: 12_000 });
    return;
  } catch {
    await refreshSession(page, options.chatId);
  }

  await expect(reaction).toBeVisible({ timeout: 12_000 });
}

export async function replyToMessage(
  page: Page,
  targetText: string,
  replyText: string,
  options: {
    chatId?: string;
  } = {}
): Promise<void> {
  await openMessageActions(page, targetText);
  await page.getByText('Reply', { exact: true }).click();
  await expect(page.locator('.composer__reply')).toBeVisible({ timeout: 12_000 });
  await sendMessage(page, replyText, options);
}

export async function forwardMessage(
  page: Page,
  text: string,
  destinationName: string,
  options: {
    publicKey?: string;
  } = {}
): Promise<void> {
  await threadMessage(page, text)
    .locator('.bubble')
    .click({
      button: 'right',
      position: { x: 4, y: 4 },
    });
  await page.getByText('Forward', { exact: true }).click();
  const list = page.getByTestId('forward-message-chat-list');
  await expect(list).toBeVisible({
    timeout: 12_000,
  });
  await expect(page.getByTestId('forward-message-chat').first()).toBeVisible({
    timeout: 15_000,
  });

  const search = page.getByTestId('forward-message-search');
  const normalizedPublicKey = options.publicKey?.trim().toLowerCase() ?? '';
  const destinationByName = list.getByTestId('forward-message-chat').filter({
    hasText: destinationName,
  });
  const destinationByKey = normalizedPublicKey
    ? page.locator(
        `[data-testid="forward-message-chat"][data-chat-public-key="${normalizedPublicKey}"]`
      )
    : destinationByName;
  const destination = destinationByName.or(destinationByKey);

  if (await search.isVisible()) {
    await search.fill(destinationName);
  }

  try {
    await expect(destination.first()).toBeVisible({ timeout: 8_000 });
  } catch (error) {
    if (!normalizedPublicKey || !(await search.isVisible())) {
      throw error;
    }

    await search.fill(normalizedPublicKey);
    await expect(destinationByKey).toBeVisible({ timeout: 12_000 });
  }

  await destination.first().click();
  await acceptAppRelayFallbackIfVisible(page);
  await expect(page.getByTestId('forward-message-chat-list')).toHaveCount(0, {
    timeout: 12_000,
  });
}

export async function editMessage(
  page: Page,
  originalText: string,
  editedText: string,
  options: {
    chatId?: string;
  } = {}
): Promise<void> {
  await openMessageActions(page, originalText);
  await page.getByTestId('message-edit-action').click();
  await expect(page.getByTestId('composer-edit-preview')).toContainText(originalText);
  await composerInput(page).fill(editedText);
  await page.getByTestId('message-composer-send').click();
  await acceptAppRelayFallbackIfVisible(page);
  await waitForThreadMessage(page, editedText, options);
  await expect(threadMessages(page, originalText)).toHaveCount(0);
}

export async function openReplyPreview(page: Page, replyText: string): Promise<void> {
  await threadMessage(page, replyText).locator('.bubble__reply-preview').click();
}

export async function waitForReplyPreviewText(
  page: Page,
  replyText: string,
  previewText: string
): Promise<void> {
  await expect(threadMessage(page, replyText).locator('.bubble__reply-preview-text')).toContainText(
    previewText,
    {
      timeout: 12_000,
    }
  );
}

export async function deleteMessage(page: Page, text: string): Promise<void> {
  await openMessageActions(page, text);
  await page.getByText('Delete', { exact: true }).click();
}

export async function waitForReactionCount(
  page: Page,
  reactionLabel: RegExp,
  count: number
): Promise<void> {
  await expect(page.getByLabel(reactionLabel)).toHaveCount(count, {
    timeout: 12_000,
  });
}

export async function expectPendingMessageRelayStatus(page: Page, text: string): Promise<void> {
  await expect(threadMessage(page, text).locator('.bubble__status--pending')).toBeVisible({
    timeout: 12_000,
  });
}

export async function expectPublishedMessageRelayStatus(page: Page, text: string): Promise<void> {
  const message = threadMessage(page, text);
  await expect(message.locator('.bubble__status')).toBeVisible({
    timeout: 12_000,
  });
  await expect(message.locator('.bubble__status--pending')).toHaveCount(0, {
    timeout: 12_000,
  });
  await expect(message.locator('.bubble__status-segment--green')).toBeVisible({
    timeout: 12_000,
  });
}

export async function openMessageRelayStatusDialog(page: Page, text: string): Promise<void> {
  const statusDialogTitle = page.getByText('Relay Status', { exact: true });
  if (await statusDialogTitle.isVisible().catch(() => false)) {
    return;
  }

  await threadMessage(page, text).locator('.bubble__status-hitbox').click();
  await expect(statusDialogTitle).toBeVisible({
    timeout: 12_000,
  });
}

async function visibleRelayStatusRoot(page: Page): Promise<Page | Locator> {
  const tabPanels = [
    page.getByTestId('relay-status-panel-recipient'),
    page.getByTestId('relay-status-panel-self'),
  ];

  for (const tabPanel of tabPanels) {
    if (await tabPanel.isVisible().catch(() => false)) {
      return tabPanel;
    }
  }

  return page;
}

export async function retryMessageRelay(page: Page, text: string, relayUrl: string): Promise<void> {
  await openMessageRelayStatusDialog(page, text);
  const statusRoot = await visibleRelayStatusRoot(page);
  const retryButtons = statusRoot
    .locator('.bubble__status-list-item--dialog')
    .filter({ hasText: relayUrl })
    .getByRole('button', { name: 'Retry', exact: true });
  await expect(retryButtons.first()).toBeVisible({ timeout: 12_000 });
  await retryButtons.first().click();
}

export async function waitForMessageRelayRetryToResolve(
  page: Page,
  text: string,
  relayUrl: string
): Promise<void> {
  await openMessageRelayStatusDialog(page, text);
  const statusRoot = await visibleRelayStatusRoot(page);
  const retryButtons = statusRoot
    .locator('.bubble__status-list-item--dialog')
    .filter({ hasText: relayUrl })
    .getByRole('button', { name: 'Retry', exact: true });
  await expect(retryButtons.first()).not.toBeVisible({ timeout: 25_000 });
}

export async function closeDialogWithEscape(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
}

export async function waitForDeletedMessageState(
  page: Page,
  text: string,
  options: {
    chatId?: string;
  } = {}
): Promise<void> {
  await waitForThreadMessage(page, text, options);
  await openMessageActions(page, text);
  await expect(page.getByText('View Deleted Message', { exact: true })).toBeVisible({
    timeout: 12_000,
  });
  await page.keyboard.press('Escape');
}

export async function logoutFromSettings(page: Page): Promise<void> {
  await page.goto('/#/settings/profile');
  const logoutItem = page.getByTestId('settings-logout-item');
  const logoutConfirm = page.getByTestId('settings-logout-confirm');

  await expect(logoutItem).toBeVisible({ timeout: 30_000 });
  await logoutItem.click();

  try {
    await expect(logoutConfirm).toBeVisible({ timeout: 15_000 });
  } catch {
    await logoutItem.click();
    await expect(logoutConfirm).toBeVisible({ timeout: 15_000 });
  }

  await logoutConfirm.click();
  await expect.poll(() => page.url(), { timeout: 30_000 }).toMatch(/#\/(auth|login)/);
  await expect(page.getByText('Welcome')).toBeVisible({ timeout: 30_000 });
  await waitForAppBridge(page);
}

async function readBrowserStorageSnapshot(page: Page) {
  return page.evaluate(async () => {
    const localStorageKeys = Array.from({ length: window.localStorage.length }, (_, index) =>
      window.localStorage.key(index)
    )
      .filter((key): key is string => typeof key === 'string' && key.length > 0)
      .sort();

    const sessionStorageKeys = Array.from({ length: window.sessionStorage.length }, (_, index) =>
      window.sessionStorage.key(index)
    )
      .filter((key): key is string => typeof key === 'string' && key.length > 0)
      .sort();

    const indexedDbFactory = window.indexedDB as IDBFactory & {
      databases?: () => Promise<Array<{ name?: string | null }>>;
    };
    const indexedDbNames =
      typeof indexedDbFactory.databases === 'function'
        ? (await indexedDbFactory.databases())
            .flatMap((database) => {
              const name = typeof database?.name === 'string' ? database.name.trim() : '';
              return name ? [name] : [];
            })
            .sort()
        : [];

    return {
      indexedDbNames,
      localStorageKeys,
      sessionStorageKeys,
    };
  });
}

export async function expectBrowserStorageToBeEmpty(page: Page): Promise<void> {
  const emptyStorageSnapshot = {
    indexedDbNames: [],
    localStorageKeys: [],
    sessionStorageKeys: [],
  };

  await expect
    .poll(() => readBrowserStorageSnapshot(page), {
      timeout: 30_000,
    })
    .toEqual(emptyStorageSnapshot);

  await page.waitForTimeout(250);
  expect(await readBrowserStorageSnapshot(page)).toEqual(emptyStorageSnapshot);
}

export async function blockFirstRequest(page: Page): Promise<void> {
  await page.getByTestId('chat-request-block-button').first().click();
  await expect(page.getByTestId('chat-request-item')).toHaveCount(0);
}

export async function deleteFirstRequest(page: Page): Promise<void> {
  await page.getByTestId('chat-request-delete-button').first().click();
  await expect(page.getByTestId('chat-request-item')).toHaveCount(0);
}

export async function addGroupMemberAndPublish(page: Page, memberPublicKey: string): Promise<void> {
  await addGroupMembersAndPublish(page, [memberPublicKey]);
}

export async function addGroupMembersAndPublish(
  page: Page,
  memberPublicKeys: string[]
): Promise<void> {
  await page.getByTestId('contact-profile-members-tab').click();
  const memberInput = page.getByLabel('Member', { exact: true });
  const pendingMemberRows = page.locator('.profile-members-pending .profile-members-list .q-item');
  await expect(memberInput).toBeVisible();

  for (const memberPublicKey of memberPublicKeys) {
    const initialPendingMemberCount = await pendingMemberRows.count().catch(() => 0);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if ((await pendingMemberRows.count().catch(() => 0)) > initialPendingMemberCount) {
        break;
      }

      await memberInput.fill(memberPublicKey);
      try {
        await clickEnabledLocator(page, () => page.getByTestId('group-member-add-button'), {
          attempts: 1,
          timeoutMs: 6_000,
        });
      } catch (error) {
        if (attempt === 3 || !isTransientClickError(error)) {
          throw error;
        }
        await page.waitForTimeout(250 * (attempt + 1));
        continue;
      }

      try {
        await expect(memberInput).toHaveValue('', { timeout: 12_000 });
        await expect(pendingMemberRows).toHaveCount(initialPendingMemberCount + 1, {
          timeout: 12_000,
        });
      } catch (error) {
        if (
          attempt === 3 ||
          (await pendingMemberRows.count().catch(() => 0)) <= initialPendingMemberCount
        ) {
          throw error;
        }
      }

      break;
    }
  }

  await expect(
    page.getByText('You must publish these changes for them to take effect')
  ).toBeVisible();
  await page.getByTestId('group-members-publish-button').click();
  await expect(
    page.getByText('You must publish these changes for them to take effect')
  ).toHaveCount(0);

  await expect(page.getByTestId('group-members-publish-button')).toBeDisabled();
}

export async function retryGroupMemberTicketFailures(page: Page): Promise<void> {
  const retryAllButton = () => page.getByTestId('group-member-ticket-retry-all-button');
  try {
    await clickEnabledLocator(page, retryAllButton);
  } catch (error) {
    if (
      !(await retryAllButton()
        .isVisible()
        .catch(() => false))
    ) {
      return;
    }
    throw error;
  }
}

export async function removeGroupMemberAndPublish(
  page: Page,
  memberPublicKey: string
): Promise<void> {
  await page.getByTestId('contact-profile-members-tab').click();
  await expect(groupMemberListItem(page, memberPublicKey)).toBeVisible();
  await groupMemberListItem(page, memberPublicKey).getByLabel('Remove member').click();
  await expect(
    page.getByText('You must publish these changes for them to take effect')
  ).toBeVisible();
  await page.getByTestId('group-members-publish-button').click();
  await expect(
    page.getByText('You must publish these changes for them to take effect')
  ).toHaveCount(0);
  await expect(groupMemberListItem(page, memberPublicKey)).toHaveCount(0);
}

export async function openGroupEpochsTab(page: Page): Promise<void> {
  await page.getByTestId('contact-profile-epochs-tab').click();
  await expect(page.locator('.profile-epochs')).toBeVisible();
}

export async function openGroupRelaysTab(page: Page): Promise<void> {
  const relaysTab = page.getByTestId('contact-profile-relays-tab');
  await expect(relaysTab).toBeVisible();
  await relaysTab.click({ force: true });
  await expect(page.locator('.profile-group-relays')).toBeVisible();
}

export async function openProfileRelaysSection(page: Page): Promise<void> {
  const relaysSection = page.getByText('Relays (NIP-65)', { exact: true });
  await expect(relaysSection).toBeVisible();

  try {
    await expect(page.getByText('Send via App Relays', { exact: true })).toBeVisible({
      timeout: 1_000,
    });
  } catch {
    await relaysSection.click();
  }

  await expect(page.getByText('Send via App Relays', { exact: true })).toBeVisible();
}

export async function openAppRelaysSettings(page: Page): Promise<void> {
  await page.goto('/#/settings/relays');
  await expect(page.getByTestId('settings-relays-contacts-tab')).toHaveCount(0);
  await expect(page.getByTestId('settings-relays-app-tab')).toBeVisible();
  await page.getByTestId('settings-relays-app-tab').click();
  await expect(
    page
      .getByTestId('settings-relays-app-panel')
      .getByTestId('relay-editor-new-relay-input')
      .first()
  ).toBeVisible();
}

export async function removeRelayFromSettings(page: Page, relayUrl: string): Promise<void> {
  const relayItem = page
    .getByTestId('settings-relays-app-panel')
    .locator('.relay-expansion-item')
    .filter({ hasText: relayUrl })
    .first();
  await expect(relayItem).toBeVisible();
  await relayItem.getByTestId('relay-editor-delete-relay-button').click();
  await expect(relayItem).toHaveCount(0);
}

export async function publishOwnProfile(
  page: Page,
  options: {
    name: string;
    about?: string;
  }
): Promise<void> {
  await page.goto('/#/settings/profile');
  const nameInput = page.getByPlaceholder('Your profile name').first();
  const aboutInput = page.getByPlaceholder('Short bio').first();
  await expect(nameInput).toBeVisible();
  await nameInput.fill(options.name);

  if (typeof options.about === 'string') {
    await aboutInput.fill(options.about);
  }

  await expect(nameInput).toHaveValue(options.name);
  if (typeof options.about === 'string') {
    await expect(aboutInput).toHaveValue(options.about);
  }
  await page.waitForTimeout(250);
  await expect(nameInput).toHaveValue(options.name);
  if (typeof options.about === 'string') {
    await expect(aboutInput).toHaveValue(options.about);
  }

  await page.getByTestId('contact-profile-publish-button').click();
  await expect(page.getByText('Profile metadata published.', { exact: true }).first()).toBeVisible({
    timeout: 12_000,
  });
}

export async function readGroupEpochNumbers(page: Page): Promise<number[]> {
  const epochCells = page.locator('.profile-epochs-table tbody tr td:first-child');
  const count = await epochCells.count();
  if (count === 0) {
    return [];
  }

  const epochNumbers: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const value = Number((await epochCells.nth(index).textContent())?.trim() ?? Number.NaN);
    if (Number.isInteger(value) && value >= 0) {
      epochNumbers.push(value);
    }
  }

  return epochNumbers;
}

export async function waitForNoThreadMessage(
  page: Page,
  text: string,
  options: {
    chatId?: string;
    timeoutMs?: number;
    refresh?: boolean;
  } = {}
): Promise<void> {
  const messageLocator = threadMessages(page, text);
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? Math.max(1_000, Math.floor(options.timeoutMs))
      : 4_000;

  await expect(messageLocator).toHaveCount(0, { timeout: timeoutMs });

  if (options.refresh === false) {
    return;
  }

  await refreshSession(page, options.chatId);
  await expect(messageLocator).toHaveCount(0, { timeout: timeoutMs });
}

export async function waitForThreadMessageCount(
  page: Page,
  text: string,
  count: number,
  options: {
    chatId?: string;
  } = {}
): Promise<void> {
  await waitForThreadMessage(page, text, options);
  await expect(threadMessages(page, text)).toHaveCount(count);
}

export async function removeGroupRelayAndPublish(page: Page, relayUrl: string): Promise<void> {
  await openGroupRelaysTab(page);
  const relayItem = page.locator('.relay-expansion-item').filter({ hasText: relayUrl }).first();
  await expect(relayItem).toBeVisible();
  await relayItem.getByLabel('Delete relay').click();
  await expect(relayItem).toHaveCount(0);
  await page
    .locator('.profile-group-relays')
    .getByRole('button', { name: 'Publish', exact: true })
    .click();
}

export async function rotateGroupEpoch(
  page: Page,
  groupPublicKey: string,
  memberPublicKeys: string[],
  relayUrls: string[] = [E2E_RELAY_URL]
): Promise<void> {
  await page.evaluate(
    async ({ nextGroupPublicKey, nextMemberPublicKeys, nextRelayUrls }) => {
      const bridge = window.__appE2E__;
      if (!bridge) {
        throw new Error('E2E bridge is not available.');
      }

      await bridge.rotateGroupEpoch({
        groupPublicKey: nextGroupPublicKey,
        memberPublicKeys: nextMemberPublicKeys,
        relayUrls: nextRelayUrls,
      });
    },
    {
      nextGroupPublicKey: groupPublicKey,
      nextMemberPublicKeys: memberPublicKeys,
      nextRelayUrls: relayUrls,
    }
  );
}

export async function updateStoredContactRelays(
  page: Page,
  publicKey: string,
  relayUrls: string[],
  options: { reload?: boolean } = {}
): Promise<void> {
  await page.evaluate(
    async ({ nextPublicKey, nextRelayUrls }) => {
      const bridge = window.__appE2E__;
      if (!bridge) {
        throw new Error('E2E bridge is not available.');
      }

      await bridge.updateContactRelays({
        publicKey: nextPublicKey,
        relayUrls: nextRelayUrls,
      });
    },
    {
      nextPublicKey: publicKey,
      nextRelayUrls: relayUrls,
    }
  );
  if (options.reload === false) {
    return;
  }

  await page.reload();
  await waitForAppBridge(page);
}

export async function replaceStoredGroupMembers(
  page: Page,
  groupPublicKey: string,
  memberPublicKeys: string[]
): Promise<void> {
  await page.evaluate(
    async ({ nextGroupPublicKey, nextMemberPublicKeys }) => {
      const bridge = window.__appE2E__;
      if (!bridge) {
        throw new Error('E2E bridge is not available.');
      }

      await bridge.replaceStoredGroupMembers({
        groupPublicKey: nextGroupPublicKey,
        memberPublicKeys: nextMemberPublicKeys,
      });
    },
    {
      nextGroupPublicKey: groupPublicKey,
      nextMemberPublicKeys: memberPublicKeys,
    }
  );
}

export async function waitForNoRequests(page: Page): Promise<void> {
  await page.goto('/#/chats/requests');

  try {
    await expect(page.getByText('No pending requests', { exact: true })).toBeVisible({
      timeout: 12_000,
    });
  } catch {
    await refreshSession(page);
    await page.goto('/#/chats/requests');
  }

  await expect(page.getByTestId('chat-request-item')).toHaveCount(0);
  await expect(page.getByText('No pending requests', { exact: true })).toBeVisible();
}

export async function establishAcceptedDirectChat(
  sender: BootstrappedUser,
  recipient: BootstrappedUser
): Promise<void> {
  const openingMessage = `acceptance-open-${Date.now()}`;
  const replyMessage = `acceptance-reply-${Date.now()}`;

  await openDirectChatFromIdentifier(
    sender.page,
    recipient.session.publicKey,
    recipient.account.displayName
  );
  await sendMessage(sender.page, openingMessage, {
    chatId: recipient.session.publicKey,
  });
  let recipientChatIsOpen = false;
  try {
    await openRequests(recipient.page);
    await acceptFirstRequest(recipient.page);
  } catch (requestError) {
    try {
      await navigateToChat(recipient.page, sender.session.publicKey);
      recipientChatIsOpen = true;
    } catch {
      throw requestError;
    }
  }

  if (!recipientChatIsOpen) {
    await navigateToChat(recipient.page, sender.session.publicKey);
  }
  await sendMessage(recipient.page, replyMessage, {
    chatId: sender.session.publicKey,
  });
  await waitForThreadMessage(sender.page, replyMessage, {
    chatId: recipient.session.publicKey,
  });
}

export async function startHangingRelayServer(): Promise<() => Promise<void>> {
  const server = net.createServer((socket) => {
    socket.on('error', () => {
      // Intentionally ignore client errors; this socket never completes the handshake.
    });
  });
  let didListen = false;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        resolve();
        return;
      }

      reject(error);
    };

    server.once('error', onError);
    server.listen(E2E_HANG_RELAY_PORT, '127.0.0.1', () => {
      didListen = true;
      server.off('error', onError);
      resolve();
    });
  });

  return async () => {
    if (!didListen) {
      return;
    }

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  };
}

export async function startDelayedRelayProxy(options: {
  delayMs: number;
  listenUrl?: string;
  targetUrl?: string;
}): Promise<{
  close: () => Promise<void>;
  connectionCount: () => number;
  relayUrl: string;
}> {
  const relayUrl = options.listenUrl ?? E2E_RELAY_URL_DELAYED;
  const targetUrl = new URL(options.targetUrl ?? E2E_RELAY_URL);
  const listenUrl = new URL(relayUrl);
  const delayMs = Math.max(0, Math.floor(options.delayMs));
  const listenPort = Number.parseInt(listenUrl.port, 10);
  const targetPort = Number.parseInt(targetUrl.port, 10);
  if (!Number.isInteger(listenPort) || !Number.isInteger(targetPort)) {
    throw new Error('Delayed relay proxy URLs must include explicit ports.');
  }

  const server = net.createServer();
  const socketPairs = new Set<{ client: net.Socket; upstream: net.Socket }>();
  const pendingTimeoutIds = new Set<ReturnType<typeof globalThis.setTimeout>>();
  let acceptedConnectionCount = 0;
  let didListen = false;

  const forwardChunk = (destination: net.Socket, chunk: Buffer): void => {
    const timeoutId = globalThis.setTimeout(() => {
      pendingTimeoutIds.delete(timeoutId);
      if (!destination.destroyed && destination.writable) {
        destination.write(chunk);
      }
    }, delayMs);
    pendingTimeoutIds.add(timeoutId);
  };

  server.on('connection', (client) => {
    acceptedConnectionCount += 1;
    const upstream = net.createConnection({
      host: targetUrl.hostname,
      port: targetPort,
    });
    const pair = { client, upstream };
    socketPairs.add(pair);

    client.on('data', (chunk) => forwardChunk(upstream, chunk));
    upstream.on('data', (chunk) => forwardChunk(client, chunk));
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => {
      upstream.destroy();
      socketPairs.delete(pair);
    });
    upstream.on('close', () => {
      client.destroy();
      socketPairs.delete(pair);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    server.once('error', onError);
    server.listen(listenPort, listenUrl.hostname, () => {
      didListen = true;
      server.off('error', onError);
      resolve();
    });
  });

  return {
    relayUrl,
    connectionCount: () => acceptedConnectionCount,
    close: async () => {
      pendingTimeoutIds.forEach((timeoutId) => {
        globalThis.clearTimeout(timeoutId);
      });
      pendingTimeoutIds.clear();
      socketPairs.forEach(({ client, upstream }) => {
        client.destroy();
        upstream.destroy();
      });
      socketPairs.clear();

      if (!didListen) {
        return;
      }
      didListen = false;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

export async function pauseRelayService(service: keyof typeof relayPortsByService): Promise<void> {
  await runDockerCompose(['pause', service]);
}

export async function unpauseRelayService(
  service: keyof typeof relayPortsByService
): Promise<void> {
  await runDockerCompose(['unpause', service]);
  await waitForTcpPort(relayPortsByService[service]);
}
