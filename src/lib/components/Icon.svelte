<script lang="ts">
  import { materialIcons } from './materialIcons';
  export let name = 'chat';
  const paths: Record<string, string> = {
    'qr-scan':
      'M3 7V3h4m10 0h4v4m0 10v4h-4M7 21H3v-4M7 7h3v3H7zm7 0h3v3h-3zM7 14h3v3H7zm7 0h1v1h2v2h-3z',

    pin: 'M9 3h6M9 3v6l-3 4v2h12v-2l-3-4V3M12 15v7',
    reply: 'm9 5-6 6 6 6M3 11h10a7 7 0 0 1 7 7',
    forward: 'm15 5 6 6-6 6M21 11H11a7 7 0 0 0-7 7',
    delete: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
    login: 'M15 3h6v18h-6M3 12h13m-5-5 5 5-5 5',
    key: 'M14 8a5 5 0 1 0 0 .01M9 12l-7 7v3h3v-3h3v-3',
    extension: 'M3 3h6V1h6v2h6v6h2v6h-2v6h-6v2H9v-2H3v-6H1V9h2z',
    download: 'M12 2v14m-5-5 5 5 5-5M3 16v6h18v-6',
    warning: 'M12 2 1 22h22L12 2zM12 9v5M12 18h.01',
    'mic-off':
      'm3 3 18 18M9 9v3a3 3 0 0 0 5 2M9 5V4a3 3 0 0 1 6 0v7M5 10v2a7 7 0 0 0 12 5M12 19v3M8 22h8',
    'video-off': 'm3 3 18 18M3 5h12v14H3zM15 9l6-3v12l-6-3',
    'screen-off': 'm3 3 18 18M2 3h20v14H2zM12 17v4M7 21h10',
    speaker: 'M3 9h4l5-5v16l-5-5H3zM16 8q5 4 0 8M19 4q9 8 0 16',
    'speaker-off': 'M3 9h4l5-5v16l-5-5H3zM16 9l6 6M22 9l-6 6',
    hangup: 'M3 16v-5q9-8 18 0v5h-5v-4q-4-2-8 0v4z',
    person:
      'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M12 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6M5 19q0-6 7-6t7 6',
    fill: 'M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5',
    minimize: 'M5 17h14',
    eye: 'M2 12q10-14 20 0-10 14-20 0zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
    grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    'speaker-view':
      'M8 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6M2 21v-5q6-7 12 0v5M17 7q4 4 0 8M20 4q7 7 0 14',
    popout: 'M14 3h7v7M21 3 11 13M10 3H3v18h18v-7',
    invite: 'M8 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6M1 21v-5q7-8 14 0v5M19 7v8M15 11h8',
    chat: 'M4 3h16v14H8l-4 4V3zm4 4h8M8 11h6',
    contacts: 'M5 4h14v16H5zM9 2v4m6-4v4M9 17h6M12 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4',
    settings:
      'm10 3-1 3-3 1-3 3 2 2-1 4 3 2 3-1 2 4 3-2 1-3 4-1v-4l-3-2-1-4-3 1-3-2zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
    search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6',
    add: 'M12 4v16M4 12h16',
    send: 'm3 3 19 9-19 9 4-9-4-9zm4 9h15',
    back: 'm14 5-7 7 7 7',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    refresh: 'M20 8a8 8 0 1 0 0 8M20 3v5h-5',
    phone: 'M5 3h4l2 5-3 2a15 15 0 0 0 6 6l2-3 5 2v4c-10 3-21-8-16-16z',
    video: 'M3 5h12v14H3zM15 9l6-3v12l-6-3',
    close: 'm5 5 14 14M19 5 5 19',
    attach: 'm8 12 7-7a4 4 0 0 1 6 6L10 22a6 6 0 0 1-8-8L13 3m-7 13 11-11',
    smile: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20M8 9h.01M16 9h.01M7 14q5 7 10 0',
    check: 'm4 12 5 5L20 6',
    group: 'M8 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6M1 21v-5q7-8 14 0v5M17 4q7 3 0 6M18 13q5 1 5 8',
    mic: 'M9 4a3 3 0 0 1 6 0v8a3 3 0 0 1-6 0V4M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8',
    screen: 'M2 3h20v14H2zM12 17v4M7 21h10',
    lock: 'M5 10h14v11H5zM8 10V6a4 4 0 0 1 8 0v4',
    logout: 'M9 3H3v18h6M8 12h13m-5-5 5 5-5 5',
    up: 'm6 15 6-6 6 6',
    down: 'm6 9 6 6 6-6',
    bell: 'M5 16V9a7 7 0 0 1 14 0v7l2 2H3l2-2M10 21h4',
  };
</script>

<svg
  width="22"
  height="22"
  viewBox="0 0 24 24"
  fill={materialIcons[name] ? 'currentColor' : 'none'}
  stroke={materialIcons[name] ? 'none' : 'currentColor'}
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  >{#if materialIcons[name]}{#each materialIcons[name] as path}<path d={path} />{/each}{:else}<path
      d={paths[name] ?? paths.chat}
    />{/if}</svg
>
