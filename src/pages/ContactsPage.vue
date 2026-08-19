<template>
  <q-page class="contacts-page" :style-fn="contactsPageStyleFn">
    <div
      ref="shellRef"
      class="contacts-shell"
      :class="{ 'contacts-shell--mobile': isMobile }"
      :style="shellStyle"
    >
      <aside v-if="!isMobile || !isMobileProfileOpen" class="contacts-sidebar">
        <div class="contacts-sidebar__top">
          <div class="contacts-sidebar__row">
            <q-input
              v-model="contactQueryModel"
              class="nc-input contacts-sidebar__search"
              data-testid="contact-list-search"
              dense
              outlined
              rounded
              clearable
              clear-icon="close"
              :placeholder="$t('contacts.filterContacts')"
            />
            <div class="contacts-sidebar__actions">
              <q-btn
                dense
                flat
                round
                icon="refresh"
                :aria-label="$t('contacts.refreshContacts')"
                :loading="isRefreshingContacts"
                @click="handleRefreshContacts"
              >
                <AppTooltip>{{ $t('contacts.refreshContacts') }}</AppTooltip>
              </q-btn>
              <q-btn
                dense
                flat
                round
                icon="person_add_alt"
                :aria-label="$t('contacts.addContact')"
                @click="openAddContactDialog"
              >
                <AppTooltip>{{ $t('contacts.addContact') }}</AppTooltip>
              </q-btn>
            </div>
          </div>

          <ReconnectHealingBanner class="contacts-sidebar__healing" />
          <StartupHistoryBanner class="contacts-sidebar__healing" />
        </div>

        <q-scroll-area class="contacts-list">
          <q-list>
            <template v-if="!isLoadingContacts && contacts.length > 0">
              <template v-for="section in contactSections" :key="section.key">
                <q-item
                  clickable
                  dense
                  class="contacts-section-toggle"
                  :aria-expanded="section.expanded ? 'true' : 'false'"
                  @click="toggleContactSection(section.key)"
                >
                  <q-item-section avatar class="contacts-section-toggle__icon">
                    <q-icon
                      :name="section.expanded ? 'expand_more' : 'chevron_right'"
                      size="18px"
                      aria-hidden="true"
                    />
                  </q-item-section>
                  <q-item-section>
                    <q-item-label class="contacts-section-toggle__label">
                      {{ section.label }}
                    </q-item-label>
                  </q-item-section>
                  <q-item-section side>
                    <span class="contacts-section-toggle__count">{{ section.contacts.length }}</span>
                  </q-item-section>
                </q-item>

                <template v-if="section.expanded">
                  <q-item
                    v-for="contact in section.contacts"
                    :key="contact.id"
                    clickable
                    class="contact-item"
                    :class="{
                      'contact-item--muted': isContactMuted(contact),
                      'contact-item--blocked': isContactBlocked(contact)
                    }"
                    :active="contact.id === selectedContactId"
                    active-class="contact-item--active"
                    @click="handleSelectContact(contact)"
                  >
                    <q-item-section avatar>
                      <CachedAvatar
                        :src="contactPictureUrl(contact)"
                        :alt="contactListTitle(contact)"
                        :fallback="contactAvatar(contact)"
                        class="contact-item__avatar"
                      />
                    </q-item-section>

                    <q-item-section class="contact-item__main">
                      <div class="contact-item__headline">
                        <q-item-label class="contact-item__name" lines="1">
                          {{ contactListTitle(contact) }}
                        </q-item-label>
                        <span
                          v-if="isContactBlocked(contact)"
                          class="contact-item__block-indicator"
                          :aria-label="$t('common.block')"
                        >
                          <q-icon name="block" size="15px" aria-hidden="true" />
                          <AppTooltip>{{ $t('common.block') }}</AppTooltip>
                        </span>
                        <span
                          v-else-if="isContactMuted(contact)"
                          class="contact-item__mute-indicator"
                          :aria-label="$t('common.mute')"
                        >
                          <q-icon name="notifications_off" size="15px" aria-hidden="true" />
                          <AppTooltip>{{ $t('common.mute') }}</AppTooltip>
                        </span>
                      </div>
                      <q-item-label
                        v-if="contactListCaption(contact)"
                        caption
                        class="contact-item__caption"
                        lines="1"
                      >
                        {{ contactListCaption(contact) }}
                      </q-item-label>
                    </q-item-section>

                    <q-item-section side class="contact-item__actions">
                      <q-btn
                        flat
                        dense
                        round
                        icon="more_vert"
                        class="contact-item__more"
                        :aria-label="$t('contacts.contactActions')"
                        @click.stop
                      >
                        <q-menu anchor="bottom right" self="top right" class="nc-pop-menu">
                          <q-list dense class="nc-pop-menu__list">
                            <q-item
                              v-if="!isContactBlocked(contact)"
                              clickable
                              v-close-popup
                              @click="handleContactMenuChat(contact)"
                            >
                              <q-item-section>{{ $t('chat.chat') }}</q-item-section>
                            </q-item>
                            <q-item
                              v-if="!isContactBlocked(contact)"
                              clickable
                              v-close-popup
                              @click="handleContactMenuRefreshProfile(contact)"
                            >
                              <q-item-section>{{ $t('profile.refreshProfile') }}</q-item-section>
                            </q-item>
                            <q-item
                              v-if="!isContactBlocked(contact)"
                              clickable
                              v-close-popup
                              @click="
                                isContactMuted(contact)
                                  ? handleContactMenuUnmute(contact)
                                  : handleContactMenuMute(contact)
                              "
                            >
                              <q-item-section>
                                {{ isContactMuted(contact) ? $t('common.unmute') : $t('common.mute') }}
                              </q-item-section>
                            </q-item>
                            <q-item
                              v-if="!isContactBlocked(contact)"
                              clickable
                              v-close-popup
                              @click="handleContactMenuBlock(contact)"
                            >
                              <q-item-section class="text-negative">
                                {{ $t('common.block') }}
                              </q-item-section>
                            </q-item>
                            <q-item
                              v-else
                              clickable
                              v-close-popup
                              @click="handleContactMenuUnblock(contact)"
                            >
                              <q-item-section>{{ $t('common.unblock') }}</q-item-section>
                            </q-item>
                            <q-item clickable v-close-popup @click="handleContactMenuDelete(contact)">
                              <q-item-section class="text-negative">
                                {{ $t('contacts.deleteContact') }}
                              </q-item-section>
                            </q-item>
                          </q-list>
                        </q-menu>
                      </q-btn>
                    </q-item-section>
                  </q-item>
                </template>
              </template>
            </template>

            <div v-if="isLoadingContacts" class="contacts-empty">{{ $t('contacts.loadingContacts') }}</div>

            <div v-else-if="contacts.length === 0" class="contacts-empty">
              {{ $t('contacts.contactsFound') }}
            </div>
          </q-list>
        </q-scroll-area>
        <AppNavRail
          v-if="!isMobile"
          class="contacts-sidebar__nav"
          active="contacts"
          @select="handleRailSelect"
        />
      </aside>

      <div
        v-if="!isMobile"
        class="app-shell__resize-handle"
        role="separator"
        :aria-label="$t('common.resizeLeftPanel')"
        aria-orientation="vertical"
        :aria-valuemin="minSidebarWidth"
        :aria-valuemax="maxSidebarWidth"
        :aria-valuenow="sidebarWidth"
        tabindex="0"
        @pointerdown="startSidebarResize"
        @keydown="handleSidebarResizeKeydown"
      />

      <section
        v-if="!isMobile || isMobileProfileOpen"
        class="contacts-detail-panel"
        :class="{ 'contacts-detail-panel--mobile': isMobile }"
      >
        <q-scroll-area class="contacts-detail-panel__scroll">
          <div v-if="selectedContactPubkey" class="contacts-detail-panel__content">
            <div v-if="isMobile" class="contacts-detail-mobile-header">
              <q-btn
                flat
                dense
                round
                icon="arrow_back"
                :aria-label="$t('contacts.backContacts')"
                @click="handleBackToContactsList"
              />
              <div class="contacts-detail-mobile-header__title">{{ selectedContactHeaderTitle }}</div>
              <div class="contacts-detail-mobile-header__spacer" aria-hidden="true" />
            </div>
            <ContactProfile
              v-model="selectedContactProfile"
              v-model:pubkey="selectedContactPubkey"
              :auto-refresh-on-pubkey-change="true"
              :read-only="!canPublishSelectedGroupProfile"
              :show-header="true"
              :show-share-action="true"
              :show-publish-action="canPublishSelectedGroupProfile"
              :is-publishing="isPublishingSelectedGroupProfile"
              @update:send-messages-to-app-relays="handleSendMessagesToAppRelaysUpdate"
              @open-chat="handleOpenChat"
              @publish="handlePublishSelectedGroupProfile"
            />
          </div>
          <div v-else class="contacts-empty-state">{{ $t('contacts.selectContactViewProfile') }}</div>
        </q-scroll-area>
      </section>
    </div>

    <ContactLookupDialog
      v-model="isAddContactDialogOpen"
      purpose="contact"
      @resolved="handleResolvedContactFromDialog"
    />
  </q-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import AppNavRail from 'src/components/AppNavRail.vue';
