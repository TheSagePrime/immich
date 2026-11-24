import {
  getFolderLocationCrumbs,
  getFriendlyFolderPath,
  locateFolderPath,
  normalizeRelativePath,
  resolveFolderLocation,
} from '#lib/utils/folder-roots.ts';
import { getRangeSelection } from '#lib/utils/folder-selection.ts';
import { FolderRootKind, type FolderRootDto } from '@immich/sdk';
import type { MessageFormatter } from 'svelte-i18n';

const $t = ((key: string) => key) as MessageFormatter;

const roots: FolderRootDto[] = [
  {
    id: 'media',
    kind: FolderRootKind.Library,
    name: 'Media',
    writable: false,
    assetCount: 3,
    coverAssetId: null,
    folders: [{ name: 'media', path: '/mnt/media', writable: false }],
  },
  {
    id: 'family',
    kind: FolderRootKind.Library,
    name: 'Family',
    writable: true,
    assetCount: 1,
    coverAssetId: null,
    folders: [
      { name: 'a/photos', path: '/mnt/a/photos', writable: true },
      { name: 'b/photos', path: '/mnt/b/photos', writable: false },
    ],
  },
  {
    id: 'uploads',
    kind: FolderRootKind.Uploads,
    name: 'Uploads',
    writable: false,
    assetCount: 2,
    coverAssetId: null,
    folders: [{ name: 'library', path: '/data/library/admin', writable: false }],
  },
];

describe('normalizeRelativePath', () => {
  it('drops empty, "." and ".." segments', () => {
    expect(normalizeRelativePath('/Trips//./../Goa/')).toBe('Trips/Goa');
    expect(normalizeRelativePath(null)).toBe('');
  });
});

describe('resolveFolderLocation', () => {
  it('maps a root with one folder directly to that folder', () => {
    expect(resolveFolderLocation(roots, 'media', 'Trips/Goa')).toMatchObject({
      absolutePath: '/mnt/media/Trips/Goa',
      relativePath: 'Trips/Goa',
    });
    expect(resolveFolderLocation(roots, 'media', '')?.absolutePath).toBe('/mnt/media');
  });

  it('lists the folders of a root with several folders and resolves names with slashes', () => {
    const listing = resolveFolderLocation(roots, 'family', '');
    expect(listing?.root.id).toBe('family');
    expect(listing?.absolutePath).toBeUndefined();
    expect(listing?.folder).toBeUndefined();
    expect(resolveFolderLocation(roots, 'family', 'b/photos/2024')?.absolutePath).toBe('/mnt/b/photos/2024');
    expect(resolveFolderLocation(roots, 'family', 'c/photos')).toBeUndefined();
  });

  it('returns nothing for an unknown root', () => {
    expect(resolveFolderLocation(roots, 'nope', 'x')).toBeUndefined();
  });
});

describe('locateFolderPath', () => {
  it('turns an old absolute path into a root and a relative path', () => {
    expect(locateFolderPath(roots, '/mnt/media/Trips/Goa')).toEqual({ rootId: 'media', relativePath: 'Trips/Goa' });
    expect(locateFolderPath(roots, '/data/library/admin')).toEqual({ rootId: 'uploads', relativePath: '' });
    expect(locateFolderPath(roots, '/mnt/b/photos/x')).toEqual({ rootId: 'family', relativePath: 'b/photos/x' });
    expect(locateFolderPath(roots, '/elsewhere')).toBeUndefined();
  });
});

describe('getFolderLocationCrumbs', () => {
  it('reads like the root name followed by the folder names', () => {
    const crumbs = getFolderLocationCrumbs($t, resolveFolderLocation(roots, 'media', 'Trips/Goa')!);

    expect(crumbs).toEqual([
      { title: 'Media', href: '/folders?root=media', path: '/mnt/media', writable: false },
      { title: 'Trips', href: '/folders?root=media&path=Trips', path: '/mnt/media/Trips', writable: false },
      { title: 'Goa', href: '/folders?root=media&path=Trips%2FGoa', path: '/mnt/media/Trips/Goa', writable: false },
    ]);
    expect(crumbs.some(({ title }) => title.includes('/'))).toBe(false);
  });

  it('names the uploads root and adds the folder name for roots with several folders', () => {
    expect(
      getFolderLocationCrumbs($t, resolveFolderLocation(roots, 'uploads', '2026')!).map(({ title }) => title),
    ).toEqual(['phone_uploads', '2026']);
    expect(
      getFolderLocationCrumbs($t, resolveFolderLocation(roots, 'family', 'a/photos/x')!).map(({ title, writable }) => ({
        title,
        writable,
      })),
    ).toEqual([
      { title: 'Family', writable: false },
      { title: 'a/photos', writable: true },
      { title: 'x', writable: true },
    ]);
  });
});

describe('getFriendlyFolderPath', () => {
  it('hides the absolute path', () => {
    expect(getFriendlyFolderPath($t, roots, '/mnt/media/Trips')).toEqual(['Media', 'Trips']);
    expect(getFriendlyFolderPath($t, roots, '/unknown')).toBeUndefined();
  });
});

describe('getRangeSelection', () => {
  it('selects the items between both ends in display order', () => {
    expect(getRangeSelection(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['b', 'c', 'd']);
    expect(getRangeSelection(['a', 'b'], -1, 1)).toEqual([]);
  });
});
