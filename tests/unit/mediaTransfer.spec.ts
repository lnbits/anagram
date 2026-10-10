import {
  hasImageTransferFile,
  hasTransferFiles,
  hasTransferText,
  readFirstImageTransferFile,
} from '#src/utils/mediaTransfer.ts';
import { describe, expect, it } from 'vitest';

describe('media transfer helpers', () => {
  it('detects text and file transfers', () => {
    expect(
      hasTransferText({
        types: ['text/plain', 'Files'],
      })
    ).toBe(true);
    expect(
      hasTransferFiles({
        types: ['text/plain', 'Files'],
      })
    ).toBe(true);
    expect(
      hasTransferFiles({
        items: [{ kind: 'file', type: 'image/png' }],
      })
    ).toBe(true);
  });

  it('reads the first image file from clipboard or drag data', () => {
    const textFile = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    const imageFile = new File(['image'], 'image.png', { type: 'image/png' });
    const laterImageFile = new File(['later'], 'later.jpg', { type: 'image/jpeg' });

    expect(
      readFirstImageTransferFile({
        items: [
          {
            kind: 'file',
            type: textFile.type,
            getAsFile: () => textFile,
          },
          {
            kind: 'file',
            type: imageFile.type,
            getAsFile: () => imageFile,
          },
          {
            kind: 'file',
            type: laterImageFile.type,
            getAsFile: () => laterImageFile,
          },
        ],
        files: [laterImageFile],
      })
    ).toBe(imageFile);
  });

  it('falls back to files when transfer items do not expose an image file', () => {
    const imageFile = new File(['image'], 'image.png', { type: 'image/png' });

    expect(
      readFirstImageTransferFile({
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => null,
          },
        ],
        files: [imageFile],
      })
    ).toBe(imageFile);
    expect(
      hasImageTransferFile({
        items: [
          {
            kind: 'file',
            type: 'image/png',
            getAsFile: () => null,
          },
        ],
      })
    ).toBe(true);
  });
});
