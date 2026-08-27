<template>
  <div class="auth-page auth-entry-page">
    <div class="auth-shell" :class="{ 'auth-shell--wide': loginStep === 'onboarding' }">
      <q-card v-if="loginStep === 'welcome'" flat bordered class="auth-card auth-card--light">
        <q-card-section class="auth-card__header">
          <div class="auth-card__header-main">
            <div class="auth-card__header-text">
              <div class="auth-card__title">{{ $t('common.welcome') }}</div>
              <div class="auth-card__subtitle">{{ $t('common.chooseHowYouWant') }}</div>
            </div>
          </div>
        </q-card-section>

        <q-card-section class="auth-card__actions">
          <q-btn
            unelevated
            color="primary"
            no-caps
            icon="login"
            :label="$t('auth.login')"
            class="auth-card__button"
            @click="openLoginOptions"
          />

          <q-btn
            outline
            color="primary"
            no-caps
            icon="vpn_key"
            :label="$t('common.createAccount')"
            class="auth-card__button auth-card__button--secondary"
            @click="goToRegister"
          />
        </q-card-section>

        <q-card-section class="auth-card__footer">
          <span>{{ $t('common.made') }}</span>
          <a
            href="https://lnbits.com"
            target="_blank"
            rel="noopener noreferrer"
            class="auth-card__footer-logo-link"
            aria-label="LNbits"
          >
            <img src="lnbits.svg" alt="" class="auth-card__footer-logo" aria-hidden="true" />
          </a>
          <a
            href="https://lnbits.com"
            target="_blank"
            rel="noopener noreferrer"
            class="auth-card__footer-link"
          >
            LNbits
          </a>
          <span>{{ $t('common.team') }}</span>
        </q-card-section>
      </q-card>

      <q-card v-else-if="loginStep === 'methods'" flat bordered class="auth-card auth-card--light">
        <q-card-section class="auth-card__header">
          <div class="auth-card__header-main">
            <q-btn
              flat
              round
              dense
              icon="arrow_back"
              color="primary"
              class="auth-card__back-button"
              :aria-label="$t('common.back')"
              @click="goBackToWelcome"
            />
            <div class="auth-card__header-text">
              <div class="auth-card__title">{{ $t('auth.login') }}</div>
              <div class="auth-card__subtitle">{{ $t('auth.chooseLoginMethod') }}</div>
            </div>
          </div>
        </q-card-section>

        <q-card-section class="auth-card__actions">
          <q-btn
            v-if="showExtensionLoginOption"
            unelevated
            color="primary"
            no-caps
            icon="extension"
            :label="$t('auth.loginExtension')"
            class="auth-card__button"
            :loading="isExtensionLoginInProgress"
            @click="handleExtensionLogin"
          />

          <q-btn
            unelevated
            color="primary"
            no-caps
            icon="phonelink_lock"
            :label="$t('auth.loginRemoteSigner')"
            class="auth-card__button"
            @click="openRemoteSignerLogin"
          />

          <q-btn
            outline
            color="primary"
            no-caps
            icon="vpn_key"
            :label="$t('auth.loginKeyRecommended')"
            class="auth-card__button auth-card__button--secondary"
            @click="openKeyLogin"
          />
        </q-card-section>

        <q-card-section class="auth-card__footer">
          <span>{{ $t('common.made') }}</span>
          <a
            href="https://lnbits.com"
            target="_blank"
            rel="noopener noreferrer"
            class="auth-card__footer-logo-link"
            aria-label="LNbits"
          >
            <img src="lnbits.svg" alt="" class="auth-card__footer-logo" aria-hidden="true" />
          </a>
          <a
            href="https://lnbits.com"
            target="_blank"
            rel="noopener noreferrer"
            class="auth-card__footer-link"
          >
            LNbits
          </a>
          <span>{{ $t('common.team') }}</span>
        </q-card-section>
      </q-card>

      <q-card
        v-else-if="loginStep === 'remote-signer'"
        flat
        bordered
        class="auth-card auth-card--light auth-card--remote-signer"
      >
        <q-card-section class="auth-card__header">
          <div class="auth-card__header-main">
            <q-btn
              flat
              round
              dense
              icon="arrow_back"
              color="primary"
              class="auth-card__back-button"
              :aria-label="$t('common.back')"
              :disable="isRemoteSignerLoginInProgress"
              @click="goBackToLoginOptions"
            />
            <div class="auth-card__header-text">
              <div class="auth-card__title">{{ $t('auth.remoteSigner') }}</div>
              <div class="auth-card__subtitle">{{ $t('auth.connectNip46') }}</div>
            </div>
          </div>
        </q-card-section>

        <q-card-section class="auth-card__actions remote-signer">
          <q-tabs
            v-model="remoteSignerMode"
            dense
            no-caps
            active-color="primary"
            indicator-color="primary"
            class="remote-signer__tabs"
          >
            <q-tab name="bunker" icon="link" :label="$t('auth.bunkerUrl')" />
            <q-tab name="nostrconnect" icon="qr_code_2" :label="$t('auth.nostrConnect')" />
          </q-tabs>

          <q-tab-panels v-model="remoteSignerMode" animated class="remote-signer__panels">
            <q-tab-panel name="bunker" class="remote-signer__panel">
              <q-input
                v-model="remoteSignerBunkerInput"
                class="nc-input"
                dense
                outlined
                rounded
                type="textarea"
                autogrow
                :label="$t('auth.bunkerConnectionString')"
                data-testid="auth-remote-signer-bunker-input"
                :disable="isRemoteSignerLoginInProgress"
                @keydown.enter.prevent="handleRemoteSignerBunkerLogin"
              />

              <q-btn
                unelevated
                color="primary"
                no-caps
                icon="login"
                :label="$t('common.connect')"
                class="auth-card__button"
                data-testid="auth-remote-signer-bunker-connect-button"
                :disable="!canLoginWithRemoteSignerBunker"
                :loading="isRemoteSignerLoginInProgress && remoteSignerMode === 'bunker'"
                @click="handleRemoteSignerBunkerLogin"
              />
            </q-tab-panel>

            <q-tab-panel name="nostrconnect" class="remote-signer__panel">
              <q-input
                v-model="remoteSignerRelayInput"
                class="nc-input"
                dense
                outlined
                rounded
                :label="$t('relays.pairingRelay')"
                placeholder="wss://relay.example.com"
                data-testid="auth-remote-signer-relay-input"
                :error="Boolean(remoteSignerRelayError)"
                :error-message="remoteSignerRelayError"
                :disable="isRemoteSignerLoginInProgress"
                @keydown.enter.prevent="handleCreateNostrConnectLogin"
              />

              <q-btn
                unelevated
                color="primary"
                no-caps
                icon="add_link"
                :label="$t('common.generatePairingLink')"
                class="auth-card__button"
                data-testid="auth-remote-signer-create-nostrconnect-button"
                :disable="!canCreateNostrConnectLogin"
                :loading="isRemoteSignerLoginInProgress && remoteSignerMode === 'nostrconnect'"
                @click="handleCreateNostrConnectLogin"
              />

              <div v-if="remoteSignerConnectUri" class="remote-signer-pairing">
                <div
                  v-if="remoteSignerConnectQrDataUrl"
                  class="remote-signer-pairing__qr-shell"
                  data-testid="auth-remote-signer-nostrconnect-qr"
                >
                  <img
                    :src="remoteSignerConnectQrDataUrl"
                    :alt="$t('auth.nostrConnectPairingQr')"
                    class="remote-signer-pairing__qr"
                  />
                </div>

                <q-input
                  :model-value="remoteSignerConnectUri"
                  class="nc-input remote-signer-pairing__uri"
                  dense
                  outlined
                  rounded
                  readonly
                  type="textarea"
                  autogrow
                  label="nostrconnect://"
                  data-testid="auth-remote-signer-nostrconnect-uri"
                />

                <div class="auth-card__button-row">
                  <q-btn
                    outline
                    color="primary"
                    no-caps
                    icon="content_copy"
                    :label="$t('common.copy')"
                    class="auth-card__button"
                    data-testid="auth-remote-signer-copy-button"
                    @click="copyRemoteSignerConnectUri"
                  />
                  <q-btn
                    unelevated
                    color="primary"
                    no-caps
                    icon="open_in_new"
                    :label="$t('common.open')"
                    class="auth-card__button"
                    data-testid="auth-remote-signer-open-button"
                    @click="openRemoteSignerConnectUri"
                  />
                </div>
              </div>
            </q-tab-panel>
          </q-tab-panels>

          <q-banner
            v-if="remoteSignerAuthUrl"
            dense
            rounded
            class="auth-onboarding-banner"
          >
            <template #avatar>
              <q-icon name="verified_user" color="primary" />
            </template>
            <a
              :href="remoteSignerAuthUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="remote-signer__auth-link"
            >
              {{ $t('auth.openSignerAuthorization') }}
            </a>
          </q-banner>

          <q-banner
            v-if="remoteSignerError"
            dense
            rounded
            class="auth-onboarding-banner auth-onboarding-banner--warning"
          >
            <template #avatar>
              <q-icon name="warning_amber" color="warning" />
            </template>
            {{ remoteSignerError }}
          </q-banner>

          <q-btn
            v-if="isRemoteSignerLoginInProgress"
            flat
            color="negative"
            no-caps
            icon="close"
            :label="$t('common.cancel')"
            class="auth-card__button"
            data-testid="auth-remote-signer-cancel-button"
            @click="cancelRemoteSignerLogin"
          />
        </q-card-section>

        <q-card-section class="auth-card__footer">
          <span>{{ $t('common.made') }}</span>
          <a
            href="https://lnbits.com"
            target="_blank"
            rel="noopener noreferrer"
            class="auth-card__footer-logo-link"
            aria-label="LNbits"
          >
            <img src="/lnbits.svg" alt="" class="auth-card__footer-logo" aria-hidden="true" />
          </a>
          <a
            href="https://lnbits.com"
            target="_blank"
            rel="noopener noreferrer"
            class="auth-card__footer-link"
          >
            LNbits
          </a>
          <span>{{ $t('common.team') }}</span>
        </q-card-section>
      </q-card>

      <q-card v-else-if="loginStep === 'key'" flat bordered class="auth-card auth-card--light">
        <q-card-section class="auth-card__header">
          <div class="auth-card__header-main">
            <q-btn
              flat
              round
              dense
              icon="arrow_back"
              color="primary"
              class="auth-card__back-button"
              :aria-label="$t('common.back')"
              :disable="isKeyLoginInProgress"
              @click="goBackToLoginOptions"
            />
            <div class="auth-card__header-text">
              <div class="auth-card__title">{{ $t('auth.loginKey') }}</div>
              <div class="auth-card__subtitle">{{ $t('auth.enterNsecHexPrivate') }}</div>
            </div>
          </div>
        </q-card-section>

        <q-card-section class="auth-card__actions">
          <q-card flat bordered class="auth-warning">
            <q-card-section class="auth-warning__content">
              <q-icon name="warning" size="20px" class="auth-warning__icon" />
              <div>{{ $t('auth.enteringPrivateKeyStrongly') }}</div>
            </q-card-section>
          </q-card>

          <q-input
            v-model="privateKey"
            class="nc-input"
            dense
            outlined
            rounded
            type="password"
            :label="$t('auth.privateKeyNsecHex')"
            :error="Boolean(privateKeyError)"
            :error-message="privateKeyError"
            @keydown.enter.prevent="handleKeyLogin"
          />

          <div class="auth-card__button-row auth-card__button-row--single">
            <q-btn
              unelevated
              color="primary"
              no-caps
              :label="$t('auth.login')"
              class="auth-card__button"
              :disable="!canLoginWithKey"
              :loading="isKeyLoginInProgress"
              @click="handleKeyLogin"
            />
          </div>
        </q-card-section>

        <q-card-section class="auth-card__footer">
          <span>{{ $t('common.made') }}</span>
          <a
            href="https://lnbits.com"
            target="_blank"
            rel="noopener noreferrer"
            class="auth-card__footer-logo-link"
            aria-label="LNbits"
          >
            <img src="lnbits.svg" alt="" class="auth-card__footer-logo" aria-hidden="true" />
          </a>
          <a
            href="https://lnbits.com"
            target="_blank"
            rel="noopener noreferrer"
            class="auth-card__footer-link"
          >
            LNbits
          </a>
          <span>{{ $t('common.team') }}</span>
        </q-card-section>
      </q-card>

      <q-card v-else flat bordered class="auth-card auth-card--light auth-card--onboarding">
        <q-card-section class="auth-card__header">
          <div class="auth-card__header-main">
            <q-btn
              v-if="onboardingStatus === 'profile-setup'"
              flat
              round
              dense
              icon="arrow_back"
              color="primary"
              class="auth-card__back-button"
              :aria-label="$t('common.back')"
              :disable="isOnboardingContinuing"
              @click="goBackToOnboardingRelays"
            />
            <div class="auth-card__header-text">
              <div class="auth-card__title">{{ onboardingTitle }}</div>
              <div class="auth-card__subtitle">{{ onboardingSubtitle }}</div>
            </div>
          </div>
        </q-card-section>

        <q-card-section class="auth-card__actions auth-onboarding">
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

          <div v-if="onboardingStatus === 'found'" class="auth-card__button-row">
            <q-btn
              outline
              color="negative"
              no-caps
              icon="logout"
              :label="$t('settings.logout')"
              class="auth-card__button"
              data-testid="auth-onboarding-logout-button"
              :disable="isOnboardingContinuing"
              @click="nostrStore.logout"
            />
            <q-btn
              unelevated
              color="primary"
              no-caps
              :label="$t('common.confirmStartUsingApp')"
              class="auth-card__button"
              data-testid="auth-onboarding-continue-button"
              :loading="isOnboardingContinuing"
              @click="continueFromOnboarding"
            />
          </div>

          <div v-else-if="onboardingStatus === 'not-found'" class="auth-card__button-row">
            <q-btn
              outline
              color="primary"
              no-caps
              :label="$t('common.skipNow')"
              class="auth-card__button"
              data-testid="auth-onboarding-skip-button"
              :loading="isOnboardingContinuing"
              @click="continueFromOnboarding"
            />
            <q-btn
              unelevated
              color="primary"
              no-caps
              :label="$t('relays.addRelays')"
              class="auth-card__button"
              data-testid="auth-onboarding-add-relays-button"
              @click="showOnboardingRelaySetup"
            />
          </div>

          <div v-else-if="onboardingStatus === 'error'" class="auth-card__actions auth-card__actions--nested">
            <q-btn
              unelevated
              color="primary"
              no-caps
              :label="$t('common.tryAgain')"
              class="auth-card__button"
              data-testid="auth-onboarding-retry-button"
              @click="findProfileFromOnboardingRelays"
            />
            <div class="auth-card__button-row">
              <q-btn
                outline
                color="primary"
                no-caps
                :label="$t('relays.editRelays')"
                class="auth-card__button"
                @click="showOnboardingRelaySetup"
              />
              <q-btn
                flat
                color="primary"
                no-caps
                :label="$t('common.continue')"
                class="auth-card__button"
                data-testid="auth-onboarding-skip-button"
                :loading="isOnboardingContinuing"
                @click="continueFromOnboarding"
              />
            </div>
          </div>

          <div
            v-else-if="onboardingStatus === 'relay-setup'"
            class="auth-card__button-row"
          >
            <q-btn
              outline
              color="negative"
              no-caps
              icon="logout"
              :label="$t('settings.logout')"
              class="auth-card__button"
              data-testid="auth-onboarding-logout-button"
              :disable="isOnboardingContinuing"
              @click="nostrStore.logout"
            />
            <q-btn
              unelevated
              color="primary"
              no-caps
              :label="$t('common.next')"
              class="auth-card__button"
              data-testid="auth-onboarding-relays-next-button"
              :disable="!canSearchSelectedOnboardingRelays"
              @click="findProfileFromOnboardingRelays"
            />
          </div>

          <div
            v-else-if="onboardingStatus === 'profile-setup'"
            class="auth-card__button-row auth-card__button-row--single"
          >
            <q-btn
              unelevated
              color="primary"
              no-caps
              :label="$t('common.saveStartUsingApp')"
              class="auth-card__button"
              data-testid="auth-onboarding-profile-start-button"
              :disable="!canCompleteOnboardingProfileSetup"
              :loading="isOnboardingContinuing"
              @click="completeOnboardingProfileSetup"
            />
          </div>
        </q-card-section>

        <q-card-section class="auth-card__footer">
          <span>{{ $t('common.made') }}</span>
          <a
            href="https://lnbits.com"
            target="_blank"
            rel="noopener noreferrer"
            class="auth-card__footer-logo-link"
            aria-label="LNbits"
          >
            <img src="lnbits.svg" alt="" class="auth-card__footer-logo" aria-hidden="true" />
          </a>
          <a
            href="https://lnbits.com"
            target="_blank"
            rel="noopener noreferrer"
            class="auth-card__footer-link"
          >
            LNbits
          </a>
          <span>{{ $t('common.team') }}</span>
        </q-card-section>
      </q-card>
    </div>

    <BrowserNotificationsLoginDialog
      v-model="isBrowserNotificationsLoginDialogOpen"
      @enable="confirmBrowserNotificationsLoginDialog"
      @skip="skipBrowserNotificationsLoginDialog"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Capacitor } from '@capacitor/core';
