<script lang="ts">
  import { onDestroy } from 'svelte';
  import { followCallLive, setCallSpeaker } from '#src/services/callPlaybackService.ts';
  export let url = '';
  export let stream: MediaStream | null = null;
  export let muted = true;
  export let sink = '';
  export let label = '';
  export let testid: string | undefined = undefined;
  export let onblocked: (blocked: boolean) => void = () => {};
  export let onoutputerror: () => void = () => {};
  let element: HTMLVideoElement;
  let attempt = 0;
  export async function play() {
    if (!element || (!url && !stream)) return;
    const current = ++attempt;
    try {
      await element.play();
      if (current === attempt) onblocked(false);
    } catch (error) {
      if (current === attempt && !(error instanceof DOMException && error.name === 'AbortError'))
        onblocked(true);
    }
  }
  function syncSource(
    node: HTMLVideoElement | undefined,
    source: MediaStream | null,
    value: string,
  ) {
    if (!node) return;
    node.srcObject = source;
    if (!source && value) node.src = value;
    void play();
  }
  $: syncSource(element, stream, url);
  $: if (element) void setCallSpeaker(element, sink).catch(onoutputerror);
  onDestroy(() => {
    attempt++;
    if (element) {
      element.pause();
      element.srcObject = null;
      element.removeAttribute('src');
      element.load();
    }
  });
</script>

<!-- svelte-ignore a11y_media_has_caption -->
<video
  bind:this={element}
  {muted}
  autoplay
  playsinline
  aria-label={label || undefined}
  data-testid={testid}
  onloadeddata={play}
  onprogress={() => followCallLive(element)}
></video>
