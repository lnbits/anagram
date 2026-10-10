import {
  readBunkerLoginQueryParam,
  removeBunkerLoginQueryParamFromUrl,
  withoutBunkerLoginQueryParam,
} from '#src/utils/bunkerLoginQuery.ts';
import { describe, expect, it } from 'vitest';

describe('bunker login query helpers', () => {
  it('reads the first non-empty bunker route query value', () => {
    expect(
      readBunkerLoginQueryParam({
        bunker: ['', ' bunker://signer?relay=ws%3A%2F%2Frelay.example '],
      })
    ).toBe('bunker://signer?relay=ws%3A%2F%2Frelay.example');

    expect(readBunkerLoginQueryParam({ bunker: '' })).toBeNull();
  });

  it('removes only the bunker parameter from route query objects', () => {
    expect(
      withoutBunkerLoginQueryParam({
        bunker: 'bunker://signer',
        chat: 'abc',
      })
    ).toEqual({
      chat: 'abc',
    });
  });

  it('removes top-level bunker parameters while preserving hash routes', () => {
    expect(
      removeBunkerLoginQueryParamFromUrl(
        'http://localhost:4100/?bunker=bunker%3A%2F%2Fsigner&theme=dark#/chats'
      )
    ).toBe('/?theme=dark#/chats');

    expect(
      removeBunkerLoginQueryParamFromUrl(
        'http://localhost:4100/?bunker=bunker%3A%2F%2Fsigner#/login'
      )
    ).toBe('/#/login');
  });
});