import { normalizeRelayUrl } from '@nostr-dev-kit/ndk';
import { toDataURL as createQrDataUrl } from 'qrcode';
import BrowserNotificationsLoginDialog from 'src/components/BrowserNotificationsLoginDialog.vue';
import CachedAvatar from 'src/components/CachedAvatar.vue';
import { useBrowserNotificationsLoginPrompt } from 'src/composables/useBrowserNotificationsLoginPrompt';
import { useNostrStore, type UserProfileLookupResult } from 'src/stores/nostrStore';
import type { PublishUserMetadataInput } from 'src/stores/nostrStore';
import { useNip65RelayStore } from 'src/stores/nip65RelayStore';
import { useRelayStore } from 'src/stores/relayStore';
import { buildAvatarText } from 'src/utils/avatarText';
import {
  readBunkerLoginQueryParam,
  readTopLevelBunkerLoginQueryParam,
  removeTopLevelBunkerLoginQueryParam,
  withoutBunkerLoginQueryParam,
} from 'src/utils/bunkerLoginQuery';
import { buildRelayLookupKey, uniqueRelayUrls } from 'src/utils/relayUrls';
import { reportUiError } from 'src/utils/uiErrorHandler';
import { t } from 'src/i18n';

const route = useRoute();
const router = useRouter();
const nostrStore = useNostrStore();
const relayStore = useRelayStore();
const nip65RelayStore = useNip65RelayStore();
const {
  isBrowserNotificationsLoginDialogOpen,
  handleBrowserNotificationsAfterLogin,
  confirmBrowserNotificationsLoginDialog,
  skipBrowserNotificationsLoginDialog
} = useBrowserNotificationsLoginPrompt();
type AuthStep = 'welcome' | 'methods' | 'remote-signer' | 'key' | 'onboarding';
type RemoteSignerMode = 'bunker' | 'nostrconnect';
type ActiveRemoteSignerLogin = {
  cancel: () => void;
};
type OnboardingStatus =
  | 'idle'
  | 'checking'
  | 'found'
  | 'not-found'
  | 'error'
  | 'relay-setup'
  | 'profile-setup';