import AppTooltip from 'src/components/AppTooltip.vue';
import ContactProfile from 'src/components/ContactProfile.vue';
import CachedAvatar from 'src/components/CachedAvatar.vue';
import ContactLookupDialog from 'src/components/ContactLookupDialog.vue';
import ReconnectHealingBanner from 'src/components/ReconnectHealingBanner.vue';
import StartupHistoryBanner from 'src/components/StartupHistoryBanner.vue';
import { useSectionShell } from 'src/composables/useSectionShell';
import { contactsService } from 'src/services/contactsService';
import { useChatStore } from 'src/stores/chatStore';
import { t } from 'src/i18n';
import { useNostrStore } from 'src/stores/nostrStore';
import { useRelayStore } from 'src/stores/relayStore';
import type { ContactMetadata, ContactRecord } from 'src/types/contact';
import {
  createEmptyContactProfileForm,
  type ContactProfileForm
} from 'src/types/contactProfile';
import { buildAvatarText } from 'src/utils/avatarText';
import {
  contactListCaption as formatContactListCaption,
  contactListTitle as formatContactListTitle,
  searchContactsForList,
  sortContactsForList,
  type ContactListOptions
} from 'src/utils/contactList';
import { buildContactProfilePublishPayload } from 'src/utils/contactProfilePublish';
import { reportUiError } from 'src/utils/uiErrorHandler';

const $q = useQuasar();
const route = useRoute();
const router = useRouter();
const chatStore = useChatStore();
const nostrStore = useNostrStore();
const relayStore = useRelayStore();

relayStore.init();

