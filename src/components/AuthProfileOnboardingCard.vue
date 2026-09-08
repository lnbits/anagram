<template>
  <q-card flat bordered class="auth-onboarding-card auth-onboarding-card--light">
    <q-card-section class="auth-onboarding-card__header">
      <div class="auth-onboarding-card__header-main">
        <q-btn
          v-if="onboardingStatus === 'profile-setup'"
          flat
          round
          dense
          icon="arrow_back"
          color="primary"
          class="auth-onboarding-card__back-button"
          :aria-label="$t('common.back')"
          :disable="isOnboardingContinuing"
          @click="goBackToOnboardingRelays"
        />
        <div class="auth-onboarding-card__header-text">
          <div class="auth-onboarding-card__title">{{ onboardingTitle }}</div>
          <div class="auth-onboarding-card__subtitle">{{ onboardingSubtitle }}</div>
        </div>
      </div>
    </q-card-section>

    <q-card-section class="auth-onboarding-card__actions auth-onboarding">
      <div v-if="onboardingStatus === 'checking'" class="onboarding-checking">
        <q-spinner color="primary" size="42px" />
        <div class="onboarding-checking__text">
          <div class="onboarding-checking__title">{{ $t('profile.lookingProfile') }}</div>
          <div class="onboarding-checking__subtitle">
            {{ $t('profile.checkingNostrMetadata', { count: appRelayCountLabel }) }}
          </div>
        </div>
      </div>

      <div v-else-if="onboardingStatus === 'found'" class="onboarding-profile">
        <CachedAvatar
          :src="onboardingProfilePicture"
          :alt="onboardingProfileName"
          :fallback="onboardingProfileAvatar"
          class="onboarding-profile__avatar"
        />
        <div class="onboarding-profile__body">
          <div class="onboarding-profile__name">{{ onboardingProfileName }}</div>
          <div class="onboarding-profile__pubkey">{{ onboardingProfilePubkey }}</div>
          <div class="onboarding-profile__about">
            {{ onboardingProfileAbout }}
          </div>
          <div v-if="onboardingProfileNip05" class="onboarding-profile__nip05">
            {{ onboardingProfileNip05 }}
          </div>
        </div>
      </div>

      <q-banner
        v-else-if="onboardingStatus === 'not-found'"
        dense
        rounded
        class="auth-onboarding-banner"
      >
        <template #avatar>
          <q-icon name="person_search" color="primary" />
        </template>
        {{ $t('relays.profileFoundCurrentApp') }}
      </q-banner>

      <q-banner
        v-else-if="onboardingStatus === 'error'"
        dense
        rounded
        class="auth-onboarding-banner auth-onboarding-banner--warning"
      >
        <template #avatar>
          <q-icon name="warning_amber" color="warning" />
        </template>
        {{ onboardingErrorMessage }}
      </q-banner>

      <div v-else-if="onboardingStatus === 'profile-setup'" class="onboarding-profile-setup">
        <q-input
          v-model="onboardingProfileNameInput"
          class="nc-input"
          dense
          outlined
          rounded
          :label="$t('common.nameOptional')"
          data-testid="auth-onboarding-profile-name-input"
          @keydown.enter.prevent="completeOnboardingProfileSetup"
        />

        <q-input
          v-model="onboardingProfileAboutInput"
          class="nc-input"
          dense
          outlined
          rounded
          type="textarea"
          autogrow
          :label="$t('common.aboutOptional')"
          data-testid="auth-onboarding-profile-about-input"
        />

        <q-checkbox
          v-if="hasSelectedOnboardingRelays"
          v-model="shouldUpdateOnboardingRelays"
          color="primary"
          :label="$t('relays.useSelectedRelaysProfile')"
          data-testid="auth-onboarding-update-relays-checkbox"
          class="onboarding-profile-setup__checkbox"
        />
      </div>

      <div v-if="onboardingStatus === 'relay-setup'" class="onboarding-relays">
        <q-input
          v-model="onboardingRelayInput"
          class="nc-input"
          dense
          outlined
          rounded
          :label="$t('relays.relayUrl')"
          placeholder="wss://example-relay.io"
          data-testid="auth-onboarding-relay-input"
          :error="Boolean(onboardingRelayValidationError)"
          :error-message="onboardingRelayValidationError"
          @keydown.enter.prevent="handleOnboardingAddRelay"
        >
          <template #append>
            <q-btn
              unelevated
              round
              dense
              color="primary"
              icon="add"
              size="sm"
              :aria-label="$t('relays.addRelay')"
              data-testid="auth-onboarding-add-relay-button"
              :disable="!canAddOnboardingRelay"
              @click="handleOnboardingAddRelay"
            />
          </template>
        </q-input>

        <q-list bordered separator class="onboarding-relay-list">
          <q-item v-for="relay in onboardingRelayRows" :key="relay.url">
            <q-item-section avatar class="onboarding-relay-list__selector">
              <q-spinner
                v-if="relay.checking"
                color="primary"
                size="24px"
                class="onboarding-relay-list__spinner"
                :aria-label="$t('relays.checking', { relay: relay.url })"
              />
              <q-checkbox
                v-else
                dense
                color="primary"
                :model-value="relay.selected"
                :aria-label="$t('relays.useSearchingProfile', { relay: relay.url })"
                class="onboarding-relay-list__checkbox"
                @update:model-value="
                  (value) => setOnboardingRelaySelected(relay.url, Boolean(value))
                "
              />
            </q-item-section>
            <q-item-section>
              <q-item-label class="onboarding-relay-list__main">
                <q-badge
                  outline
                  :color="relay.statusColor"
                  class="onboarding-relay-list__status"
                  :aria-label="relay.statusLabel"
                >
                  <q-icon :name="relay.statusIcon" size="18px" />
                </q-badge>
                <span class="onboarding-relay-list__url">{{ relay.url }}</span>
              </q-item-label>
            </q-item-section>
            <q-item-section side>
              <q-btn
                flat
                round
                dense
                icon="delete"
                color="negative"
                :aria-label="$t('relays.delete', { relay: relay.url })"
                @click="removeOnboardingRelay(relay.url)"
              />
            </q-item-section>
          </q-item>
        </q-list>
      </div>

      <MessageHistoryRestoreSlider
        v-if="onboardingStatus === 'found'"
        v-model="messageHistoryRestoreDays"
        :disable="isOnboardingContinuing || isLoggingOut"
      />

      <div
        v-if="onboardingStatus === 'found'"
        class="auth-onboarding-card__button-row"
      >
        <q-btn
          outline
          color="negative"
          no-caps
          icon="logout"
          :label="$t('settings.logout')"
          class="auth-onboarding-card__button"
          data-testid="auth-onboarding-logout-button"
          :disable="isOnboardingContinuing"
          @click="logoutFromOnboarding"
          :loading="isLoggingOut"
        />
        <q-btn
          unelevated
          color="primary"
          no-caps
          :label="$t('common.confirmStartUsingApp')"
          class="auth-onboarding-card__button"
          data-testid="auth-onboarding-continue-button"
          :loading="isOnboardingContinuing"
          :disable="isLoggingOut"
          @click="continueFromOnboarding"
        />
      </div>

      <div v-else-if="onboardingStatus === 'not-found'" class="auth-onboarding-card__button-row">
        <q-btn
          outline
          color="primary"
          no-caps
          :label="$t('common.skipNow')"
          class="auth-onboarding-card__button"
          data-testid="auth-onboarding-skip-button"
          :loading="isOnboardingContinuing"
          :disable="isLoggingOut"
          @click="continueFromOnboarding"
        />
        <q-btn
          unelevated
          color="primary"
          no-caps
          :label="$t('relays.addRelays')"
          class="auth-onboarding-card__button"
          data-testid="auth-onboarding-add-relays-button"
          @click="showOnboardingRelaySetup"
        />
      </div>

      <div
        v-else-if="onboardingStatus === 'error'"
        class="auth-onboarding-card__actions auth-onboarding-card__actions--nested"
      >
        <q-btn
          unelevated
          color="primary"
          no-caps
          :label="$t('common.tryAgain')"
          class="auth-onboarding-card__button"
          data-testid="auth-onboarding-retry-button"
          @click="findProfileFromOnboardingRelays"
        />
        <div class="auth-onboarding-card__button-row">
          <q-btn
            outline
            color="primary"
            no-caps
            :label="$t('relays.editRelays')"
            class="auth-onboarding-card__button"
            @click="showOnboardingRelaySetup"
          />
          <q-btn
            flat
            color="primary"
            no-caps
            :label="$t('common.continue')"
            class="auth-onboarding-card__button"
            data-testid="auth-onboarding-skip-button"
            :loading="isOnboardingContinuing"
            :disable="isLoggingOut"
            @click="continueFromOnboarding"
          />
        </div>
      </div>

      <div
        v-else-if="onboardingStatus === 'relay-setup'"
        class="auth-onboarding-card__button-row"
      >
        <q-btn
          outline
          color="negative"
          no-caps
          icon="logout"
          :label="$t('settings.logout')"
          class="auth-onboarding-card__button"
          data-testid="auth-onboarding-logout-button"
          :disable="isOnboardingContinuing"
          @click="logoutFromOnboarding"
          :loading="isLoggingOut"
        />
        <q-btn
          unelevated
          color="primary"
          no-caps
          :label="$t('common.next')"
          class="auth-onboarding-card__button"
          data-testid="auth-onboarding-relays-next-button"
          :disable="!canSearchSelectedOnboardingRelays || isLoggingOut"
          @click="findProfileFromOnboardingRelays"
        />
      </div>

      <div
        v-else-if="onboardingStatus === 'profile-setup'"
        class="auth-onboarding-card__button-row auth-onboarding-card__button-row--single"
      >
        <q-btn
          unelevated
          color="primary"
          no-caps
          :label="$t('common.saveStartUsingApp')"
          class="auth-onboarding-card__button"
          data-testid="auth-onboarding-profile-start-button"
          :disable="!canCompleteOnboardingProfileSetup || isLoggingOut"
          :loading="isOnboardingContinuing"
          @click="completeOnboardingProfileSetup"
        />
      </div>
    </q-card-section>

    <BrowserNotificationsLoginDialog
      v-model="isBrowserNotificationsLoginDialogOpen"
      @enable="confirmBrowserNotificationsLoginDialog"
      @skip="skipBrowserNotificationsLoginDialog"
    />
  </q-card>