const loginStep = ref<AuthStep>('welcome');
const privateKey = ref('');
const remoteSignerMode = ref<RemoteSignerMode>('bunker');
const remoteSignerBunkerInput = ref('');
const remoteSignerRelayInput = ref('');
const remoteSignerConnectUri = ref('');
const remoteSignerConnectQrDataUrl = ref('');
const remoteSignerAuthUrl = ref('');
const remoteSignerError = ref('');
const isExtensionLoginInProgress = ref(false);
const isKeyLoginInProgress = ref(false);
const isRemoteSignerLoginInProgress = ref(false);
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
const privateKeyValidation = computed(() => nostrStore.validatePrivateKey(privateKey.value.trim()));
const privateKeyError = computed(() =>
  privateKey.value.trim() && !privateKeyValidation.value.isValid
    ? t('auth.enterValidNsec64')
    : ''
);
const canLoginWithKey = computed(() => privateKeyValidation.value.isValid && !isKeyLoginInProgress.value);
const remoteSignerRelayError = computed(() =>
  validateRelayUrlForRemoteSigner(remoteSignerRelayInput.value.trim())
);
const canLoginWithRemoteSignerBunker = computed(
  () => remoteSignerBunkerInput.value.trim().length > 0 && !isRemoteSignerLoginInProgress.value
);
const canCreateNostrConnectLogin = computed(
  () =>
    remoteSignerRelayInput.value.trim().length > 0 &&
    !remoteSignerRelayError.value &&
    !isRemoteSignerLoginInProgress.value
);
const isDesktopAppRuntime = computed(() =>
  typeof window === 'undefined' ? false : Boolean(window.desktopRuntime?.isElectron)
);
const isAndroidAppRuntime = computed(
  () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'
);
const showExtensionLoginOption = computed(
  () =>
    !isDesktopAppRuntime.value &&
    !isAndroidAppRuntime.value &&
    nostrStore.hasNip07Extension()
);
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
      connected,
      selected: selectedOnboardingRelayKeys.value.has(relayKey),
      statusColor: checking ? 'primary' : connected ? 'positive' : 'warning',
      statusIcon: checking ? 'hourglass_empty' : connected ? 'check' : 'warning_amber',
      statusLabel: checking ? t('common.checking') : connected ? t('common.connected') : t('common.warning'),
    };
  });
});
const selectedOnboardingRelayUrls = computed(() =>
  uniqueRelayUrls(
    relayStore.relays.filter((url) => selectedOnboardingRelayKeys.value.has(buildRelayLookupKey(url)))
  )
);
const canSearchSelectedOnboardingRelays = computed(
  () => selectedOnboardingRelayUrls.value.length > 0
);
const hasSelectedOnboardingRelays = computed(() => selectedOnboardingRelayUrls.value.length > 0);
const canCompleteOnboardingProfileSetup = computed(() => !isOnboardingContinuing.value);
let activeRemoteSignerLogin: ActiveRemoteSignerLogin | null = null;
let hasAttemptedBunkerQueryLogin = false;