const {
  isMobile,
  shellRef,
  shellStyle,
  sidebarWidth,
  minSidebarWidth,
  maxSidebarWidth,
  startSidebarResize,
  handleSidebarResizeKeydown,
  buildPageStyle: contactsPageStyleFn,
  handleRailSelect
} = useSectionShell({
  activeSection: 'contacts',
  errorContext: 'Failed to navigate from contacts rail'
});
const isMobileProfileOpen = computed(() => isMobile.value && Boolean(selectedContactPubkey.value.trim()));
const contactQuery = ref('');
const contactQueryModel = computed({
  get: () => contactQuery.value,
  set: (value: string | null) => {
    contactQuery.value = typeof value === 'string' ? value : '';
  }
});
const isAddContactDialogOpen = ref(false);
const isLoadingContacts = ref(false);
const isRefreshingContacts = ref(false);
const selectedContactId = ref<number | null>(null);
const selectedContactPubkey = ref('');
const selectedContactProfile = ref(createEmptyContactProfileForm());
const contacts = ref<ContactRecord[]>([]);
const isPublishingSelectedGroupProfile = ref(false);
type ContactSectionKey = 'active' | 'muted' | 'blocked';

interface ContactSection {
  key: ContactSectionKey;
  label: string;
  contacts: ContactRecord[];
  expanded: boolean;
}

const expandedContactSections = ref<Record<ContactSectionKey, boolean>>({
  active: true,
  muted: false,
  blocked: false
});
const selectedContactRecord = computed<ContactRecord | null>(() => {
  const normalizedPubkey = selectedContactPubkey.value.trim().toLowerCase();
  if (!normalizedPubkey) {
    return null;
  }

  return (
    contacts.value.find(
      (contact) => contact.public_key.trim().toLowerCase() === normalizedPubkey
    ) ?? null
  );
});
const canPublishSelectedGroupProfile = computed(() => {
  const loggedInPubkey = nostrStore.getLoggedInPublicKeyHex()?.trim().toLowerCase() ?? '';
  const selectedContact = selectedContactRecord.value;
  if (!loggedInPubkey || !selectedContact || selectedContact.type !== 'group') {
    return false;
  }

  return (selectedContact.meta.owner_public_key?.trim().toLowerCase() ?? '') === loggedInPubkey;
});
const selectedContactHeaderTitle = computed(() => {
  const displayName = selectedContactProfile.value.display_name.trim();
  if (displayName) {
    return displayName;
  }

  const name = selectedContactProfile.value.name.trim();
  if (name) {
    return name;
  }

  return selectedContactPubkey.value.trim().slice(0, 32) || t('contacts.contact.label');
});
const activeContacts = computed(() =>
  contacts.value.filter((contact) => !isContactMuted(contact) && !isContactBlocked(contact))
);
const mutedContacts = computed(() =>
  contacts.value.filter((contact) => isContactMuted(contact) && !isContactBlocked(contact))
);
const blockedContacts = computed(() => contacts.value.filter((contact) => isContactBlocked(contact)));
const contactSections = computed<ContactSection[]>(() => [
  {
    key: 'active',
    label: t('contacts.section.active'),
    contacts: activeContacts.value,
    expanded: expandedContactSections.value.active
  },
  {
    key: 'muted',
    label: t('contacts.section.muted'),
    contacts: mutedContacts.value,
    expanded: expandedContactSections.value.muted
  },
  {
    key: 'blocked',
    label: t('contacts.section.blocked'),
    contacts: blockedContacts.value,
    expanded: expandedContactSections.value.blocked
  }
]);

let latestSearchRequestId = 0;

onMounted(() => {
  void chatStore.init();
  void initializeContacts();
});

watch(contactQuery, (query) => {
  void loadContacts(query);
});

watch(
  () => parsePubkeyRouteParam(route.params.pubkey),
  (pubkey) => {
    syncSelectedContactFromRoute(pubkey);
  },
  { immediate: true }
);

watch(
  () => nostrStore.contactListVersion,
  () => {
    void loadContacts(contactQuery.value);
  }
);

function contactAvatar(contact: ContactRecord): string {
  const meta = contact.meta;
  if (meta.avatar?.trim()) {
    return meta.avatar.trim().slice(0, 2).toUpperCase();
  }

  return buildAvatarText(contactDisplayName(contact) || contact.public_key);
}

function contactPictureUrl(contact: ContactRecord): string {
  const picture = contact.meta.picture?.trim();
  if (picture) {
    return picture;
  }

  return '';
}

function contactDisplayName(contact: ContactRecord): string {
  const displayName = contact.meta.display_name?.trim();
  if (displayName) {
    return displayName;
  }

  const givenName = contact.given_name?.trim();
  if (givenName) {
    return givenName;
  }

  return contact.name || contact.public_key;
}

function selectedProfileDisplayName(fallbackPublicKey: string): string {
  const displayName = selectedContactProfile.value.display_name.trim();
  if (displayName) {
    return displayName;
  }

  const name = selectedContactProfile.value.name.trim();
  if (name) {
    return name;
  }

  return fallbackPublicKey.slice(0, 16);
}

function contactPubkeySnippet(contact: ContactRecord): string {
  return contact.public_key.trim().slice(0, 32);
}

function currentContactListOptions(): ContactListOptions {
  return {
    loggedInPubkey: nostrStore.getLoggedInPublicKeyHex(),
    resolveNpub: (publicKey: string) => nostrStore.encodeNpub(publicKey)
  };
}

function contactListTitle(contact: ContactRecord): string {
  return formatContactListTitle(contact, currentContactListOptions()) || contactPubkeySnippet(contact);
}