</template>

<script setup lang="ts">
import { normalizeRelayUrl } from '@nostr-dev-kit/ndk';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import BrowserNotificationsLoginDialog from 'src/components/BrowserNotificationsLoginDialog.vue';
import CachedAvatar from 'src/components/CachedAvatar.vue';
import MessageHistoryRestoreSlider from 'src/components/MessageHistoryRestoreSlider.vue';
import { useOnboardingLogout } from 'src/composables/useOnboardingLogout';
import { DEFAULT_MESSAGE_HISTORY_RESTORE_DAYS } from 'src/utils/messageHistoryRestore';
import { useBrowserNotificationsLoginPrompt } from 'src/composables/useBrowserNotificationsLoginPrompt';
import {
  useNostrStore,
  type PublishUserMetadataInput,
  type UserProfileLookupResult,
} from 'src/stores/nostrStore';
import { useNip65RelayStore } from 'src/stores/nip65RelayStore';
import { useRelayStore } from 'src/stores/relayStore';
import { buildAvatarText } from 'src/utils/avatarText';
import { buildRelayLookupKey, uniqueRelayUrls } from 'src/utils/relayUrls';
import { reportUiError } from 'src/utils/uiErrorHandler';
import { t } from 'src/i18n';

type OnboardingStatus =
  | 'idle'
  | 'checking'
  | 'found'
  | 'not-found'
  | 'error'
  | 'relay-setup'
  | 'profile-setup';