function prepareRemoteSignerBunkerLogin(connectionToken: string): void {
  relayStore.init();
  remoteSignerMode.value = 'bunker';
  remoteSignerBunkerInput.value = connectionToken;
  clearRemoteSignerPairingState();
  remoteSignerAuthUrl.value = '';
  remoteSignerError.value = '';
  remoteSignerRelayInput.value = relayStore.relays[0] ?? '';
  loginStep.value = 'remote-signer';
}

async function removeRouteBunkerQueryParam(): Promise<void> {
  if (!readBunkerLoginQueryParam(route.query)) {
    return;
  }

  await router.replace({
    path: route.path,
    query: withoutBunkerLoginQueryParam(route.query),
    hash: route.hash,
  });
}

async function consumeBunkerLoginQueryParam(): Promise<void> {
  if (hasAttemptedBunkerQueryLogin || isRemoteSignerLoginInProgress.value) {
    return;
  }

  const connectionToken =
    readBunkerLoginQueryParam(route.query) ?? readTopLevelBunkerLoginQueryParam();
  if (!connectionToken) {
    return;
  }

  hasAttemptedBunkerQueryLogin = true;
  try {
    removeTopLevelBunkerLoginQueryParam();
    await removeRouteBunkerQueryParam();
    prepareRemoteSignerBunkerLogin(connectionToken);
    await handleRemoteSignerBunkerLogin();
  } catch (error) {
    reportUiError('Failed to start NIP-46 bunker login from route query', error);
  }
}