function contactListCaption(contact: ContactRecord): string {
  return formatContactListCaption(contact, currentContactListOptions());
}

function isContactMuted(contact: ContactRecord): boolean {
  return contact.meta.muted === true;
}

function isContactBlocked(contact: ContactRecord): boolean {
  return contact.meta.blocked === true;
}

function shouldEnsureContactBeforeChat(contact: ContactRecord): boolean {
  return contact.type !== 'group' && contact.meta.private_contact_list_member !== true;
}

function toggleContactSection(sectionKey: ContactSectionKey): void {
  expandedContactSections.value[sectionKey] = !expandedContactSections.value[sectionKey];
}

function expandContactSectionForContact(contact: ContactRecord): void {
  if (isContactBlocked(contact)) {
    expandedContactSections.value.blocked = true;
    return;
  }

  expandedContactSections.value[isContactMuted(contact) ? 'muted' : 'active'] = true;
}

function applyContactListQuery(nextContacts: ContactRecord[], query = ''): ContactRecord[] {
  const options = currentContactListOptions();
  const normalizedQuery = typeof query === 'string' ? query.trim() : '';
  if (!normalizedQuery) {
    return sortContactsForList(nextContacts, options);
  }

  return searchContactsForList(nextContacts, normalizedQuery, options);
}

function mapContactToProfileForm(contact: ContactRecord): ContactProfileForm {
  const picture = contact.meta.picture ?? '';

  return {
    ...createEmptyContactProfileForm(),
    name: contact.meta.name ?? contact.name ?? '',
    about: contact.meta.about ?? '',
    picture,
    nip05: contact.meta.nip05 ?? '',
    lud06: contact.meta.lud06 ?? '',
    lud16: contact.meta.lud16 ?? '',
    display_name: contact.meta.display_name ?? contact.given_name ?? '',
    website: contact.meta.website ?? '',
    banner: contact.meta.banner ?? '',
    bot: contact.meta.bot === true,
    group: contact.meta.group === true,
    birthday: {
      year: contact.meta.birthday?.year ?? null,
      month: contact.meta.birthday?.month ?? null,
      day: contact.meta.birthday?.day ?? null
    },
    relays: (contact.relays ?? []).map((relay) => relay.url),
    sendMessagesToAppRelays: contact.sendMessagesToAppRelays === true
  };
}

function setOptionalContactMetaString(
  meta: ContactMetadata,
  key:
    | 'name'
    | 'about'
    | 'picture'
    | 'nip05'
    | 'lud06'
    | 'lud16'
    | 'display_name'
    | 'website'
    | 'banner',
  value: string
): void {
  const normalizedValue = value.trim();
  if (normalizedValue) {
    meta[key] = normalizedValue;
    return;
  }

  delete meta[key];
}

function buildUpdatedContactMeta(contact: ContactRecord, profile: ContactProfileForm): ContactMetadata {
  const nextMeta: ContactMetadata = {
    ...(contact.meta ?? {})
  };

  setOptionalContactMetaString(nextMeta, 'name', profile.name);
  setOptionalContactMetaString(nextMeta, 'about', profile.about);
  setOptionalContactMetaString(nextMeta, 'picture', profile.picture);
  setOptionalContactMetaString(nextMeta, 'nip05', profile.nip05);
  setOptionalContactMetaString(nextMeta, 'lud06', profile.lud06);
  setOptionalContactMetaString(nextMeta, 'lud16', profile.lud16);
  setOptionalContactMetaString(nextMeta, 'display_name', profile.display_name);
  setOptionalContactMetaString(nextMeta, 'website', profile.website);
  setOptionalContactMetaString(nextMeta, 'banner', profile.banner);
  nextMeta.bot = profile.bot;
  nextMeta.group = profile.group;

  const birthday = profile.birthday;
  const normalizedBirthday: NonNullable<ContactMetadata['birthday']> = {};
  if (Number.isInteger(birthday.year) && Number(birthday.year) > 0) {
    normalizedBirthday.year = Number(birthday.year);
  }
  if (
    Number.isInteger(birthday.month) &&
    Number(birthday.month) >= 1 &&
    Number(birthday.month) <= 12
  ) {
    normalizedBirthday.month = Number(birthday.month);
  }
  if (Number.isInteger(birthday.day) && Number(birthday.day) >= 1 && Number(birthday.day) <= 31) {
    normalizedBirthday.day = Number(birthday.day);
  }

  if (Object.keys(normalizedBirthday).length > 0) {
    nextMeta.birthday = normalizedBirthday;
  } else {
    delete nextMeta.birthday;
  }

  return nextMeta;
}

function updateContactInState(updatedContact: ContactRecord): void {
  contacts.value = applyContactListQuery(
    contacts.value.map((contact) => (contact.id === updatedContact.id ? updatedContact : contact)),
    contactQuery.value
  );

  if (selectedContactId.value === updatedContact.id) {
    selectedContactPubkey.value = updatedContact.public_key;
    selectedContactProfile.value = mapContactToProfileForm(updatedContact);
  }
}

async function initializeContacts(): Promise<void> {
  try {
    await contactsService.init();
    await loadContacts();
  } catch (error) {
    console.error('Failed to initialize contacts service', error);
  }
}

