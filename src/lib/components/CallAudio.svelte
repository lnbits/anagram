<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { observeCallActivity } from '#src/services/callActivityService.ts';
  import {
    followCallLive,
    registerCallAudio,
    setCallSpeaker,
  } from '#src/services/callPlaybackService.ts';
  import { translate } from '#src/i18n.ts';
  export let url = '';
  export let muted = false;
  export let sink = '';
  export let name = '';
  export let testid = 'call-remote-audio';
  export let primary = false;
  export let activity = false;
  export let onlevel: (value: number) => void = () => {};
  export let onoutputerror: () => void = () => {};
  let audio: HTMLAudioElement;
  let blocked = false,
    attempt = 0;
  let stopActivity: (() => void) | undefined;
  function meter(enabled: boolean, currentUrl: string) {
    stopActivity?.();
    stopActivity = undefined;
    onlevel(0);
    if (!enabled || !currentUrl || !audio) return;
    try {
      const element = audio as HTMLAudioElement & {
        captureStream?: () => MediaStream;
        mozCaptureStream?: () => MediaStream;
      };
      const stream = element.captureStream?.() ?? element.mozCaptureStream?.();
      if (stream) stopActivity = observeCallActivity(stream, onlevel);
    } catch {
      /* Audio playback is independent of activity detection. */
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
    attempt++;
    blocked = false;
    if (value) {
      element.src = value;
      void play();
    } else {
      element.pause();
      element.removeAttribute('src');
      element.load();
    }
  }
  $: syncSource(audio, url);
  $: if (audio) void setCallSpeaker(audio, sink).catch(onoutputerror);
  $: meter(activity, url);
  onMount(() => {
    if (primary) registerCallAudio(audio);
  });
  onDestroy(() => {
    attempt++;
    stopActivity?.();
    onlevel(0);
    if (primary) registerCallAudio(null);
    audio?.pause();
  });
</script>

<audio
  bind:this={audio}
  {muted}
  autoplay
  data-testid={testid}
  onloadeddata={play}
  onprogress={() => followCallLive(audio)}
></audio>
{#if blocked && url}<button class="call-audio-recovery" data-testid="call-play-audio" onclick={play}
    >{$translate('call.playAudio')}{name ? ` · ${name}` : ''}</button
  >{/if}