function openLoginOptions(): void {
  try {
    loginStep.value = 'methods';
  } catch (error) {
    reportUiError('Failed to open login options', error);
  }
}

function openKeyLogin(): void {
  try {
    loginStep.value = 'key';
  } catch (error) {
    reportUiError('Failed to open key login', error);
  }
}

function openRemoteSignerLogin(): void {
  try {
    prepareRemoteSignerBunkerLogin('');
  } catch (error) {
    reportUiError('Failed to open remote signer login', error);
  }
}

function goBackToWelcome(): void {
  try {
    loginStep.value = 'welcome';
    privateKey.value = '';
  } catch (error) {
    reportUiError('Failed to go back from login options', error);
  }
}

function goBackToLoginOptions(): void {
  try {
    cancelRemoteSignerLogin();
    loginStep.value = 'methods';
    privateKey.value = '';
    remoteSignerBunkerInput.value = '';
    clearRemoteSignerPairingState();
    remoteSignerAuthUrl.value = '';
    remoteSignerError.value = '';
  } catch (error) {
    reportUiError('Failed to go back to login options', error);
  }
}

async function handleExtensionLogin(): Promise<void> {
  if (isExtensionLoginInProgress.value) {
    return;
  }

  isExtensionLoginInProgress.value = true;
  try {
    await nostrStore.loginWithExtension();
    await startProfileOnboarding();
  } catch (error) {
    reportUiError(
      'Failed to log in with NIP-07 extension',
      error,
      t('errors.failedLogExtension')
    );
  } finally {
    isExtensionLoginInProgress.value = false;
  }
}

