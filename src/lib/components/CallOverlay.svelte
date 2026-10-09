<script lang="ts">
  import { syncAndroidCallActivity } from '#src/services/androidCallNotificationService.ts';
  import { dismissOnBackdrop } from '#src/lib/actions/dismissOnBackdrop.ts';
  import { onMount, onDestroy } from 'svelte';
  import { useCallStore } from '#src/stores/callStore.ts';
  import { useCallRoomStore } from '#src/stores/callRoomStore.ts';
  import { useNostrStore } from '#src/stores/nostrStore.ts';
  import { contactsService } from '#src/services/contactsService.ts';
  import { canShareCallScreen, callMediaSupported } from '#src/services/callMediaService.ts';
  import { createCallRingtone } from '#src/services/callRingtone.ts';
  import { observeCallActivity } from '#src/services/callActivityService.ts';
  import { createActiveSpeakerSelector } from '#src/utils/callActiveSpeaker.ts';
  import { observe } from '#src/lib/state/store.ts';
  import { translate } from '#src/i18n.ts';
  import { Notify } from '#src/lib/platform/ui.ts';
  import CallRelayPrompt from './CallRelayPrompt.svelte';
  import Icon from './Icon.svelte';
  import Avatar from './Avatar.svelte';
  import { observePublicProfile } from '#src/lib/state/publicProfiles.ts';
  import { avatarColor } from '#src/utils/avatarText.ts';
  import { callDialogFocus } from '#src/lib/platform/callDialogFocus.ts';
  import CallAudio from './CallAudio.svelte';
  import CallVideo from './CallVideo.svelte';
  import CallStage from './CallStage.svelte';
  import CallControlsTray from './CallControlsTray.svelte';
  import CallDeviceMenu from './CallDeviceMenu.svelte';
  const calls = useCallStore(),
    rooms = useCallRoomStore();
  const state = observe(() => ({
    session: calls.session,
    room: rooms.session,
    busy: rooms.busy,
    local: rooms.session ? rooms.localStream : calls.localStream,
    localScreen: rooms.session ? rooms.localScreenStream : calls.localScreenStream,
    remote: calls.remoteMediaUrl,
    video: calls.remoteVideoUrl,
    screen: calls.remoteScreenUrl,
    error: rooms.session ? rooms.error : calls.error || rooms.error,
    deviceError: rooms.session ? '' : calls.deviceError,
    participants: rooms.participants,
    link: rooms.shareLink,
    muted: rooms.session ? rooms.microphoneMuted : calls.session?.microphoneMuted,
    cameraMuted: rooms.session ? rooms.cameraMuted : calls.session?.cameraMuted,
    microphone: rooms.session ? rooms.microphoneDeviceId : calls.microphoneDeviceId,
    camera: rooms.session ? rooms.cameraDeviceId : calls.cameraDeviceId,
    changing: rooms.session ? rooms.changingMedia : calls.changingMedia,
  }));
  $: syncAndroidCallActivity(
    useNostrStore().getLoggedInPublicKeyHex(),
    $state.session,
    $state.busy,
  );
  let stage: CallStage;
  let remoteVideo: CallVideo;
  let minimized = false,
    maxFill = false,
    speakerView = false;
  let speakerMuted = false,
    speaker = '',
    outputError = '',
    playbackBlocked = false;
  let invite = false,
    showInviteLink = false,
    inviteError = '';
  let devices: MediaDeviceInfo[] = [];
  let names: Record<string, string> = {};
  let now = Date.now();
  let disposed = false;
  let nameGeneration = 0;
  let namesSignature = '';
  let activityStream: MediaStream | null = null,
    activityEnabled = false;
  let previousId = '';
  const ringtone = createCallRingtone();
  const levels = new Map<string, number>();
  let selector = createActiveSpeakerSelector(),
    activeSpeaker = 'local';
  let stopActivity: (() => void) | undefined;
  const canShareScreen = canShareCallScreen();
  const canSelectSpeaker = typeof HTMLMediaElement.prototype.setSinkId === 'function';
  const outputs = navigator.mediaDevices as MediaDevices & {
    selectAudioOutput?: () => Promise<MediaDeviceInfo>;
  };
  $: room = Boolean($state.room);
  $: peerKey = $state.session?.peerPubkey ?? '';
  $: peerProfile = observePublicProfile(peerKey);
  $: peerNpub = peerKey ? useNostrStore().encodeNpub(peerKey) : '';
  $: peerName = $state.session?.peerName || $peerProfile?.name || peerNpub;
  $: peerColor = avatarColor(peerName);
  let failedPicture = '';
  $: peerPicture = $peerProfile?.picture ?? '';
  $: prefix = room ? 'room' : 'call';
  $: phase = $state.room?.phase ?? $state.session?.phase;
  $: active = phase === 'active';
  $: hangupLabel = $translate(
    !room && $state.session?.direction === 'outgoing' && !active ? 'common.cancel' : 'call.hangup',
  );
  $: ended = phase === 'ended';
  $: runtime = room ? rooms : calls;
  $: audioUrl =
    !room && ($state.session?.mediaVersion === 2 || $state.session?.mode === 'audio')
      ? $state.remote
      : '';
  $: videoUrl = !room
    ? $state.video ||
      ($state.session?.mediaVersion !== 2 && $state.session?.mode === 'video' ? $state.remote : '')
    : '';
  $: hasVideo = Boolean(videoUrl || (!$state.cameraMuted && $state.local?.getVideoTracks().length));
  $: canCamera = Boolean(
    $state.local &&
    active &&
    (room
      ? callMediaSupported('video')
      : $state.session?.mediaVersion === 2
        ? $state.session.videoAvailable
        : $state.session?.mode === 'video'),
  );
  $: canMinimize = room ? $state.busy : ['active', 'connecting', 'outgoing'].includes(phase ?? '');
  $: focusedSpeaker = $state.participants.some((peer) => peer.pubkey === activeSpeaker)
    ? activeSpeaker
    : 'local';
  $: screens = [
    ...(room
      ? $state.participants
          .filter((peer) => peer.screenUrl)
          .map((peer) => ({ id: peer.pubkey, name: names[peer.pubkey] || '', url: peer.screenUrl }))
      : $state.screen
        ? [{ id: 'remote', name: $state.session?.peerName || '', url: $state.screen }]
        : []),
    ...($state.localScreen
      ? [{ id: 'local', name: $translate('call.yourScreen'), stream: $state.localScreen }]
      : []),
  ];
  $: status = room
    ? $translate(`room.phase.${phase || 'preparing'}`)
    : active && $state.session?.startedAt
      ? duration(now - Date.parse($state.session.startedAt))
      : $translate(
          phase === 'outgoing' && !$state.session?.peerConfirmed
            ? 'call.phase.checkingSupport'
            : ended
              ? `call.ended.${$state.session?.endReason}`
              : `call.phase.${phase}`,
        );
  $: resetSession($state.room?.own.sessionId ?? $state.session?.id ?? '');
  $: ringtone.setRinging(!room && (phase === 'incoming' || phase === 'outgoing'));
  $: if (ended) minimized = false;
  $: if (!$state.busy) invite = false;
  $: if ($state.local) void refreshDevices();
  $: watchActivity($state.local, speakerView && room && !$state.muted);
  $: void resolveNames($state.room?.members ?? []);
  function duration(ms: number) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function resetSession(id: string) {
    if (id === previousId) return;
    previousId = id;
    minimized = maxFill = speakerView = speakerMuted = playbackBlocked = false;
    outputError = '';
    invite = false;
    levels.clear();
    selector = createActiveSpeakerSelector();
    activeSpeaker = 'local';
  }
  function updateLevel(id: string, level: number) {
    levels.set(id, level);
    for (const key of levels.keys())
      if (key !== 'local' && !$state.participants.some((peer) => peer.pubkey === key))
        levels.delete(key);
    activeSpeaker = selector(levels, performance.now());
  }
  function watchActivity(stream: MediaStream | null, enabled: boolean) {
    if (stream === activityStream && enabled === activityEnabled) return;
    activityStream = stream;
    activityEnabled = enabled;
    stopActivity?.();
    stopActivity = undefined;
    updateLevel('local', 0);
    if (stream && enabled)
      stopActivity = observeCallActivity(stream, (level) => updateLevel('local', level));
  }
  async function resolveNames(members: Array<{ pubkey: string; relays: string[] }>) {
    const signature = JSON.stringify(members);
    if (signature === namesSignature) return;
    namesSignature = signature;
    const generation = ++nameGeneration;
    names = {};
    for (const member of members)
      void (async () => {
        try {
          const cached = await contactsService.getContactByPublicKey(member.pubkey);
          if (generation === nameGeneration && !disposed)
            names = { ...names, [member.pubkey]: cached?.meta.nip05?.trim() || '' };
          const profile = await useNostrStore().fetchUserProfileFromRelays(
            member.pubkey,
            member.relays,
          );
          if (profile && generation === nameGeneration && !disposed)
            names = { ...names, [member.pubkey]: profile.nip05?.trim() || '' };
        } catch {
          /* Keep cached identity when relay lookup fails. */
        }
      })();
  }
  async function act(fn: () => unknown) {
    try {
      await fn();
    } catch (error) {
      outputError = error instanceof Error ? error.message : String(error);
    }
  }
  async function refreshDevices(recover = false) {
    try {
      const next = await navigator.mediaDevices?.enumerateDevices();
      if (!next || disposed) return;
      devices = next.filter(
        (device) =>
          device.deviceId && (device.kind !== 'audiooutput' || device.deviceId !== 'default'),
      );
      if (
        recover &&
        speaker &&
        !devices.some((d) => d.kind === 'audiooutput' && d.deviceId === speaker)
      )
        speaker = '';
      if (
        recover &&
        $state.microphone &&
        devices.some((d) => d.kind === 'audioinput') &&
        !devices.some((d) => d.kind === 'audioinput' && d.deviceId === $state.microphone)
      )
        await runtime.selectMicrophone('');
    } catch {
      /* Denied enumeration does not stop working media. */
    }
  }
  async function requestSpeaker() {
    try {
      const device = await outputs.selectAudioOutput?.();
      if (device && !disposed) {
        speaker = device.deviceId;
        await refreshDevices();
      }
    } catch {
      outputError = 'call.error.speakerPermission';
    }
  }
  async function toggleScreen() {
    if ($state.localScreen) {
      await runtime.stopScreenSharing();
      return;
    }
    const capture = runtime.startScreenSharing();
    if (!room) {
      stage?.openWindow();
      window.focus();
    }
    await capture;
    if (!room) stage?.focusWindow();
  }
  function openInvite() {
    showInviteLink = false;
    inviteError = '';
    invite = true;
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText($state.link);
      Notify.create($translate('room.linkCopied'));
    } catch {
      inviteError = 'room.copyManually';
      showInviteLink = true;
    }
  }
  function dismiss() {
    if (room) rooms.dismiss();
    else {
      calls.dismiss();
      if (!calls.session) rooms.dismiss();
    }
  }
  onMount(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    const changed = () => void refreshDevices(true);
    navigator.mediaDevices?.addEventListener('devicechange', changed);
    return () => {
      clearInterval(timer);
      navigator.mediaDevices?.removeEventListener('devicechange', changed);
    };
  });
  onDestroy(() => {
    disposed = true;
    nameGeneration++;
    ringtone.dispose();
    stopActivity?.();
    calls.reset();
    rooms.reset();
  });
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Escape' && invite) invite = false;
  }}