const router = useRouter();
const nostrStore = useNostrStore();
const { isLoggingOut, logoutFromOnboarding } = useOnboardingLogout();
const messageHistoryRestoreDays = ref<number>(DEFAULT_MESSAGE_HISTORY_RESTORE_DAYS);
const relayStore = useRelayStore();
const nip65RelayStore = useNip65RelayStore();
const {
  isBrowserNotificationsLoginDialogOpen,
  handleBrowserNotificationsAfterLogin,
  confirmBrowserNotificationsLoginDialog,
  skipBrowserNotificationsLoginDialog,
} = useBrowserNotificationsLoginPrompt();
const onboardingStatus = ref<OnboardingStatus>('idle');
const onboardingProfile = ref<UserProfileLookupResult | null>(null);
const onboardingPubkey = ref('');
const onboardingNpub = ref('');
const onboardingError = ref('');
const onboardingRelayInput = ref('');
const onboardingProfileNameInput = ref('');
const onboardingProfileAboutInput = ref('');
const onboardingAttempt = ref(0);
const selectedOnboardingRelayKeys = ref<Set<string>>(new Set());
const checkingOnboardingRelayKeys = ref<Set<string>>(new Set());
const timedOutOnboardingRelayKeys = ref<Set<string>>(new Set());
const hasSeenOnboardingRelaySetup = ref(false);
const shouldUpdateOnboardingRelays = ref(true);
const isOnboardingContinuing = ref(false);
const PROFILE_LOOKUP_TIMEOUT_MS = 12_000;
const ONBOARDING_RELAY_CHECK_TIMEOUT_MS = 5_000;
const onboardingRelayCheckTimeouts = new Map<
  string,
  ReturnType<typeof globalThis.setTimeout>
>();