async function handleKeyLogin(): Promise<void> {
  try {
    if (!canLoginWithKey.value || isKeyLoginInProgress.value) {
      return;
    }

    isKeyLoginInProgress.value = true;
    const validation = await nostrStore.savePrivateKey(privateKey.value);
    if (!validation.isValid) {
      return;
    }

    privateKey.value = '';
    await startProfileOnboarding();
  } catch (error) {
    reportUiError('Failed to log in', error, t('errors.failedLog'));
  } finally {
    isKeyLoginInProgress.value = false;
  }
}

function setRemoteSignerAuthUrl(url: string): void {
  remoteSignerAuthUrl.value = url;
}

function getRemoteSignerErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return fallback;
}

async function handleRemoteSignerBunkerLogin(): Promise<void> {
  if (!canLoginWithRemoteSignerBunker.value) {
    return;
  }

  isRemoteSignerLoginInProgress.value = true;
  clearRemoteSignerPairingState();
  remoteSignerAuthUrl.value = '';
  remoteSignerError.value = '';
  try {
    await nostrStore.loginWithRemoteSignerBunker({
      connectionToken: remoteSignerBunkerInput.value,
      onAuthUrl: setRemoteSignerAuthUrl,
    });
    remoteSignerBunkerInput.value = '';
    await startProfileOnboarding();
  } catch (error) {
    remoteSignerError.value = getRemoteSignerErrorMessage(
      error,
      t('errors.failedConnectRemoteSigner')
    );
    reportUiError('Failed to log in with NIP-46 remote signer', error, remoteSignerError.value);
  } finally {
    isRemoteSignerLoginInProgress.value = false;
  }
}

