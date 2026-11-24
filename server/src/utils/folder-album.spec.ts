import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobName } from 'src/enum.js';
import {
  buildDesiredFolderAlbums,
  buildFolderAlbumRoots,
  diffFolderAlbums,
  expandFolderAlbumPaths,
  findFolderAlbumRoot,
  getFolderAlbumDirectory,
  getFolderAlbumRootsKey,
  getPrunableFolderAlbumIds,
  normalizeFolderAlbumPath,
  queueFolderAlbumSync,
  resetFolderAlbumSyncThrottle,
} from 'src/utils/folder-album.js';

const libraryFolder = { path: '/data/library/admin', name: 'admin' };

describe('folder album utils', () => {
  describe('normalizeFolderAlbumPath', () => {
    it('should strip trailing slashes and normalise', () => {
      expect(normalizeFolderAlbumPath('/mnt/photos/')).toBe('/mnt/photos');
      expect(normalizeFolderAlbumPath('/mnt//photos/./2024')).toBe('/mnt/photos/2024');
    });

    it('should reject relative, empty and root paths', () => {
      expect(normalizeFolderAlbumPath('mnt/photos')).toBeNull();
      expect(normalizeFolderAlbumPath('')).toBeNull();
      expect(normalizeFolderAlbumPath('/')).toBeNull();
      expect(normalizeFolderAlbumPath('/mnt/\0x')).toBeNull();
    });
  });

  describe('getFolderAlbumDirectory', () => {
    it('should return the directory of a file', () => {
      expect(getFolderAlbumDirectory('/mnt/photos/a.jpg')).toBe('/mnt/photos');
      expect(getFolderAlbumDirectory('/a.jpg')).toBe('');
    });
  });

  describe('buildFolderAlbumRoots', () => {
    it('should add every import path and the storage template folder', () => {
      const roots = buildFolderAlbumRoots(
        [
          { id: 'lib-1', importPaths: ['/mnt/photos/', '/mnt/other'] },
          { id: 'lib-2', importPaths: ['/mnt/photos/2024'] },
        ],
        libraryFolder,
      );

      expect(roots).toEqual([
        { path: '/data/library/admin', name: 'admin', libraryId: null },
        { path: '/mnt/photos/2024', name: '2024', libraryId: 'lib-2' },
        { path: '/mnt/photos', name: 'photos', libraryId: 'lib-1' },
        { path: '/mnt/other', name: 'other', libraryId: 'lib-1' },
      ]);
    });

    it('should ignore duplicate and invalid import paths', () => {
      const roots = buildFolderAlbumRoots(
        [{ id: 'lib-1', importPaths: ['/mnt/photos', '/mnt/photos/', 'relative'] }],
        libraryFolder,
      );
      expect(roots.map(({ path }) => path)).toEqual(['/data/library/admin', '/mnt/photos']);
    });

    it('should produce a stable key that changes with the roots', () => {
      const a = buildFolderAlbumRoots([{ id: 'lib-1', importPaths: ['/mnt/a', '/mnt/b'] }], libraryFolder);
      const b = buildFolderAlbumRoots([{ id: 'lib-1', importPaths: ['/mnt/b', '/mnt/a'] }], libraryFolder);
      const c = buildFolderAlbumRoots([{ id: 'lib-1', importPaths: ['/mnt/a'] }], libraryFolder);
      expect(getFolderAlbumRootsKey(a)).toBe(getFolderAlbumRootsKey(b));
      expect(getFolderAlbumRootsKey(a)).not.toBe(getFolderAlbumRootsKey(c));
    });
  });

  describe('findFolderAlbumRoot', () => {
    const roots = buildFolderAlbumRoots(
      [
        { id: 'lib-1', importPaths: ['/mnt/photos'] },
        { id: 'lib-2', importPaths: ['/mnt/photos/2024'] },
      ],
      libraryFolder,
    );

    it('should use the longest import path of the asset library', () => {
      expect(findFolderAlbumRoot('/mnt/photos/2024/trip', 'lib-2', roots)?.path).toBe('/mnt/photos/2024');
      expect(findFolderAlbumRoot('/mnt/photos/2024/trip', 'lib-1', roots)?.path).toBe('/mnt/photos');
    });

    it('should not match a sibling folder with the same prefix', () => {
      expect(findFolderAlbumRoot('/mnt/photos-old/a', 'lib-1', roots)).toBeUndefined();
    });

    it('should only use the storage template folder for uploads', () => {
      expect(findFolderAlbumRoot('/data/library/admin/2024/2024-01-01', null, roots)?.path).toBe('/data/library/admin');
      expect(findFolderAlbumRoot('/data/upload/user-1/ab/cd', null, roots)).toBeUndefined();
      expect(findFolderAlbumRoot('/mnt/photos/a', null, roots)).toBeUndefined();
    });

    it('should match any root when the library is unknown', () => {
      expect(findFolderAlbumRoot('/mnt/photos/a', undefined, roots)?.path).toBe('/mnt/photos');
    });
  });

  describe('expandFolderAlbumPaths', () => {
    it('should return every folder from the root down to the directory', () => {
      const root = { path: '/mnt/photos', name: 'photos', libraryId: 'lib-1' };
      expect(expandFolderAlbumPaths('/mnt/photos/a/b/c/d/e/f/g/h', root)).toEqual([
        '/mnt/photos',
        '/mnt/photos/a',
        '/mnt/photos/a/b',
        '/mnt/photos/a/b/c',
        '/mnt/photos/a/b/c/d',
        '/mnt/photos/a/b/c/d/e',
        '/mnt/photos/a/b/c/d/e/f',
        '/mnt/photos/a/b/c/d/e/f/g',
        '/mnt/photos/a/b/c/d/e/f/g/h',
      ]);
      expect(expandFolderAlbumPaths('/mnt/photos', root)).toEqual(['/mnt/photos']);
      expect(expandFolderAlbumPaths('/mnt/other', root)).toEqual([]);
    });
  });

  describe('buildDesiredFolderAlbums', () => {
    it('should build a continuous tree with names and parents', () => {
      const roots = buildFolderAlbumRoots([{ id: 'lib-1', importPaths: ['/mnt/photos'] }], libraryFolder);
      const desired = buildDesiredFolderAlbums(
        [
          { directory: '/mnt/photos/2024/trip', libraryId: 'lib-1' },
          { directory: '/mnt/photos/2023', libraryId: 'lib-1' },
          { directory: '/data/upload/u/ab/cd', libraryId: null },
          { directory: '/data/library/admin/2024', libraryId: null },
        ],
        roots,
      );

      expect([...desired.values()]).toEqual([
        { path: '/mnt/photos', name: 'photos', parentPath: null },
        { path: '/mnt/photos/2024', name: '2024', parentPath: '/mnt/photos' },
        { path: '/mnt/photos/2024/trip', name: 'trip', parentPath: '/mnt/photos/2024' },
        { path: '/mnt/photos/2023', name: '2023', parentPath: '/mnt/photos' },
        { path: '/data/library/admin', name: 'admin', parentPath: null },
        { path: '/data/library/admin/2024', name: '2024', parentPath: '/data/library/admin' },
      ]);
    });
  });

  describe('diffFolderAlbums', () => {
    const roots = buildFolderAlbumRoots([{ id: 'lib-1', importPaths: ['/mnt/photos'] }], libraryFolder);
    let counter = 0;
    const newId = () => `new-${++counter}`;

    beforeEach(() => {
      counter = 0;
    });

    it('should create missing albums parents first', () => {
      const desired = buildDesiredFolderAlbums([{ directory: '/mnt/photos/a/b', libraryId: 'lib-1' }], roots);
      const diff = diffFolderAlbums(desired, [], { deleteUndesired: true, newId });
      expect(diff).toEqual({
        create: [
          { id: 'new-1', folderPath: '/mnt/photos', albumName: 'photos', parentAlbumId: null },
          { id: 'new-2', folderPath: '/mnt/photos/a', albumName: 'a', parentAlbumId: 'new-1' },
          { id: 'new-3', folderPath: '/mnt/photos/a/b', albumName: 'b', parentAlbumId: 'new-2' },
        ],
        update: [],
        delete: [],
      });
    });

    it('should not touch albums that are already correct', () => {
      const desired = buildDesiredFolderAlbums([{ directory: '/mnt/photos/a', libraryId: 'lib-1' }], roots);
      const diff = diffFolderAlbums(
        desired,
        [
          { id: 'root', folderPath: '/mnt/photos', albumName: 'photos', parentAlbumId: null },
          { id: 'a', folderPath: '/mnt/photos/a', albumName: 'a', parentAlbumId: 'root' },
        ],
        { deleteUndesired: true, newId },
      );
      expect(diff).toEqual({ create: [], update: [], delete: [] });
    });

    it('should keep the album id of a renamed folder and fix its name and parent', () => {
      const desired = buildDesiredFolderAlbums([{ directory: '/mnt/photos/new/b', libraryId: 'lib-1' }], roots);
      const diff = diffFolderAlbums(
        desired,
        [
          { id: 'root', folderPath: '/mnt/photos', albumName: 'photos', parentAlbumId: null },
          { id: 'old', folderPath: '/mnt/photos/old', albumName: 'old', parentAlbumId: 'root' },
          { id: 'b', folderPath: '/mnt/photos/new/b', albumName: 'renamed', parentAlbumId: 'old' },
        ],
        { deleteUndesired: false, newId },
      );
      expect(diff.create).toEqual([
        { id: 'new-1', folderPath: '/mnt/photos/new', albumName: 'new', parentAlbumId: 'root' },
      ]);
      expect(diff.update).toEqual([{ id: 'b', albumName: 'b', parentAlbumId: 'new-1' }]);
      expect(diff.delete).toEqual([]);
    });

    it('should delete undesired albums only when asked', () => {
      const desired = buildDesiredFolderAlbums([], roots);
      const existing = [{ id: 'gone', folderPath: '/mnt/removed', albumName: 'removed', parentAlbumId: null }];
      expect(diffFolderAlbums(desired, existing, { deleteUndesired: true, newId }).delete).toEqual(['gone']);
      expect(diffFolderAlbums(desired, existing, { deleteUndesired: false, newId }).delete).toEqual([]);
    });
  });

  describe('getPrunableFolderAlbumIds', () => {
    it('should keep non-empty albums and their ancestors', () => {
      const albums = [
        { id: 'root', parentAlbumId: null },
        { id: 'a', parentAlbumId: 'root' },
        { id: 'a1', parentAlbumId: 'a' },
        { id: 'b', parentAlbumId: 'root' },
        { id: 'b1', parentAlbumId: 'b' },
        { id: 'other', parentAlbumId: null },
      ];
      expect(getPrunableFolderAlbumIds(albums, new Set(['a1']))).toEqual(['b', 'b1', 'other']);
      expect(getPrunableFolderAlbumIds(albums, new Set())).toEqual(albums.map(({ id }) => id));
    });

    it('should not loop on a cycle', () => {
      const albums = [
        { id: 'a', parentAlbumId: 'b' },
        { id: 'b', parentAlbumId: 'a' },
      ];
      expect(getPrunableFolderAlbumIds(albums, new Set(['a']))).toEqual([]);
    });
  });

  describe('queueFolderAlbumSync', () => {
    beforeEach(() => {
      resetFolderAlbumSyncThrottle();
    });

    it('should queue a debounced job per user', async () => {
      const jobRepository = { queueAll: vi.fn().mockResolvedValue(void 0) };
      await queueFolderAlbumSync(jobRepository, ['user-1', 'user-1', null, 'user-2']);
      expect(jobRepository.queueAll).toHaveBeenCalledWith([
        { name: JobName.FolderAlbumSync, data: { userId: 'user-1', debounce: true } },
        { name: JobName.FolderAlbumSync, data: { userId: 'user-2', debounce: true } },
      ]);
    });

    it('should throttle repeated debounced jobs locally', async () => {
      const jobRepository = { queueAll: vi.fn().mockResolvedValue(void 0) };
      await queueFolderAlbumSync(jobRepository, ['user-1']);
      await queueFolderAlbumSync(jobRepository, ['user-1']);
      expect(jobRepository.queueAll).toHaveBeenNthCalledWith(2, []);
    });

    it('should always queue full jobs', async () => {
      const jobRepository = { queueAll: vi.fn().mockResolvedValue(void 0) };
      await queueFolderAlbumSync(jobRepository, ['user-1']);
      await queueFolderAlbumSync(jobRepository, ['user-1'], { full: true });
      expect(jobRepository.queueAll).toHaveBeenNthCalledWith(2, [
        { name: JobName.FolderAlbumSync, data: { userId: 'user-1', full: true } },
      ]);
    });
  });
});