const onboardingTitle = computed(() => {
  if (onboardingStatus.value === 'found') {
    return t('profile.confirmProfile');
  }

  if (onboardingStatus.value === 'relay-setup') {
    return t('relays.appRelays.label');
  }

  if (onboardingStatus.value === 'profile-setup') {
    return t('profile.setUpProfile');
  }

  if (onboardingStatus.value === 'error') {
    return t('profile.profileCheckFailed');
  }

  return t('profile.checkingProfile');
});
const onboardingSubtitle = computed(() => {
  if (onboardingStatus.value === 'found') {
    return t('relays.profileFoundAppRelays');
  }

  if (onboardingStatus.value === 'relay-setup') {
    return t('relays.addRemoveRelaysSearching');
  }

  if (onboardingStatus.value === 'profile-setup') {
    return t('common.finalStepEnteringApp');
  }

  if (onboardingStatus.value === 'not-found') {
    return t('relays.youAddRelaysSkip');
  }

  if (onboardingStatus.value === 'error') {
    return t('relays.appCouldFinishChecking');
  }

  return t('relays.stayHereAppChecks');
});
const appRelayCountLabel = computed(() => {
  const count = relayStore.relays.length;
  return count === 1
    ? t('relays.appRelayCount.one', { count })
    : t('relays.appRelayCount.many', { count });
});
const onboardingProfileName = computed(() => onboardingProfile.value?.name ?? t('profile.unknownProfile'));
const onboardingProfilePubkey = computed(() => {
  if (onboardingNpub.value) {
    return onboardingNpub.value;
  }

  if (!onboardingPubkey.value) {
    return '';
  }

  return `${onboardingPubkey.value.slice(0, 10)}...${onboardingPubkey.value.slice(-6)}`;
});
const onboardingProfilePicture = computed(() => onboardingProfile.value?.picture ?? '');
const onboardingProfileAvatar = computed(() => buildAvatarText(onboardingProfileName.value));
const onboardingProfileAbout = computed(
  () => onboardingProfile.value?.about || t('common.descriptionPublished')
);
const onboardingProfileNip05 = computed(() => onboardingProfile.value?.nip05 ?? '');
const onboardingErrorMessage = computed(
  () => onboardingError.value || t('relays.profileLookupFailedYou')
);
const onboardingRelayValidationError = computed(() =>
  validateRelayUrlForOnboarding(onboardingRelayInput.value.trim())
);
const canAddOnboardingRelay = computed(() => {
  const value = onboardingRelayInput.value.trim();
  return value.length > 0 && onboardingRelayValidationError.value.length === 0;
});
const onboardingRelayRows = computed(() => {
  void nostrStore.relayStatusVersion;
  return relayStore.relays.map((url) => {
    const relayKey = buildRelayLookupKey(url);
    const connected = nostrStore.getRelayConnectionState(url) === 'connected';
    const checking =
      !timedOutOnboardingRelayKeys.value.has(relayKey) &&
      (checkingOnboardingRelayKeys.value.has(relayKey) ||
        nostrStore.isRelayConnectionPending(url));
    return {
      url,
      checking,
      selected: selectedOnboardingRelayKeys.value.has(relayKey),
      statusColor: checking ? 'primary' : connected ? 'positive' : 'warning',
      statusIcon: checking ? 'hourglass_empty' : connected ? 'check' : 'warning_amber',
      statusLabel: checking ? t('common.checking') : connected ? t('common.connected') : t('common.warning'),
    };
  });
});
const selectedOnboardingRelayUrls = computed(() =>
  uniqueRelayUrls(
    relayStore.relays.filter((url) =>
      selectedOnboardingRelayKeys.value.has(buildRelayLookupKey(url))
    )
  )
);
const canSearchSelectedOnboardingRelays = computed(
  () => selectedOnboardingRelayUrls.value.length > 0
);
const hasSelectedOnboardingRelays = computed(() => selectedOnboardingRelayUrls.value.length > 0);
const canCompleteOnboardingProfileSetup = computed(() => !isOnboardingContinuing.value);

onMounted(() => {
  void startProfileOnboarding();
});

async function startProfileOnboarding(): Promise<void> {
  messageHistoryRestoreDays.value = DEFAULT_MESSAGE_HISTORY_RESTORE_DAYS;
  const publicKey = nostrStore.getLoggedInPublicKeyHex();
  if (!publicKey) {
    reportUiError('Failed to start profile onboarding', new Error('Missing logged-in public key.'));
    onboardingStatus.value = 'error';
    onboardingError.value = t('errors.failedResolveLoggedPublic');
    return;
  }

  relayStore.init();
  onboardingPubkey.value = publicKey;
  onboardingNpub.value = nostrStore.encodeNpub(publicKey) ?? '';
  onboardingProfile.value = null;
  onboardingError.value = '';
  onboardingProfileNameInput.value = '';
  onboardingProfileAboutInput.value = '';
  selectedOnboardingRelayKeys.value = new Set();
  checkingOnboardingRelayKeys.value = new Set();
  timedOutOnboardingRelayKeys.value = new Set();
  clearAllOnboardingRelayCheckTimeouts();
  hasSeenOnboardingRelaySetup.value = false;
  shouldUpdateOnboardingRelays.value = true;
  await showOnboardingRelaySetup();
}