async function handleCreateNostrConnectLogin(): Promise<void> {
  if (!canCreateNostrConnectLogin.value) {
    return;
  }

  cancelRemoteSignerLogin();
  isRemoteSignerLoginInProgress.value = true;
  clearRemoteSignerPairingState();
  remoteSignerAuthUrl.value = '';
  remoteSignerError.value = '';

  try {
    const login = nostrStore.createRemoteSignerNostrConnectLogin({
      relayUrl: remoteSignerRelayInput.value,
      onAuthUrl: setRemoteSignerAuthUrl,
    });
    activeRemoteSignerLogin = {
      cancel: login.cancel,
    };
    remoteSignerConnectUri.value = login.uri;
    remoteSignerRelayInput.value = login.relayUrl;
    await Promise.all([renderRemoteSignerConnectQr(login.uri), login.login]);
    activeRemoteSignerLogin = null;
    clearRemoteSignerPairingState();
    await startProfileOnboarding();
  } catch (error) {
    const message = getRemoteSignerErrorMessage(error, t('errors.failedPairRemoteSigner'));
    clearRemoteSignerPairingState();
    if (message !== 'NIP-46 login was cancelled.') {
      remoteSignerError.value = message;
      reportUiError('Failed to pair NIP-46 remote signer', error, message);
    }
  } finally {
    activeRemoteSignerLogin = null;
    isRemoteSignerLoginInProgress.value = false;
  }
}

function cancelRemoteSignerLogin(): void {
  activeRemoteSignerLogin?.cancel();
  activeRemoteSignerLogin = null;
  clearRemoteSignerPairingState();
  remoteSignerAuthUrl.value = '';
  isRemoteSignerLoginInProgress.value = false;
}

function clearRemoteSignerPairingState(): void {
  remoteSignerConnectUri.value = '';
  remoteSignerConnectQrDataUrl.value = '';
}

async function renderRemoteSignerConnectQr(uri: string): Promise<void> {
  try {
    const dataUrl = await createQrDataUrl(uri, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 256,
      color: {
        dark: '#182236',
        light: '#ffffff',
      },
    });
    if (remoteSignerConnectUri.value === uri) {
      remoteSignerConnectQrDataUrl.value = dataUrl;
    }
  } catch (error) {
    console.warn('Failed to render NIP-46 pairing QR code', error);
    remoteSignerConnectQrDataUrl.value = '';
  }
}

async function copyRemoteSignerConnectUri(): Promise<void> {
  const uri = remoteSignerConnectUri.value.trim();
  if (!uri) {
    return;
  }

  try {
    await navigator.clipboard.writeText(uri);
  } catch (error) {
    reportUiError('Failed to copy NIP-46 pairing link', error, t('errors.failedCopyPairingLink'));
  }
}

function openRemoteSignerConnectUri(): void {
  const uri = remoteSignerConnectUri.value.trim();
  if (!uri) {
    return;
  }

  try {
    window.open(uri, '_blank', 'noopener,noreferrer');
  } catch (error) {
    reportUiError('Failed to open NIP-46 pairing link', error, t('errors.failedOpenPairingLink'));
  }
}

async function startProfileOnboarding(): Promise<void> {
  const publicKey = nostrStore.getLoggedInPublicKeyHex();
  if (!publicKey) {
    throw new Error('Failed to resolve the logged-in public key.');
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
  loginStep.value = 'onboarding';
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

watch(
  () => route.fullPath,
  () => {
    void consumeBunkerLoginQueryParam();
  }
);

onMounted(() => {
  void consumeBunkerLoginQueryParam();
});

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
    await handleBrowserNotificationsAfterLogin();
    await goToHome();
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

function validateRelayUrlForRemoteSigner(value: string): string {
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
    await handleBrowserNotificationsAfterLogin();
    await goToHome();
  } catch (error) {
    reportUiError('Failed to continue after profile onboarding', error, t('errors.failedContinue'));
  } finally {
    isOnboardingContinuing.value = false;
  }
}

async function goToHome(): Promise<void> {
  try {
    await router.push({ name: 'chats' });
  } catch (error) {
    reportUiError('Failed to navigate after login', error);
  }
}

async function goToRegister(): Promise<void> {
  try {
    await router.push({ name: 'register' });
  } catch (error) {
    reportUiError('Failed to navigate to account registration', error);
  }
}
</script>

<style scoped>
.auth-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 20px;
}

.auth-shell {
  width: min(100%, 460px);
}

.auth-shell--wide {
  width: min(100%, 560px);
}

.auth-card {
  --auth-card-chrome-height: 128px;
  --auth-card-footer-height: calc(var(--auth-card-chrome-height) / 2);
  border-radius: 20px;
  border: 1px solid var(--nc-border);
  overflow: hidden;
  background: var(--nc-panel-sidebar-bg);
  box-shadow: var(--nc-shadow-sm);
  backdrop-filter: blur(var(--nc-glass-blur));
}