async function loadContacts(query = ''): Promise<void> {
  const requestId = ++latestSearchRequestId;
  isLoadingContacts.value = true;
  const normalizedQuery = typeof query === 'string' ? query : '';

  try {
    const nextContacts = await contactsService.listContacts();

    if (requestId !== latestSearchRequestId) {
      return;
    }

    contacts.value = applyContactListQuery(nextContacts, normalizedQuery);

    if (
      selectedContactId.value !== null &&
      !contacts.value.some((contact) => contact.id === selectedContactId.value)
    ) {
      selectedContactId.value = null;
      selectedContactPubkey.value = '';
      selectedContactProfile.value = createEmptyContactProfileForm();
    }

    syncSelectedContactFromRoute(parsePubkeyRouteParam(route.params.pubkey));
  } catch (error) {
    console.error('Failed to load contacts', error);
  } finally {
    if (requestId === latestSearchRequestId) {
      isLoadingContacts.value = false;
    }
  }
}

function handleSelectContact(contact: ContactRecord, syncRoute = true): void {
  try {
    selectedContactId.value = contact.id;
    selectedContactPubkey.value = contact.public_key;
    selectedContactProfile.value = mapContactToProfileForm(contact);
    expandContactSectionForContact(contact);

    if (!syncRoute) {
      return;
    }

    const routePubkey = parsePubkeyRouteParam(route.params.pubkey).toLowerCase();
    const selectedPubkey = contact.public_key.toLowerCase();
    if (routePubkey === selectedPubkey) {
      return;
    }

    if (isMobile.value) {
      void router.push({
        name: 'contacts',
        params: {
          pubkey: contact.public_key
        }
      });
      return;
    }

    void router.replace({
      name: 'contacts',
      params: {
        pubkey: contact.public_key
      }
    });
  } catch (error) {
    reportUiError('Failed to select contact', error);
  }
}

function openAddContactDialog(): void {
  try {
    isAddContactDialogOpen.value = true;
  } catch (error) {
    reportUiError('Failed to open add contact dialog', error);
  }
}

async function handleResolvedContactFromDialog(contact: ContactRecord): Promise<void> {
  try {
    contactQuery.value = '';
    await loadContacts();
    const nextSelectedContact = await contactsService.getContactByPublicKey(contact.public_key);
    handleSelectContact(nextSelectedContact ?? contact, true);
  } catch (error) {
    reportUiError('Failed to select resolved contact', error);
  }
}