async function runProfileLookup(
  relayUrlOverride?: string[],
  options: { showProfileSetupWhenNotFound?: boolean } = {}
): Promise<void> {
  if (!onboardingPubkey.value) {
    return;
  }

  const attempt = onboardingAttempt.value + 1;
  onboardingAttempt.value = attempt;
  onboardingStatus.value = 'checking';
  onboardingProfile.value = null;
  onboardingError.value = '';

  const relayUrls = uniqueRelayUrls(relayUrlOverride ?? relayStore.relays);
  if (relayUrls.length === 0) {
    onboardingStatus.value = options.showProfileSetupWhenNotFound ? 'profile-setup' : 'not-found';
    return;
  }

  try {
    const profile = await withTimeout(
      nostrStore.fetchUserProfileFromRelays(onboardingPubkey.value, relayUrls),
      PROFILE_LOOKUP_TIMEOUT_MS
    );
    if (attempt !== onboardingAttempt.value) {
      return;
    }

    if (profile) {
      onboardingProfile.value = profile;
      onboardingStatus.value = 'found';
      return;
    }

    onboardingStatus.value = options.showProfileSetupWhenNotFound ? 'profile-setup' : 'not-found';
  } catch (error) {
    if (attempt !== onboardingAttempt.value) {
      return;
    }

    onboardingError.value =
      error instanceof Error && error.message
        ? error.message
        : t('relays.profileLookupFailedYou');
    onboardingStatus.value = 'error';
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(t('relays.profileLookupTimedOut')));
    }, timeoutMs);

    promise
      .then(resolve)
      .catch(reject)
      .finally(() => {
        window.clearTimeout(timeoutId);
      });
  });
}

async function showOnboardingRelaySetup(): Promise<void> {
  hasSeenOnboardingRelaySetup.value = true;
  resetSelectedOnboardingRelaysToConnected();
  onboardingStatus.value = 'relay-setup';

  const relayUrls = uniqueRelayUrls(relayStore.relays);
  markOnboardingRelaysChecking(relayUrls);
  if (relayUrls.length === 0) {
    return;
  }

  try {
    await nostrStore.ensureRelayConnections(relayUrls);
  } catch (error) {
    console.warn('Failed to connect onboarding relays', error);
  } finally {
    clearResolvedOnboardingRelayChecks(relayUrls);
  }
}

async function findProfileFromOnboardingRelays(): Promise<void> {
  if (!canSearchSelectedOnboardingRelays.value) {
    return;
  }

  keepOnlySelectedOnboardingRelays();
  await runProfileLookup(relayStore.relays, {
    showProfileSetupWhenNotFound: true,
  });
}

async function handleOnboardingAddRelay(): Promise<void> {
  try {
    const value = onboardingRelayInput.value.trim();
    if (!value || onboardingRelayValidationError.value) {
      return;
    }

    const normalizedRelay = normalizeRelayUrl(value);
    relayStore.replaceRelayEntries([
      { url: normalizedRelay, read: true, write: true },
      ...relayStore.relayEntries,
    ]);
    onboardingRelayInput.value = '';
    markOnboardingRelaysChecking([normalizedRelay]);

    try {
      await nostrStore.ensureRelayConnections([normalizedRelay]);
      if (nostrStore.getRelayConnectionState(normalizedRelay) === 'connected') {
        setOnboardingRelaySelected(normalizedRelay, true);
      }
    } catch (error) {
      console.warn('Failed to connect onboarding relay', normalizedRelay, error);
    } finally {
      clearResolvedOnboardingRelayChecks([normalizedRelay]);
    }
  } catch (error) {
    reportUiError('Failed to add relay during onboarding', error, t('errors.failedAddRelay'));
  }
}

function removeOnboardingRelay(relayUrl: string): void {
  try {
    const relayKey = buildRelayLookupKey(relayUrl);
    relayStore.replaceRelayEntries(
      relayStore.relayEntries.filter((entry) => buildRelayLookupKey(entry.url) !== relayKey)
    );
    setOnboardingRelaySelected(relayUrl, false);
    clearOnboardingRelayChecking(relayUrl);
  } catch (error) {
    reportUiError('Failed to remove relay during onboarding', error, t('errors.failedRemoveRelay'));
  }
}

function resetSelectedOnboardingRelaysToConnected(): void {
  selectedOnboardingRelayKeys.value = new Set(
    relayStore.relays
      .filter((url) => nostrStore.getRelayConnectionState(url) === 'connected')
      .map((url) => buildRelayLookupKey(url))
  );
}

function setOnboardingRelaySelected(relayUrl: string, selected: boolean): void {
  const nextSelectedRelayKeys = new Set(selectedOnboardingRelayKeys.value);
  const key = buildRelayLookupKey(relayUrl);
  if (selected) {
    nextSelectedRelayKeys.add(key);
  } else {
    nextSelectedRelayKeys.delete(key);
  }
  selectedOnboardingRelayKeys.value = nextSelectedRelayKeys;
}

function markOnboardingRelaysChecking(relayUrls: string[]): void {
  const nextCheckingRelayKeys = new Set(checkingOnboardingRelayKeys.value);
  for (const relayUrl of relayUrls) {
    if (nostrStore.getRelayConnectionState(relayUrl) === 'connected') {
      continue;
    }

    nextCheckingRelayKeys.add(buildRelayLookupKey(relayUrl));
    clearOnboardingRelayTimeoutState(relayUrl);
    scheduleOnboardingRelayCheckTimeout(relayUrl);
  }
  checkingOnboardingRelayKeys.value = nextCheckingRelayKeys;
}

