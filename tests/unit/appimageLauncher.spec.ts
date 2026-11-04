import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it.each([
  {
    name: 'explicit Wayland',
    backend: 'wayland',
    session: 'wayland',
    display: 'wayland-0',
    expected: 'wayland',
  },
  {
    name: 'explicit X11 on Wayland',
    backend: 'x11',
    session: 'wayland',
    display: 'wayland-0',
    expected: 'x11',
  },
  {
    name: 'explicit fallback order',
    backend: 'x11,wayland',
    session: 'wayland',
    display: 'wayland-0',
    expected: 'x11,wayland',
  },
  {
    name: 'Wayland display',
    backend: '',
    session: '',
    display: 'wayland-0',
    expected: 'wayland,x11',
  },
  {
    name: 'Wayland session',
    backend: '',
    session: 'wayland',
    display: '',
    expected: 'wayland,x11',
  },
  { name: 'X11 session', backend: '', session: 'x11', display: '', expected: 'x11,wayland' },
  { name: 'unspecified session', backend: '', session: '', display: '', expected: 'x11,wayland' },
])(
  'preserves packaged hooks, arguments and working directory with $name',
  ({ backend, session, display, expected }) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'anagram launcher ')));
    try {
      mkdirSync(join(dir, 'usr/bin'), { recursive: true });
      mkdirSync(join(dir, 'apprun-hooks'));
      copyFileSync(resolve('scripts/appimage/AppRun'), join(dir, 'AppRun'));
      writeFileSync(
        join(dir, 'apprun-hooks/linuxdeploy-plugin-gtk.sh'),
        'export GDK_BACKEND=x11\nexport GTK_DATA_PREFIX="$APPDIR"\n',
      );
      writeFileSync(
        join(dir, 'apprun-hooks/linuxdeploy-plugin-gstreamer.sh'),
        'export GST_PLUGIN_SYSTEM_PATH_1_0="$APPDIR/usr/lib/gstreamer-1.0"\n',
      );
      writeFileSync(
        join(dir, 'usr/bin/anagram'),
        `#!/usr/bin/env node
console.log(JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),env:Object.fromEntries(['APPDIR','GDK_BACKEND','GTK_DATA_PREFIX','GST_PLUGIN_SYSTEM_PATH_1_0','LD_LIBRARY_PATH'].map(key=>[key,process.env[key]]))}));
`,
        { mode: 0o755 },
      );
      const result = JSON.parse(
        execFileSync('bash', [join(dir, 'AppRun'), 'argument with spaces'], {
          cwd: tmpdir(),
          env: {
            ...process.env,
            APPDIR: '/stale-appdir',
            GDK_BACKEND: backend,
            XDG_SESSION_TYPE: session,
            WAYLAND_DISPLAY: display,
          },
          encoding: 'utf8',
        }),
      );
      expect(result.cwd).toBe(join(dir, 'usr'));
      expect(result.args).toEqual(['argument with spaces']);
      expect(result.env.APPDIR).toBe(dir);
      expect(result.env.GDK_BACKEND).toBe(expected);
      expect(result.env.GTK_DATA_PREFIX).toBe(dir);
      expect(result.env.GST_PLUGIN_SYSTEM_PATH_1_0).toBe(join(dir, 'usr/lib/gstreamer-1.0'));
      expect(result.env.LD_LIBRARY_PATH.split(':').slice(0, 2)).toEqual([
        join(dir, 'usr/lib'),
        join(dir, 'usr/lib/x86_64-linux-gnu'),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
