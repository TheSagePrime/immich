import { BadRequestException } from '@nestjs/common';
import { mapWithConcurrency, numberedName, parseUploadOffset, parseUploadPath } from 'src/utils/upload.js';

describe('numberedName', () => {
  it.each([
    ['photo.jpg', 1, 'photo (1).jpg'],
    ['photo.jpg', 12, 'photo (12).jpg'],
    ['README', 2, 'README (2)'],
    ['my.holiday.photo.HEIC', 1, 'my.holiday.photo (1).HEIC'],
    ['archive.tar.gz', 1, 'archive.tar (1).gz'],
    ['photo (1).jpg', 1, 'photo (1) (1).jpg'],
    ['clip.mov', 3, 'clip (3).mov'],
  ])('should number %s as %s', (name, n, expected) => {
    expect(numberedName(name, n)).toBe(expected);
  });
});

describe('parseUploadPath', () => {
  it('should split a relative path', () => {
    expect(parseUploadPath('a/b/c.jpg')).toEqual(['a', 'b', 'c.jpg']);
    expect(parseUploadPath('./a//c.jpg')).toEqual(['a', 'c.jpg']);
  });

  it.each([
    [''],
    ['/'],
    ['../a.jpg'],
    ['/etc/passwd.jpg'],
    ['a/../../b.jpg'],
    ['a\0b.jpg'],
    [String.raw`a\b.jpg`],
    ['.hidden.jpg'],
    ['a/.git/b.jpg'],
    ['a\u{1F}b.jpg'],
    [`${'x'.repeat(252)}.jpg`],
  ])('should refuse %j', (input) => {
    expect(() => parseUploadPath(input)).toThrow(BadRequestException);
  });

  it('should accept multi-byte names up to 255 bytes', () => {
    const name = `${'é'.repeat(125)}.jpg`;
    expect(parseUploadPath(name)).toEqual([name]);
    expect(() => parseUploadPath(`é${name}`)).toThrow(BadRequestException);
  });
});

describe('parseUploadOffset', () => {
  it('should parse an integer', () => {
    expect(parseUploadOffset('0')).toBe(0);
    expect(parseUploadOffset('8388608')).toBe(8_388_608);
  });

  it.each([[undefined], [''], ['-1'], ['1.5'], ['abc'], [['1', '2']]])('should refuse %j', (value) => {
    expect(() => parseUploadOffset(value)).toThrow(BadRequestException);
  });
});

describe('mapWithConcurrency', () => {
  it('should keep the order and limit the concurrency', async () => {
    let running = 0;
    let peak = 0;
    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return value * 2;
    });

    expect(result).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(2);
  });

  it('should handle an empty list', async () => {
    await expect(mapWithConcurrency([], 4, () => Promise.resolve(1))).resolves.toEqual([]);
  });
});