function clearOnboardingRelayChecking(relayUrl: string): void {
  const relayKey = buildRelayLookupKey(relayUrl);
  clearOnboardingRelayCheckTimeout(relayUrl);
  clearOnboardingRelayTimeoutState(relayUrl);
  if (!checkingOnboardingRelayKeys.value.has(relayKey)) {
    return;
  }

  const nextCheckingRelayKeys = new Set(checkingOnboardingRelayKeys.value);
  nextCheckingRelayKeys.delete(relayKey);
  checkingOnboardingRelayKeys.value = nextCheckingRelayKeys;
}

function clearResolvedOnboardingRelayChecks(relayUrls: string[]): void {
  const nextSelectedRelayKeys = new Set(selectedOnboardingRelayKeys.value);
  const nextCheckingRelayKeys = new Set(checkingOnboardingRelayKeys.value);
  const nextTimedOutRelayKeys = new Set(timedOutOnboardingRelayKeys.value);
  for (const relayUrl of relayUrls) {
    const relayKey = buildRelayLookupKey(relayUrl);
    if (!nextCheckingRelayKeys.has(relayKey)) {
      continue;
    }

    if (nostrStore.getRelayConnectionState(relayUrl) === 'connected') {
      nextSelectedRelayKeys.add(relayKey);
      nextCheckingRelayKeys.delete(relayKey);
      nextTimedOutRelayKeys.delete(relayKey);
      clearOnboardingRelayCheckTimeout(relayUrl);
      continue;
    }

    if (!nostrStore.isRelayConnectionPending(relayUrl)) {
      nextCheckingRelayKeys.delete(relayKey);
      nextTimedOutRelayKeys.add(relayKey);
      clearOnboardingRelayCheckTimeout(relayUrl);
    }
  }
  selectedOnboardingRelayKeys.value = nextSelectedRelayKeys;
  checkingOnboardingRelayKeys.value = nextCheckingRelayKeys;
  timedOutOnboardingRelayKeys.value = nextTimedOutRelayKeys;
}

function scheduleOnboardingRelayCheckTimeout(relayUrl: string): void {
  const relayKey = buildRelayLookupKey(relayUrl);
  clearOnboardingRelayCheckTimeout(relayUrl);
  const timeoutId = globalThis.setTimeout(() => {
    onboardingRelayCheckTimeouts.delete(relayKey);
    const nextSelectedRelayKeys = new Set(selectedOnboardingRelayKeys.value);
    const nextCheckingRelayKeys = new Set(checkingOnboardingRelayKeys.value);
    const nextTimedOutRelayKeys = new Set(timedOutOnboardingRelayKeys.value);

    if (!nextCheckingRelayKeys.has(relayKey)) {
      return;
    }

    nextCheckingRelayKeys.delete(relayKey);
    if (nostrStore.getRelayConnectionState(relayUrl) === 'connected') {
      nextSelectedRelayKeys.add(relayKey);
      nextTimedOutRelayKeys.delete(relayKey);
    } else {
      nextSelectedRelayKeys.delete(relayKey);
      nextTimedOutRelayKeys.add(relayKey);
    }

    selectedOnboardingRelayKeys.value = nextSelectedRelayKeys;
    checkingOnboardingRelayKeys.value = nextCheckingRelayKeys;
    timedOutOnboardingRelayKeys.value = nextTimedOutRelayKeys;
  }, ONBOARDING_RELAY_CHECK_TIMEOUT_MS);
  onboardingRelayCheckTimeouts.set(relayKey, timeoutId);
}

function clearOnboardingRelayCheckTimeout(relayUrl: string): void {
  const relayKey = buildRelayLookupKey(relayUrl);
  const timeoutId = onboardingRelayCheckTimeouts.get(relayKey);
  if (!timeoutId) {
    return;
  }

  globalThis.clearTimeout(timeoutId);
  onboardingRelayCheckTimeouts.delete(relayKey);
}

function clearOnboardingRelayTimeoutState(relayUrl: string): void {
  const relayKey = buildRelayLookupKey(relayUrl);
  if (!timedOutOnboardingRelayKeys.value.has(relayKey)) {
    return;
  }

  const nextTimedOutRelayKeys = new Set(timedOutOnboardingRelayKeys.value);
  nextTimedOutRelayKeys.delete(relayKey);
  timedOutOnboardingRelayKeys.value = nextTimedOutRelayKeys;
}

function clearAllOnboardingRelayCheckTimeouts(): void {
  for (const timeoutId of onboardingRelayCheckTimeouts.values()) {
    globalThis.clearTimeout(timeoutId);
  }
  onboardingRelayCheckTimeouts.clear();
}