function parsePubkeyRouteParam(value: unknown): string {
  if (Array.isArray(value)) {
    return parsePubkeyRouteParam(value[0]);
  }

  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function clearSelectedContact(): void {
  selectedContactId.value = null;
  selectedContactPubkey.value = '';
  selectedContactProfile.value = createEmptyContactProfileForm();
}

function syncSelectedContactFromRoute(pubkey: string): void {
  const normalizedPubkey = pubkey.trim().toLowerCase();
  if (!normalizedPubkey) {
    clearSelectedContact();
    return;
  }

  selectContactByPublicKey(normalizedPubkey);
}

function selectContactByPublicKey(pubkey: string): void {
  const normalizedPubkey = pubkey.trim().toLowerCase();
  if (!normalizedPubkey) {
    clearSelectedContact();
    return;
  }

  const matchedContact = contacts.value.find(
    (contact) => contact.public_key.trim().toLowerCase() === normalizedPubkey
  );

  if (matchedContact) {
    handleSelectContact(matchedContact, false);
    return;
  }

  selectedContactId.value = null;
  selectedContactPubkey.value = pubkey.trim();
  selectedContactProfile.value = createEmptyContactProfileForm();
}

async function openChatForContact(contact: ContactRecord): Promise<void> {
  if (isContactBlocked(contact)) {
    return;
  }

  const contactPubkey = contact.public_key.trim();
  if (!contactPubkey) {
    return;
  }

  await chatStore.init();

  const fallbackName = contactPubkey.slice(0, 32);
  const chatName = contactDisplayName(contact) || contact.public_key || fallbackName;

  const chat = await chatStore.addContact(chatName, contactPubkey);
  if (!chat) {
    return;
  }

  chatStore.selectChat(chat.id);

  void router.push({ name: 'chats', params: { pubkey: chat.publicKey } });
}

async function ensureSelectedContactForChat(publicKey: string): Promise<ContactRecord | null> {
  const normalizedPublicKey = publicKey.trim().toLowerCase();
  if (!normalizedPublicKey) {
    return null;
  }

  await contactsService.init();
  const existingContact = await contactsService.getContactByPublicKey(normalizedPublicKey);
  if (existingContact) {
    if (isContactBlocked(existingContact)) {
      return null;
    }

    if (!shouldEnsureContactBeforeChat(existingContact)) {
      return existingContact;
    }
  }

  const fallbackName = selectedProfileDisplayName(normalizedPublicKey);
  await nostrStore.ensureRespondedPubkeyIsContact(normalizedPublicKey, fallbackName);

  let nextContact = await contactsService.getContactByPublicKey(normalizedPublicKey);
  if (!nextContact) {
    const profileName = selectedContactProfile.value.name.trim();
    const profileDisplayName = selectedContactProfile.value.display_name.trim();
    const profilePicture = selectedContactProfile.value.picture.trim();
    const profileAbout = selectedContactProfile.value.about.trim();
    const profileNip05 = selectedContactProfile.value.nip05.trim();
    const profileMeta: ContactMetadata = {
      private_contact_list_member: true,
      ...(profileName ? { name: profileName } : {}),
      ...(profileDisplayName ? { display_name: profileDisplayName } : {}),
      ...(profilePicture ? { picture: profilePicture } : {}),
      ...(profileAbout ? { about: profileAbout } : {}),
      ...(profileNip05 ? { nip05: profileNip05 } : {})
    };
    nextContact = await contactsService.createContact({
      public_key: normalizedPublicKey,
      name: fallbackName,
      given_name: profileDisplayName || null,
      meta: profileMeta,
      relays: selectedContactProfile.value.relays.map((url) => ({
        url,
        read: true,
        write: true
      }))
    });
    try {
      await nostrStore.publishPrivateContactList(relayStore.relays);
    } catch (error) {
      reportUiError(
        'Failed to publish private contact list after creating chat contact',
        error,
        t('contacts.contactSavedContactList')
      );
    }
  }

  if (!nextContact || isContactBlocked(nextContact)) {
    return null;
  }

  await loadContacts(contactQuery.value);
  const refreshedContact =
    (await contactsService.getContactByPublicKey(normalizedPublicKey)) ?? nextContact;
  handleSelectContact(refreshedContact, false);
  return refreshedContact;
}

async function handleOpenChat(): Promise<void> {
  try {
    const contactPubkey = selectedContactPubkey.value.trim().toLowerCase();
    if (!contactPubkey) {
      return;
    }

    const selectedContact = contacts.value.find(
      (contact) => contact.public_key.trim().toLowerCase() === contactPubkey
    );
    const contactForChat =
      selectedContact &&
      !isContactBlocked(selectedContact) &&
      !shouldEnsureContactBeforeChat(selectedContact)
        ? selectedContact
        : await ensureSelectedContactForChat(contactPubkey);

    if (!contactForChat) {
      return;
    }

    await openChatForContact(contactForChat);
  } catch (error) {
    reportUiError('Failed to open chat for contact', error);
  }
}

function removeRoutePubkeyIfMatches(publicKey: string): void {
  const routePubkey = parsePubkeyRouteParam(route.params.pubkey).trim().toLowerCase();
  if (!routePubkey || routePubkey !== publicKey.trim().toLowerCase()) {
    return;
  }

  void router.replace({
    name: 'contacts'
  });
}

function handleBackToContactsList(): void {
  try {
    void router.replace({ name: 'contacts' });
  } catch (error) {
    reportUiError('Failed to navigate back to contacts list', error);
  }
}

async function handleContactMenuChat(contact: ContactRecord): Promise<void> {
  try {
    if (isContactBlocked(contact)) {
      return;
    }

    handleSelectContact(contact, true);
    await openChatForContact(contact);
  } catch (error) {
    reportUiError('Failed to open contact chat from menu', error);
  }
}

async function refreshStoredContact(contact: ContactRecord): Promise<ContactRecord | null> {
  if (isContactBlocked(contact)) {
    return contact;
  }

  await nostrStore.refreshContactByPublicKey(contact.public_key, contactDisplayName(contact), {
    refreshRelayList: true
  });
  return contactsService.getContactByPublicKey(contact.public_key);
}

async function handleRefreshContacts(): Promise<void> {
  if (isRefreshingContacts.value) {
    return;
  }

  isRefreshingContacts.value = true;

  try {
    await nostrStore.refreshPrivateContactListWithOutgoingMessages();
    await contactsService.init();
    const storedContacts = await contactsService.listContacts();
    const refreshableContacts = storedContacts.filter((contact) => !isContactBlocked(contact));

    if (refreshableContacts.length === 0) {
      await loadContacts(contactQuery.value);
      $q.notify({
        type: 'info',
        message: t('contacts.contactsRefresh'),
        position: 'top'
      });
      return;
    }

    let refreshedCount = 0;
    let failedCount = 0;

    for (const contact of refreshableContacts) {
      try {
        await refreshStoredContact(contact);
        refreshedCount += 1;
      } catch (error) {
        failedCount += 1;
        console.warn('Failed to refresh contact profile from contacts header', contact.public_key, error);
      }
    }

    await loadContacts(contactQuery.value);

    if (failedCount === 0) {
      $q.notify({
      type: 'positive',
      message:
        refreshedCount === 1
          ? t('contacts.refreshedContact', { count: refreshedCount })
          : t('contacts.refreshedContacts', { count: refreshedCount }),
      position: 'top'
    });
      return;
    }

    $q.notify({
      type: refreshedCount > 0 ? 'warning' : 'negative',
      message:
        refreshedCount > 0
          ? t('contacts.refreshedFailed', {
              count: refreshedCount,
              contactLabel: refreshedCount === 1 ? t('contacts.contact') : t('contacts.contacts'),
              failedCount
            })
          : t('errors.failedRefreshContacts'),
      position: 'top'
    });
  } catch (error) {
    reportUiError('Failed to refresh contacts from header', error, t('errors.failedRefreshContacts'));
  } finally {
    isRefreshingContacts.value = false;
  }
}

async function handleContactMenuRefreshProfile(contact: ContactRecord): Promise<void> {
  try {
    if (isContactBlocked(contact)) {
      return;
    }

    await refreshStoredContact(contact);
    await loadContacts(contactQuery.value);

    const refreshedContact = await contactsService.getContactByPublicKey(contact.public_key);
    if (refreshedContact && refreshedContact.id === selectedContactId.value) {
      selectedContactProfile.value = mapContactToProfileForm(refreshedContact);
    }
  } catch (error) {
    reportUiError('Failed to refresh contact profile from menu', error, t('errors.failedRefreshProfile'));
  }
}

async function handleContactMenuMute(contact: ContactRecord): Promise<void> {
  try {
    if (isContactBlocked(contact)) {
      return;
    }

    expandedContactSections.value.muted = true;
    await nostrStore.mutePubkey(contact.public_key, relayStore.relays);
    await loadContacts(contactQuery.value);
  } catch (error) {
    reportUiError('Failed to mute contact from menu', error);
  }
}

async function handleContactMenuUnmute(contact: ContactRecord): Promise<void> {
  try {
    expandedContactSections.value.active = true;
    await nostrStore.unmutePubkey(contact.public_key, relayStore.relays);
    await loadContacts(contactQuery.value);
  } catch (error) {
    reportUiError('Failed to unmute contact from menu', error);
  }
}

async function handleContactMenuBlock(contact: ContactRecord): Promise<void> {
  try {
    expandedContactSections.value.blocked = true;
    await nostrStore.blockPubkey(contact.public_key, relayStore.relays, {
      fallbackName: contactDisplayName(contact),
      type: contact.type
    });
    await loadContacts(contactQuery.value);
  } catch (error) {
    reportUiError('Failed to block contact from menu', error);
  }
}

async function handleContactMenuUnblock(contact: ContactRecord): Promise<void> {
  try {
    expandedContactSections.value.active = true;
    await nostrStore.unblockPubkey(contact.public_key, relayStore.relays, {
      fallbackName: contactDisplayName(contact),
      type: contact.type
    });
    await loadContacts(contactQuery.value);
  } catch (error) {
    reportUiError('Failed to unblock contact from menu', error);
  }
}

async function handleSendMessagesToAppRelaysUpdate(value: boolean): Promise<void> {
  const normalizedPubkey = selectedContactPubkey.value.trim().toLowerCase();
  if (!normalizedPubkey) {
    return;
  }

  const currentContact =
    contacts.value.find((contact) => contact.public_key.trim().toLowerCase() === normalizedPubkey) ??
    null;
  const previousValue = currentContact?.sendMessagesToAppRelays ?? false;

  try {
    const updatedContact = await contactsService.updateSendMessagesToAppRelays(
      normalizedPubkey,
      value
    );
    if (!updatedContact) {
      throw new Error('Contact not found.');
    }

    updateContactInState(updatedContact);
  } catch (error) {
    if (currentContact) {
      updateContactInState(currentContact);
    } else {
      selectedContactProfile.value = {
        ...selectedContactProfile.value,
        sendMessagesToAppRelays: previousValue
      };
    }

    reportUiError(
      'Failed to update contact app relay preference',
      error,
      t('errors.failedUpdateRelayPreference')
    );
  }
}

async function handlePublishSelectedGroupProfile(nextProfile: ContactProfileForm): Promise<void> {
  if (isPublishingSelectedGroupProfile.value || !canPublishSelectedGroupProfile.value) {
    return;
  }

  const selectedContact = selectedContactRecord.value;
  if (!selectedContact) {
    return;
  }

  isPublishingSelectedGroupProfile.value = true;

  try {
    selectedContactProfile.value = nextProfile;
    await nostrStore.publishGroupMetadata(
      selectedContact.public_key,
      buildContactProfilePublishPayload(nextProfile),
      relayStore.relays
    );

    const updatedContact = await contactsService.updateContact(selectedContact.id, {
      ...(nextProfile.name.trim()
        ? { name: nextProfile.name.trim() }
        : {}),
      meta: buildUpdatedContactMeta(selectedContact, nextProfile)
    });

    if (updatedContact) {
      updateContactInState(updatedContact);
      await chatStore.syncContactProfile(updatedContact.public_key);
    }

    $q.notify({
      type: 'positive',
      message: t('group.groupProfilePublished'),
      position: 'top'
    });
  } catch (error) {
    reportUiError('Failed to publish group profile metadata', error, t('errors.failedPublishGroupProfile'));
  } finally {
    isPublishingSelectedGroupProfile.value = false;
  }
}

async function handleContactMenuDelete(contact: ContactRecord): Promise<void> {
  try {
    const deleted = await contactsService.deleteContact(contact.id);
    if (!deleted) {
      return;
    }

    if (selectedContactId.value === contact.id) {
      selectedContactId.value = null;
      selectedContactPubkey.value = '';
      selectedContactProfile.value = createEmptyContactProfileForm();
    }

    removeRoutePubkeyIfMatches(contact.public_key);
    try {
      await nostrStore.publishPrivateContactList(relayStore.relays);
    } catch (error) {
      reportUiError(
        'Failed to publish private contact list after deleting contact',
        error,
        'Contact deleted, but contact list sync failed.'
      );
    }

    await loadContacts(contactQuery.value);
  } catch (error) {
    reportUiError('Failed to delete contact from menu', error);
  }
}
</script>

<style scoped>
.contacts-page {
  height: calc(100vh - env(safe-area-inset-top));
  padding: 0;
  overflow: hidden;
  width: 100%;
  max-width: 100%;
  background: var(--nc-app-background);
}

.contacts-shell {
  display: grid;
  grid-template-columns: var(--desktop-sidebar-width, 360px) 0px minmax(0, 1fr);
  gap: 0;
  height: 100%;
  min-height: 0;
  width: 100%;
  max-width: 100%;
  background: var(--nc-panel-thread-bg);
}

.contacts-shell--mobile {
  grid-template-columns: 1fr;
}

.contacts-sidebar,
.contacts-detail-panel {
  overflow: hidden;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}

.contacts-sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background: var(--nc-panel-sidebar-bg);
  border-right: 0;
}

