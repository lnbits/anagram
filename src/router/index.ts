import { Notify } from 'quasar';
import { route } from 'quasar/wrappers';
import {
  clearAndroidPrivateKeySessionMetadata,
  hasUsableAndroidPrivateKeySession,
} from 'src/services/androidSecurePrivateKeyStorage';
import {
  clearElectronPrivateKeySessionMetadata,
  hasUsableElectronPrivateKeySession,
} from 'src/services/electronSecurePrivateKeyStorage';
import {
  ALREADY_LOGGED_IN_BUNKER_MESSAGE,
  readBunkerLoginQueryParam,
  readTopLevelBunkerLoginQueryParam,
  removeTopLevelBunkerLoginQueryParam,
  withoutBunkerLoginQueryParam,
} from 'src/utils/bunkerLoginQuery';
import { finalizePendingLogoutCleanup, hasPendingLogoutCleanup } from 'src/utils/logoutCleanup';
import {
  createMemoryHistory,
  createRouter,
  createWebHashHistory,
  createWebHistory,
} from 'vue-router';
import routes from './routes';
import { createStoredSessionChecker } from './storedSession';

const hasStoredPublicKey = createStoredSessionChecker({
  clearAndroidSessionMetadata: clearAndroidPrivateKeySessionMetadata,
  clearElectronSessionMetadata: clearElectronPrivateKeySessionMetadata,
  getLocalStorage: () =>
    typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
      ? window.localStorage
      : null,
  hasUsableAndroidSession: hasUsableAndroidPrivateKeySession,
  hasUsableElectronSession: hasUsableElectronPrivateKeySession,
});

function showAlreadyLoggedInBunkerMessage(): void {
  Notify.create({
    type: 'info',
    message: ALREADY_LOGGED_IN_BUNKER_MESSAGE,
    position: 'top',
    timeout: 3200,
  });
}

export default route(() => {
  const createHistory = process.env.SERVER
    ? createMemoryHistory
    : process.env.VUE_ROUTER_MODE === 'history'
      ? createWebHistory
      : createWebHashHistory;

  const Router = createRouter({
    scrollBehavior: () => ({ left: 0, top: 0 }),
    routes,
    history: createHistory(process.env.VUE_ROUTER_BASE),
  });

  Router.beforeEach((to) => {
    if (process.env.SERVER) {
      return true;
    }

    const resolveNavigation = (hasLoggedInUser: boolean) => {
      const isAuthRoute = to.name === 'auth' || to.name === 'register';
      const routeBunkerToken = readBunkerLoginQueryParam(to.query);
      const topLevelBunkerToken = readTopLevelBunkerLoginQueryParam();
      const hasBunkerLoginToken = Boolean(routeBunkerToken || topLevelBunkerToken);

      if (hasLoggedInUser && hasBunkerLoginToken) {
        removeTopLevelBunkerLoginQueryParam();
        showAlreadyLoggedInBunkerMessage();

        if (isAuthRoute) {
          return { name: 'chats' };
        }

        if (routeBunkerToken) {
          return {
            path: to.path,
            query: withoutBunkerLoginQueryParam(to.query),
            hash: to.hash,
            replace: true,
          };
        }

        return true;
      }

      if (isAuthRoute) {
        return hasLoggedInUser ? { name: 'chats' } : true;
      }

      if (hasLoggedInUser) {
        return true;
      }

      if (routeBunkerToken) {
        return {
          name: 'auth',
          query: {
            bunker: routeBunkerToken,
          },
        };
      }

      return '/login';
    };

    const checkStoredSession = () => {
      const result = hasStoredPublicKey();
      return typeof result === 'boolean'
        ? resolveNavigation(result)
        : result.then(resolveNavigation);
    };

    return hasPendingLogoutCleanup()
      ? finalizePendingLogoutCleanup().then(checkStoredSession)
      : checkStoredSession();
  });

  return Router;
});