watch(
  () => nostrStore.relayStatusVersion,
  () => {
    clearResolvedOnboardingRelayChecks(relayStore.relays);
  }
);

onBeforeUnmount(() => {
  clearAllOnboardingRelayCheckTimeouts();
});

function keepOnlySelectedOnboardingRelays(): void {
  if (!hasSeenOnboardingRelaySetup.value) {
    return;
  }

  const selectedRelayKeys = selectedOnboardingRelayKeys.value;
  relayStore.replaceRelayEntries(
    relayStore.relayEntries.filter((entry) => selectedRelayKeys.has(buildRelayLookupKey(entry.url)))
  );
  selectedOnboardingRelayKeys.value = new Set(relayStore.relays.map((url) => buildRelayLookupKey(url)));
}

function goBackToOnboardingRelays(): void {
  try {
    onboardingError.value = '';
    onboardingStatus.value = 'relay-setup';
  } catch (error) {
    reportUiError('Failed to go back to onboarding relays', error);
  }
}

function selectedOnboardingRelayEntries() {
  const selectedRelayKeys = selectedOnboardingRelayKeys.value;
  return relayStore.relayEntries.filter((entry) => selectedRelayKeys.has(buildRelayLookupKey(entry.url)));
}

function buildOnboardingProfileMetadata(): PublishUserMetadataInput {
  const metadata: PublishUserMetadataInput = {};
  const name = onboardingProfileNameInput.value.trim();
  if (name) {
    metadata.name = name;
  }
  const about = onboardingProfileAboutInput.value.trim();
  if (about) {
    metadata.about = about;
  }
  return metadata;
}

async function completeOnboardingProfileSetup(): Promise<void> {
  if (!canCompleteOnboardingProfileSetup.value || isOnboardingContinuing.value) {
    return;
  }

  isOnboardingContinuing.value = true;
  try {
    const selectedRelayEntries = selectedOnboardingRelayEntries();
    const selectedRelayUrls = selectedRelayEntries.map((entry) => entry.url);

    const profileMetadata = buildOnboardingProfileMetadata();
    if (selectedRelayUrls.length > 0 && Object.keys(profileMetadata).length > 0) {
      await nostrStore.publishUserMetadata(profileMetadata, selectedRelayUrls);
    }

    if (shouldUpdateOnboardingRelays.value && selectedRelayEntries.length > 0) {
      nip65RelayStore.init();
      nip65RelayStore.replaceRelayEntries(selectedRelayEntries);
      await nostrStore.publishMyRelayList(selectedRelayEntries, selectedRelayUrls);
      await nostrStore.updateLoggedInUserRelayList(selectedRelayEntries);
    }

    keepOnlySelectedOnboardingRelays();
    nostrStore.setMessageHistoryRestoreDays(messageHistoryRestoreDays.value);
    await handleBrowserNotificationsAfterLogin();
    await router.push({ name: 'chats' });
  } catch (error) {
    reportUiError('Failed to finish profile onboarding', error, t('errors.failedFinishOnboarding'));
  } finally {
    isOnboardingContinuing.value = false;
  }
}

function validateRelayUrlForOnboarding(value: string): string {
  if (!value) {
    return '';
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      return t('relays.relayMustUseWs');
    }

    if (!url.hostname) {
      return t('relays.relayUrlMustInclude');
    }

    const nextRelayKey = buildRelayLookupKey(normalizeRelayUrl(value));
    const existingRelayKeys = new Set(relayStore.relays.map((relay) => buildRelayLookupKey(relay)));
    if (existingRelayKeys.has(nextRelayKey)) {
      return t('relays.validation.alreadyAddedState');
    }

    return '';
  } catch {
    return t('relays.relayMustValidWs');
  }
}

async function continueFromOnboarding(): Promise<void> {
  if (isOnboardingContinuing.value) {
    return;
  }

  isOnboardingContinuing.value = true;
  try {
    keepOnlySelectedOnboardingRelays();
    nostrStore.setMessageHistoryRestoreDays(messageHistoryRestoreDays.value);
    await handleBrowserNotificationsAfterLogin();
    await router.push({ name: 'chats' });
  } catch (error) {
    reportUiError('Failed to continue after profile onboarding', error, t('errors.failedContinue'));
  } finally {
    isOnboardingContinuing.value = false;
  }
}
</script>

<style scoped>
.auth-onboarding-card {
  width: 100%;
  border-radius: 20px;
  border: 1px solid var(--nc-border);
  overflow: hidden;
  background: var(--nc-panel-sidebar-bg);
  box-shadow: var(--nc-shadow-sm);
  backdrop-filter: blur(var(--nc-glass-blur));
}

.auth-onboarding-card--light {
  border-color: rgba(208, 220, 235, 0.82);
  background: rgba(239, 246, 251, 0.9);
  color: #182236;
  box-shadow: 0 18px 40px rgba(17, 40, 76, 0.16);
  backdrop-filter: blur(18px);
}

