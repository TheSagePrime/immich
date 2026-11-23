import {
  canMoveFoldersTo,
  getFolderCrumbs,
  getFolderName,
  getFolderParentPath,
  isSameOrInsidePath,
  isValidFolderEntryName,
  splitFileName,
} from '#lib/utils/folder-utils.ts';

describe('folder-utils', () => {
  it.each(['photos', 'Summer 2024', 'été', 'a.b'])('should accept the name %j', (name) => {
    expect(isValidFolderEntryName(name)).toBe(true);
  });

  it.each(['', ' '.repeat(3), '.', '..', '.hidden', 'a/b', String.raw`a\b`, 'a\0b', 'x'.repeat(256), 'é'.repeat(128)])(
    'should refuse the name %j',
    (name) => {
      expect(isValidFolderEntryName(name)).toBe(false);
    },
  );

  it('should split file names', () => {
    expect(splitFileName('photo.JPG')).toEqual({ stem: 'photo', extension: '.JPG' });
    expect(splitFileName('archive.tar.gz')).toEqual({ stem: 'archive.tar', extension: '.gz' });
    expect(splitFileName('README')).toEqual({ stem: 'README', extension: '' });
  });

  it('should detect nested paths', () => {
    expect(isSameOrInsidePath('/a/b', '/a/b')).toBe(true);
    expect(isSameOrInsidePath('/a/b', '/a/b/c')).toBe(true);
    expect(isSameOrInsidePath('/a/b', '/a/bc')).toBe(false);
    expect(isSameOrInsidePath('/', '/a')).toBe(true);
  });

  it('should compute parents, names and crumbs', () => {
    expect(getFolderParentPath('/a/b/')).toBe('/a');
    expect(getFolderParentPath('/a')).toBe('/');
    expect(getFolderName('/a/b')).toBe('b');
    expect(getFolderName('/')).toBe('/');
    expect(getFolderCrumbs('/a/b')).toEqual([
      { name: 'a', path: '/a' },
      { name: 'b', path: '/a/b' },
    ]);
  });

  it('should refuse to move folders into themselves', () => {
    expect(canMoveFoldersTo('/lib/b', ['/lib/a'])).toBe(true);
    expect(canMoveFoldersTo('/lib/a', ['/lib/a'])).toBe(false);
    expect(canMoveFoldersTo('/lib/a/x', ['/lib/a'])).toBe(false);
    expect(canMoveFoldersTo(null, [])).toBe(false);
  });
});