.auth-card--light {
  border-color: rgba(208, 220, 235, 0.82);
  background: rgba(239, 246, 251, 0.9);
  color: #182236;
  box-shadow: 0 18px 40px rgba(17, 40, 76, 0.16);
  backdrop-filter: blur(18px);
}

.auth-card__header {
  height: var(--auth-card-chrome-height);
  padding: 22px 22px 10px;
  box-sizing: border-box;
  background: var(--nc-panel-header-bg);
  border-bottom: 1px solid color-mix(in srgb, var(--nc-border) 90%, #8fa5c1 10%);
}

.auth-card--light .auth-card__header {
  background: rgba(255, 255, 255, 0.82);
  border-bottom-color: rgba(208, 220, 235, 0.82);
}

.auth-card__header-main {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
}

.auth-card__header-text {
  min-width: 0;
}

.auth-card__back-button {
  flex: 0 0 auto;
  margin-top: -2px;
  color: #2563eb;
}

.auth-card__title {
  font-size: 28px;
  font-weight: 700;
  line-height: 1.1;
}

.auth-card__subtitle {
  margin-top: 8px;
  opacity: 0.75;
}

.auth-card__actions {
  display: grid;
  gap: 12px;
  padding: 10px 22px 22px;
}

.auth-card__actions--nested {
  padding: 0;
}

.auth-card__button {
  min-height: 44px;
  border-radius: 999px;
}

.auth-card__button--secondary {
  border: 1px solid rgba(37, 99, 235, 0.55);
  background: rgba(255, 255, 255, 0.18);
}

.auth-card__button-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.auth-card__button-row--single {
  grid-template-columns: 1fr;
}

.auth-card__footer {
  display: flex;
  align-items: flex-end;
  justify-content: center;
  gap: 6px;
  height: var(--auth-card-footer-height);
  padding: 10px 22px 14px;
  box-sizing: border-box;
  color: #64748b;
  font-size: 13px;
  border-top: 1px solid rgba(208, 220, 235, 0.72);
  background: rgba(255, 255, 255, 0.48);
}

.auth-card__footer-logo-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
}

.auth-card__footer-logo {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  border-radius: 50%;
}

.auth-card__footer-link {
  color: #ff1fe1;
  font-weight: 700;
  text-decoration: none;
}

.auth-card__footer-link:hover,
.auth-card__footer-link:focus-visible {
  text-decoration: underline;
}

.auth-warning {
  border-color: #f3c969;
  background: #fff7db;
}

.auth-warning__content {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  color: #7c4a03;
  font-weight: 600;
}

.auth-warning__icon {
  color: #b26b00;
}

.auth-card--onboarding {
  width: min(100%, 560px);
}

.auth-card--remote-signer {
  width: min(100%, 560px);
}

.auth-onboarding {
  gap: 16px;
  padding-top: 16px;
}

.remote-signer {
  gap: 14px;
}

.remote-signer__tabs {
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.78);
  color: #334155;
}

.remote-signer__panels {
  border-radius: 14px;
  background: transparent;
  color: #182236;
}

.remote-signer__panel {
  display: grid;
  gap: 12px;
  padding: 0;
}

.remote-signer-pairing {
  display: grid;
  gap: 12px;
}

.remote-signer-pairing__qr-shell {
  justify-self: center;
  display: grid;
  place-items: center;
  width: min(100%, 280px);
  aspect-ratio: 1;
  padding: 12px;
  border: 1px solid rgba(208, 220, 235, 0.92);
  border-radius: 12px;
  background: #ffffff;
}

.remote-signer-pairing__qr {
  display: block;
  width: 100%;
  max-width: 256px;
  height: auto;
}

.remote-signer-pairing__uri :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  font-size: 12px;
  line-height: 1.35;
}

.remote-signer__auth-link {
  color: #2563eb;
  font-weight: 700;
  text-decoration: none;
}

.remote-signer__auth-link:hover,
.remote-signer__auth-link:focus-visible {
  text-decoration: underline;
}

.auth-card--light .nc-input :deep(.q-field__control) {
  background: rgba(255, 255, 255, 0.94);
  color: #182236;
}

.auth-card--light .nc-input :deep(.q-field__native),
.auth-card--light .nc-input :deep(.q-field__input),
.auth-card--light .nc-input :deep(.q-field__label) {
  color: #182236;
}

.auth-card--light .nc-input :deep(.q-field__label) {
  opacity: 0.72;
}

.auth-card--light .nc-input :deep(.q-field__marginal) {
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

.onboarding-relay-list :deep(.q-item__label--caption) {
  color: #64748b;
  opacity: 1;
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

  .auth-card__button-row {
    grid-template-columns: 1fr;
  }
}
</style>
