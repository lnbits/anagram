<script lang="ts">
  import { translate } from '#src/i18n.ts';
  import Icon from './Icon.svelte';
  export let kind: 'microphone' | 'camera' | 'speaker';
  export let prefix = 'call';
  export let devices: MediaDeviceInfo[] = [];
  export let selected = '';
  export let disabled = false;
  export let supported = true;
  export let canRequest = false;
  export let onrefresh: () => unknown = () => {};
  export let onselect: (id: string) => unknown;
  export let onrequest: () => unknown = () => {};
  let open = false;
  let picker: HTMLDivElement;
  $: label = `call.choose${kind[0].toUpperCase()}${kind.slice(1)}`;
  function choose(id: string) {
    open = false;
    void onselect(id);
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    if (open && !picker.contains(event.target as Node)) open = false;
  }}
  onkeydown={(event) => {
    if (event.key === 'Escape') open = false;
  }}
/>
<div bind:this={picker} class="call-device-picker">
  <button
    class="call-device-toggle"
    {disabled}
    aria-label={$translate(label)}
    aria-expanded={open}
    data-testid={`${prefix}-${kind}-menu`}
    onclick={() => {
      open = !open;
      if (open) void onrefresh();
    }}><Icon name="down" /></button
  >
  {#if open}
    <div
      class="call-device-menu"
      data-call-device-menu
      role="group"
      aria-label={$translate(`call.${kind}`)}
    >
      <strong>{$translate(`call.${kind}`)}</strong>
      {#if supported || kind === 'speaker'}<button
          class:chosen={!selected}
          data-testid={`${prefix}-${kind}-default`}
          onclick={() => choose('')}>{$translate('call.systemDefault')}</button
        >{/if}
      {#if supported}
        {#each devices as device, index (device.deviceId)}<button
            class:chosen={selected === device.deviceId}
            data-testid={`${prefix}-${kind}-source-${index}`}
            onclick={() => choose(device.deviceId)}
            >{device.label || `${$translate(`call.${kind}`)} ${index + 1}`}</button
          >{/each}
        {#if canRequest}<button
            onclick={() => {
              open = false;
              void onrequest();
            }}>{$translate('call.chooseSpeaker')}</button
          >{/if}
      {:else}<p>
          {$translate(kind === 'speaker' ? 'call.speakerUnavailable' : 'call.error.peerUpgrade')}
        </p>{/if}
    </div>
  {/if}
</div>

<style>
  .call-device-picker {
    position: relative;
    display: flex;
    justify-content: center;
  }
  .call-device-toggle {
    background: transparent;
    border: 0;
    color: inherit;
    padding: 2px;
  }
  .call-device-menu {
    position: absolute;
    z-index: 4;
    bottom: 100%;
    left: 50%;
    transform: translateX(-50%);
    width: 240px;
    max-width: 80vw;
    max-height: 45vh;
    overflow: auto;
    background: #222b35;
    color: #fff;
    padding: 8px;
    border-radius: 6px;
    box-shadow: 0 6px 24px #0009;
  }
  .call-device-menu strong,
  .call-device-menu p {
    display: block;
    padding: 8px;
  }
  .call-device-menu button {
    display: block;
    text-align: left;
    width: 100%;
    padding: 12px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: inherit;
  }
  .call-device-menu button:hover,
  .call-device-menu .chosen {
    background: #315a7b;
  }
</style>
