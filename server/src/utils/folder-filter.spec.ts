import { toFolderLikePattern } from 'src/utils/folder-filter.js';

describe('toFolderLikePattern', () => {
  it.each([
    ['/videos', '/videos/%'],
    ['/videos/', '/videos/%'],
    ['videos/holiday', '/videos/holiday/%'],
    ['/', '/%'],
    [String.raw`/a_b%c\d`, String.raw`/a\_b\%c\\d/%`],
  ])('should turn %s into %s', (folder, pattern) => {
    expect(toFolderLikePattern(folder)).toBe(pattern);
  });
});
