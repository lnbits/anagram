<script lang="ts">
  import { observePublicProfile } from '#src/lib/state/publicProfiles.ts';
  import { buildAvatarText, avatarColor } from '#src/utils/avatarText.ts';
  export let name = '';
  export let picture = '';
  export let publicKey = '';
  export let eager = false;
  export let privateGroup = false;
  export let publicGroup = false;
  let failedUrl = '';
  $: profile = observePublicProfile(publicKey);
  $: resolvedPicture =
    $profile?.createdAt !== undefined ? $profile.picture : $profile?.picture || picture;
  export let size = 48;
  export let fontSize: number | undefined = undefined;
  $: initials = buildAvatarText(name);
  $: color = avatarColor(name || initials);
</script>

<span
  class="avatar"
  style:width="{size}px"
  style:height="{size}px"
  style:background={color}
  style:font-size={`${fontSize ?? (size === 48 ? 28 : Math.round(size * 0.39))}px`}
>
  {#if resolvedPicture && resolvedPicture !== failedUrl && /^https?:\/\//i.test(resolvedPicture)}<img
      src={resolvedPicture}
      alt=""
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      referrerpolicy="no-referrer"
      onerror={(event) => (failedUrl = event.currentTarget.getAttribute('src') ?? '')}
    />{:else}{initials}{/if}
  {#if publicGroup}<span
      class="private-group-badge"
      role="img"
      aria-label="Public group"
      title="Public group"
      style:width={`${Math.max(14, Math.round(size * 0.36))}px`}
      style:height={`${Math.max(14, Math.round(size * 0.36))}px`}
      ><svg viewBox="0 0 24 24" aria-hidden="true"
        ><path
          fill="currentColor"
          d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3M8 11c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3m0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13m8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5"
        /></svg
      ></span
    >{/if}
  {#if privateGroup}
    <span
      class="private-group-badge"
      role="img"
      aria-label="Private group"
      title="Private group"
      style:width={`${Math.max(14, Math.round(size * 0.36))}px`}
      style:height={`${Math.max(14, Math.round(size * 0.36))}px`}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M5 7V5a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.7" />
        <rect x="3" y="6.5" width="10" height="8" rx="2" fill="currentColor" />
        <path
          d="M8 9.5v2"
          stroke="var(--nc-panel-sidebar-bg)"
          stroke-width="1.5"
          stroke-linecap="round"
        />
      </svg>
    </span>
  {/if}
</span>

<style>
  .avatar {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    font-weight: 700;
    color: white;
    font-size: 14px;
    position: relative;
  }
  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: inherit;
  }
  .private-group-badge {
    position: absolute;
    top: -1px;
    left: -1px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--q-primary);
    pointer-events: none;
  }
  .private-group-badge svg {
    width: 100%;
    height: 100%;
  }
</style>