/>
<div class="call-audio-recovery-container">
  <CallAudio
    primary
    url={audioUrl}
    muted={speakerMuted}
    sink={speaker}
    onoutputerror={() => (outputError = 'call.error.speaker')}
  />
  {#each $state.participants as peer (`${peer.pubkey}:${peer.sessionId}`)}<CallAudio
      url={peer.audioUrl}
      name={names[peer.pubkey] || ''}
      testid={`room-audio-${peer.pubkey}`}
      muted={speakerMuted}
      sink={speaker}
      activity={speakerView && !peer.microphoneMuted}
      onlevel={(level) => updateLevel(peer.pubkey, level)}
      onoutputerror={() => (outputError = 'call.error.speaker')}
    />{/each}
</div>
{#if $state.session || $state.room}
  <div
    tabindex="-1"
    use:callDialogFocus={!minimized}
    inert={minimized}
    class="call-panel"
    class:call-panel--minimized={minimized}
    class:call-panel--fill={maxFill}
    class:room-panel={room}
    class:call-panel--voice={!room && !hasVideo && !screens.length}
    style:--call-peer-color={peerColor}
    role="dialog"
    aria-modal={!minimized}
    aria-label={room ? $translate('room.title') : $state.session?.peerName}
    data-testid={room ? 'room-panel' : 'call-panel'}
  >
    {#if !room}<div class="call-backdrop" aria-hidden="true">
        {#if peerPicture && peerPicture !== failedPicture}<img
            src={peerPicture}
            alt=""
            referrerpolicy="no-referrer"
            onerror={(event) => (failedPicture = event.currentTarget.getAttribute('src') ?? '')}
          />{/if}
      </div>
      <header class="call-panel__header">
        {$translate(hasVideo || $state.session?.mode === 'video' ? 'call.video' : 'call.audio')}
      </header>
      <div class="call-panel__identity">
        <Icon name={hasVideo || $state.session?.mode === 'video' ? 'video' : 'phone'} />
        <div class="call-peer-avatar">
          <Avatar name={peerName} publicKey={peerKey} size={104} eager />
        </div>
        <h2>{peerName}</h2>
        <div class="call-peer-npub" title={peerNpub} data-testid="call-peer-npub">{peerNpub}</div>
        <div role="status" aria-live="polite" data-testid="call-status">{status}</div>
      </div>{:else}<div role="status" class:room-status--hidden={active} data-testid="room-status">
        {status}
      </div>{/if}
    <CallStage
      bind:this={stage}
      active={!ended}
      {screens}
      {maxFill}
      onblocked={() => (outputError = 'call.error.popup')}
    >
      {#if room}
        <div
          class="room-grid"
          class:room-grid--fill={maxFill}
          class:room-grid--sharing={screens.length > 0}
          class:room-grid--speaker={speakerView &&
            !screens.length &&
            $state.participants.length > 0}
          style={`--sidebar-count:${Math.max(1, $state.participants.length)};--gallery-columns:${Math.ceil(Math.sqrt($state.participants.length + 1))};--gallery-rows:${Math.ceil(($state.participants.length + 1) / Math.ceil(Math.sqrt($state.participants.length + 1)))}`}
        >
          {#if $state.local}<div
              class="room-tile"
              class:room-tile--speaker={focusedSpeaker === 'local'}
            >
              {#if !$state.cameraMuted}<CallVideo
                  stream={$state.local}
                  label={$translate('You')}
                />{:else}<div class="call-person"><Icon name="person" /></div>{/if}
              {#if names[$state.room?.own.pubkey || '']}<div
                  class="room-tile__overlay"
                  class:room-tile__overlay--muted={$state.muted}
                >
                  {names[$state.room?.own.pubkey || '']}
                </div>{/if}
              {#if $state.muted}<span
                  class="room-tile__mute"
                  aria-label={$translate('call.microphoneMuted')}
                  role="img"
                  data-testid="room-local-muted"><Icon name="mic-off" /></span
                >{/if}
            </div>{/if}
          {#each $state.participants as peer (`${peer.pubkey}:${peer.sessionId}`)}<div
              class="room-tile"
              class:room-tile--speaker={focusedSpeaker === peer.pubkey}
              data-testid={`room-peer-${peer.pubkey}`}
            >
              {#if peer.videoUrl}<CallVideo
                  url={peer.videoUrl}
                  label={names[peer.pubkey] || peer.name}
                />{:else}<div class="call-person"><Icon name="person" /></div>{/if}
              {#if names[peer.pubkey] || peer.phase !== 'active'}<div
                  class="room-tile__overlay"
                  class:room-tile__overlay--muted={peer.microphoneMuted}
                >
                  {names[peer.pubkey] || ''}
                  {peer.phase !== 'active'
                    ? $translate(
                        peer.phase === 'ended' ? 'call.ended.failed' : 'call.phase.connecting',
                      )
                    : ''}
                </div>{/if}
              {#if peer.microphoneMuted}<span
                  class="room-tile__mute"
                  aria-label={$translate('call.microphoneMuted')}
                  role="img"
                  data-testid="room-peer-muted"><Icon name="mic-off" /></span
                >{/if}
            </div>{/each}
        </div>
      {:else if hasVideo}<div class="call-panel__media">
          {#if videoUrl}<div class="call-panel__remote">
              <CallVideo
                bind:this={remoteVideo}
                url={videoUrl}
                muted={$state.session?.mediaVersion === 2 || speakerMuted}
                sink={speaker}
                label="Remote camera"
                testid="call-remote-media"
                onblocked={(blocked) =>
                  (playbackBlocked = $state.session?.mediaVersion !== 2 && blocked)}
                onoutputerror={() => (outputError = 'call.error.speaker')}
              />
            </div>{/if}
          {#if $state.local?.getVideoTracks().length && !$state.cameraMuted}<div
              class="call-panel__local"
            >
              <CallVideo stream={$state.local} label="Your camera" />
            </div>{/if}
        </div>{/if}
    </CallStage>
    {#if !room && (screens.length || hasVideo)}<button
        class="call-text-button"
        data-testid="call-open-window"
        onclick={() => stage?.openWindow()}
        ><Icon name="popout" />{$translate('call.presentationWindow')}</button
      >{/if}
    {#if playbackBlocked}<button data-testid="call-play-audio" onclick={() => remoteVideo?.play()}
        >{$translate('call.playAudio')}</button
      >{/if}
    {#if $state.error || $state.deviceError || outputError}<div
        class="call-panel__error"
        role="alert"
      >
        {$translate($state.error || $state.deviceError || outputError)}
      </div>{/if}
    {#if !ended}
      <CallControlsTray enabled={active} let:autoHide let:toggle>
        <div class="call-panel__controls" class:room-controls={room}>
          {#if room || hasVideo || screens.length}<button
              class="call-round"
              class:chosen={maxFill}
              title={$translate(maxFill ? 'call.fitMedia' : 'call.maxFill')}
              aria-label={$translate('call.maxFill')}
              aria-pressed={maxFill}
              data-testid={`${prefix}-max-fill`}
              onclick={() => (maxFill = !maxFill)}><Icon name="fill" /></button
            >{/if}
          {#if canMinimize}<button
              class="call-round flat"
              aria-label={$translate('call.minimize')}
              data-testid={`${prefix}-minimize`}
              onclick={() => (minimized = true)}><Icon name="minimize" /></button
            >{/if}
          {#if active}<button
              class="call-round"
              aria-label={$translate(autoHide ? 'call.keepControls' : 'call.hideControls')}
              title={$translate(autoHide ? 'call.keepControls' : 'call.hideControls')}
              data-testid={`${prefix}-hide-controls`}
              aria-pressed={autoHide}
              onclick={toggle}><Icon name={autoHide ? 'eye' : 'down'} /></button
            >{/if}
          {#if room}<button
              class="call-round"
              aria-label={$translate(speakerView ? 'room.galleryView' : 'room.speakerView')}
              data-testid="room-view-toggle"
              onclick={() => (speakerView = !speakerView)}
              ><Icon name={speakerView ? 'grid' : 'speaker-view'} /></button
            >{/if}
          {#if phase === 'incoming'}
            <button
              class="call-round danger call-primary-action"
              data-testid="call-decline"
              aria-label={$translate('call.decline')}
              onclick={() => act(() => calls.end())}
              ><Icon name="hangup" /><span class="call-action-label"
                >{$translate('call.decline')}</span
              ></button
            >
            <button
              class="call-answer audio call-primary-action"
              data-testid="call-accept"
              onclick={() => act(() => calls.accept('audio'))}
              ><Icon name="phone" /><span>{$translate('call.answerAudio')}</span></button
            >
            {#if $state.session?.mode === 'video'}<button
                class="call-answer call-primary-action"
                data-testid="call-accept-video"
                onclick={() => act(() => calls.accept('video'))}
                ><Icon name="video" /><span>{$translate('call.answerVideo')}</span></button
              >{/if}
          {:else}
            <div class="call-panel__device">
              <button
                class="call-round"
                class:danger={$state.muted}
                aria-label={$translate(
                  $state.muted ? 'call.unmuteMicrophone' : 'call.muteMicrophone',
                )}
                aria-pressed={Boolean($state.muted)}
                disabled={!$state.local}
                data-testid={`${prefix}-microphone`}
                onclick={() => act(() => runtime.toggleMicrophone())}
                ><Icon name={$state.muted ? 'mic-off' : 'mic'} /></button
              ><CallDeviceMenu
                kind="microphone"
                {prefix}
                devices={devices.filter((d) => d.kind === 'audioinput')}
                selected={$state.microphone}
                disabled={!active || $state.changing}
                supported={room || $state.session?.mediaVersion === 2}
                onrefresh={refreshDevices}
                onselect={(id) => act(() => runtime.selectMicrophone(id))}
              />
            </div>
            <div class="call-panel__device">
              <button
                class="call-round"
                class:danger={speakerMuted}
                aria-label={$translate(speakerMuted ? 'call.unmuteSpeaker' : 'call.muteSpeaker')}
                aria-pressed={speakerMuted}
                data-testid={`${prefix}-speaker`}
                onclick={() => (speakerMuted = !speakerMuted)}
                ><Icon name={speakerMuted ? 'speaker-off' : 'speaker'} /></button
              ><CallDeviceMenu
                kind="speaker"
                {prefix}
                devices={devices.filter((d) => d.kind === 'audiooutput')}
                selected={speaker}
                supported={canSelectSpeaker}
                canRequest={Boolean(outputs?.selectAudioOutput)}
                onrefresh={refreshDevices}
                onselect={(id) => {
                  outputError = '';
                  speaker = id;
                }}
                onrequest={requestSpeaker}
              />
            </div>
            <div class="call-panel__device">
              <button
                class="call-round"
                class:chosen={!$state.cameraMuted}
                aria-label={$translate(
                  $state.cameraMuted ? 'call.enableCamera' : 'call.disableCamera',
                )}
                title={!canCamera ? $translate('call.videoUnavailable') : undefined}
                aria-pressed={!$state.cameraMuted}
                disabled={!canCamera || $state.changing}
                data-testid={`${prefix}-camera`}
                onclick={() => act(() => runtime.toggleCamera())}
                ><Icon name={$state.cameraMuted ? 'video-off' : 'video'} /></button
              ><CallDeviceMenu
                kind="camera"
                {prefix}
                devices={devices.filter((d) => d.kind === 'videoinput')}
                selected={$state.camera}
                disabled={!canCamera ||
                  $state.changing ||
                  (!room && $state.session?.mediaVersion !== 2)}
                onrefresh={refreshDevices}
                onselect={(id) => act(() => runtime.selectCamera(id))}
              />
            </div>
            <button
              class="call-round"
              class:chosen={Boolean($state.localScreen)}
              aria-label={$translate($state.localScreen ? 'call.stopScreen' : 'call.shareScreen')}
              title={$translate(canShareScreen ? 'call.shareScreen' : 'call.screenUnavailable')}
              disabled={!active || !canShareScreen || (!room && !$state.session?.screenAvailable)}
              data-testid={`${prefix}-share-screen`}
              onclick={() => act(toggleScreen)}
              ><Icon name={$state.localScreen ? 'screen-off' : 'screen'} /></button
            >
            {#if room}<button
                class="call-round"
                aria-label={$translate('call.presentationWindow')}
                data-testid="room-open-window"
                onclick={() => stage?.openWindow()}><Icon name="popout" /></button
              >{#if $state.link}<button
                  class="call-round"
                  aria-label={$translate('room.invite')}
                  data-testid="room-invite"
                  onclick={openInvite}><Icon name="invite" /></button
                >{/if}{/if}
            <button
              class="call-round danger"
              class:call-hangup={!room}
              data-testid={room ? 'room-leave' : 'call-hangup'}
              aria-label={room ? $translate('room.leave') : hangupLabel}
              onclick={() => act(() => (room ? rooms.leave() : calls.end()))}
              ><Icon name="hangup" />{#if !room}<span class="call-action-label">{hangupLabel}</span
                >{/if}</button
            >
          {/if}
        </div>
      </CallControlsTray>
    {:else}<button
        class="call-answer dismiss"
        class:call-primary-action={!room}
        data-testid={`${prefix}-dismiss`}
        onclick={dismiss}
        >{#if !room}<span class="call-close-icon"><Icon name="hangup" /></span>{/if}<span
          >{$translate('common.close')}</span
        ></button
      >{/if}
  </div>
  {#if minimized && !ended}<div
      class="call-compact"
      data-testid={room ? 'room-compact' : 'call-compact'}
    >
      <button
        data-testid={`${prefix}-restore`}
        aria-label={$translate(room ? 'room.return' : 'call.restore')}
        onclick={() => (minimized = false)}
        ><Icon name={room ? 'group' : 'phone'} />{room
          ? $translate('room.return')
          : `${$state.session?.peerName} · ${status}`}</button
      ><button
        class="danger-text"
        aria-label={room ? $translate('room.leave') : hangupLabel}
        onclick={() => act(() => (room ? rooms.leave() : calls.end()))}
        ><Icon name="hangup" /></button
      >
    </div>{/if}
{:else if $state.error}<div
    class="call-error-dialog"
    role="dialog"
    aria-modal="true"
    aria-label={$translate('room.title')}
  >
    <p role="alert">{$translate($state.error)}</p>
    <button class="primary" data-testid="call-dismiss" onclick={dismiss}
      >{$translate('common.close')}</button
    >
  </div>{/if}
{#if invite && $state.busy}<div
    class="call-invite-backdrop"
    use:dismissOnBackdrop={() => (invite = false)}
  >
    <div
      tabindex="-1"
      use:callDialogFocus
      class="room-invite-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={$translate('room.invite')}
      data-testid="room-invite-dialog"
    >
      <header>
        <h2>{$translate('room.invite')}</h2>
        <button
          class="icon-button"
          aria-label={$translate('common.close')}
          data-testid="room-invite-close"
          onclick={() => (invite = false)}><Icon name="close" /></button
        >
      </header>
      <p>{$translate('room.inviteHint')}</p>
      {#if showInviteLink}<label
          >{$translate('room.link')}<input
            readonly
            value={$state.link}
            data-testid="room-link"
            onclick={(e) => e.currentTarget.select()}
          /></label
        >{:else}<p data-testid="room-link-hidden">
          {$translate('room.linkHidden')}
        </p>{/if}{#if inviteError}<p role="alert">{$translate(inviteError)}</p>{/if}<button
        class="primary"
        data-testid="room-copy-link"
        onclick={copyLink}>{$translate('room.copyLink')}</button
      ><button data-testid="room-toggle-link" onclick={() => (showInviteLink = !showInviteLink)}
        >{$translate(showInviteLink ? 'room.hideLink' : 'room.showLink')}</button
      >
    </div>
  </div>{/if}

<CallRelayPrompt />

<style>
  .call-action-label {
    display: none;
  }

  .call-panel--minimized {
    visibility: hidden;
    pointer-events: none;
  }
  .call-panel {
    width: 100%;
    height: 100dvh;
    max-width: 100%;
    max-height: 100dvh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: #000;
    color: #fff;
    border-radius: 0;
    padding: clamp(8px, 2vw, 20px);
  }
  .call-panel > :not(.call-stage) {
    flex-shrink: 0;
  }
  .call-panel__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: var(--nc-text-secondary);
  }
  .call-panel__identity {
    text-align: center;
    padding: 4px 0;
  }
  .call-panel__identity h2 {
    font-size: 1.5rem;
    line-height: 1.3;
    margin: 4px 0;
    overflow-wrap: anywhere;
  }
  .call-panel__media {
    position: relative;
    background: #000;
    height: 100%;
    min-height: 0;
    border-radius: 12px;
    overflow: hidden;
  }
  .call-panel__remote {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .call-panel__local {
    position: absolute;
    bottom: 12px;
    right: 12px;
    width: 28%;
    max-height: 35%;
    object-fit: contain;
    border-radius: 8px;
    transform: scaleX(-1);
  }
  .call-panel__controls {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: center;
    align-items: flex-start;
    padding: 8px 0 0;
  }
  .call-panel__device {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .call-panel__error {
    text-align: center;
    color: var(--q-negative);
    padding: 12px 0;
  }
  .call-compact {
    position: fixed;
    z-index: 6000;
    top: calc(env(safe-area-inset-top, 0px) + 12px);
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    max-width: calc(100vw - 24px);
    border-radius: 30px;
    box-shadow: var(--nc-shadow-md);
    background: var(--nc-panel-header-bg);
    color: var(--nc-text);
  }
  @media (max-width: 599px), (max-height: 500px) {
    .call-panel {
      padding: 8px;
      padding-top: max(8px, env(safe-area-inset-top));
      padding-bottom: max(8px, env(safe-area-inset-bottom));
    }
    .call-panel__identity > :global(svg) {
      display: none;
    }
    .call-panel__controls {
      gap: 4px;
    }
  }
  .call-panel.call-panel--fill {
    padding-left: 0;
    padding-right: 0;
  }

  .room-invite-dialog {
    width: min(480px, calc(100vw - 32px));
    max-width: 100%;
    background: var(--nc-panel-header-bg);
    color: var(--nc-text);
  }
  .room-panel {
    width: 100%;
    height: 100dvh;
    max-width: 100%;
    max-height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: clamp(8px, 2vw, 20px);
    padding-bottom: max(8px, env(safe-area-inset-bottom));
    background: #000;
    color: #fff;
  }
  .room-panel > :not(.call-stage) {
    flex-shrink: 0;
  }
  .room-status--hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .room-grid {
    height: 100%;
    min-height: 0;
    display: grid;
    grid-template-columns: repeat(var(--gallery-columns), minmax(0, 1fr));
    grid-auto-rows: minmax(0, 1fr);
    gap: 8px;
  }
  .room-tile {
    position: relative;
    min-width: 0;
    min-height: 0;
    background: transparent;
    color: #fff;
    border-radius: 0;
    overflow: hidden;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  }
  .room-tile :global(video),
  .room-tile :global(canvas) {
    flex: 1;
    min-height: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .room-tile__overlay {
    position: absolute;
    bottom: 0;
    left: 0;
    width: 100%;
    padding: 12px 8px 4px;
    background: linear-gradient(transparent, rgba(0, 0, 0, 0.7));
    text-align: left;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    pointer-events: none;
  }
  .room-tile__mute {
    position: absolute;
    bottom: 6px;
    left: 6px;
    z-index: 1;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.65);
    font-size: 16px;
  }
  .room-tile__overlay--muted {
    padding-left: 40px;
  }
  .room-grid--speaker {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
  }
  .room-grid--speaker .room-tile {
    flex: 0 1 auto;
    width: calc(25% - 6px);
    aspect-ratio: 16 / 9;
  }
  .room-grid--speaker .room-tile--speaker {
    position: absolute;
    inset: 0 auto 0 0;
    width: calc(75% - 2px);
    height: 100%;
    aspect-ratio: auto;
  }
  @media (max-width: 599px) {
    .room-grid--speaker {
      display: grid;
      grid-template-columns: repeat(var(--sidebar-count), minmax(0, 1fr));
      grid-template-rows: minmax(0, 3fr) minmax(0, 1fr);
    }
    .room-grid--speaker .room-tile {
      width: 100%;
      aspect-ratio: auto;
      grid-column: auto;
      grid-row: 2;
    }
    .room-grid--speaker .room-tile--speaker {
      position: static;
      width: 100%;
      height: auto;
      grid-column: 1 / -1;
      grid-row: 1;
    }
  }
  @media (min-width: 600px) {
    .room-grid--sharing {
      display: flex;
      flex-direction: column;
    }
    .room-grid--sharing .room-tile {
      flex: 0 1 auto;
      width: 100%;
      aspect-ratio: 16 / 9;
    }
  }
  .room-controls {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    padding: 8px 0 0;
  }
  @media (max-width: 599px), (max-height: 500px) {
    .room-controls {
      gap: 4px;
    }
  }
  .room-panel.call-panel--fill {
    padding: 0;
  }
  .call-panel--fill .room-controls {
    padding-bottom: max(8px, env(safe-area-inset-bottom));
  }
  .room-grid--fill {
    gap: 0;
  }
  .room-grid--fill:not(.room-grid--speaker):not(.room-grid--sharing) {
    display: flex;
    flex-wrap: wrap;
  }
  .room-grid--fill:not(.room-grid--speaker):not(.room-grid--sharing) .room-tile {
    flex: 1 1 calc(100% / var(--gallery-columns));
    height: calc(100% / var(--gallery-rows));
  }
  .room-grid--fill.room-grid--sharing {
    display: flex;
    flex-direction: column;
  }
  .room-grid--fill.room-grid--sharing .room-tile {
    flex: 1 1 0;
    width: 100%;
    aspect-ratio: auto;
  }
  @media (min-width: 600px) {
    .room-grid--fill.room-grid--speaker .room-tile {
      flex: 1 1 0;
      width: 25%;
      aspect-ratio: auto;
    }
    .room-grid--fill.room-grid--speaker .room-tile--speaker {
      width: 75%;
    }
  }
  @media (max-width: 599px) {
    .room-grid--fill.room-grid--sharing {
      flex-direction: row;
    }
    .room-grid--fill.room-grid--sharing .room-tile {
      width: 0;
      height: 100%;
    }
  }

  .call-panel {
    position: fixed;
    inset: 0;
    z-index: 1000;
    box-sizing: border-box;
  }
  .call-panel__remote :global(video),
  .call-panel__local :global(video),
  .call-panel__remote :global(canvas),
  .call-panel__local :global(canvas) {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .call-panel__local {
    display: flex;
  }
  .call-panel__header {
    font-size: 14px;
  }
  .call-panel__identity :global(svg) {
    width: 40px;
    height: 40px;
  }
  .call-person :global(svg) {
    width: 64px;
    height: 64px;
  }
  .call-panel__device {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .call-round {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 52px;
    height: 52px;
    border: 0;
    border-radius: 50%;
    background: #424242;
    color: white;
    padding: 0;
  }
  .call-round.flat {
    background: transparent;
  }
  .call-round.chosen,
  .call-answer {
    background: #1976d2;
  }
  .call-round.danger {
    background: #c10015;
  }
  .call-answer {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border: 0;
    color: white;
    border-radius: 4px;
    padding: 12px 16px;
    min-height: 44px;
  }
  .call-answer.audio {
    background: #21ba45;
  }
  .call-answer.dismiss {
    align-self: center;
    margin: 12px;
  }
  .call-round:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .call-panel__controls {
    align-items: flex-start;
  }
  .call-text-button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    background: transparent;
    color: white;
    border: 0;
    padding: 8px;
  }
  .call-compact {
    position: fixed;
    z-index: 1100;
    left: 50%;
    transform: translateX(-50%);
    top: calc(env(safe-area-inset-top, 0px) + 12px);
    background: var(--nc-panel-header-bg);
    border-radius: 24px;
    box-shadow: var(--nc-shadow-md);
    display: flex;
    max-width: calc(100vw - 24px);
  }
  .call-compact button {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: transparent;
    border: 0;
    color: inherit;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .call-audio-recovery-container {
    position: fixed;
    z-index: 1200;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
  }
  .room-tile__mute {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .room-tile__mute :global(svg) {
    width: 16px;
    height: 16px;
  }
  .call-invite-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1200;
    background: #0008;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .room-invite-dialog {
    padding: 20px;
    border-radius: 8px;
  }
  .room-invite-dialog header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .room-invite-dialog h2 {
    font-size: 20px;
  }
  .room-invite-dialog input {
    display: block;
    width: 100%;
    padding: 12px;
    margin: 8px 0;
  }
  .room-invite-dialog > button {
    margin: 8px 8px 0 0;
    padding: 10px;
  }
  .call-error-dialog {
    position: fixed;
    z-index: 1200;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    padding: 24px;
    border-radius: 8px;
    background: var(--nc-panel-header-bg);
  }
  @media (max-width: 599px), (max-height: 500px) {
    .call-round {
      width: 40px;
      height: 40px;
    }
    .room-controls .call-round {
      width: 32px;
      height: 32px;
    }
    .call-panel__identity :global(svg) {
      display: none;
    }
    .call-panel__identity h2 {
      font-size: 20px;
    }
    .call-panel__controls {
      gap: 4px;
    }
  }

  /* Shared caller identity and phone actions across mobile and desktop. */
  .call-panel__identity > :global(svg) {
    display: none;
  }
  .call-panel:not(.room-panel) {
    isolation: isolate;
    --call-stage-background: transparent;
    padding: max(16px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
    background: #101820;
    overflow-y: auto;
  }
  .call-backdrop {
    display: block;
    position: absolute;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    overflow: hidden;
    background: radial-gradient(ellipse at 50% 25%, var(--call-peer-color), #101820 85%);
  }
  .call-backdrop img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    filter: blur(28px);
    transform: scale(1.15);
  }
  .call-backdrop::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(#10182099, #101820dd);
  }
  .call-peer-avatar {
    display: flex;
    justify-content: center;
    margin-bottom: 20px;
  }
  .call-panel:not(.call-panel--voice) .call-peer-avatar {
    display: none;
  }
  .call-panel__identity {
    padding: 20px 0;
  }
  .call-panel__identity h2 {
    font-size: 26px;
    color: color-mix(in srgb, var(--call-peer-color) 30%, white);
    max-height: 3.9em;
    overflow: auto;
  }
  .call-peer-npub {
    display: block;
    color: color-mix(in srgb, var(--call-peer-color) 30%, white);
    font-size: 12px;
    overflow-wrap: anywhere;
    max-width: 320px;
    margin: 8px auto 16px;
    user-select: text;
  }
  .call-panel--voice .call-panel__identity {
    margin-top: auto;
  }
  .call-panel--voice :global(.call-stage) {
    flex: 0 0 24px;
    margin-bottom: auto;
  }
  .call-panel:not(.room-panel) .call-panel__controls {
    gap: 12px;
    padding-bottom: 12px;
    align-items: center;
  }
  .call-panel:not(.room-panel) .call-round {
    width: 44px;
    height: 44px;
  }
  .call-panel:not(.room-panel) .call-primary-action {
    position: relative;
    display: inline-flex;
    justify-content: center;
    align-items: center;
    flex-shrink: 0;
    width: 64px;
    height: 64px;
    min-height: 64px;
    border-radius: 50%;
    padding: 0;
    margin: 12px 8px 52px;
  }
  .call-primary-action > span:not(.call-close-icon) {
    display: block;
    position: absolute;
    top: calc(100% + 10px);
    left: 50%;
    transform: translateX(-50%);
    width: 80px;
    color: white;
    font-size: 13px;
    line-height: 1.3;
    text-align: center;
  }
  .call-panel .call-primary-action :global(svg),
  .call-hangup :global(svg) {
    width: 28px;
    height: 28px;
  }
  .call-panel .call-primary-action.audio {
    background: #198348;
  }
  .call-panel .call-primary-action.danger,
  .call-panel .call-primary-action.dismiss,
  .call-panel .call-hangup {
    background: #d9364f;
  }
  .call-panel:not(.room-panel) .call-hangup {
    width: 60px;
    height: 60px;
  }
  .call-close-icon {
    display: flex;
  }
  @media (min-width: 600px) {
    .call-panel:not(.room-panel) {
      padding: 24px 32px 28px;
    }
    .call-panel__header {
      color: #ffffffb3;
    }
    .call-panel--voice .call-panel__identity {
      width: min(100%, 640px);
      align-self: center;
      padding: 32px 0;
    }
    .call-panel--voice .call-panel__identity h2 {
      font-size: clamp(28px, 3vw, 40px);
      letter-spacing: -0.025em;
    }
    .call-peer-avatar {
      margin-bottom: 28px;
    }
    .call-peer-avatar :global(.avatar) {
      box-shadow:
        0 0 0 6px #ffffff0d,
        0 16px 48px #0004;
    }
    .call-peer-npub {
      max-width: 480px;
      opacity: 0.8;
      margin-bottom: 20px;
    }
    .call-panel:not(.call-panel--voice) .call-panel__identity {
      padding: 4px 0 12px;
    }
    .call-panel:not(.call-panel--voice) .call-panel__identity h2 {
      font-size: 20px;
    }
    .call-panel:not(.call-panel--voice) .call-peer-npub {
      margin: 4px auto 8px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .call-panel:not(.room-panel) .call-panel__controls {
      gap: 16px;
      padding-top: 20px;
      align-items: flex-start;
    }
    .call-panel:not(.room-panel) .call-round {
      width: 52px;
      height: 52px;
    }
    .call-panel:not(.room-panel) .call-primary-action {
      width: 72px;
      height: 72px;
      min-height: 72px;
      margin: 0 18px 48px;
      box-shadow: 0 8px 24px #0003;
    }
    .call-primary-action > span:not(.call-close-icon) {
      width: 100px;
      font-size: 14px;
    }
    .call-panel:not(.room-panel) .call-hangup {
      position: relative;
      width: 64px;
      height: 64px;
      margin: 0 8px 36px;
      box-shadow: 0 8px 24px #0003;
    }
    .call-hangup .call-action-label {
      display: block;
      position: absolute;
      top: calc(100% + 8px);
      left: 50%;
      transform: translateX(-50%);
      width: 100px;
      font-size: 13px;
      line-height: 1.3;
      text-align: center;
    }
    .call-panel:not(.room-panel) .call-round,
    .call-primary-action {
      transition:
        background 150ms ease,
        box-shadow 150ms ease,
        transform 150ms ease;
    }
    .call-panel:not(.room-panel) .call-round:not(:disabled):hover,
    .call-primary-action:hover {
      filter: brightness(1.12);
      transform: translateY(-2px);
    }
    .call-panel:not(.room-panel) .call-round:not(:disabled):active,
    .call-primary-action:active {
      transform: translateY(0);
    }
    .call-panel:not(.room-panel) button:focus-visible {
      outline: 3px solid white;
      outline-offset: 5px;
    }
  }
  @media (min-width: 600px) and (max-height: 650px) {
    .call-panel:not(.room-panel) {
      padding: 12px 20px;
    }
    .call-peer-avatar {
      display: none;
    }
    .call-panel--voice .call-panel__identity {
      padding: 12px 0;
    }
    .call-panel--voice .call-panel__identity h2 {
      font-size: 24px;
    }
    .call-peer-npub {
      margin-bottom: 8px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .call-panel:not(.room-panel) .call-round,
    .call-primary-action {
      transition: none;
    }
  }
  @media (max-width: 599px) and (max-height: 600px) {
    .call-peer-avatar {
      display: none;
    }
    .call-panel__identity {
      padding: 8px 0;
    }
    .call-panel__identity h2 {
      font-size: 20px;
    }
    .call-peer-npub {
      margin-bottom: 8px;
    }
  }
</style>
