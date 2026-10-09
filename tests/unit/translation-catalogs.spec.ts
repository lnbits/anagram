import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const directory = new URL('../../src/locales/', import.meta.url);
const files = readdirSync(directory).filter((file) => file.endsWith('.json'));
const source = JSON.parse(readFileSync(new URL('en-US.json', directory), 'utf8')) as Record<
  string,
  string
>;
const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('translation catalogs', () => {
  for (const file of files) {
    it(`${file} covers the source keys without duplicates or broken placeholders`, () => {
      const raw = readFileSync(new URL(file, directory), 'utf8');
      const catalog = JSON.parse(raw) as Record<string, string>;
      const declaredKeys = [...raw.matchAll(/^\s*"((?:[^"\\]|\\.)+)"\s*:/gm)].map(
        (match) => JSON.parse(`"${match[1]}"`) as string,
      );
      expect(new Set(declaredKeys).size, 'duplicate JSON keys').toBe(declaredKeys.length);
      expect(Object.keys(catalog).sort()).toEqual(Object.keys(source).sort());
      for (const [key, value] of Object.entries(catalog)) {
        expect(typeof value, key).toBe('string');
        expect(value.trim(), key).not.toBe('');
        expect(placeholders(value), key).toEqual(placeholders(source[key]));
      }
    });
  }
});