.contacts-detail-panel {
  background: var(--nc-panel-thread-bg);
  min-height: 0;
}

.contacts-detail-panel__scroll {
  height: 100%;
}

.contacts-detail-panel__content {
  padding: 0;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
}

.contacts-detail-panel__scroll :deep(.q-scrollarea__content) {
  display: flex;
  flex-direction: column;
  min-height: 100%;
}

.contacts-detail-mobile-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--nc-border);
  background: var(--nc-panel-header-bg);
}

.contacts-detail-mobile-header__title {
  flex: 1;
  min-width: 0;
  font-size: 16px;
  font-weight: 700;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.contacts-detail-mobile-header__spacer {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
}

.contacts-sidebar__top {
  position: relative;
  padding: 12px;
  border-bottom: 1px solid var(--nc-border);
  background: var(--nc-panel-header-bg);
}

.contacts-sidebar__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 0;
}

.contacts-sidebar__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.contacts-sidebar__search {
  flex: 1;
  min-width: 0;
}

@media (min-width: 1024px) {
  .contacts-sidebar__top .contacts-sidebar__healing.reconnect-healing-banner--expanded,
  .contacts-sidebar__top .contacts-sidebar__healing.startup-history-banner--expanded {
    margin-right: -12px;
    margin-bottom: -13px;
    margin-left: -12px;
  }
}

