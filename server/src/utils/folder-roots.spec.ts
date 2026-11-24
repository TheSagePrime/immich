import { FolderRootKind } from 'src/enum.js';
import type { FolderDirectoryRow } from 'src/repositories/view-repository.js';
import { buildFolderRoots, getFolderDisplayNames, type FolderRootLibrary } from 'src/utils/folder-roots.js';
import { factory, newUuid } from 'test/small.factory.js';

const user = factory.auth({ user: { id: newUuid() } });
const admin = factory.auth({ user: { id: newUuid(), isAdmin: true } });

const library = (overrides: Partial<FolderRootLibrary>): FolderRootLibrary => ({
  id: newUuid(),
  name: 'Library',
  ownerId: user.user.id,
  importPaths: [],
  exclusionPatterns: [],
  writable: false,
  deletedAt: null,
  ...overrides,
});

const row = (libraryId: string | null, directoryPath: string, assetCount = 1, day = 1): FolderDirectoryRow => ({
  libraryId,
  directoryPath,
  assetCount,
  coverAssetId: newUuid(),
  newestTakenAt: new Date(Date.UTC(2024, 0, day)),
});

const uploadLocations = [
  { name: 'library', path: '/data/library/admin' },
  { name: 'upload', path: `/data/upload/${user.user.id}` },
];

const containsAbsolutePath = (value: unknown) =>
  JSON.stringify(value, (key, item) => (key === 'path' ? undefined : item)).includes('/data');

describe('getFolderDisplayNames', () => {
  it('should use the last segment', () => {
    expect(getFolderDisplayNames(['/mnt/media', '/srv/photos'])).toEqual(['media', 'photos']);
  });

  it('should add parent segments until the names are unique', () => {
    expect(getFolderDisplayNames(['/mnt/a/photos', '/mnt/b/photos', '/srv/videos'])).toEqual([
      'a/photos',
      'b/photos',
      'videos',
    ]);
  });
});

describe('buildFolderRoots', () => {
  it('should name library roots after the library and hide empty read-only libraries', () => {
    const media = library({ name: 'Media', importPaths: ['/mnt/media/'] });
    const empty = library({ name: 'Empty', importPaths: ['/mnt/empty'] });
    const uploads = library({ name: 'Uploads', importPaths: ['/mnt/uploads'], writable: true });
    const cover = row(media.id, '/mnt/media/Trips/Goa', 3, 9);

    const roots = buildFolderRoots({
      auth: user,
      libraries: [uploads, empty, media],
      directories: [row(media.id, '/mnt/media/Trips', 2, 1), cover],
      uploadLocations,
    });

    expect(roots).toEqual([
      {
        id: media.id,
        kind: FolderRootKind.Library,
        name: 'Media',
        writable: false,
        assetCount: 5,
        coverAssetId: cover.coverAssetId,
        folders: [{ name: 'media', path: '/mnt/media', writable: false }],
      },
      {
        id: uploads.id,
        kind: FolderRootKind.Library,
        name: 'Uploads',
        writable: true,
        assetCount: 0,
        coverAssetId: null,
        folders: [{ name: 'uploads', path: '/mnt/uploads', writable: true }],
      },
    ]);
  });

  it('should list every import path that has assets and keep only the first one writable', () => {
    const media = library({ name: 'Media', importPaths: ['/mnt/a/photos', '/mnt/b/photos', '/mnt/c'], writable: true });

    const [root] = buildFolderRoots({
      auth: user,
      libraries: [media],
      directories: [row(media.id, '/mnt/b/photos/x')],
      uploadLocations,
    });

    expect(root.folders).toEqual([
      { name: 'a/photos', path: '/mnt/a/photos', writable: true },
      { name: 'b/photos', path: '/mnt/b/photos', writable: false },
    ]);
    expect(root.writable).toBe(true);
  });

  it('should add one root for the assets uploaded to Immich', () => {
    const roots = buildFolderRoots({
      auth: user,
      libraries: [],
      directories: [
        row(null, '/data/library/admin/2026/2026-01-01', 4, 2),
        row(null, '/data/library/admin/2025', 1, 1),
      ],
      uploadLocations,
    });

    expect(roots).toEqual([
      expect.objectContaining({
        id: 'uploads',
        kind: FolderRootKind.Uploads,
        writable: false,
        assetCount: 5,
        folders: [{ name: 'library', path: '/data/library/admin', writable: false }],
      }),
    ]);
    expect(containsAbsolutePath(roots)).toBe(false);
  });

  it('should keep the upload folders apart and collect unknown locations', () => {
    const [root] = buildFolderRoots({
      auth: user,
      libraries: [],
      directories: [
        row(null, '/data/library/admin/2026'),
        row(null, `/data/upload/${user.user.id}/ab/cd`),
        row(null, '/old/storage/2019/a'),
        row(null, '/old/storage/2019/b'),
      ],
      uploadLocations,
    });

    expect(root.folders.map(({ name, path }) => ({ name, path }))).toEqual([
      { name: '2019', path: '/old/storage/2019' },
      { name: 'library', path: '/data/library/admin' },
      { name: 'upload', path: `/data/upload/${user.user.id}` },
    ]);
  });

  it('should not show libraries of other users unless they are writable and managed', () => {
    const owner = newUuid();
    const other = library({ name: 'Other', ownerId: owner, importPaths: ['/mnt/other'] });
    const shared = library({ name: 'Shared', ownerId: owner, importPaths: ['/mnt/shared'], writable: true });

    const directories = [row(other.id, '/mnt/other/a'), row(shared.id, '/mnt/shared/a')];
    expect(buildFolderRoots({ auth: user, libraries: [other, shared], directories, uploadLocations })).toEqual([]);
    expect(
      buildFolderRoots({ auth: admin, libraries: [other, shared], directories, uploadLocations }).map(
        ({ name }) => name,
      ),
    ).toEqual(['Shared']);
  });

  it('should skip deleted libraries and sort libraries by natural name before uploads', () => {
    const a = library({ name: 'Disk 10', importPaths: ['/d10'] });
    const b = library({ name: 'disk 2', importPaths: ['/d2'] });
    const deleted = library({ name: 'Deleted', importPaths: ['/del'], deletedAt: new Date() });

    const roots = buildFolderRoots({
      auth: user,
      libraries: [a, deleted, b],
      directories: [
        row(a.id, '/d10/x'),
        row(b.id, '/d2/x'),
        row(deleted.id, '/del/x'),
        row(null, '/data/library/admin'),
      ],
      uploadLocations,
    });

    expect(roots.map(({ name }) => name)).toEqual(['disk 2', 'Disk 10', 'Uploads']);
  });
});
