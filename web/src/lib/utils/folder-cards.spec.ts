import { getFolderCards, getMountCards, getRootCards } from '#lib/utils/folder-cards.ts';
import { resolveFolderLocation } from '#lib/utils/folder-roots.ts';
import { FolderRootKind, type FolderRootDto, type FolderSummaryResponseDto } from '@immich/sdk';
import type { MessageFormatter } from 'svelte-i18n';

const $t = ((key: string) => key) as MessageFormatter;

const summary = (overrides: Partial<FolderSummaryResponseDto> = {}): FolderSummaryResponseDto => ({
  path: '/',
  directAssetCount: 0,
  children: [],
  writable: false,
  isLibraryRoot: false,
  ...overrides,
});

const roots: FolderRootDto[] = [
  {
    id: 'media-id',
    kind: FolderRootKind.Library,
    name: 'Media',
    writable: false,
    assetCount: 5,
    coverAssetId: 'cover-media',
    folders: [{ name: 'media', path: '/mnt/media', writable: false }],
  },
  {
    id: 'uploads',
    kind: FolderRootKind.Uploads,
    name: 'Uploads',
    writable: false,
    assetCount: 2,
    coverAssetId: null,
    folders: [
      { name: 'library', path: '/data/library/admin', writable: false },
      { name: 'upload', path: '/data/upload/user', writable: false },
    ],
  },
];

describe('getRootCards', () => {
  it('shows the library names and the phone uploads without paths', () => {
    const cards = getRootCards($t, roots);

    expect(cards.map(({ label, href, kind }) => ({ label, href, kind }))).toEqual([
      { label: 'Media', href: '/folders?root=media-id', kind: 'root' },
      { label: 'phone_uploads', href: '/folders?root=uploads', kind: 'root' },
    ]);
    expect(cards.some(({ label }) => label.includes('/'))).toBe(false);
    expect(cards[0]).toMatchObject({ assetCount: 5, coverAssetId: 'cover-media', folderPath: '/mnt/media' });
    expect(cards[1].folderPath).toBeUndefined();
  });
});

describe('getMountCards', () => {
  it('lists the folders of a root with several locations', () => {
    const location = resolveFolderLocation(roots, 'uploads', '')!;

    expect(getMountCards(location).map(({ label, href }) => ({ label, href }))).toEqual([
      { label: 'library', href: '/folders?root=uploads&path=library' },
      { label: 'upload', href: '/folders?root=uploads&path=upload' },
    ]);
  });
});

describe('getFolderCards', () => {
  it('uses the last path segment and links relative to the root', () => {
    const location = resolveFolderLocation(roots, 'media-id', 'Trips')!;
    const cards = getFolderCards(
      summary({
        path: '/mnt/media/Trips',
        children: [
          {
            name: 'Goa 10',
            path: '/mnt/media/Trips/Goa 10',
            assetCount: 1,
            coverAssetId: null,
            totalSize: 10,
          },
          { name: 'goa 2', path: '/mnt/media/Trips/goa 2', assetCount: 3, coverAssetId: 'cover' },
        ],
      }),
      location,
    );

    expect(cards.map(({ label, href, folderPath }) => ({ label, href, folderPath }))).toEqual([
      { label: 'goa 2', href: '/folders?root=media-id&path=Trips%2Fgoa%202', folderPath: '/mnt/media/Trips/goa 2' },
      {
        label: 'Goa 10',
        href: '/folders?root=media-id&path=Trips%2FGoa%2010',
        folderPath: '/mnt/media/Trips/Goa 10',
      },
    ]);
    expect(cards[1]).toMatchObject({ kind: 'folder', writable: false, assetCount: 1, totalSize: 10 });
  });

  it('falls back to absolute links outside of every root', () => {
    const cards = getFolderCards(
      summary({ path: '/other', children: [{ name: 'x', path: '/other/x', assetCount: 0, coverAssetId: null }] }),
    );

    expect(cards[0]).toMatchObject({ label: 'x', href: '/folders?path=%2Fother%2Fx' });
  });
});
