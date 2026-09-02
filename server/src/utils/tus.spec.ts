import { parseNonNegativeInt, parseUploadMetadata, serializeUploadMetadata, validateOffset } from 'src/utils/tus';
import { describe, expect, it } from 'vitest';

describe('parseUploadMetadata', () => {
  it('should return an empty object for a missing or blank header', () => {
    expect(parseUploadMetadata()).toEqual({});
    expect(parseUploadMetadata('')).toEqual({});
    expect(parseUploadMetadata(' '.repeat(3))).toEqual({});
  });

  it('should decode base64 values', () => {
    const header = `filename ${Buffer.from('IMG_1234.mov').toString('base64')}`;
    expect(parseUploadMetadata(header)).toEqual({ filename: 'IMG_1234.mov' });
  });

  it('should decode multiple pairs', () => {
    const header = [
      `filename ${Buffer.from('a.jpg').toString('base64')}`,
      `isFavorite ${Buffer.from('true').toString('base64')}`,
    ].join(',');

    expect(parseUploadMetadata(header)).toEqual({ filename: 'a.jpg', isFavorite: 'true' });
  });

  it('should tolerate whitespace around pairs', () => {
    const header = ` filename ${Buffer.from('a.jpg').toString('base64')} , isFavorite ${Buffer.from('true').toString('base64')} `;
    expect(parseUploadMetadata(header)).toEqual({ filename: 'a.jpg', isFavorite: 'true' });
  });

  it('should map a bare key to an empty string', () => {
    expect(parseUploadMetadata('is_confidential')).toEqual({ is_confidential: '' });
  });

  it('should round-trip non-ascii filenames', () => {
    const metadata = { filename: 'æøå 日本語 🙂.jpg' };
    expect(parseUploadMetadata(serializeUploadMetadata(metadata))).toEqual(metadata);
  });

  it('should reject a pair with more than one space', () => {
    expect(parseUploadMetadata('filename abc def')).toBeUndefined();
  });

  it('should reject an empty pair', () => {
    expect(parseUploadMetadata('filename YS5qcGc=,,isFavorite dHJ1ZQ==')).toBeUndefined();
    expect(parseUploadMetadata(',')).toBeUndefined();
  });
});

describe('serializeUploadMetadata', () => {
  it('should emit a bare key for an empty value', () => {
    expect(serializeUploadMetadata({ flag: '' })).toBe('flag');
  });

  it('should base64 encode values', () => {
    expect(serializeUploadMetadata({ filename: 'a.jpg' })).toBe(`filename ${Buffer.from('a.jpg').toString('base64')}`);
  });
});

describe('parseNonNegativeInt', () => {
  it.each([
    ['0', 0],
    ['1', 1],
    ['4294967296', 4_294_967_296],
  ])('should accept %s', (input, expected) => {
    expect(parseNonNegativeInt(input)).toBe(expected);
  });

  it.each([undefined, '', ' 1', '1.5', '-1', '1e3', 'abc', '0x10', '9'.repeat(30)])('should reject %s', (input) => {
    expect(parseNonNegativeInt(input)).toBeUndefined();
  });

  it('should use the first value of an array header', () => {
    expect(parseNonNegativeInt(['5', '9'])).toBe(5);
  });
});

describe('validateOffset', () => {
  it('should accept a claimed offset matching the file size', () => {
    expect(validateOffset(100, 100, 500)).toBe('ok');
  });

  it.each([
    [50, 100],
    [150, 100],
  ])('should conflict when the claimed offset (%i) does not match the size (%i)', (claimed, size) => {
    expect(validateOffset(claimed, size, 500)).toBe('conflict');
  });

  it('should report complete once the file has reached the declared length', () => {
    expect(validateOffset(500, 500, 500)).toBe('complete');
  });

  it('should report complete ahead of the offset check when the file is oversized', () => {
    expect(validateOffset(0, 600, 500)).toBe('complete');
  });
});
