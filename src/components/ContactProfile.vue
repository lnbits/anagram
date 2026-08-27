<template>
  <div class="contact-profile">
    <div v-if="showHeader" class="profile-header">
      <div
        class="profile-header__identity"
        :class="{ 'profile-header__identity--disabled': !normalizedHeaderPubkey }"
        @click="handleOpenChat"
      >
        <CachedAvatar
          :src="headerPictureUrl"
          :alt="headerName"
          :fallback="headerAvatar"
          class="profile-header__avatar"
        />
        <div class="profile-header__meta">
          <div class="profile-header__name">{{ headerName }}</div>
          <div class="profile-header__subtitle">{{ headerSubtitle }}</div>
        </div>
      </div>
      <q-btn
        flat
        dense
        round
        icon="chat_bubble"
        :aria-label="$t('chat.openChat')"
        class="profile-header__action"
        :disable="!normalizedHeaderPubkey"
        @click="handleOpenChat"
      />
    </div>

    <div class="profile-content" :class="{ 'profile-content--with-header': showHeader }">
      <div class="profile-tabs-shell" :class="{ 'profile-tabs-shell--mobile': isMobileTabs }">
        <q-tabs
          v-if="!isMobileTabs && showTabSelection"
          v-model="activeTab"
          dense
          align="justify"
          active-color="primary"
          indicator-color="primary"
          class="profile-tabs"
        >
          <q-tab name="profile" :label="$t('profile.profile')" no-caps class="profile-tab" />
          <q-tab
            v-if="isGroupContact"
            name="members"
            :label="membersTabLabel"
            no-caps
            class="profile-tab"
            data-testid="contact-profile-members-tab"
          />
          <q-tab
            v-if="isOwnedGroupContact"
            name="relays"
            :label="$t('relays.title')"
            no-caps
            class="profile-tab"
            data-testid="contact-profile-relays-tab"
          />
          <q-tab
            v-if="isGroupContact"
            name="epochs"
            :label="$t('group.epochs')"
            no-caps
            class="profile-tab"
            data-testid="contact-profile-epochs-tab"
          />
        </q-tabs>

        <q-tab-panels
          v-model="activeTab"
          animated
          class="profile-tab-panels"
          :class="{ 'profile-tab-panels--mobile': isMobileTabs }"
        >
          <q-tab-panel name="profile" class="profile-tab-panel">
            <div v-if="showProfileTabActions" class="profile-tab-actions">
              <q-btn
                v-if="props.showHeader"
                no-caps
                outline
                color="primary"
                :label="$t('common.refresh')"
                class="profile-tab-actions__button"
                data-testid="contact-profile-refresh-button"
                :disable="!normalizedHeaderPubkey || isRefreshingContact"
                :loading="isRefreshingContact"
                @click="handleRefreshContactProfile"
              />
              <q-btn
                v-if="props.showShareAction"
                no-caps
                outline
                color="primary"
                :label="$t('common.share')"
                class="profile-tab-actions__button"
                data-testid="contact-profile-share-button"
                :disable="!shareNostrAddress"
                @click="handleOpenShareDialog"
              />
              <q-btn
                v-if="props.showPublishAction"
                no-caps
                unelevated
                color="primary"
                :label="$t('common.publishAction')"
                class="profile-tab-actions__button"
                data-testid="contact-profile-publish-button"
                :disable="!normalizedHeaderPubkey"
                :loading="props.isPublishing"
                @click="handlePublishProfile"
              />
            </div>

            <div class="profile-lookup" :class="{ 'profile-lookup--with-header': showHeader }">
              <q-input
                :model-value="displayedPubkeyValue"
                class="nc-input profile-lookup__pubkey-input"
                outlined
                dense
                rounded
                readonly
                :label="displayedPubkeyLabel"
                :placeholder="displayedPubkeyPlaceholder"
                :loading="isLoadingContact"
                :error="Boolean(pubkeyError)"
                :error-message="pubkeyError"
              >
                <template #prepend>
                  <q-badge
                    outline
                    color="primary"
                    :label="displayedPubkeyToggleLabel"
                    class="profile-lookup__format-toggle"
                    role="button"
                    tabindex="0"
                    :aria-label="pubkeyFormatToggleAriaLabel"
                    @click.stop="toggleDisplayedPubkeyFormat"
                    @keydown.enter.prevent.stop="toggleDisplayedPubkeyFormat"
                    @keydown.space.prevent.stop="toggleDisplayedPubkeyFormat"
                  >
                    <AppTooltip>{{ pubkeyFormatToggleTooltip }}</AppTooltip>
                  </q-badge>
                </template>

                <template #append>
                  <q-btn
                    flat
                    dense
                    round
                    icon="content_copy"
                    color="primary"
                    :aria-label="$t('common.copyLabel', { label: displayedPubkeyCopyLabel })"
                    :disable="!displayedPubkeyValue.trim()"
                    @click.stop="handleCopyProfileValue(displayedPubkeyValue, displayedPubkeyCopyLabel)"
                  >
                    <AppTooltip>{{ $t('common.copyLabel', { label: displayedPubkeyCopyLabel }) }}</AppTooltip>
                  </q-btn>
                </template>
              </q-input>
              <div v-if="pubkeyInfo" class="text-caption text-grey-6">{{ pubkeyInfo }}</div>
            </div>

            <q-banner
              v-if="showGroupProfileMarkerWarning"
              dense
              rounded
              class="profile-warning-banner q-mt-md"
            >
              <template #avatar>
                <q-icon name="warning_amber" color="warning" />
              </template>
              {{ $t('group.identityTreatedGroupPublished') }}
            </q-banner>

            <q-list bordered separator class="profile-sections q-mt-md">
              <q-expansion-item
                default-opened
                expand-separator
                switch-toggle-side
                expand-icon="keyboard_arrow_right"
                expanded-icon="keyboard_arrow_down"
                class="profile-section"
              >
                <template #header>
                  <q-item-section>
                    <q-item-label class="profile-card__title">{{ $t('profile.userMetadataNip01') }}</q-item-label>
                  </q-item-section>
                </template>

                <div class="profile-card__section profile-section__content">
                  <q-input
                    v-model="localProfile.name"
                    class="nc-input"
                    outlined
                    dense
                    rounded
                    :readonly="readOnly"
                    :label="$t('common.name')"
                    :placeholder="$t('profile.profileName')"
                  />

                  <q-input
                    v-model="localProfile.about"
                    class="nc-input q-mt-sm"
                    outlined
                    dense
                    rounded
                    type="textarea"
                    autogrow
                    :readonly="readOnly"
                    :label="$t('common.about')"
                    :placeholder="$t('profile.shortBio')"
                  />

                  <q-input
                    v-model="localProfile.picture"
                    class="nc-input q-mt-sm"
                    outlined
                    dense
                    rounded
                    :readonly="readOnly"
                    :label="$t('profile.pictureUrl')"
                    placeholder="https://example.com/avatar.png"
                  />

                  <q-input
                    v-model="localProfile.nip05"
                    class="nc-input q-mt-sm"
                    outlined
                    dense
                    rounded
                    :readonly="readOnly"
                    label="NIP-05"
                    placeholder="name@example.com"
                  />

                  <q-input
                    v-model="localProfile.lud16"
                    class="nc-input q-mt-sm"
                    outlined
                    dense
                    rounded
                    :readonly="readOnly"
                    :label="$t('common.lightningAddress')"
                    placeholder="name@domain.com"
                  />

                  <q-input
                    v-model="localProfile.lud06"
                    class="nc-input q-mt-sm"
                    outlined
                    dense
                    rounded
                    :readonly="readOnly"
                    label="LNURL"
                    placeholder="lnurl1..."
                  />
                </div>
              </q-expansion-item>

              <q-expansion-item
                v-if="!isGroupContact"
                expand-separator
                switch-toggle-side
                expand-icon="keyboard_arrow_right"
                expanded-icon="keyboard_arrow_down"
                class="profile-section"
              >
                <template #header>
                  <q-item-section>
                    <q-item-label class="profile-card__title">{{ $t('profile.extraMetadataFieldsNip24') }}</q-item-label>
                  </q-item-section>
                </template>

                <div class="profile-card__section profile-section__content">
                  <q-input
                    v-model="localProfile.display_name"
                    class="nc-input"
                    outlined
                    dense
                    rounded
                    :readonly="readOnly"
                    :label="$t('profile.displayName')"
                    :placeholder="$t('profile.alternativeDisplayName')"
                  />

                  <q-input
                    v-model="localProfile.website"
                    class="nc-input q-mt-sm"
                    outlined
                    dense
                    rounded
                    :readonly="readOnly"
                    :label="$t('profile.website')"
                    placeholder="https://example.com"
                  />

                  <q-input
                    v-model="localProfile.banner"
                    class="nc-input q-mt-sm"
                    outlined
                    dense
                    rounded
                    :readonly="readOnly"
                    :label="$t('profile.bannerUrl')"
                    placeholder="https://example.com/banner.png"
                  />

                  <div class="profile-card__bot-row q-mt-sm">
                    <div>
                      <div class="text-body2">{{ $t('profile.bot') }}</div>
                      <div class="text-caption text-grey-6">
                        {{ $t('common.contentPartiallyFullyAutomated') }}
                      </div>
                    </div>

                    <q-toggle
                      v-model="localProfile.bot"
                      color="primary"
                      checked-icon="smart_toy"
                      unchecked-icon="person"
                      :disable="readOnly"
                    />
                  </div>

                  <div class="profile-card__bot-row q-mt-sm">
                    <div>
                      <div class="text-body2">{{ $t('group.group') }}</div>
                      <div class="text-caption text-grey-6">
                        {{ $t('group.profileRepresentsGroupIdentity') }}
                      </div>
                    </div>

                    <q-toggle
                      v-model="localProfile.group"
                      color="primary"
                      checked-icon="groups"
                      unchecked-icon="person"
                      :disable="readOnly"
                    />
                  </div>

                  <div class="profile-card__subtitle q-mt-md">{{ $t('profile.birthday') }}</div>
                  <div class="profile-card__birthday-grid q-mt-sm">
                    <q-input
                      v-model.number="localProfile.birthday.year"
                      class="nc-input"
                      outlined
                      dense
                      rounded
                      type="number"
                      :readonly="readOnly"
                      :label="$t('common.year')"
                      placeholder="1990"
                    />

                    <q-input
                      v-model.number="localProfile.birthday.month"
                      class="nc-input"
                      outlined
                      dense
                      rounded
                      type="number"
                      :readonly="readOnly"
                      :label="$t('common.month')"
                      placeholder="1-12"
                      min="1"
                      max="12"
                    />

                    <q-input
                      v-model.number="localProfile.birthday.day"
                      class="nc-input"
                      outlined
                      dense
                      rounded
                      type="number"
                      :readonly="readOnly"
                      :label="$t('common.day')"
                      placeholder="1-31"
                      min="1"
                      max="31"
                    />
                  </div>
                </div>
              </q-expansion-item>

              <q-expansion-item
                expand-separator
                switch-toggle-side
                expand-icon="keyboard_arrow_right"
                expanded-icon="keyboard_arrow_down"
                class="profile-section"
              >
                <template #header>
                  <q-item-section>
                    <div class="profile-card__title-row">
                      <div class="profile-card__title">{{ $t('relays.nip65.title') }}</div>
                      <q-btn
                        v-if="props.showRelaysEditAction"
                        flat
                        dense
                        round
                        icon="edit"
                        color="primary"
                        :aria-label="$t('relays.editRelays')"
                        @click.stop="emit('open-relays-settings')"
                      />
                    </div>
                  </q-item-section>
                </template>

                <div class="profile-card__section profile-section__content">
                  <div class="profile-card__bot-row">
                    <div>
                      <div class="text-body2">{{ $t('relays.sendViaAppRelays') }}</div>
                      <div class="text-caption text-grey-6">
                        {{ $t('relays.useAppRelays.description') }}
                      </div>
                    </div>

                    <q-toggle
                      v-model="localProfile.sendMessagesToAppRelays"
                      color="primary"
                      checked-icon="cloud_upload"
                      unchecked-icon="cloud_off"
                      :disable="!normalizedHeaderPubkey"
                      @update:model-value="handleSendMessagesToAppRelaysUpdate"
                    />
                  </div>

                  <RelayEditorPanel
                    :new-relay="''"
                    :relays="relayList"
                    relay-validation-error=""
                    :can-add-relay="false"
                    :empty-message="$t('relays.relaysConfigured')"
                    :show-toolbar="false"
                    :show-secondary-action="false"
                    :relay-toggles-disabled="true"
                    :show-remove-relay-action="false"
                    :relay-read-enabled="relayReadEnabled"
                    :relay-write-enabled="relayWriteEnabled"
                    :relay-icon-url="relayIconUrl"
                    :is-relay-connected="isRelayConnected"
                    :is-relay-info-loading="isRelayInfoLoading"
                    :relay-info-error="relayInfoError"
                    :relay-info="relayInfo"
                    @relay-expand="handleRelayExpand"
                    @retry-relay-info="retryRelayInfo"
                    @relay-icon-error="handleRelayIconError"
                  />
                </div>
              </q-expansion-item>
            </q-list>
          </q-tab-panel>

          <q-tab-panel v-if="isGroupContact" name="members" class="profile-tab-panel">
            <div class="profile-members">
              <div v-if="showMembersTabActions" class="profile-tab-actions">
                <q-btn
                  v-if="props.showHeader"
                  no-caps
                  outline
                  color="primary"
                  :label="$t('common.refresh')"
                  class="profile-tab-actions__button"
                  :disable="
                    !normalizedHeaderPubkey ||
                    isPublishingMembersEpoch ||
                    (canEditGroupMembers && hasPendingGroupMemberChanges) ||
                    isRefreshingGroupMembersFromFollowSet
                  "
                  :loading="isRefreshingGroupMembersFromFollowSet"
                  @click="handleRefreshGroupMembersFromFollowSet"
                />
                <q-btn
                  v-if="props.showPublishAction"
                  no-caps
                  unelevated
                  color="primary"
                  :label="$t('common.publishAction')"
                  data-testid="group-members-publish-button"
                  class="profile-tab-actions__button"
                  :disable="!normalizedHeaderPubkey || !hasPendingGroupMemberChanges"
                  :loading="isPublishingMembersEpoch"
                  @click="handleMembersPublish"
                />
              </div>

              <div v-if="canEditGroupMembers" class="profile-members-toolbar">
                <q-input
                  v-model="newMemberIdentifier"
                  class="nc-input profile-members-toolbar__input"
                  data-testid="group-member-identifier-input"
                  outlined
                  dense
                  rounded
                  :label="$t('group.member')"
                  :placeholder="$t('contacts.hexPubkeyNpubName')"
                  :error="Boolean(newMemberIdentifierError)"
                  :error-message="newMemberIdentifierError"
                  @update:model-value="clearMemberIdentifierError"
                  @keydown.enter.prevent="handleAddMember"
                >
                  <template #append>
                    <q-btn
                      unelevated
                      round
                      dense
                      color="primary"
                      icon="add"
                      size="sm"
                      data-testid="group-member-add-button"
                      :aria-label="$t('group.addMember')"
                      :disable="!canAddMember"
                      :loading="isAddingMember"
                      @click="handleAddMember"
                    />
                  </template>
                </q-input>
              </div>

              <div v-if="hasPendingGroupMemberChanges" class="profile-members-pending q-mt-md">
                <q-banner dense rounded class="profile-warning-banner">
                  <template #avatar>
                    <q-icon name="warning_amber" color="warning" />
                  </template>
                  {{ $t('common.youMustPublishChanges') }}
                </q-banner>

                <div class="profile-members-section-title">{{ $t('common.pending') }}</div>

                <q-list bordered separator class="profile-members-list">
                  <q-item
                    v-for="change in pendingGroupMemberChanges"
                    :key="`${change.action}:${change.member.public_key}`"
                    class="profile-members-list__item"
                  >
                    <q-item-section avatar>
                      <CachedAvatar
                        :src="memberPictureUrl(change.member)"
                        :alt="memberListTitle(change.member)"
                        :fallback="memberAvatar(change.member)"
                      />
                    </q-item-section>

                    <q-item-section>
                      <div class="profile-members-list__headline">
                        <div class="profile-members-list__name">
                          {{ memberListTitle(change.member) }}
                        </div>
                        <q-badge
                          rounded
                          :color="pendingMemberBadgeColor(change.action)"
                          class="profile-members-list__badge"
                        >
                          {{ pendingMemberBadgeLabel(change.action) }}
                        </q-badge>
                      </div>
                      <q-item-label
                        v-if="memberListCaption(change.member)"
                        caption
                        class="profile-members-list__caption"
                        lines="1"
                      >
                        {{ memberListCaption(change.member) }}
                      </q-item-label>
                    </q-item-section>

                    <q-item-section side top class="profile-members-list__actions">
                      <q-btn
                        flat
                        round
                        dense
                        icon="undo"
                        color="primary"
                        :aria-label="$t('group.undoPendingMemberChange')"
                        @click="handleUndoPendingMember(change.member.public_key)"
                      />
                    </q-item-section>
                  </q-item>
                </q-list>
              </div>

              <div class="profile-members-section-title q-mt-md">{{ $t('group.members') }}</div>

              <div
                v-if="visibleGroupMembers.length === 0"
                class="profile-members-state"
                :class="{ 'q-mt-sm': true }"
              >
                <div class="text-body2">{{ $t('group.publishedMembersYet') }}</div>
              </div>

              <q-list v-else bordered separator class="profile-members-list q-mt-sm">
                <q-item
                  v-for="member in visibleGroupMembers"
                  :key="member.public_key"
                  clickable
                  class="profile-members-list__item"
                  @click="handleOpenMemberProfile(member)"
                >
                  <q-item-section avatar>
                    <CachedAvatar
                      :src="memberPictureUrl(member)"
                      :alt="memberListTitle(member)"
                      :fallback="memberAvatar(member)"
                    />
                  </q-item-section>

                  <q-item-section>
                    <div class="profile-members-list__headline">
                      <q-item-label class="profile-members-list__name" lines="1">
                        {{ memberListTitle(member) }}
                      </q-item-label>
                      <q-badge
                        v-if="isGroupOwnerMember(member)"
                        rounded
                        color="primary"
                        class="profile-members-list__badge"
                      >
                        {{ $t('common.admin') }}
                      </q-badge>
                    </div>
                    <q-item-label
                      v-if="memberListCaption(member)"
                      caption
                      class="profile-members-list__caption"
                      lines="1"
                    >
                      {{ memberListCaption(member) }}
                    </q-item-label>
                    <div
                      v-if="hasMemberLatestGroupTicketStatus(member)"
                      class="profile-member-delivery"
                    >
                      <q-badge
                        outline
                        color="primary"
                        class="profile-member-delivery__epoch"
                        data-testid="group-member-ticket-epoch-badge"
                      >
                        {{ memberLatestGroupTicketEpochLabel(member) }}
                      </q-badge>
                      <button
                        type="button"
                        class="profile-member-delivery__status-hitbox"
                        data-testid="group-member-ticket-status"
                        :aria-label="$t('relays.openRelayDeliveryStatus', { name: memberListTitle(member) })"
                        @click.stop="openGroupMemberTicketStatus(member)"
                      >
                        <div class="profile-member-delivery__status">
                          <span
                            v-for="segment in memberLatestGroupTicketStatusSegments(member)"
                            :key="segment.key"
                            class="profile-member-delivery__status-segment"
                            :class="segment.className"
                            :style="{ flex: `${segment.weight} 1 0` }"
                          />
                        </div>
                      </button>
                    </div>
                  </q-item-section>

                  <q-item-section side top class="profile-members-list__actions">
                    <q-btn
                      flat
                      round
                      dense
                      icon="refresh"
                      color="primary"
                      :aria-label="$t('group.refreshMember')"
                      :loading="isMemberRefreshing(member.public_key)"
                      @click.stop="handleRefreshMember(member.public_key)"
                    />
                    <q-btn
                      v-if="canEditGroupMembers && !isGroupOwnerMember(member)"
                      flat
                      round
                      dense
                      icon="delete"
                      color="negative"
                      :aria-label="$t('group.removeMember')"
                      @click.stop="handleRemoveMember(member.public_key)"
                    />
                  </q-item-section>
                </q-item>
              </q-list>
            </div>
          </q-tab-panel>

          <q-tab-panel v-if="isGroupContact" name="epochs" class="profile-tab-panel">
            <div class="profile-epochs">
              <div class="profile-card__section">
                <div class="profile-card__title">{{ $t('group.currentEpochPublicKey.title') }}</div>
                <q-input
                  :model-value="currentEpochPublicKey"
                  class="nc-input q-mt-sm"
                  outlined
                  dense
                  rounded
                  readonly
                  :label="$t('group.currentEpochPublicKey.title')"
                  :placeholder="$t('group.currentEpochPublicKey.empty')"
                >
                  <template #append>
                    <q-btn
                      flat
                      dense
                      round
                      icon="content_copy"
                      color="primary"
                      :aria-label="$t('group.copyCurrentEpochPublic')"
                      :disable="!currentEpochPublicKey"
                      @click.stop="
                        handleCopyProfileValue(currentEpochPublicKey, 'Current epoch public key')
                      "
                    >
                      <AppTooltip>{{ $t('group.copyCurrentEpochPublic') }}</AppTooltip>
                    </q-btn>
                  </template>
                </q-input>
              </div>

              <div class="profile-card__section q-mt-md">
                <div class="profile-card__title">{{ $t('group.allEpochs') }}</div>

                <div v-if="groupEpochRows.length === 0" class="profile-members-state q-mt-sm">
                  <div class="text-body2">{{ $t('group.epochsStoredGroupYet') }}</div>
                </div>

                <q-markup-table v-else flat bordered class="profile-epochs-table q-mt-sm">
                  <thead>
                    <tr>
                      <th class="text-left">{{ $t('group.epoch.label') }}</th>
                      <th class="text-left">{{ $t('contacts.publicKey') }}</th>
                      <th class="text-left">{{ $t('group.invitationDate') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="epoch in groupEpochRows" :key="`${epoch.epoch_number}:${epoch.epoch_public_key}`">
                      <td class="text-left">{{ epoch.epoch_number }}</td>
                      <td class="text-left">{{ epoch.epoch_public_key }}</td>
                      <td class="text-left">{{ formatEpochInvitationDate(epoch.invitation_created_at) }}</td>
                    </tr>
                  </tbody>
                </q-markup-table>
              </div>
            </div>
          </q-tab-panel>

          <q-tab-panel v-if="isOwnedGroupContact" name="relays" class="profile-tab-panel">
            <div class="profile-group-relays">
              <div v-if="showRelaysTabActions" class="profile-tab-actions">
                <q-btn
                  v-if="props.showHeader"
                  no-caps
                  outline
                  color="primary"
                  :label="$t('common.refresh')"
                  class="profile-tab-actions__button"
                  :disable="!normalizedHeaderPubkey || isRefreshingGroupRelays"
                  :loading="isRefreshingGroupRelays"
                  @click="handleRefreshGroupRelays"
                />
                <q-btn
                  v-if="props.showPublishAction"
                  no-caps
                  unelevated
                  color="primary"
                  :label="$t('common.publishAction')"
                  class="profile-tab-actions__button"
                  :disable="!normalizedHeaderPubkey"
                  :loading="isPublishingGroupRelays"
                  @click="handlePublishGroupRelays"
                />
              </div>

              <RelayEditorPanel
                v-model:new-relay="newGroupRelay"
                :relays="groupRelayUrls"
                :relay-validation-error="groupRelayValidationError"
                :can-add-relay="canAddGroupRelay"
                :empty-message="$t('relays.nip65RelaysConfigured')"
                :secondary-action-disabled="!canUseDefaultGroupRelays"
                :secondary-action-label="$t('relays.useDefaultRelays')"
                secondary-action-icon="restart_alt"
                :relay-read-enabled="groupRelayReadEnabled"
                :relay-write-enabled="groupRelayWriteEnabled"
                :relay-icon-url="relayIconUrl"
                :is-relay-connected="isRelayConnected"
                :is-relay-info-loading="isRelayInfoLoading"
                :relay-info-error="relayInfoError"
                :relay-info="relayInfo"
                @add-relay="handleAddGroupRelay"
                @remove-relay="handleRemoveGroupRelay"
                @secondary-action="handleUseDefaultGroupRelays"
                @relay-expand="handleRelayExpand"
                @retry-relay-info="retryRelayInfo"
                @relay-icon-error="handleRelayIconError"
                @update-relay-read="handleUpdateGroupRelayRead"
                @update-relay-write="handleUpdateGroupRelayWrite"
              />
            </div>
          </q-tab-panel>
        </q-tab-panels>
      </div>
    </div>

    <div v-if="isMobileTabs && showTabSelection" class="mobile-nav">
      <div class="mobile-nav__inner" :style="mobileNavGridStyle">
        <q-btn
          :flat="activeTab !== 'profile'"
          :unelevated="activeTab === 'profile'"
          :color="activeTab === 'profile' ? 'primary' : undefined"
          :text-color="activeTab === 'profile' ? 'white' : undefined"
          no-caps
          icon="badge"
          :label="$t('profile.profile')"
          class="mobile-nav__btn"
          :class="{ 'mobile-nav__btn--active': activeTab === 'profile' }"
          @click="activeTab = 'profile'"
        />
        <q-btn
          v-if="isGroupContact"
          :flat="activeTab !== 'members'"
          :unelevated="activeTab === 'members'"
          :color="activeTab === 'members' ? 'primary' : undefined"
          :text-color="activeTab === 'members' ? 'white' : undefined"
          no-caps
          icon="groups"
          :label="membersTabLabel"
          class="mobile-nav__btn"
          :class="{ 'mobile-nav__btn--active': activeTab === 'members' }"
          @click="activeTab = 'members'"
        />
        <q-btn
          v-if="isOwnedGroupContact"
          :flat="activeTab !== 'relays'"
          :unelevated="activeTab === 'relays'"
          :color="activeTab === 'relays' ? 'primary' : undefined"
          :text-color="activeTab === 'relays' ? 'white' : undefined"
          no-caps
          icon="satellite_alt"
          :label="$t('relays.title')"
          class="mobile-nav__btn"
          :class="{ 'mobile-nav__btn--active': activeTab === 'relays' }"
          @click="activeTab = 'relays'"
        />
        <q-btn
          v-if="isGroupContact"
          :flat="activeTab !== 'epochs'"
          :unelevated="activeTab === 'epochs'"
          :color="activeTab === 'epochs' ? 'primary' : undefined"
          :text-color="activeTab === 'epochs' ? 'white' : undefined"
          no-caps
          icon="history"
          :label="$t('group.epochs')"
          class="mobile-nav__btn"
          :class="{ 'mobile-nav__btn--active': activeTab === 'epochs' }"
          @click="activeTab = 'epochs'"
        />
      </div>
    </div>

    <AppDialog
      v-if="isShareDialogOpen"
      :model-value="isShareDialogOpen"
      :title="$t('contacts.shareContact')"
      :subtitle="$t('common.scanQrCodeCopy')"
      plain
      max-width="520px"
      body-class="profile-share-dialog__body"
      @update:model-value="closeShareDialog"
    >
      <div class="profile-share" data-testid="contact-profile-share-dialog">
        <div
          v-if="shareQrCodeSvgDataUrl"
          class="profile-share__qr-shell"
        >
          <img
            :src="shareQrCodeSvgDataUrl"
            :alt="$t('contacts.qrCodeContactNostr')"
            class="profile-share__qr"
            data-testid="contact-profile-share-qr"
          />
        </div>

        <q-input
          :model-value="shareNostrAddress"
          class="nc-input profile-share__address"
          outlined
          dense
          rounded
          readonly
          :label="$t('common.nostrAddress')"
        >
          <template #append>
            <q-btn
              flat
              dense
              round
              icon="content_copy"
              color="primary"
              :aria-label="$t('common.copyNostrAddress')"
              :disable="!shareNostrAddress"
              @click.stop="handleCopyProfileValue(shareNostrAddress, 'Nostr address')"
            >
              <AppTooltip>{{ $t('common.copyNostrAddress') }}</AppTooltip>
            </q-btn>
          </template>
        </q-input>
      </div>
    </AppDialog>

    <AppDialog
      v-if="selectedGroupMemberTicketStatus"
      :model-value="selectedGroupMemberTicketStatus !== null"
      :title="selectedGroupMemberTicketStatusTitle"
      plain
      max-width="460px"
      @update:model-value="closeGroupMemberTicketStatusDialog"
    >
      <div
        v-if="selectedGroupMemberTicketStatusItems.length === 0"
        class="profile-member-delivery__dialog-empty"
      >
        {{ $t('relays.relayStatusRecordedYet') }}
      </div>
      <template v-else>
        <ul class="profile-member-delivery__dialog-list">
          <li
            v-for="item in selectedGroupMemberTicketStatusItems"
            :key="item.key"
            class="profile-member-delivery__dialog-item"
          >
            <span class="profile-member-delivery__dialog-item-main">
              <span
                class="profile-member-delivery__status-dot"
                :class="item.dotClass"
                aria-hidden="true"
              />
              <span class="profile-member-delivery__dialog-copy">
                <span class="profile-member-delivery__dialog-relay">{{ item.relayUrl }}</span>
                <span
                  v-if="item.detail"
                  class="profile-member-delivery__dialog-detail"
                >
                  {{ item.detail }}
                </span>
              </span>
            </span>
            <q-btn
              v-if="item.retryable"
              flat
              dense
              no-caps
              size="sm"
              color="primary"
              :label="$t('common.retry')"
              class="profile-member-delivery__dialog-retry"
              :loading="isRetryingGroupMemberTicketRelay(item)"
              :disable="isRetryingGroupMemberTicketRelay(item)"
              @click="retrySelectedGroupMemberTicketRelay(item)"
            />
          </li>
        </ul>
        <div
          v-if="selectedGroupMemberTicketRetryableItems.length > 0"
          class="profile-member-delivery__dialog-actions"
        >
          <q-btn
            flat
            dense
            no-caps
            icon="refresh"
            color="primary"
            :label="$t('relays.retryFailed')"
            class="profile-member-delivery__dialog-retry-all"
            data-testid="group-member-ticket-retry-all-button"
            :loading="isRetryingGroupMemberTicketFailedRelays"
            :disable="
              isRetryingGroupMemberTicketFailedRelays ||
              selectedGroupMemberTicketRetryableItems.length === 0
            "
            @click="retrySelectedGroupMemberTicketFailedRelays"
          />
        </div>
      </template>
    </AppDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { isValidPubkey, normalizeRelayUrl } from '@nostr-dev-kit/ndk';
import { useQuasar } from 'quasar';
import AppDialog from 'src/components/AppDialog.vue';
import AppTooltip from 'src/components/AppTooltip.vue';
import CachedAvatar from 'src/components/CachedAvatar.vue';
import RelayEditorPanel from 'src/components/RelayEditorPanel.vue';
import { useRelayDecorations } from 'src/composables/useRelayDecorations';
import { DEFAULT_RELAYS } from 'src/constants/relays';
import { chatDataService, type ChatRow } from 'src/services/chatDataService';
import { contactsService } from 'src/services/contactsService';
import { nostrEventDataService } from 'src/services/nostrEventDataService';
import { useChatStore } from 'src/stores/chatStore';
import { useNostrStore } from 'src/stores/nostrStore';
import type {
  GroupMemberTicketDelivery,
  MessageRelayStatus,
  NostrEventEntry,
  ChatGroupEpochKey
} from 'src/types/chat';
import type {
  ContactGroupMember,
  ContactMetadata,
  ContactRecord,
  ContactRelay
} from 'src/types/contact';
import {
  createEmptyContactProfileForm,
  type ContactProfileForm
} from 'src/types/contactProfile';
import { buildAvatarText } from 'src/utils/avatarText';
import { normalizeGroupMemberTicketDeliveries } from 'src/utils/groupMemberTicketDelivery';
import { formatCompactPublicKey } from 'src/utils/publicKeyText';
import { buildQrCodeSvgDataUrl } from 'src/utils/qrCode';
import { buildRelayLookupKey, uniqueRelayUrls } from 'src/utils/relayUrls';
import { reportUiError } from 'src/utils/uiErrorHandler';
import { getDateTimeLocale, t } from 'src/i18n';

type ProfileTab = 'profile' | 'members' | 'epochs' | 'relays';
type RelayTogglePayload = {
  index: number;
  value: boolean;
};

type GroupMemberDraft = ContactGroupMember;
type PendingGroupMemberChangeAction = 'add' | 'remove';
type PubkeyDisplayFormat = 'hex' | 'npub';

interface PendingGroupMemberChange {
  action: PendingGroupMemberChangeAction;
  member: GroupMemberDraft;
}

interface GroupMemberTicketStatusListItem {
  key: string;
  relayUrl: string;
  detail?: string;
  status: 'published' | 'failed' | 'pending';
  retryable: boolean;
  dotClass: string;
}

interface SelectedGroupMemberTicketStatus {
  delivery: GroupMemberTicketDelivery;
  memberLabel: string;
}

interface Props {
  modelValue: ContactProfileForm;
  pubkey: string;
  autoRefreshOnPubkeyChange?: boolean;
  readOnly?: boolean;
  showHeader?: boolean;
  showRelaysEditAction?: boolean;
  showShareAction?: boolean;
  showPublishAction?: boolean;
  isPublishing?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  autoRefreshOnPubkeyChange: false,
  readOnly: false,
  showHeader: false,
  showRelaysEditAction: false,
  showShareAction: false,
  showPublishAction: false,
  isPublishing: false
});

const emit = defineEmits<{
  (event: 'update:modelValue', value: ContactProfileForm): void;
  (event: 'update:pubkey', value: string): void;
  (event: 'update:send-messages-to-app-relays', value: boolean): void;
  (event: 'open-chat'): void;
  (event: 'open-relays-settings'): void;
  (event: 'publish', value: ContactProfileForm): void;
}>();

const $q = useQuasar();
const router = useRouter();
const nostrStore = useNostrStore();
const chatStore = useChatStore();
const localPubkey = computed({
  get: () => props.pubkey ?? '',
  set: (value: string) => emit('update:pubkey', value)
});
const localProfile = reactive<ContactProfileForm>(cloneProfile(props.modelValue));
const activeTab = ref<ProfileTab>('profile');
const currentContact = ref<ContactRecord | null>(null);
const currentGroupChat = ref<ChatRow | null>(null);
const groupOwnerMember = ref<GroupMemberDraft | null>(null);
const isLoadingContact = ref(false);
const isRefreshingContact = ref(false);
let refreshRequestId = 0;
const isShareDialogOpen = ref(false);
const isRefreshingGroupMembersFromFollowSet = ref(false);
const displayedPubkeyFormat = ref<PubkeyDisplayFormat>('hex');
const pubkeyError = ref('');
const pubkeyInfo = ref('');
const newMemberIdentifier = ref('');
const newMemberIdentifierError = ref('');
const isAddingMember = ref(false);
const isPublishingMembersEpoch = ref(false);
const newGroupRelay = ref('');
const isRefreshingGroupRelays = ref(false);
const isPublishingGroupRelays = ref(false);
const groupMembers = ref<GroupMemberDraft[]>([]);
const pendingGroupMemberChanges = ref<PendingGroupMemberChange[]>([]);
const groupRelayEntries = ref<ContactRelay[]>([]);
const refreshingMemberPubkeys = ref<Record<string, boolean>>({});
const groupMemberTicketEventsById = ref<Record<string, NostrEventEntry | null>>({});
const selectedGroupMemberTicketStatus = ref<SelectedGroupMemberTicketStatus | null>(null);
const retryingGroupMemberTicketRelayKeys = ref<string[]>([]);
const isRetryingGroupMemberTicketFailedRelays = ref(false);
const {
  isRelayConnected,
  isRelayInfoLoading,
  loadRelayInfo,
  prepareRelayDecorations,
  pruneRelayInfoCache,
  relayIconUrl,
  relayInfo,
  relayInfoError,
  setRelayIconError
} = useRelayDecorations(nostrStore);
let lookupRequestId = 0;
let groupOwnerLookupRequestId = 0;
let groupMemberTicketEventsRequestId = 0;

const relayList = computed(() => uniqueRelayUrls(localProfile.relays));
const normalizedDisplayPubkey = computed(() => normalizePubkeyInput(localPubkey.value));
const displayHexPubkey = computed(() => {
  return normalizedDisplayPubkey.value ?? localPubkey.value.trim();
});
const displayNpub = computed(() => {
  const pubkey = normalizedDisplayPubkey.value;
  return pubkey ? nostrStore.encodeNpub(pubkey) ?? '' : '';
});
const shareNostrAddress = computed(() => {
  const npub = displayNpub.value.trim();
  return npub ? `nostr:${npub}` : '';
});
const shareQrCodeSvgDataUrl = computed(() => {
  const shareValue = shareNostrAddress.value;
  if (!shareValue) {
    return '';
  }

  try {
    return buildQrCodeSvgDataUrl(shareValue);
  } catch (error) {
    console.warn('Failed to generate contact share QR code', error);
    return '';
  }
});
const displayedPubkeyValue = computed(() => {
  return displayedPubkeyFormat.value === 'npub' ? displayNpub.value : displayHexPubkey.value;
});
const displayedPubkeyLabel = computed(() => {
  return displayedPubkeyFormat.value === 'npub' ? t('contacts.publicKeyNpub') : t('contacts.publicKeyHex');
});
const displayedPubkeyPlaceholder = computed(() => {
  return displayedPubkeyFormat.value === 'npub' ? 'npub1...' : t('contacts.hexPublicKey.placeholder');
});
const displayedPubkeyCopyLabel = computed(() => {
  return displayedPubkeyFormat.value === 'npub' ? 'npub' : t('contacts.hexPublicKey.label');
});
const displayedPubkeyToggleLabel = computed(() => {
  return displayedPubkeyFormat.value === 'npub' ? 'hex' : 'npub';
});
const pubkeyFormatToggleAriaLabel = computed(() => {
  return displayedPubkeyFormat.value === 'npub'
    ? t('contacts.showPublicKeyHex')
    : t('contacts.showPublicKeyNpub');
});
const pubkeyFormatToggleTooltip = computed(() => {
  return displayedPubkeyFormat.value === 'npub' ? t('common.showHex') : t('contacts.showNpub');
});
const isMobileTabs = computed(() => $q.screen.lt.sm);
const isGroupContact = computed(() => currentContact.value?.type === 'group');
const isOwnedGroupContact = computed(() => {
  const loggedInPubkey = nostrStore.getLoggedInPublicKeyHex()?.trim().toLowerCase() ?? '';
  if (!loggedInPubkey || currentContact.value?.type !== 'group') {
    return false;
  }

  return (currentContact.value.meta.owner_public_key?.trim().toLowerCase() ?? '') === loggedInPubkey;
});
const showGroupProfileMarkerWarning = computed(() => {
  return currentContact.value?.type === 'group' && currentContact.value.meta.group !== true;
});
const showTabSelection = computed(() => isGroupContact.value);
const canEditGroupMembers = computed(() => isOwnedGroupContact.value && !props.readOnly);
const canAddMember = computed(() => {
  return canEditGroupMembers.value && newMemberIdentifier.value.trim().length > 0 && !isAddingMember.value;
});
const groupRelayUrls = computed(() => groupRelayEntries.value.map((entry) => entry.url));
const groupRelayValidationError = computed(() => validateGroupRelayUrl(newGroupRelay.value.trim()));
const canAddGroupRelay = computed(() => {
  const value = newGroupRelay.value.trim();
  return value.length > 0 && groupRelayValidationError.value.length === 0;
});
const groupOwnerPublicKey = computed(() => {
  if (currentContact.value?.type !== 'group') {
    return '';
  }

  return currentContact.value.meta.owner_public_key?.trim().toLowerCase() ?? '';
});
const canUseDefaultGroupRelays = computed(() => {
  if (groupRelayEntries.value.length !== DEFAULT_RELAYS.length) {
    return true;
  }

  if (groupRelayEntries.value.some((relay, index) => relay.url !== DEFAULT_RELAYS[index])) {
    return true;
  }

  return groupRelayEntries.value.some((relay) => relay.read !== true || relay.write !== true);
});
const mobileNavGridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${isGroupContact.value ? (isOwnedGroupContact.value ? 4 : 3) : 1}, minmax(0, 1fr))`
}));
const showProfileTabActions = computed(() => {
  return props.showHeader || props.showShareAction || props.showPublishAction;
});
const showMembersTabActions = computed(() => {
  return props.showHeader || (canEditGroupMembers.value && props.showPublishAction);
});
const showRelaysTabActions = computed(() => props.showHeader || props.showPublishAction);
const hasUnsavedLocalProfileChanges = computed(() => {
  if (props.readOnly || props.isPublishing || currentContact.value === null) {
    return false;
  }

  return !isSameProfile(localProfile, mapContactToProfile(currentContact.value));
});
const hasPendingGroupMemberChanges = computed(() => pendingGroupMemberChanges.value.length > 0);
const pendingRemovedGroupMemberPubkeys = computed(() => new Set(
  pendingGroupMemberChanges.value
    .filter((change) => change.action === 'remove')
    .map((change) => change.member.public_key)
));
const visibleStoredGroupMembers = computed(() => {
  const pendingRemovedMemberPubkeys = pendingRemovedGroupMemberPubkeys.value;
  return groupMembers.value.filter((member) => !pendingRemovedMemberPubkeys.has(member.public_key));
});
const visibleGroupMembers = computed(() => {
  const ownerPublicKey = groupOwnerPublicKey.value;
  const visibleMembers = visibleStoredGroupMembers.value.filter(
    (member) => member.public_key !== ownerPublicKey
  );
  const ownerMember = groupOwnerMember.value;
  if (!ownerMember || !ownerPublicKey) {
    return visibleMembers;
  }

  return [ownerMember, ...visibleMembers];
});
const membersTabLabel = computed(() => `${t('group.members')} (${visibleGroupMembers.value.length})`);
const nextPublishedGroupMembers = computed(() => {
  const pendingRemovedMemberPubkeys = pendingRemovedGroupMemberPubkeys.value;
  const remainingMembers = groupMembers.value
    .filter((member) => !pendingRemovedMemberPubkeys.has(member.public_key))
    .map((member) => cloneGroupMember(member));
  const pendingAddedMembers = pendingGroupMemberChanges.value
    .filter((change) => change.action === 'add')
    .map((change) => cloneGroupMember(change.member));

  return [...remainingMembers, ...pendingAddedMembers];
});
const allKnownRelays = computed(() => uniqueRelayUrls([...relayList.value, ...groupRelayUrls.value]));
const trackedGroupChatStoreSignature = computed(() => {
  const normalizedPubkey = normalizedHeaderPubkey.value;
  if (!normalizedPubkey) {
    return '';
  }

  const matchingChat = chatStore.chats.find(
    (chat) => normalizePubkeyInput(chat.publicKey) === normalizedPubkey && chat.type === 'group'
  );
  if (!matchingChat) {
    return '';
  }

  return JSON.stringify({
    publicKey: matchingChat.publicKey,
    epochPublicKey: matchingChat.epochPublicKey,
    lastMessageAt: matchingChat.lastMessageAt,
    unreadCount: matchingChat.unreadCount,
    meta: matchingChat.meta
  });
});
const groupEpochRows = computed(() => normalizeGroupEpochRows(currentGroupChat.value?.meta?.group_epoch_keys));
const currentEpochPublicKey = computed(() => {
  const fromChat = currentGroupChat.value?.meta?.current_epoch_public_key;
  if (typeof fromChat === 'string' && fromChat.trim()) {
    return fromChat.trim().toLowerCase();
  }

  return groupEpochRows.value[0]?.epoch_public_key ?? '';
});
const groupMemberTicketDeliveries = computed(() => {
  return normalizeGroupMemberTicketDeliveries(
    currentGroupChat.value?.meta?.group_member_ticket_deliveries
  );
});
const groupMemberTicketDeliverySignature = computed(() => {
  return groupMemberTicketDeliveries.value
    .map((delivery) => {
      return [
        delivery.member_public_key,
        delivery.epoch_number,
        delivery.event_id,
        delivery.created_at
      ].join(':');
    })
    .join('|');
});
const latestGroupMemberTicketDeliveryByMember = computed(() => {
  const deliveriesByMember = new Map<string, GroupMemberTicketDelivery>();

  for (const delivery of groupMemberTicketDeliveries.value) {
    if (!deliveriesByMember.has(delivery.member_public_key)) {
      deliveriesByMember.set(delivery.member_public_key, delivery);
    }
  }

  return deliveriesByMember;
});
const selectedGroupMemberTicketRelayStatuses = computed(() => {
  const delivery = selectedGroupMemberTicketStatus.value?.delivery;
  if (!delivery) {
    return [] as MessageRelayStatus[];
  }

  return groupMemberTicketEventsById.value[delivery.event_id]?.relay_statuses ?? [];
});
const selectedGroupMemberTicketStatusItems = computed<GroupMemberTicketStatusListItem[]>(() => {
  return buildGroupMemberTicketStatusItems(selectedGroupMemberTicketRelayStatuses.value);
});
const selectedGroupMemberTicketRetryableItems = computed(() => {
  return selectedGroupMemberTicketStatusItems.value.filter((item) => item.retryable);
});
const selectedGroupMemberTicketStatusTitle = computed(() => {
  const selectedStatus = selectedGroupMemberTicketStatus.value;
  if (!selectedStatus) {
    return t('relays.relayStatus');
  }

  return t('group.epochTitle', {
    name: selectedStatus.memberLabel,
    number: selectedStatus.delivery.epoch_number
  });
});

const normalizedHeaderPubkey = computed(() => localPubkey.value.trim());

const headerName = computed(() => {
  const displayName = localProfile.display_name.trim();
  if (displayName) {
    return displayName;
  }

  const name = localProfile.name.trim();
  if (name) {
    return name;
  }

  return formatCompactPublicKey(normalizedHeaderPubkey.value) || t('contacts.contact.label');
});

const headerSubtitle = computed(() => {
  const pubkey = normalizedHeaderPubkey.value;
  return pubkey
    ? t('contacts.pubkey.value', { pubkey: formatCompactPublicKey(pubkey) })
    : t('contacts.contactProfile');
});

const headerAvatar = computed(() => {
  return buildAvatarText(headerName.value || normalizedHeaderPubkey.value || 'NA');
});

const headerPictureUrl = computed(() => {
  return localProfile.picture.trim();
});

watch(
  () => props.modelValue,
  (value) => {
    const nextProfile = cloneProfile(value);
    if (isSameProfile(nextProfile, localProfile)) {
      return;
    }

    Object.assign(localProfile, nextProfile);
  },
  { immediate: true }
);

watch(
  localProfile,
  (value) => {
    const nextProfile = cloneProfile(value);
    if (isSameProfile(nextProfile, props.modelValue)) {
      return;
    }

    emit('update:modelValue', nextProfile);
  },
  { deep: true }
);

watch(
  () => props.pubkey,
  (value) => {
    if (props.autoRefreshOnPubkeyChange) {
      void refreshContactProfileFromPubkey(value ?? '');
      return;
    }

    void loadContactFromPubkey(value ?? '');
  },
  { immediate: true }
);

watch(
  () => nostrStore.contactListVersion,
  () => {
    const normalizedPubkey = normalizePubkeyInput(props.pubkey ?? '');
    if (
      !normalizedPubkey ||
      isLoadingContact.value ||
      hasUnsavedLocalProfileChanges.value ||
      (canEditGroupMembers.value &&
        (activeTab.value === 'members' || hasPendingGroupMemberChanges.value))
    ) {
      return;
    }

    void loadContactFromPubkey(normalizedPubkey);
  }
);

watch(
  allKnownRelays,
  (relays) => {
    pruneRelayInfoCache(relays);
    void prepareRelayDecorations(relays);
  },
  { immediate: true }
);

watch(isGroupContact, (value) => {
  if (!value && activeTab.value !== 'profile') {
    activeTab.value = 'profile';
  }
});

watch(isOwnedGroupContact, (value) => {
  if (!value && activeTab.value === 'relays') {
    activeTab.value = 'profile';
  }
});

watch(
  currentContact,
  (contact) => {
    syncGroupMembersFromContact(contact);
    syncGroupRelayEntriesFromContact(contact);
    void syncGroupOwnerMemberFromContact(contact);
  },
  { immediate: true }
);

watch(
  () => groupMemberTicketDeliverySignature.value,
  () => {
    void loadGroupMemberTicketEvents();
  },
  { immediate: true }
);

watch(
  [() => trackedGroupChatStoreSignature.value, isGroupContact, () => props.pubkey],
  ([, isGroup, pubkey]) => {
    if (!isGroup) {
      return;
    }

    void refreshCurrentGroupChat(pubkey ?? '');
  },
  { immediate: true }
);

function normalizeGroupEpochRows(value: unknown): ChatGroupEpochKey[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const rows: ChatGroupEpochKey[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }

    const epochNumber = Number('epoch_number' in entry ? entry.epoch_number : Number.NaN);
    const epochPublicKey =
      'epoch_public_key' in entry && typeof entry.epoch_public_key === 'string'
        ? entry.epoch_public_key.trim().toLowerCase()
        : '';
    const epochPrivateKeyEncrypted =
      'epoch_private_key_encrypted' in entry && typeof entry.epoch_private_key_encrypted === 'string'
        ? entry.epoch_private_key_encrypted.trim()
        : '';
    const invitationCreatedAt =
      'invitation_created_at' in entry && typeof entry.invitation_created_at === 'string'
        ? entry.invitation_created_at.trim()
        : '';

    if (!Number.isInteger(epochNumber) || epochNumber < 0 || !epochPublicKey || !epochPrivateKeyEncrypted) {
      continue;
    }

    rows.push({
      epoch_number: Math.floor(epochNumber),
      epoch_public_key: epochPublicKey,
      epoch_private_key_encrypted: epochPrivateKeyEncrypted,
      ...(invitationCreatedAt ? { invitation_created_at: invitationCreatedAt } : {})
    });
  }

  return rows.sort((first, second) => second.epoch_number - first.epoch_number);
}

function formatEpochInvitationDate(value: string | undefined): string {
  if (!value) {
    return t('common.unknownLabel');
  }

  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) {
    return t('common.unknownLabel');
  }

  return new Intl.DateTimeFormat(getDateTimeLocale(), {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(parsedDate);
}

function memberLatestGroupTicketDelivery(
  member: GroupMemberDraft
): GroupMemberTicketDelivery | null {
  return latestGroupMemberTicketDeliveryByMember.value.get(
    member.public_key.trim().toLowerCase()
  ) ?? null;
}

function memberLatestGroupTicketRelayStatuses(member: GroupMemberDraft): MessageRelayStatus[] {
  const delivery = memberLatestGroupTicketDelivery(member);
  if (!delivery) {
    return [];
  }

  return groupMemberTicketEventsById.value[delivery.event_id]?.relay_statuses ?? [];
}

function hasMemberLatestGroupTicketStatus(member: GroupMemberDraft): boolean {
  return memberLatestGroupTicketRelayStatuses(member).length > 0;
}

function memberLatestGroupTicketEpochLabel(member: GroupMemberDraft): string {
  const delivery = memberLatestGroupTicketDelivery(member);
  return delivery ? `Epoch ${delivery.epoch_number}` : '';
}

function groupMemberTicketStatusDotClass(
  status: GroupMemberTicketStatusListItem['status']
): string {
  switch (status) {
    case 'published':
      return 'profile-member-delivery__status-dot--green';
    case 'failed':
      return 'profile-member-delivery__status-dot--red';
    case 'pending':
    default:
      return 'profile-member-delivery__status-dot--gray';
  }
}

function groupMemberTicketStatusSegmentClass(
  status: GroupMemberTicketStatusListItem['status']
): string {
  switch (status) {
    case 'published':
      return 'profile-member-delivery__status-segment--green';
    case 'failed':
      return 'profile-member-delivery__status-segment--red';
    case 'pending':
    default:
      return 'profile-member-delivery__status-segment--gray';
  }
}

function buildGroupMemberTicketStatusItems(
  relayStatuses: MessageRelayStatus[]
): GroupMemberTicketStatusListItem[] {
  const statusPriority: Record<GroupMemberTicketStatusListItem['status'], number> = {
    published: 0,
    failed: 1,
    pending: 2
  };

  return relayStatuses
    .filter(
      (
        relayStatus
      ): relayStatus is MessageRelayStatus & {
        direction: 'outbound';
        scope: 'recipient';
        status: GroupMemberTicketStatusListItem['status'];
      } =>
        relayStatus.direction === 'outbound' &&
        relayStatus.scope === 'recipient' &&
        (relayStatus.status === 'published' ||
          relayStatus.status === 'failed' ||
          relayStatus.status === 'pending')
    )
    .slice()
    .sort((first, second) => {
      const byStatus = statusPriority[first.status] - statusPriority[second.status];
      if (byStatus !== 0) {
        return byStatus;
      }

      return first.relay_url.localeCompare(second.relay_url);
    })
    .map((relayStatus) => ({
      key: `${relayStatus.status}-${relayStatus.relay_url}`,
      relayUrl: relayStatus.relay_url,
      detail: relayStatus.detail,
      status: relayStatus.status,
      retryable: relayStatus.status === 'failed',
      dotClass: groupMemberTicketStatusDotClass(relayStatus.status)
    }));
}

function memberLatestGroupTicketStatusSegments(member: GroupMemberDraft): Array<{
  key: GroupMemberTicketStatusListItem['status'];
  className: string;
  weight: number;
}> {
  const relayStatuses = memberLatestGroupTicketRelayStatuses(member);
  const published = relayStatuses.filter((relayStatus) => {
    return relayStatus.direction === 'outbound' &&
      relayStatus.scope === 'recipient' &&
      relayStatus.status === 'published';
  }).length;
  const failed = relayStatuses.filter((relayStatus) => {
    return relayStatus.direction === 'outbound' &&
      relayStatus.scope === 'recipient' &&
      relayStatus.status === 'failed';
  }).length;
  const pending = relayStatuses.filter((relayStatus) => {
    return relayStatus.direction === 'outbound' &&
      relayStatus.scope === 'recipient' &&
      relayStatus.status === 'pending';
  }).length;

  const segments: Array<{
    key: GroupMemberTicketStatusListItem['status'];
    className: string;
    weight: number;
  }> = [
    {
      key: 'published',
      className: groupMemberTicketStatusSegmentClass('published'),
      weight: published
    },
    {
      key: 'failed',
      className: groupMemberTicketStatusSegmentClass('failed'),
      weight: failed
    },
    {
      key: 'pending',
      className: groupMemberTicketStatusSegmentClass('pending'),
      weight: pending
    }
  ];

  return segments.filter((segment) => segment.weight > 0);
}

async function loadGroupMemberTicketEvents(): Promise<void> {
  const requestId = ++groupMemberTicketEventsRequestId;
  const deliveries = groupMemberTicketDeliveries.value;
  if (deliveries.length === 0) {
    groupMemberTicketEventsById.value = {};
    return;
  }

  try {
    await nostrEventDataService.init();
    const eventIds = deliveries.map((delivery) => delivery.event_id);
    const eventsById = await nostrEventDataService.getEventsByIds(eventIds);
    if (requestId !== groupMemberTicketEventsRequestId) {
      return;
    }

    groupMemberTicketEventsById.value = Object.fromEntries(
      eventIds.map((eventId) => [eventId, eventsById.get(eventId) ?? null])
    );
  } catch (error) {
    if (requestId !== groupMemberTicketEventsRequestId) {
      return;
    }

    console.warn('Failed to load group member ticket relay statuses', error);
    groupMemberTicketEventsById.value = {};
  }
}

async function refreshGroupMemberTicketEvent(eventId: string): Promise<void> {
  const normalizedEventId = eventId.trim().toLowerCase();
  if (!normalizedEventId) {
    return;
  }

  await nostrEventDataService.init();
  const eventEntry = await nostrEventDataService.getEventById(normalizedEventId);
  groupMemberTicketEventsById.value = {
    ...groupMemberTicketEventsById.value,
    [normalizedEventId]: eventEntry
  };
}

function openGroupMemberTicketStatus(member: GroupMemberDraft): void {
  const delivery = memberLatestGroupTicketDelivery(member);
  if (!delivery) {
    return;
  }

  selectedGroupMemberTicketStatus.value = {
    delivery,
    memberLabel: memberListTitle(member)
  };
}

function closeGroupMemberTicketStatusDialog(isOpen = false): void {
  if (isOpen) {
    return;
  }

  selectedGroupMemberTicketStatus.value = null;
}

function retryingGroupMemberTicketRelayKey(eventId: string, relayUrl: string): string {
  return `${eventId.trim().toLowerCase()}|${relayUrl.trim()}`;
}

function isRetryingGroupMemberTicketRelay(item: GroupMemberTicketStatusListItem): boolean {
  const eventId = selectedGroupMemberTicketStatus.value?.delivery.event_id ?? '';
  return retryingGroupMemberTicketRelayKeys.value.includes(
    retryingGroupMemberTicketRelayKey(eventId, item.relayUrl)
  );
}

async function retrySelectedGroupMemberTicketRelay(
  item: GroupMemberTicketStatusListItem
): Promise<void> {
  const selectedStatus = selectedGroupMemberTicketStatus.value;
  if (!selectedStatus || !item.retryable) {
    return;
  }

  const retryKey = retryingGroupMemberTicketRelayKey(
    selectedStatus.delivery.event_id,
    item.relayUrl
  );
  if (retryingGroupMemberTicketRelayKeys.value.includes(retryKey)) {
    return;
  }

  retryingGroupMemberTicketRelayKeys.value = [
    ...retryingGroupMemberTicketRelayKeys.value,
    retryKey
  ];

  try {
    await nostrStore.retryGroupEpochTicketRelay(
      selectedStatus.delivery.event_id,
      item.relayUrl
    );
    await refreshGroupMemberTicketEvent(selectedStatus.delivery.event_id);
  } catch (error) {
    reportUiError(
      'Failed to retry group member ticket relay',
      error,
      t('errors.failedRetryRelay')
    );
  } finally {
    retryingGroupMemberTicketRelayKeys.value =
      retryingGroupMemberTicketRelayKeys.value.filter((key) => key !== retryKey);
  }
}

async function retrySelectedGroupMemberTicketFailedRelays(): Promise<void> {
  if (isRetryingGroupMemberTicketFailedRelays.value) {
    return;
  }

  const retryItems = selectedGroupMemberTicketRetryableItems.value.filter(
    (item) => !isRetryingGroupMemberTicketRelay(item)
  );
  if (retryItems.length === 0) {
    return;
  }

  isRetryingGroupMemberTicketFailedRelays.value = true;
  try {
    await Promise.all(
      retryItems.map((item) => retrySelectedGroupMemberTicketRelay(item))
    );
  } finally {
    isRetryingGroupMemberTicketFailedRelays.value = false;
  }
}

function cloneProfile(value: ContactProfileForm): ContactProfileForm {
  return {
    ...(value ?? createEmptyContactProfileForm()),
    birthday: {
      year: value?.birthday?.year ?? null,
      month: value?.birthday?.month ?? null,
      day: value?.birthday?.day ?? null
    },
    relays: [...(value?.relays ?? [])],
    sendMessagesToAppRelays: value?.sendMessagesToAppRelays === true
  };
}

function normalizePubkeyInput(input: string): string | null {
  const value = input.trim();
  if (!value) {
    return null;
  }

  if (isValidPubkey(value)) {
    return value.toLowerCase();
  }

  const npubValidation = nostrStore.validateNpub(value);
  return npubValidation.isValid ? npubValidation.normalizedPubkey : null;
}

function toggleDisplayedPubkeyFormat(): void {
  displayedPubkeyFormat.value = displayedPubkeyFormat.value === 'npub' ? 'hex' : 'npub';
}

function handlePublishProfile(): void {
  emit('publish', cloneProfile(localProfile));
}

function handleRelayExpand(relay: string): void {
  try {
    void loadRelayInfo(relay);
  } catch (error) {
    reportUiError('Failed to expand relay details in contact profile', error);
  }
}

function retryRelayInfo(relay: string): void {
  try {
    void loadRelayInfo(relay, true);
  } catch (error) {
    reportUiError('Failed to retry relay info in contact profile', error);
  }
}

function handleRelayIconError(relay: string): void {
  try {
    setRelayIconError(relay);
  } catch (error) {
    reportUiError('Failed to handle relay icon error in contact profile', error);
  }
}

function relayReadEnabled(): boolean {
  return true;
}

function relayWriteEnabled(): boolean {
  return true;
}

function handleSendMessagesToAppRelaysUpdate(value: boolean): void {
  emit('update:send-messages-to-app-relays', value === true);
}

function clearMemberIdentifierError(): void {
  if (newMemberIdentifierError.value) {
    newMemberIdentifierError.value = '';
  }
}

function validateGroupRelayUrl(value: string): string {
  if (!value) {
    return '';
  }

  try {
    const normalizedRelay = normalizeRelayUrl(value);
    if (
      groupRelayEntries.value.some(
        (entry) => buildRelayLookupKey(entry.url) === buildRelayLookupKey(normalizedRelay)
      )
    ) {
      return t('relays.validation.alreadyAdded');
    }

    return '';
  } catch {
    return t('relays.relayMustValidWs');
  }
}

function memberIdentifierErrorMessage(resolution: {
  identifierType: string | null;
  error: string | null;
}): string {
  if (resolution.identifierType === 'nip05') {
    return resolution.error === 'nip05_unresolved'
      ? t('contacts.nip05CouldResolvedPlease')
      : t('contacts.enterValidNip05Identifier');
  }

  return t('contacts.validation.hexPubkeyNpubNip05');
}

function applyStoredContactToCurrentContact(updatedContact: ContactRecord): void {
  const contact = currentContact.value;
  if (!contact || contact.id !== updatedContact.id) {
    return;
  }

  contact.public_key = updatedContact.public_key;
  contact.type = updatedContact.type;
  contact.name = updatedContact.name;
  contact.given_name = updatedContact.given_name;
  contact.meta = {
    ...(updatedContact.meta ?? {})
  };
  contact.relays = updatedContact.relays ? updatedContact.relays.map((relay) => ({ ...relay })) : [];
  contact.sendMessagesToAppRelays = updatedContact.sendMessagesToAppRelays;
}

function findPendingGroupMemberChangeIndex(memberPublicKey: string): number {
  const normalizedPublicKey = memberPublicKey.trim().toLowerCase();
  return pendingGroupMemberChanges.value.findIndex(
    (change) => change.member.public_key === normalizedPublicKey
  );
}

function pendingMemberBadgeColor(action: PendingGroupMemberChangeAction): string {
  return action === 'add' ? 'positive' : 'negative';
}

function pendingMemberBadgeLabel(action: PendingGroupMemberChangeAction): string {
  return action === 'add' ? t('common.adding') : t('common.removing');
}

async function handleAddMember(): Promise<void> {
  if (!canEditGroupMembers.value || isAddingMember.value) {
    return;
  }

  const identifier = newMemberIdentifier.value.trim();
  if (!identifier) {
    newMemberIdentifierError.value = t('contacts.validation.hexPubkeyNpubNip05');
    return;
  }

  isAddingMember.value = true;

  try {
    const resolution = await nostrStore.resolveIdentifier(identifier);
    if (!resolution.isValid || !resolution.normalizedPubkey) {
      newMemberIdentifierError.value = memberIdentifierErrorMessage(resolution);
      return;
    }

    const normalizedPublicKey = resolution.normalizedPubkey;
    const ownerPublicKey = currentContact.value?.meta.owner_public_key?.trim().toLowerCase() ?? '';
    if (ownerPublicKey && normalizedPublicKey === ownerPublicKey) {
      newMemberIdentifierError.value = t('group.groupOwnerDoesNeed');
      return;
    }

    const pendingChangeIndex = findPendingGroupMemberChangeIndex(normalizedPublicKey);
    if (pendingChangeIndex >= 0) {
      const pendingChange = pendingGroupMemberChanges.value[pendingChangeIndex];
      if (pendingChange?.action === 'add') {
        newMemberIdentifierError.value = t('relays.memberAlreadyPending');
        return;
      }

      pendingGroupMemberChanges.value = pendingGroupMemberChanges.value.filter(
        (change) => change.member.public_key !== normalizedPublicKey
      );
      newMemberIdentifier.value = '';
      newMemberIdentifierError.value = '';
      return;
    }

    if (groupMembers.value.some((member) => member.public_key === normalizedPublicKey)) {
      newMemberIdentifierError.value = t('relays.memberAlreadyList');
      return;
    }

    const fallbackName =
      resolution.resolvedName?.trim() ||
      identifier.slice(0, 32) ||
      normalizedPublicKey.slice(0, 16);
    const memberPreview =
      (await nostrStore.fetchContactPreviewByPublicKey(normalizedPublicKey, fallbackName)) ?? {
        public_key: normalizedPublicKey,
        name: fallbackName,
        given_name: null,
        meta: {}
      };

    const trimmedIdentifier = identifier.trim();
    pendingGroupMemberChanges.value = [
      ...pendingGroupMemberChanges.value,
      {
        action: 'add',
        member: buildStoredGroupMember(
          memberPreview,
          resolution.identifierType,
          trimmedIdentifier.startsWith('nprofile1') ? trimmedIdentifier : null,
          resolution.identifierType === 'nip05' ? trimmedIdentifier : null
        )
      }
    ];

    newMemberIdentifier.value = '';
    newMemberIdentifierError.value = '';
  } catch (error) {
    reportUiError('Failed to validate group member', error, t('errors.failedAddMember'));
  } finally {
    isAddingMember.value = false;
  }
}

function handleUndoPendingMember(memberPublicKey: string): void {
  try {
    pendingGroupMemberChanges.value = pendingGroupMemberChanges.value.filter(
      (change) => change.member.public_key !== memberPublicKey
    );
  } catch (error) {
    reportUiError('Failed to undo pending group member change', error, t('errors.failedUndoMemberChange'));
  }
}

function handleRemoveMember(memberPublicKey: string): void {
  if (!canEditGroupMembers.value) {
    return;
  }

  if (isGroupOwnerPublicKey(memberPublicKey)) {
    return;
  }

  try {
    const member = groupMembers.value.find((entry) => entry.public_key === memberPublicKey);
    if (!member || findPendingGroupMemberChangeIndex(memberPublicKey) >= 0) {
      return;
    }

    pendingGroupMemberChanges.value = [
      ...pendingGroupMemberChanges.value,
      {
        action: 'remove',
        member: cloneGroupMember(member)
      }
    ];
  } catch (error) {
    reportUiError('Failed to remove group member', error, t('errors.failedRemoveMember'));
  }
}

async function handleRefreshMember(memberPublicKey: string): Promise<void> {
  if (isGroupOwnerPublicKey(memberPublicKey)) {
    if (refreshingMemberPubkeys.value[memberPublicKey]) {
      return;
    }

    refreshingMemberPubkeys.value = {
      ...refreshingMemberPubkeys.value,
      [memberPublicKey]: true
    };

    try {
      const fallbackName = groupOwnerMember.value?.name?.trim() || memberPublicKey.slice(0, 16);
      await refreshGroupOwnerMember(memberPublicKey, fallbackName);
    } catch (error) {
      reportUiError('Failed to refresh group owner profile', error, t('errors.failedRefreshMemberProfile'));
    } finally {
      const nextRefreshingState = {
        ...refreshingMemberPubkeys.value
      };
      delete nextRefreshingState[memberPublicKey];
      refreshingMemberPubkeys.value = nextRefreshingState;
    }

    return;
  }

  const targetMemberIndex = groupMembers.value.findIndex(
    (entry) => entry.public_key === memberPublicKey
  );
  const member = targetMemberIndex >= 0 ? groupMembers.value[targetMemberIndex] : null;
  if (!member) {
    return;
  }

  const memberPubkey = member.public_key;
  if (refreshingMemberPubkeys.value[memberPubkey]) {
    return;
  }

  refreshingMemberPubkeys.value = {
    ...refreshingMemberPubkeys.value,
    [memberPubkey]: true
  };

  try {
    const refreshedMember =
      (await nostrStore.fetchContactPreviewByPublicKey(memberPubkey, member.name)) ?? member;
    await persistGroupMembers(groupMembers.value.map((entry, memberIndex) =>
      memberIndex === targetMemberIndex
        ? buildStoredGroupMember(refreshedMember, null, entry.nprofile ?? null, entry.nip05 ?? null)
        : entry
    ));
  } catch (error) {
    reportUiError('Failed to refresh group member profile', error, t('errors.failedRefreshMemberProfile'));
  } finally {
    const nextRefreshingState = {
      ...refreshingMemberPubkeys.value
    };
    delete nextRefreshingState[memberPubkey];
    refreshingMemberPubkeys.value = nextRefreshingState;
  }
}

async function handleRefreshGroupMembersFromFollowSet(): Promise<void> {
  const groupPublicKey = currentContact.value?.public_key?.trim() ?? '';
  if (
    !groupPublicKey ||
    isPublishingMembersEpoch.value ||
    (canEditGroupMembers.value && hasPendingGroupMemberChanges.value) ||
    isRefreshingGroupMembersFromFollowSet.value
  ) {
    return;
  }

  isRefreshingGroupMembersFromFollowSet.value = true;

  try {
    const refreshResult = await nostrStore.refreshGroupMembershipRoster(groupPublicKey);
    await loadContactFromPubkey(groupPublicKey);
    const visibleRefreshedMemberCount = refreshResult.memberPublicKeys.filter(
      (memberPublicKey) => !isGroupOwnerPublicKey(memberPublicKey)
    ).length;

    $q.notify({
      type: refreshResult.fallbackProfileCount > 0 ? 'warning' : 'positive',
      message:
        visibleRefreshedMemberCount > 0 || refreshResult.ownerIncluded
          ? t('group.refreshedPublishedRoster', {
              count: visibleRefreshedMemberCount,
              memberLabel:
                visibleRefreshedMemberCount === 1 ? t('common.member') : t('common.members')
            })
          : t('group.groupMembersRefreshedMembers'),
      caption:
        refreshResult.fallbackProfileCount > 0
          ? t('group.members.localFallbackData', {
              count: refreshResult.fallbackProfileCount,
              profileLabel:
                refreshResult.fallbackProfileCount === 1 ? t('common.profile') : t('common.profiles')
            })
          : t('group.fetchedLatestNip51Roster'),
      position: 'top',
      timeout: refreshResult.fallbackProfileCount > 0 ? 6000 : 3000
    });
  } catch (error) {
    reportUiError(
      'Failed to refresh group members from roster',
      error,
      t('errors.failedRefreshGroupMembers')
    );
  } finally {
    isRefreshingGroupMembersFromFollowSet.value = false;
  }
}

async function handleMembersPublish(): Promise<void> {
  const groupPublicKey = currentContact.value?.public_key?.trim() ?? '';
  if (
    !groupPublicKey ||
    !canEditGroupMembers.value ||
    !hasPendingGroupMemberChanges.value ||
    isPublishingMembersEpoch.value
  ) {
    return;
  }

  isPublishingMembersEpoch.value = true;

  try {
    const nextMembers = nextPublishedGroupMembers.value.map((member) => cloneGroupMember(member));
    const publishResult = await nostrStore.publishGroupMemberChanges(
      groupPublicKey,
      nextMembers.map((member) => member.public_key)
    );

    await persistGroupMembers(nextMembers);
    pendingGroupMemberChanges.value = [];
    await loadContactFromPubkey(groupPublicKey);

    if (publishResult.failedMemberPubkeys.length === 0) {
      $q.notify({
        type: 'positive',
        message:
          publishResult.attemptedMemberCount > 0
            ? publishResult.createdNewEpoch
              ? t('group.epochPublished', {
                  epoch: publishResult.epochNumber,
                  count: publishResult.deliveredMemberCount,
                  memberLabel:
                    publishResult.deliveredMemberCount === 1 ? t('common.member') : t('common.members')
                })
              : t('group.invitationsEpochSent', {
                  epoch: publishResult.epochNumber,
                  count: publishResult.deliveredMemberCount,
                  memberLabel:
                    publishResult.deliveredMemberCount === 1 ? t('common.member') : t('common.members')
                })
            : publishResult.createdNewEpoch
              ? t('group.epochCreatedLocallyMembers', {
                  epoch: publishResult.epochNumber
                })
              : t('group.membersNotifyEpoch', {
                  epoch: publishResult.epochNumber
                }),
        caption: t('relays.published', {
          count: publishResult.publishedRelayUrls.length,
          relayLabel:
            publishResult.publishedRelayUrls.length === 1 ? t('common.relay') : t('common.relays')
        }),
        position: 'top'
      });
      return;
    }

    $q.notify({
      type: publishResult.deliveredMemberCount > 0 ? 'warning' : 'negative',
      message: publishResult.createdNewEpoch
        ? t('group.epochPublishedPartialDelivery', {
            epoch: publishResult.epochNumber
          })
        : t('group.invitationsEpochSentPartial', {
            epoch: publishResult.epochNumber
          }),
      caption: t('relays.deliverySummary', {
        delivered: publishResult.deliveredMemberCount,
        failed: publishResult.failedMemberPubkeys.length,
        relayCount: publishResult.publishedRelayUrls.length,
        relayLabel:
          publishResult.publishedRelayUrls.length === 1 ? t('common.relay') : t('common.relays')
      }),
      position: 'top',
      timeout: 6000
    });
  } catch (error) {
    reportUiError(
      'Failed to publish group member changes',
      error,
      t('errors.failedPublishGroupMembers')
    );
  } finally {
    isPublishingMembersEpoch.value = false;
  }
}

function cloneGroupRelayEntries(relays: ContactRelay[] | undefined): ContactRelay[] {
  return relays ? relays.map((relay) => ({ ...relay })) : [];
}

function syncGroupRelayEntriesFromContact(contact: ContactRecord | null): void {
  newGroupRelay.value = '';
  groupRelayEntries.value =
    contact && contact.type === 'group'
      ? cloneGroupRelayEntries(contact.relays ?? [])
      : [];
}

function handleAddGroupRelay(): void {
  try {
    const value = newGroupRelay.value.trim();
    if (!value || groupRelayValidationError.value) {
      return;
    }

    const normalizedRelay = normalizeRelayUrl(value);
    groupRelayEntries.value = [
      ...groupRelayEntries.value,
      {
        url: normalizedRelay,
        read: true,
        write: true
      }
    ];
    newGroupRelay.value = '';
  } catch (error) {
    reportUiError('Failed to add group relay', error, t('errors.failedAddRelay'));
  }
}

function handleRemoveGroupRelay(index: number): void {
  try {
    groupRelayEntries.value = groupRelayEntries.value.filter((_, relayIndex) => relayIndex !== index);
  } catch (error) {
    reportUiError('Failed to remove group relay', error, t('errors.failedRemoveRelay'));
  }
}

function handleUseDefaultGroupRelays(): void {
  try {
    newGroupRelay.value = '';
    groupRelayEntries.value = DEFAULT_RELAYS.map((url) => ({
      url,
      read: true,
      write: true
    }));
  } catch (error) {
    reportUiError(
      'Failed to reset group relays to defaults',
      error,
      t('errors.failedUseDefaultRelays')
    );
  }
}

function groupRelayReadEnabled(index: number): boolean {
  return groupRelayEntries.value[index]?.read ?? true;
}

function groupRelayWriteEnabled(index: number): boolean {
  return groupRelayEntries.value[index]?.write ?? true;
}

function handleUpdateGroupRelayRead({ index, value }: RelayTogglePayload): void {
  try {
    groupRelayEntries.value = groupRelayEntries.value.map((entry, relayIndex) =>
      relayIndex === index
        ? {
            ...entry,
            read: value
          }
        : entry
    );
  } catch (error) {
    reportUiError('Failed to update group relay read flag', error, t('errors.failedUpdateRelay'));
  }
}

function handleUpdateGroupRelayWrite({ index, value }: RelayTogglePayload): void {
  try {
    groupRelayEntries.value = groupRelayEntries.value.map((entry, relayIndex) =>
      relayIndex === index
        ? {
            ...entry,
            write: value
          }
        : entry
    );
  } catch (error) {
    reportUiError('Failed to update group relay write flag', error, t('errors.failedUpdateRelay'));
  }
}

async function handleRefreshGroupRelays(): Promise<void> {
  const groupPublicKey = currentContact.value?.public_key?.trim() ?? '';
  if (!groupPublicKey || isRefreshingGroupRelays.value) {
    return;
  }

  isRefreshingGroupRelays.value = true;

  try {
    await nostrStore.refreshContactRelayList(groupPublicKey);
    await loadContactFromPubkey(groupPublicKey);
  } catch (error) {
    reportUiError('Failed to refresh group relays', error, t('errors.failedRefreshGroupRelays'));
  } finally {
    isRefreshingGroupRelays.value = false;
  }
}

async function handlePublishGroupRelays(): Promise<void> {
  const contact = currentContact.value;
  if (!contact || contact.type !== 'group' || isPublishingGroupRelays.value) {
    return;
  }

  isPublishingGroupRelays.value = true;

  try {
    const nextRelayEntries = groupRelayEntries.value.map((relay) => ({ ...relay }));
    const updatedContact = await contactsService.updateContact(contact.id, {
      relays: nextRelayEntries
    });
    if (!updatedContact) {
      throw new Error('Failed to persist group relay list.');
    }

    applyStoredContactToCurrentContact(updatedContact);
    groupRelayEntries.value = cloneGroupRelayEntries(updatedContact.relays ?? []);
    localProfile.relays = (updatedContact.relays ?? []).map((relay) => relay.url);

    const relaySaveStatus = await nostrStore.publishGroupRelayList(
      updatedContact.public_key,
      nextRelayEntries,
      nextRelayEntries.map((relay) => relay.url)
    );

    if (relaySaveStatus.publishedRelayUrls.length > 0 && relaySaveStatus.failedRelayUrls.length === 0) {
      $q.notify({
        type: 'positive',
        message: t('relays.groupRelaysPublished'),
        caption: t('relays.published', {
          count: relaySaveStatus.publishedRelayUrls.length,
          relayLabel:
            relaySaveStatus.publishedRelayUrls.length === 1 ? t('common.relay') : t('common.relays')
        }),
        position: 'top'
      });
      return;
    }

    $q.notify({
      type: relaySaveStatus.publishedRelayUrls.length > 0 ? 'warning' : 'negative',
      message:
        relaySaveStatus.publishedRelayUrls.length > 0
          ? t('relays.groupRelaysPublishedPartial')
          : t('errors.failedPublishGroupRelays'),
      caption:
        t('relays.published', {
          count: relaySaveStatus.publishedRelayUrls.length,
          relayLabel:
            relaySaveStatus.publishedRelayUrls.length === 1 ? t('common.relay') : t('common.relays')
        }) +
        (relaySaveStatus.errorMessage ? ` ${relaySaveStatus.errorMessage}` : ''),
      position: 'top',
      timeout: 6000
    });
  } catch (error) {
    reportUiError('Failed to publish group relays', error, t('errors.failedPublishGroupRelays'));
  } finally {
    isPublishingGroupRelays.value = false;
  }
}

function resetMembersEditor(): void {
  newMemberIdentifier.value = '';
  newMemberIdentifierError.value = '';
  groupMembers.value = [];
  groupOwnerMember.value = null;
  pendingGroupMemberChanges.value = [];
  refreshingMemberPubkeys.value = {};
  selectedGroupMemberTicketStatus.value = null;
  retryingGroupMemberTicketRelayKeys.value = [];
}

function isMemberRefreshing(pubkey: string): boolean {
  return refreshingMemberPubkeys.value[pubkey] === true;
}

function buildStoredGroupMember(
  preview:
    | Pick<ContactRecord, 'public_key' | 'name' | 'given_name' | 'meta'>
    | {
        public_key: string;
        name: string;
        given_name?: string | null;
        meta?: ContactRecord['meta'];
        about?: string;
        nip05?: string;
        nprofile?: string;
      },
  identifierType: string | null,
  nprofile: string | null,
  nip05: string | null
): GroupMemberDraft {
  const name =
    preview.meta?.name?.trim() ||
    preview.meta?.display_name?.trim() ||
    preview.name.trim() ||
    preview.public_key;
  const previewPicture =
    'picture' in preview && typeof preview.picture === 'string' ? preview.picture.trim() : '';
  const previewAvatar =
    'avatar' in preview && typeof preview.avatar === 'string' ? preview.avatar.trim() : '';
  const picture = preview.meta?.picture?.trim() || previewPicture;
  const avatar = preview.meta?.avatar?.trim() || previewAvatar;
  const about =
    preview.meta?.about?.trim() || ('about' in preview ? preview.about?.trim() || '' : '');

  return {
    public_key: preview.public_key,
    name,
    given_name: preview.given_name?.trim() || null,
    ...(picture ? { picture } : {}),
    ...(avatar ? { avatar } : {}),
    ...(about ? { about } : {}),
    ...(identifierType === 'nip05' && nip05 ? { nip05 } : {}),
    ...(nprofile ? { nprofile } : {}),
    ...(identifierType === null && nip05 ? { nip05 } : {})
  };
}

function cloneGroupMember(member: ContactGroupMember): GroupMemberDraft {
  return {
    public_key: member.public_key,
    name: member.name,
    given_name: member.given_name ?? null,
    picture: member.picture,
    avatar: member.avatar,
    about: member.about,
    nip05: member.nip05,
    nprofile: member.nprofile
  };
}

function cloneGroupMembers(members: ContactGroupMember[] | undefined): GroupMemberDraft[] {
  return Array.isArray(members) ? members.map((member) => cloneGroupMember(member)) : [];
}

function syncGroupMembersFromContact(contact: ContactRecord | null): void {
  resetMembersEditor();
  if (!contact || contact.type !== 'group') {
    return;
  }

  const ownerPublicKey = contact.meta.owner_public_key?.trim().toLowerCase() ?? '';
  groupMembers.value = cloneGroupMembers(contact.meta.group_members).filter(
    (member) => member.public_key !== ownerPublicKey
  );
}

async function persistGroupMembers(nextMembers: GroupMemberDraft[]): Promise<void> {
  const contact = currentContact.value;
  if (!contact || contact.type !== 'group') {
    groupMembers.value = cloneGroupMembers(nextMembers);
    return;
  }

  await contactsService.init();
  const latestStoredContact = await contactsService.getContactById(contact.id);
  const baseContact =
    latestStoredContact && latestStoredContact.type === 'group' ? latestStoredContact : contact;

  const nextMeta: ContactMetadata = {
    ...(baseContact.meta ?? {})
  };
  const ownerPublicKey = baseContact.meta.owner_public_key?.trim().toLowerCase() ?? '';
  const storedMembers = cloneGroupMembers(nextMembers).filter(
    (member) => member.public_key !== ownerPublicKey
  );

  if (storedMembers.length > 0) {
    nextMeta.group_members = storedMembers;
  } else {
    delete nextMeta.group_members;
  }

  const updatedContact = await contactsService.updateContact(baseContact.id, {
    meta: nextMeta
  });
  if (!updatedContact) {
    throw new Error('Failed to persist group members.');
  }

  applyStoredContactToCurrentContact(updatedContact);
  groupMembers.value = cloneGroupMembers(updatedContact.meta.group_members).filter(
    (member) => member.public_key !== ownerPublicKey
  );
}

async function syncGroupOwnerMemberFromContact(contact: ContactRecord | null): Promise<void> {
  const requestId = ++groupOwnerLookupRequestId;
  const ownerPublicKey =
    contact?.type === 'group' ? contact.meta.owner_public_key?.trim().toLowerCase() ?? '' : '';
  if (!ownerPublicKey) {
    groupOwnerMember.value = null;
    return;
  }

  const fallbackName = ownerPublicKey.slice(0, 16);
  groupOwnerMember.value = {
    public_key: ownerPublicKey,
    name: fallbackName,
    given_name: null
  };

  try {
    await refreshGroupOwnerMember(ownerPublicKey, fallbackName, requestId);
  } catch (error) {
    if (requestId !== groupOwnerLookupRequestId) {
      return;
    }

    console.warn('Failed to load group owner preview', ownerPublicKey, error);
  }
}

async function refreshGroupOwnerMember(
  ownerPublicKey: string,
  fallbackName: string,
  requestId = ++groupOwnerLookupRequestId
): Promise<void> {
  await contactsService.init();
  const storedOwner = await contactsService.getContactByPublicKey(ownerPublicKey);
  const ownerPreview =
    storedOwner ?? (await nostrStore.fetchContactPreviewByPublicKey(ownerPublicKey, fallbackName));

  if (requestId !== groupOwnerLookupRequestId) {
    return;
  }

  if (!ownerPreview) {
    groupOwnerMember.value = {
      public_key: ownerPublicKey,
      name: fallbackName,
      given_name: null
    };
    return;
  }

  groupOwnerMember.value = buildStoredGroupMember(
    ownerPreview,
    null,
    ownerPreview.meta?.nprofile?.trim() ?? null,
    ownerPreview.meta?.nip05?.trim() ?? null
  );
}

function isGroupOwnerPublicKey(publicKey: string): boolean {
  return groupOwnerPublicKey.value.length > 0 && publicKey.trim().toLowerCase() === groupOwnerPublicKey.value;
}

function isGroupOwnerMember(member: GroupMemberDraft): boolean {
  return isGroupOwnerPublicKey(member.public_key);
}

function memberDisplayName(member: GroupMemberDraft): string {
  const givenName = member.given_name?.trim();
  if (givenName) {
    return givenName;
  }

  return member.name || member.public_key;
}

function memberAvatar(member: GroupMemberDraft): string {
  return member.avatar?.trim() || buildAvatarText(memberDisplayName(member) || member.public_key);
}

function memberPictureUrl(member: GroupMemberDraft): string {
  return member.picture?.trim() || '';
}

function memberListCandidates(member: GroupMemberDraft): string[] {
  const npub = nostrStore.encodeNpub(member.public_key) || '';
  const storedIdentifier = member.nip05?.trim() || member.nprofile?.trim() || '';

  return [member.name.trim(), member.about?.trim() ?? '', storedIdentifier, npub].filter((value) => value.length > 0);
}

function isLoggedInMember(member: GroupMemberDraft): boolean {
  const loggedInPubkey = nostrStore.getLoggedInPublicKeyHex();
  if (!loggedInPubkey) {
    return false;
  }

  return member.public_key.trim().toLowerCase() === loggedInPubkey;
}

function memberPubkeySnippet(member: GroupMemberDraft): string {
  return member.public_key.trim().slice(0, 32);
}

function memberListTitle(member: GroupMemberDraft): string {
  if (isLoggedInMember(member)) {
    return t('common.self');
  }

  return memberListCandidates(member)[0] ?? memberPubkeySnippet(member);
}

function memberListCaption(member: GroupMemberDraft): string {
  const candidates = memberListCandidates(member);
  if (isLoggedInMember(member)) {
    return candidates[0] ?? '';
  }

  return candidates[1] ?? '';
}

function mapContactToProfile(contact: ContactRecord): ContactProfileForm {
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

function handleOpenChat(): void {
  try {
    if (!normalizedHeaderPubkey.value) {
      return;
    }

    emit('open-chat');
  } catch (error) {
    reportUiError('Failed to open chat from contact profile', error);
  }
}

function handleOpenMemberProfile(member: GroupMemberDraft): void {
  try {
    const publicKey = member.public_key.trim();
    if (!publicKey) {
      return;
    }

    void router.push({ name: 'contacts', params: { pubkey: publicKey } });
  } catch (error) {
    reportUiError('Failed to open group member profile', error);
  }
}

function handleOpenShareDialog(): void {
  try {
    if (!shareNostrAddress.value) {
      return;
    }

    isShareDialogOpen.value = true;
  } catch (error) {
    reportUiError('Failed to open contact share dialog', error, t('errors.failedOpenShareDialog'));
  }
}

function closeShareDialog(isOpen = false): void {
  if (isOpen) {
    return;
  }

  isShareDialogOpen.value = false;
}

async function copyText(value: string): Promise<void> {
  const text = value.trim();
  if (!text) {
    return;
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === 'undefined') {
    throw new Error(t('common.clipboardAvailable'));
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'absolute';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

async function handleCopyProfileValue(value: string, label: string): Promise<void> {
  try {
    await copyText(value);
    $q.notify({
      type: 'positive',
      message: t('common.copiedLabel', { label }),
      position: 'top'
    });
  } catch (error) {
    reportUiError(
      `Failed to copy ${label.toLowerCase()}`,
      error,
      `Failed to copy ${label.toLowerCase()}.`
    );
  }
}

async function refreshContactProfileFromPubkey(input: string): Promise<void> {
  const refreshRequest = ++refreshRequestId;
  const normalizedPubkey = normalizePubkeyInput(input);

  if (!input.trim() || !normalizedPubkey) {
    await loadContactFromPubkey(input);
    return;
  }

  isRefreshingContact.value = true;
  pubkeyError.value = '';
  pubkeyInfo.value = '';

  try {
    await nostrStore.refreshContactByPublicKey(normalizedPubkey, headerName.value, {
      refreshRelayList: true
    });
    if (
      refreshRequest !== refreshRequestId ||
      normalizePubkeyInput(props.pubkey ?? '') !== normalizedPubkey
    ) {
      return;
    }
    await loadContactFromPubkey(normalizedPubkey);
  } catch (error) {
    reportUiError('Failed to refresh profile', error, t('errors.failedRefreshProfile'));
    pubkeyError.value =
      error instanceof Error ? error.message : t('errors.failedRefreshContactProfile');
    pubkeyInfo.value = '';
  } finally {
    if (refreshRequest === refreshRequestId) {
      isRefreshingContact.value = false;
    }
  }
}

async function handleRefreshContactProfile(): Promise<void> {
  if (isRefreshingContact.value) {
    return;
  }

  await refreshContactProfileFromPubkey(localPubkey.value);
}

function isSameProfile(a: ContactProfileForm, b: ContactProfileForm): boolean {
  return (
    a.name === b.name &&
    a.about === b.about &&
    a.picture === b.picture &&
    a.nip05 === b.nip05 &&
    a.lud06 === b.lud06 &&
    a.lud16 === b.lud16 &&
    a.display_name === b.display_name &&
    a.website === b.website &&
    a.banner === b.banner &&
    a.bot === b.bot &&
    a.group === b.group &&
    a.birthday.year === b.birthday.year &&
    a.birthday.month === b.birthday.month &&
    a.birthday.day === b.birthday.day &&
    a.relays.length === b.relays.length &&
    a.relays.every((relay, index) => relay === b.relays[index]) &&
    a.sendMessagesToAppRelays === b.sendMessagesToAppRelays
  );
}

async function loadContactFromPubkey(input: string): Promise<void> {
  const requestId = ++lookupRequestId;
  const normalizedPubkey = normalizePubkeyInput(input);

  if (!input.trim()) {
    currentContact.value = null;
    currentGroupChat.value = null;
    isLoadingContact.value = false;
    pubkeyError.value = '';
    pubkeyInfo.value = '';
    return;
  }

  if (!normalizedPubkey) {
    currentContact.value = null;
    currentGroupChat.value = null;
    isLoadingContact.value = false;
    pubkeyError.value = t('contacts.validation.hexPubkeyOrNpub');
    pubkeyInfo.value = '';
    return;
  }

  isLoadingContact.value = true;
  pubkeyError.value = '';
  pubkeyInfo.value = '';

  try {
    await Promise.all([contactsService.init(), chatDataService.init()]);
    const [contact, groupChat] = await Promise.all([
      contactsService.getContactByPublicKey(normalizedPubkey),
      chatDataService.getChatByPublicKey(normalizedPubkey)
    ]);
    if (requestId !== lookupRequestId) {
      return;
    }

    if (!contact) {
      currentContact.value = null;
      currentGroupChat.value = null;
      pubkeyInfo.value = t('contacts.contactFoundPublicKey');
      return;
    }

    currentContact.value = contact;
    currentGroupChat.value = groupChat;
    Object.assign(localProfile, mapContactToProfile(contact));
  } catch (error) {
    if (requestId !== lookupRequestId) {
      return;
    }

    currentContact.value = null;
    currentGroupChat.value = null;
    pubkeyError.value = error instanceof Error ? error.message : t('errors.failedLoadContact');
    pubkeyInfo.value = '';
  } finally {
    if (requestId === lookupRequestId) {
      isLoadingContact.value = false;
    }
  }
}

async function refreshCurrentGroupChat(input: string): Promise<void> {
  const normalizedPubkey = normalizePubkeyInput(input);
  if (!normalizedPubkey) {
    currentGroupChat.value = null;
    return;
  }

  await chatDataService.init();
  const groupChat = await chatDataService.getChatByPublicKey(normalizedPubkey);
  if (normalizePubkeyInput(props.pubkey ?? '') !== normalizedPubkey) {
    return;
  }

  currentGroupChat.value = groupChat;
}
</script>

<style scoped>
.contact-profile {
  flex: 1 1 auto;
  width: 100%;
  min-height: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: transparent;
}

.profile-content {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.profile-content--with-header {
  padding: 12px;
}

.profile-warning-banner {
  border: 1px solid color-mix(in srgb, var(--q-warning) 28%, var(--nc-border) 72%);
  background: color-mix(in srgb, var(--q-warning) 10%, var(--nc-panel-thread-bg) 90%);
  color: var(--nc-text);
}

.profile-tabs-shell {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  gap: 12px;
}

.profile-tabs-shell--mobile {
  justify-content: space-between;
}

.profile-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--nc-border);
  background: var(--nc-panel-header-bg);
}

.profile-header__identity {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  cursor: pointer;
}

.profile-header__identity--disabled {
  cursor: default;
}

.profile-header__meta {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.profile-header__name {
  font-weight: 600;
  color: var(--nc-text);
}

.profile-header__subtitle {
  font-size: 12px;
  color: var(--nc-text-secondary);
  opacity: 1;
}

.profile-header__action {
}

body.body--dark .profile-header__action {
  color: var(--nc-text-secondary) !important;
}

.profile-tabs {
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--nc-border) 88%, #8ea4c0 12%);
  background: color-mix(in srgb, var(--nc-panel-header-bg) 92%, rgba(255, 255, 255, 0.08));
}

.profile-tab-panels {
  background: transparent;
  flex: 1 1 auto;
  min-height: 0;
}

.profile-tab-panels--mobile {
  padding-bottom: 4px;
}

.profile-tab-panel {
  padding: 0;
}

.profile-tab-panels--mobile :deep(.q-panel) {
  min-height: 100%;
}

.profile-tab-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.profile-tab-actions__button {
  flex-shrink: 0;
}

.profile-lookup {
  display: grid;
  gap: 6px;
}

.profile-lookup__format-toggle {
  cursor: pointer;
  min-height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  user-select: none;
}

.profile-lookup__pubkey-input :deep(.q-field__prepend) {
  align-items: center;
  padding-right: 6px;
}

.profile-lookup__pubkey-input {
  width: 100%;
}

.profile-lookup--with-header {
  margin-top: 0;
}

.profile-sections {
  border-radius: 12px;
  background: color-mix(in srgb, var(--nc-sidebar) 92%, transparent);
}

.profile-sections :deep(.q-expansion-item + .q-expansion-item) {
  border-top: 1px solid var(--nc-border);
}

.profile-section__content {
  margin: 6px 12px 12px;
  padding: 12px 14px 14px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--nc-sidebar) 88%, var(--nc-border) 12%);
}

.profile-card {
  background: color-mix(in srgb, var(--nc-sidebar) 92%, transparent);
}

.profile-card__section {
  display: grid;
  gap: 6px;
}

.profile-card__title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 4px;
  color: var(--nc-text);
}

.profile-card__title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.profile-card__title-row .profile-card__title {
  margin-bottom: 0;
}

.profile-card__subtitle {
  font-size: 14px;
  font-weight: 600;
  color: var(--nc-text);
}

.profile-card__bot-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.profile-card__birthday-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.profile-members-state {
  padding: 18px 16px;
  border: 1px solid color-mix(in srgb, var(--nc-border) 88%, #8ea4c0 12%);
  border-radius: 14px;
  background: color-mix(in srgb, var(--nc-panel-sidebar-bg) 94%, rgba(255, 255, 255, 0.04));
  display: grid;
  gap: 8px;
}

.profile-members-state__title {
  font-size: 16px;
  font-weight: 700;
  color: var(--nc-text);
}

.profile-members-section-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--nc-text);
}

.profile-members {
  display: flex;
  flex-direction: column;
}

.profile-group-relays {
  display: flex;
  flex-direction: column;
}

.profile-epochs {
  display: flex;
  flex-direction: column;
}

.profile-epochs-table td:nth-child(2),
.profile-epochs-table th:nth-child(2) {
  word-break: break-all;
}

.profile-members-toolbar {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}

.profile-members-toolbar__input {
  flex: 1 1 auto;
  min-width: 0;
}

.profile-members-pending {
  display: grid;
  gap: 10px;
}

.profile-members-list {
  border-radius: 14px;
  background: color-mix(in srgb, var(--nc-sidebar) 92%, transparent);
}

.profile-members-list__item {
  min-height: 64px;
}

.profile-members-list__headline {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.profile-members-list__name {
  font-weight: 600;
  color: var(--nc-text);
}

.profile-members-list__badge {
  flex-shrink: 0;
}

.profile-members-list__caption {
  word-break: break-word;
  color: var(--nc-text-secondary);
}

.profile-member-delivery {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  min-width: 0;
}

.profile-member-delivery__epoch {
  flex-shrink: 0;
}

.profile-member-delivery__status-hitbox {
  display: inline-flex;
  flex: 0 0 auto;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.profile-member-delivery__status-hitbox:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--q-primary) 58%, transparent);
  outline-offset: 3px;
  border-radius: 999px;
}

.profile-member-delivery__status {
  display: inline-flex;
  align-items: center;
  width: 28px;
  height: 6px;
  border-radius: 999px;
  overflow: hidden;
  background: color-mix(in srgb, var(--nc-text-secondary) 16%, transparent);
  box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.08);
}

.profile-member-delivery__status-segment {
  height: 100%;
}

.profile-member-delivery__status-segment--green {
  background: #27c281;
}

.profile-member-delivery__status-segment--red {
  background: #f05656;
}

.profile-member-delivery__status-segment--gray {
  background: color-mix(in srgb, var(--nc-text-secondary) 45%, transparent);
}

.profile-member-delivery__dialog-empty {
  color: var(--nc-text-secondary);
}

.profile-member-delivery__dialog-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.profile-member-delivery__dialog-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.profile-member-delivery__dialog-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}

.profile-member-delivery__dialog-item-main {
  display: inline-flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  flex: 1 1 auto;
}

.profile-member-delivery__status-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  margin-top: 4px;
  flex-shrink: 0;
}

.profile-member-delivery__status-dot--green {
  background: #27c281;
}

.profile-member-delivery__status-dot--red {
  background: #f05656;
}

.profile-member-delivery__status-dot--gray {
  background: color-mix(in srgb, var(--nc-text-secondary) 50%, transparent);
}

.profile-member-delivery__dialog-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.profile-member-delivery__dialog-relay {
  word-break: break-word;
  color: var(--nc-text);
}

.profile-member-delivery__dialog-detail {
  word-break: break-word;
  color: var(--nc-text-secondary);
  font-size: 0.84rem;
}

.profile-member-delivery__dialog-retry {
  flex-shrink: 0;
}

.profile-member-delivery__dialog-retry-all {
  flex-shrink: 0;
  min-height: 28px;
}

.profile-members-list__actions {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  padding-left: 8px;
}

:deep(.profile-share-dialog__body) {
  padding: 12px 14px 14px;
}

.profile-share {
  display: grid;
  gap: 12px;
}

.profile-share__qr-shell {
  display: flex;
  justify-content: center;
  padding: 2px 0 0;
}

.profile-share__qr {
  width: min(100%, 336px);
  height: auto;
  border-radius: 22px;
  border: 1px solid color-mix(in srgb, var(--nc-border) 86%, #d8e2f0 14%);
  background: #fff;
  padding: 12px;
  box-shadow: 0 14px 32px rgba(15, 23, 42, 0.12);
}

.profile-share__address {
  width: 100%;
}

.mobile-nav {
  position: sticky;
  bottom: 0;
  z-index: 3;
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--nc-sidebar) 78%, transparent), var(--nc-sidebar));
  border-top: 1px solid color-mix(in srgb, var(--nc-border) 84%, #6b7d96 16%);
  padding-bottom: env(safe-area-inset-bottom);
  backdrop-filter: blur(var(--nc-glass-blur-strong));
}

.mobile-nav__inner {
  display: grid;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 5px;
}

.mobile-nav__btn {
  color: #55697f;
  border-radius: 12px;
  min-height: 42px;
  padding: 0 8px;
  border: 1px solid color-mix(in srgb, var(--nc-border) 74%, transparent);
  background: color-mix(in srgb, var(--nc-sidebar) 90%, #eef5ff 10%);
  transition:
    transform 0.2s ease,
    background-color 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    color 0.2s ease;
}

.mobile-nav__btn :deep(.q-btn__content) {
  gap: 5px;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.01em;
}

.mobile-nav__btn :deep(.q-icon) {
  font-size: 18px;
}

.mobile-nav__btn:hover {
  transform: translateY(-1px);
  border-color: color-mix(in srgb, var(--nc-border) 72%, #6d8db8 28%);
  background: color-mix(in srgb, var(--nc-sidebar) 82%, #dce9ff 18%);
}

.mobile-nav__btn--active {
  border-color: rgba(33, 110, 236, 0.68);
  box-shadow: 0 8px 18px rgba(30, 102, 214, 0.24);
}

body.body--dark .mobile-nav__btn {
  color: var(--nc-text-secondary);
  border-color: color-mix(in srgb, var(--nc-border) 72%, transparent);
  background: color-mix(in srgb, var(--nc-sidebar) 90%, #102035 10%);
}

body.body--dark .mobile-nav__btn--active {
  border-color: rgba(128, 193, 255, 0.62);
  box-shadow: 0 10px 20px rgba(0, 0, 0, 0.38);
}

@media (max-width: 640px) {
  :deep(.profile-share-dialog__body) {
    padding: 6px 8px 10px;
  }

  .profile-share {
    gap: 8px;
  }

  .profile-share__qr-shell {
    padding: 0;
  }

  .profile-share__qr {
    width: 100%;
    border-radius: 18px;
    padding: 8px;
  }

  .profile-card__birthday-grid {
    grid-template-columns: 1fr;
  }

  .profile-members-toolbar {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