.auth-onboarding-card__header {
  padding: 22px 22px 10px;
  background: var(--nc-panel-header-bg);
  border-bottom: 1px solid color-mix(in srgb, var(--nc-border) 90%, #8fa5c1 10%);
}

.auth-onboarding-card--light .auth-onboarding-card__header {
  background: rgba(255, 255, 255, 0.82);
  border-bottom-color: rgba(208, 220, 235, 0.82);
}

.auth-onboarding-card__header-main {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
}

.auth-onboarding-card__header-text {
  min-width: 0;
}

.auth-onboarding-card__back-button {
  flex: 0 0 auto;
  margin-top: -2px;
  color: #2563eb;
}

.auth-onboarding-card__title {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.1;
}

.auth-onboarding-card__subtitle {
  margin-top: 8px;
  opacity: 0.75;
}

.auth-onboarding-card__actions {
  display: grid;
  gap: 12px;
  padding: 10px 22px 22px;
}

.auth-onboarding-card__actions--nested {
  padding: 0;
}

.auth-onboarding-card__button {
  min-height: 44px;
  border-radius: 999px;
}

.auth-onboarding-card__button-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.auth-onboarding-card__button-row--single {
  grid-template-columns: 1fr;
}

.auth-onboarding {
  gap: 16px;
  padding-top: 16px;
}

.auth-onboarding-card--light .nc-input :deep(.q-field__control) {
  background: rgba(255, 255, 255, 0.94);
  color: #182236;
}

.auth-onboarding-card--light .nc-input :deep(.q-field__native),
.auth-onboarding-card--light .nc-input :deep(.q-field__input),
.auth-onboarding-card--light .nc-input :deep(.q-field__label) {
  color: #182236;
}

.auth-onboarding-card--light .nc-input :deep(.q-field__label) {
  opacity: 0.72;
}

.auth-onboarding-card--light .nc-input :deep(.q-field__marginal) {
  color: #475569;
}

.onboarding-checking {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 116px;
}

.onboarding-checking__text {
  min-width: 0;
}

.onboarding-checking__title {
  font-size: 18px;
  font-weight: 700;
}

.onboarding-checking__subtitle {
  margin-top: 4px;
  color: #64748b;
  line-height: 1.35;
}

.onboarding-profile {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 16px;
  align-items: center;
  padding: 6px 0;
}

.onboarding-profile__avatar {
  width: 72px;
  height: 72px;
  font-size: 24px;
}

.onboarding-profile__body {
  min-width: 0;
}

.onboarding-profile__name {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.onboarding-profile__pubkey {
  margin-top: 4px;
  color: #64748b;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.onboarding-profile__about {
  margin-top: 10px;
  color: #334155;
  line-height: 1.45;
  overflow-wrap: anywhere;
}

.onboarding-profile__nip05 {
  margin-top: 8px;
  color: #2563eb;
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.auth-onboarding-banner {
  color: #334155;
  background: #eaf4ff;
  border: 1px solid #bfdbfe;
}

.auth-onboarding-banner--warning {
  background: #fff7db;
  border-color: #f3c969;
}

.onboarding-relays {
  display: grid;
  gap: 14px;
}

.onboarding-profile-setup {
  display: grid;
  gap: 14px;
}

.onboarding-profile-setup__checkbox {
  color: #334155;
}

.onboarding-relay-list__selector {
  min-width: 48px;
}

.onboarding-relay-list__spinner {
  width: 32px;
  justify-content: center;
}

.onboarding-relay-list__checkbox :deep(.q-checkbox__bg),
.onboarding-profile-setup__checkbox :deep(.q-checkbox__bg) {
  background: #ffffff;
  border: 2px solid #64748b;
}

.onboarding-relay-list__checkbox :deep(.q-checkbox__inner--truthy .q-checkbox__bg),
.onboarding-profile-setup__checkbox :deep(.q-checkbox__inner--truthy .q-checkbox__bg) {
  background: #2563eb;
  border-color: #2563eb;
}

.onboarding-relay-list {
  max-height: 260px;
  overflow: auto;
  border-radius: 14px;
  background: rgba(248, 250, 252, 0.94);
  color: #182236;
}

.onboarding-relay-list :deep(.q-item) {
  color: #182236;
}

.onboarding-relay-list :deep(.q-item__label) {
  color: #182236;
}

.onboarding-relay-list__main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.onboarding-relay-list__url {
  min-width: 0;
  font-size: 13px;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.onboarding-relay-list__status {
  flex: 0 0 auto;
  min-width: 36px;
  min-height: 26px;
  justify-content: center;
}

@media (max-width: 520px) {
  .onboarding-profile {
    grid-template-columns: 1fr;
    justify-items: center;
    text-align: center;
  }

  .auth-onboarding-card__button-row {
    grid-template-columns: 1fr;
  }
}
</style>
