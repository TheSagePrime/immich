import { beforeEach, describe, expect, it } from 'vitest';
import { FOLDER_ALBUM_SYNC_OVERLAP_MS } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetOrder, JobName, JobStatus, UserMetadataKey } from 'src/enum.js';
import { FolderAlbumService } from 'src/services/folder-album.service.js';
import { buildFolderAlbumRoots, getFolderAlbumRootsKey, resetFolderAlbumSyncThrottle } from 'src/utils/folder-album.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const userId = 'user-1';
const now = new Date('2026-01-01T12:00:00.000Z');

const rootsKey = () =>
  getFolderAlbumRootsKey(
    buildFolderAlbumRoots([{ id: 'lib-1', importPaths: ['/mnt/photos'] }], {
      path: '/data/library/admin',
      name: 'admin',
    }),
  );

describe(FolderAlbumService.name, () => {
  let sut: FolderAlbumService;
  let mocks: ServiceMocks;
  let ids: number;

  beforeEach(() => {
    StorageCore.setMediaLocation('/data');
    resetFolderAlbumSyncThrottle();
    ({ sut, mocks } = newTestService(FolderAlbumService));
    ids = 0;
    mocks.crypto.randomUUID.mockImplementation(
      () => `new-${++ids}` as `${string}-${string}-${string}-${string}-${string}`,
    );
    mocks.database.withLock.mockImplementation((_lock, callback) => callback());
    mocks.folderAlbum.getUser.mockResolvedValue({ id: userId, storageLabel: 'admin', deletedAt: null });
    mocks.folderAlbum.getLibraries.mockResolvedValue([{ id: 'lib-1', importPaths: ['/mnt/photos'] }]);
    mocks.folderAlbum.getDatabaseTime.mockResolvedValue(now);
    mocks.folderAlbum.getFolderAlbums.mockResolvedValue([]);
    mocks.folderAlbum.getDirectories.mockResolvedValue([]);
    mocks.folderAlbum.getNonEmptyFolderAlbumIds.mockResolvedValue(new Set());
    mocks.folderAlbum.removeStaleMembers.mockResolvedValue(0);
    mocks.folderAlbum.addMembers.mockResolvedValue(0);
    mocks.user.getMetadata.mockResolvedValue([]);
    mocks.folderAlbum.getState.mockResolvedValue(void 0);
    mocks.folderAlbum.deleteAll.mockResolvedValue();
    mocks.folderAlbum.deleteState.mockResolvedValue();
    mocks.folderAlbum.deleteFolderAlbums.mockResolvedValue();
    mocks.folderAlbum.createFolderAlbums.mockResolvedValue();
    mocks.folderAlbum.updateFolderAlbums.mockResolvedValue();
    mocks.folderAlbum.saveState.mockResolvedValue();
    mocks.album.updateThumbnails.mockResolvedValue(0);
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('events', () => {
    it('should queue a debounced sync on asset create', async () => {
      await sut.onAssetCreate({ asset: { id: 'asset-1', ownerId: userId } });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.FolderAlbumSync, data: { userId, debounce: true } },
      ]);
    });

    it.each([
      ['onAssetTrash', { assetId: 'asset-1', userId }],
      ['onAssetDelete', { assetId: 'asset-1', userId }],
      ['onAssetHide', { assetId: 'asset-1', userId }],
      ['onAssetShow', { assetId: 'asset-1', userId }],
      ['onAssetMetadataExtracted', { assetId: 'asset-1', userId }],
      ['onAssetTrashAll', { assetIds: ['asset-1'], userId }],
      ['onAssetDeleteAll', { assetIds: ['asset-1'], userId }],
      ['onAssetRestoreAll', { assetIds: ['asset-1'], userId }],
    ] as const)('should queue a debounced sync on %s', async (method, payload) => {
      await (sut[method] as (payload: unknown) => Promise<void>)(payload);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.FolderAlbumSync, data: { userId, debounce: true } },
      ]);
    });

    it('should queue the backfill on bootstrap', async () => {
      await sut.onBootstrap();
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.FolderAlbumSyncQueueAll, data: { full: false } });
    });
  });

  describe('handleQueueAll', () => {
    it('should queue one sync per user', async () => {
      mocks.user.getList.mockResolvedValue([{ id: 'user-1' }, { id: 'user-2' }] as any);
      await expect(sut.handleQueueAll({ full: true })).resolves.toBe(JobStatus.Success);
      expect(mocks.user.getList).toHaveBeenCalledWith({ withDeleted: false });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.FolderAlbumSync, data: { userId: 'user-1', full: true } },
        { name: JobName.FolderAlbumSync, data: { userId: 'user-2', full: true } },
      ]);
    });
  });

  describe('handleSync', () => {
    it('should skip a missing user', async () => {
      mocks.folderAlbum.getUser.mockResolvedValue(void 0);
      await expect(sut.handleSync({ userId })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.folderAlbum.createFolderAlbums).not.toHaveBeenCalled();
    });

    it('should skip a deleted user', async () => {
      mocks.folderAlbum.getUser.mockResolvedValue({ id: userId, storageLabel: null, deletedAt: now });
      await expect(sut.handleSync({ userId })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.folderAlbum.deleteAll).not.toHaveBeenCalled();
    });

    it('should delete all folder albums when the preference is off', async () => {
      mocks.user.getMetadata.mockResolvedValue([
        { key: UserMetadataKey.Preferences, value: { folderAlbums: { enabled: false } } },
      ]);
      await expect(sut.handleSync({ userId })).resolves.toBe(JobStatus.Success);
      expect(mocks.folderAlbum.deleteAll).toHaveBeenCalledWith(userId);
      expect(mocks.folderAlbum.deleteState).toHaveBeenCalledWith(userId);
      expect(mocks.folderAlbum.getDirectories).not.toHaveBeenCalled();
    });

    it('should run a full sync when there is no state', async () => {
      mocks.folderAlbum.getState.mockResolvedValue(void 0);
      mocks.folderAlbum.getDirectories.mockResolvedValue([
        { directory: '/mnt/photos/2024/trip', libraryId: 'lib-1' },
        { directory: '/data/upload/user-1/ab/cd', libraryId: null },
      ]);
      mocks.folderAlbum.addMembers.mockResolvedValue(3);

      await expect(sut.handleSync({ userId })).resolves.toBe(JobStatus.Success);

      expect(mocks.folderAlbum.getDirectories).toHaveBeenCalledWith(userId, undefined);
      expect(mocks.folderAlbum.createFolderAlbums).toHaveBeenCalledWith(
        [
          { id: 'new-1', folderPath: '/mnt/photos', albumName: 'photos', parentAlbumId: null },
          { id: 'new-2', folderPath: '/mnt/photos/2024', albumName: '2024', parentAlbumId: 'new-1' },
          { id: 'new-3', folderPath: '/mnt/photos/2024/trip', albumName: 'trip', parentAlbumId: 'new-2' },
        ],
        userId,
        AssetOrder.Desc,
      );
      expect(mocks.folderAlbum.removeStaleMembers).toHaveBeenCalledWith(userId, undefined);
      expect(mocks.folderAlbum.addMembers).toHaveBeenCalledWith(userId, undefined);
      expect(mocks.album.updateThumbnails).toHaveBeenCalled();
      expect(mocks.folderAlbum.saveState).toHaveBeenCalledWith({
        userId,
        checkpointAt: now,
        rootsKey: rootsKey(),
        fullSyncAt: now,
      });
    });

    it('should use the album order preference for new albums', async () => {
      mocks.user.getMetadata.mockResolvedValue([
        { key: UserMetadataKey.Preferences, value: { albums: { defaultAssetOrder: AssetOrder.Asc } } },
      ]);
      mocks.folderAlbum.getDirectories.mockResolvedValue([{ directory: '/mnt/photos', libraryId: 'lib-1' }]);
      await sut.handleSync({ userId });
      expect(mocks.folderAlbum.createFolderAlbums).toHaveBeenCalledWith(expect.any(Array), userId, AssetOrder.Asc);
    });

    it('should run an incremental sync from the checkpoint with an overlap', async () => {
      const checkpointAt = new Date('2026-01-01T11:00:00.000Z');
      mocks.folderAlbum.getState.mockResolvedValue({
        userId,
        checkpointAt,
        fullSyncAt: checkpointAt,
        rootsKey: rootsKey(),
      });
      mocks.folderAlbum.getFolderAlbums.mockResolvedValue([
        { id: 'root', folderPath: '/mnt/photos', albumName: 'photos', parentAlbumId: null },
        { id: 'old', folderPath: '/mnt/photos/old', albumName: 'old', parentAlbumId: 'root' },
      ]);
      mocks.folderAlbum.getDirectories.mockResolvedValue([{ directory: '/mnt/photos/new', libraryId: 'lib-1' }]);
      mocks.folderAlbum.getNonEmptyFolderAlbumIds.mockResolvedValue(new Set(['old']));

      await sut.handleSync({ userId });

      const since = new Date(checkpointAt.getTime() - FOLDER_ALBUM_SYNC_OVERLAP_MS);
      expect(mocks.folderAlbum.getDirectories).toHaveBeenCalledWith(userId, since);
      expect(mocks.folderAlbum.deleteFolderAlbums).toHaveBeenNthCalledWith(1, []);
      expect(mocks.folderAlbum.createFolderAlbums).toHaveBeenCalledWith(
        [{ id: 'new-1', folderPath: '/mnt/photos/new', albumName: 'new', parentAlbumId: 'root' }],
        userId,
        AssetOrder.Desc,
      );
      expect(mocks.folderAlbum.updateFolderAlbums).toHaveBeenCalledWith([]);
      expect(mocks.folderAlbum.removeStaleMembers).toHaveBeenCalledWith(userId, since);
      expect(mocks.folderAlbum.addMembers).toHaveBeenCalledWith(userId, since);
      expect(mocks.album.updateThumbnails).not.toHaveBeenCalled();
      expect(mocks.folderAlbum.saveState).toHaveBeenCalledWith({
        userId,
        checkpointAt: now,
        rootsKey: rootsKey(),
        fullSyncAt: undefined,
      });
    });

    it('should run a full sync when the roots changed', async () => {
      mocks.folderAlbum.getState.mockResolvedValue({ userId, checkpointAt: now, fullSyncAt: now, rootsKey: 'old' });
      mocks.folderAlbum.getFolderAlbums.mockResolvedValue([
        { id: 'gone', folderPath: '/mnt/removed', albumName: 'removed', parentAlbumId: null },
      ]);
      await sut.handleSync({ userId });
      expect(mocks.folderAlbum.getDirectories).toHaveBeenCalledWith(userId, undefined);
      expect(mocks.folderAlbum.deleteFolderAlbums).toHaveBeenNthCalledWith(1, ['gone']);
    });

    it('should run a full sync when asked', async () => {
      mocks.folderAlbum.getState.mockResolvedValue({
        userId,
        checkpointAt: now,
        fullSyncAt: now,
        rootsKey: rootsKey(),
      });
      await sut.handleSync({ userId, full: true });
      expect(mocks.folderAlbum.getDirectories).toHaveBeenCalledWith(userId, undefined);
    });

    it('should prune empty folder albums but keep ancestors of non-empty ones', async () => {
      mocks.folderAlbum.getFolderAlbums.mockResolvedValue([
        { id: 'root', folderPath: '/mnt/photos', albumName: 'photos', parentAlbumId: null },
        { id: 'a', folderPath: '/mnt/photos/a', albumName: 'a', parentAlbumId: 'root' },
        { id: 'a1', folderPath: '/mnt/photos/a/1', albumName: '1', parentAlbumId: 'a' },
        { id: 'b', folderPath: '/mnt/photos/b', albumName: 'b', parentAlbumId: 'root' },
      ]);
      mocks.folderAlbum.getDirectories.mockResolvedValue([
        { directory: '/mnt/photos/a/1', libraryId: 'lib-1' },
        { directory: '/mnt/photos/b', libraryId: 'lib-1' },
      ]);
      mocks.folderAlbum.getNonEmptyFolderAlbumIds.mockResolvedValue(new Set(['a1']));

      await sut.handleSync({ userId });

      expect(mocks.folderAlbum.deleteFolderAlbums).toHaveBeenLastCalledWith(['b']);
    });
  });
});
