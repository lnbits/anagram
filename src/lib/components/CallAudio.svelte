<script lang="ts">
  import { attachCallMedia, getCallStream } from '#src/services/callStreamRegistry.ts';
  import { onMount, onDestroy } from 'svelte';
  import { isIosNative } from '#src/lib/platform/ios.ts';
  import { observeCallActivity } from '#src/services/callActivityService.ts';
  import {
    followCallLive,
    registerCallAudio,
    setCallSpeaker,
    watchCallLive,
  } from '#src/services/callPlaybackService.ts';
  import { translate } from '#src/i18n.ts';
  export let url = '';
  export let muted = false;
  export let sink = '';
  export let name = '';
  export let testid = 'call-remote-audio';
  export let primary = false;
  export let activity = false;
  /** Speech level while metered; null once this input is no longer metered. */
  export let onlevel: (value: number | null) => void = () => {};
  export let onoutputerror: () => void = () => {};
  let audio: HTMLAudioElement;
  let blocked = false,
    attempt = 0;
  let stopActivity: (() => void) | undefined;
  let stopFollowing: (() => void) | undefined;
  function meter(enabled: boolean, currentUrl: string) {
    stopActivity?.();
    stopActivity = undefined;
    onlevel(null);
    if (!enabled || !currentUrl || !audio) return;
    // A registered stream belongs to the call and is never stopped here. A capture
    // is the meter's own. Firefox's mozCaptureStream would divert playback away
    // from the speakers, so without captureStream this input is not metered.
    const registered = getCallStream(currentUrl);
    let captured: MediaStream | undefined;
    const release = () => captured?.getTracks().forEach((track) => track.stop());
    try {
      captured = registered
        ? undefined
        : (audio as HTMLAudioElement & { captureStream?: () => MediaStream }).captureStream?.();
      const stream = registered ?? captured;
      if (!stream) return;
      const stop = observeCallActivity(stream, onlevel);
      stopActivity = () => {
        stop();
        release();
      };
    } catch {
      /* Audio playback is independent of activity detection. */
      release();
    }
  }
  export async function play() {
    if (!audio || !url) return;
    const current = ++attempt;
    try {
      await audio.play();
      if (current === attempt) {
        blocked = false;
        meter(activity, url);
      }
    } catch (error) {
      if (current === attempt && !(error instanceof DOMException && error.name === 'AbortError'))
        blocked = true;
    }
  }
  function syncSource(element: HTMLAudioElement | undefined, value: string) {
    if (!element) return;
    stopFollowing?.();
    stopFollowing = value && !getCallStream(value) ? watchCallLive(element, 'audio') : undefined;
    attempt++;
    blocked = false;
    // ManagedMediaSource on iPhone requires remote playback to be disabled
    // before attaching the stream. Calls have no alternative AirPlay URL.
    if (isIosNative()) element.disableRemotePlayback = true;
    if (value) {
      attachCallMedia(element, value);
      void play();
    } else {
      element.pause();
      element.srcObject = null;
      element.removeAttribute('src');
      element.load();
    }
  }
  $: syncSource(audio, url);
  $: if (audio) void setCallSpeaker(audio, sink).catch(onoutputerror);
  $: meter(activity, url);
  onMount(() => {
    if (primary) registerCallAudio(audio);
    const resume = () => {
      if (document.visibilityState === 'visible' && audio?.paused && url) void play();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', resume);
    window.addEventListener('focus', resume);
    return () => {
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('focus', resume);
    };
  });
  onDestroy(() => {
    attempt++;
    stopActivity?.();
    stopFollowing?.();
    onlevel(null);
    if (primary) registerCallAudio(null);
    audio?.pause();
    if (audio) audio.srcObject = null;
  });
</script>

<audio
  bind:this={audio}
  {muted}
  autoplay
  data-testid={testid}
  onloadeddata={play}
  onprogress={() => followCallLive(audio, 'audio')}
  ontimeupdate={() => followCallLive(audio, 'audio')}
></audio>
{#if blocked && url}<button class="call-audio-recovery" data-testid="call-play-audio" onclick={play}
    >{$translate('call.playAudio')}{name ? ` · ${name}` : ''}</button
  >{/if}
