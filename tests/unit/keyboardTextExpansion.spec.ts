import { describe, expect, it } from 'vitest';
import { collapseKeyboardSections } from '#src/utils/keyboardTextExpansion.ts';
import { COLLAPSED_MESSAGE_CHARACTER_LIMIT as LIMIT } from '#src/utils/messageTextExpansion.ts';

const row = [{ text: 'Copy', copy_text: { text: 'full payload' } }];
describe('positioned keyboard text expansion', () => {
  it('leaves short cards and their full button payloads intact', () => {
    const sections = [{ text: 'Listing', row }];
    expect(collapseKeyboardSections(null)).toBeNull();
    expect(collapseKeyboardSections(sections)).toEqual(sections);
  });
  it('shares one budget across rows and hides actions for incomplete items', () => {
    const sections = [
      { text: 'a'.repeat(2000), row },
      { text: 'b'.repeat(3000), row },
      { text: 'hidden', row },
    ];
    expect(collapseKeyboardSections(sections)).toEqual([
      sections[0],
      { text: 'b'.repeat(LIMIT - 2002) + '...', row: [] },
    ]);
    expect(sections[1].row).toEqual(row);
    expect(sections[1].text.length).toBe(3000);
  });
  it('bounds even a huge first item and handles an exact section boundary', () => {
    expect(collapseKeyboardSections([{ text: 'x'.repeat(100000), row }])).toEqual([
      { text: 'x'.repeat(LIMIT) + '...', row: [] },
    ]);
    expect(
      collapseKeyboardSections([
        { text: 'x'.repeat(LIMIT), row },
        { text: 'tail', row },
      ]),
    ).toEqual([
      { text: 'x'.repeat(LIMIT), row },
      { text: '...', row: [] },
    ]);
  });
});