.contacts-list {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
}

.contacts-list :deep(.q-scrollarea__container),
.contacts-list :deep(.q-scrollarea__content),
.contacts-list :deep(.q-list) {
  overflow-x: hidden !important;
  min-width: 0;
  width: 100%;
}

.contacts-section-toggle {
  min-height: 32px;
  padding: 0 12px;
  border-bottom: 1px solid var(--nc-border);
  color: var(--nc-text-secondary);
  background: color-mix(in srgb, var(--nc-panel-sidebar-bg) 92%, var(--nc-hover) 8%);
  transition:
    background-color 0.2s ease,
    color 0.2s ease;
}

.contacts-section-toggle:hover {
  background: var(--nc-hover);
  color: var(--nc-text);
}

.contacts-section-toggle__icon {
  flex: 0 0 28px;
  min-width: 28px !important;
  padding-right: 0;
}

.contacts-section-toggle__label {
  font-size: 12px;
  line-height: 1;
  font-weight: 700;
  letter-spacing: 0;
  color: inherit;
}

.contacts-section-toggle__count {
  min-width: 24px;
  padding: 2px 7px;
  border: 1px solid var(--nc-border);
  border-radius: 999px;
  text-align: center;
  font-size: 11px;
  line-height: 1;
  font-weight: 700;
  color: var(--nc-text-secondary);
  background: var(--nc-panel-thread-bg);
  font-variant-numeric: tabular-nums;
}

.contact-item {
  min-width: 0;
  margin: 0;
  border-radius: 0;
  min-height: 72px;
  padding: 0 12px;
  border-bottom: 1px solid var(--nc-border);
  transition:
    background-color 0.2s ease,
    border-color 0.2s ease;
}

.q-btn.contact-item__more {
  color: color-mix(in srgb, var(--nc-border) 20%, #5f718a 80%);
  background: transparent !important;
  box-shadow: none !important;
  opacity: 0;
  transition: color 0.2s ease, opacity 0.2s ease;
}

.q-btn.contact-item__more::before {
  border-color: transparent !important;
}

.q-btn.contact-item__more:hover {
  color: color-mix(in srgb, var(--nc-border) 10%, #4f637e 90%);
  background: transparent !important;
  box-shadow: none !important;
  transform: none !important;
}

.contact-item:hover .contact-item__more,
.contact-item:focus-within .contact-item__more {
  opacity: 1;
}

.contact-item__main {
  flex: 1 1 auto;
  min-width: 0;
}

.contact-item__headline {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.contact-item__mute-indicator,
.contact-item__block-indicator {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  color: var(--nc-text-secondary);
}

.contact-item--muted .contact-item__mute-indicator {
  color: color-mix(in srgb, var(--nc-text-secondary) 86%, var(--q-primary) 14%);
}

.contact-item--blocked .contact-item__block-indicator {
  color: var(--q-negative);
}

.contact-item__actions {
  flex: 0 0 36px;
  min-width: 36px;
  padding-left: 0 !important;
  align-items: flex-end;
  justify-content: center;
}

.contact-item :deep(.q-item__section--avatar) {
  min-width: 60px;
}

.contact-item :deep(.contact-item__avatar) {
  width: 54px;
  height: 54px;
  font-size: 23px;
}

.contact-item__name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--nc-text);
}

.contact-item:hover {
  background: var(--nc-hover);
}

.contact-item__caption {
  color: var(--nc-text-secondary);
  opacity: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.contact-item--active {
  background: var(--nc-active);
  color: var(--nc-active-text);
}

.contact-item--active .contact-item__caption,
.contact-item--active .q-btn.contact-item__more {
  color: var(--nc-active-subtext);
}

.contact-item--active .contact-item__caption {
  opacity: 1;
}

.contacts-empty {
  padding: 14px;
  text-align: center;
  color: var(--nc-text-secondary);
  opacity: 1;
}

.contacts-empty-state {
  min-height: 100%;
  display: grid;
  place-items: center;
  text-align: center;
  padding: 20px;
  color: var(--nc-text-secondary);
  opacity: 1;
}

.contacts-sidebar__nav {
  border-top: 1px solid var(--nc-border);
}

@media (max-width: 1023px) {
  .contacts-sidebar {
    border-right: 0;
  }

  .contacts-detail-panel--mobile {
    border-bottom: 0;
    border-top: 0;
  }

  .q-btn.contact-item__more {
    opacity: 1;
  }
}
</style>
