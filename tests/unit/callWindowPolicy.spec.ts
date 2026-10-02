import { describe, expect, it } from 'vitest';
import { isCallLobbyWindow } from '../../src-electron/callWindowPolicy';

describe('desktop call window privileges', () => {
  it('allows only the call lobby in the same app document', () => {
    for (const base of [
      'https://chat.example/app/',
      'http://localhost:9000/',
      'file:///app/index.html',
    ]) {
      expect(isCallLobbyWindow(`${base}#/call`, `${base}#/chats`)).toBe(true);
      for (const target of [
        'https://evil.example/#/call',
        'file:///other/index.html#/call',
        `${base}#/settings`,
        `${base}?external=1#/call`,
        'about:blank',
        'invalid',
      ])
        expect(isCallLobbyWindow(target, `${base}#/chats`)).toBe(false);
    }
  });
});
