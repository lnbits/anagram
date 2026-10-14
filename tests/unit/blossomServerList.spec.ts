import {
  blossomServerUrlsFromTagsValue,
  normalizeBlossomServerUrls,
} from '#src/utils/blossomServerList.ts';
import { describe, expect, it } from 'vitest';

describe('Blossom server list', () => {
  it('keeps the published order and drops duplicates', () => {
    expect(
      blossomServerUrlsFromTagsValue([
        ['server', 'https://second.example.com'],
        ['server', 'https://first.example.com/'],
        ['server', 'https://second.example.com'],
      ]),
    ).toEqual(['https://second.example.com', 'https://first.example.com']);
  });

  it('drops entries that are not plain HTTPS origins', () => {
    expect(
      normalizeBlossomServerUrls([
        'http://insecure.example.com',
        'https://user:password@example.com',
        'https://example.com/upload',
        'https://example.com/?a=1',
        'https://example.com/#fragment',
        '',
        'not a url',
        42,
        null,
        ' https://valid.example.com/ ',
      ]),
    ).toEqual(['https://valid.example.com']);
  });

  it('ignores tags that are not server tags', () => {
    expect(
      blossomServerUrlsFromTagsValue([
        ['t', 'upload'],
        ['server'],
        ['server', 42],
        ['r', 'https://other.example.com'],
        ['server', 'https://blossom.example.com'],
      ]),
    ).toEqual(['https://blossom.example.com']);
  });

  it('returns an empty list for a missing or malformed list', () => {
    expect(blossomServerUrlsFromTagsValue(undefined)).toEqual([]);
    expect(blossomServerUrlsFromTagsValue('server')).toEqual([]);
    expect(blossomServerUrlsFromTagsValue({})).toEqual([]);
    expect(blossomServerUrlsFromTagsValue([[]])).toEqual([]);
  });
});
