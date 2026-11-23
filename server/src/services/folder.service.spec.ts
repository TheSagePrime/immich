import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetStatus, DatabaseLock } from 'src/enum.js';
import { FolderService } from 'src/services/folder.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { factory, newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const errnoError = (code: string) => Object.assign(new Error(code), { code });

const libraryAsset = (path: string, options: Record<string, unknown> = {}) => ({
  id: newUuid(),
  originalPath: path,
  livePhotoVideoId: null,
  libraryId: null as string | null,
  ownerId: authStub.user1.user.id,
  deletedAt: null,
  sidecarPath: null,
  ...options,
});

describe(FolderService.name, () => {
  let sut: FolderService;
  let mocks: ServiceMocks;
  let base: string;
  let root: string;
  let outside: string;

  const libraryFor = (options: Partial<ReturnType<typeof factory.library>> = {}) =>
    factory.library({ ownerId: authStub.user1.user.id, importPaths: [root], writable: true, ...options });

  beforeEach(async () => {
    ({ sut, mocks } = newTestService(FolderService));

    base = await realpath(await mkdtemp(join(tmpdir(), 'immich-folder-')));
    root = join(base, 'library');
    outside = join(base, 'outside');
    await mkdir(join(root, 'a', 'x'), { recursive: true });
    await mkdir(join(root, 'b'), { recursive: true });
    await mkdir(outside);
    await writeFile(join(root, 'a', 'photo.jpg'), 'photo');
    await symlink(outside, join(root, 'escape'));

    mocks.storage.realpath.mockImplementation((path) => realpath(path));
    mocks.storage.lstat.mockImplementation((path) => lstat(path));
    mocks.storage.readdirWithTypes.mockImplementation((path) => readdir(path, { withFileTypes: true }));
    mocks.storage.checkFileExists.mockResolvedValue(true);
    mocks.view.hasLibraryAssetsAtPath.mockResolvedValue(false);
    mocks.view.getLibraryAssetsByPath.mockResolvedValue([]);
    mocks.view.getAssetPathsByIds.mockResolvedValue([]);
    mocks.view.rewritePaths.mockImplementation((_, beforeCommit) => beforeCommit());
    mocks.crypto.hashSha1.mockImplementation((value) => Buffer.from(String(value)));
    mocks.library.getAll.mockResolvedValue([libraryFor()]);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  describe('browse', () => {
    it('should list the writable library roots', async () => {
      mocks.library.getAll.mockResolvedValue([libraryFor(), libraryFor({ writable: false, importPaths: [outside] })]);

      await expect(sut.browse(authStub.user1, {})).resolves.toEqual({
        path: null,
        parentPath: null,
        entries: [{ name: root, path: root }],
      });
    });

    it('should list child folders without symbolic links', async () => {
      await expect(sut.browse(authStub.user1, { path: join(root, 'a') })).resolves.toEqual({
        path: join(root, 'a'),
        parentPath: root,
        entries: [{ name: 'x', path: join(root, 'a', 'x') }],
      });
    });

    it('should refuse folders outside of writable libraries', async () => {
      await expect(sut.browse(authStub.user1, { path: outside })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('create', () => {
    it('should create a folder', async () => {
      await expect(sut.create(authStub.user1, { parentPath: join(root, 'a'), name: ' new ' })).resolves.toEqual({
        path: join(root, 'a', 'new'),
      });

      expect(mocks.database.withLock).toHaveBeenCalledWith(DatabaseLock.FolderManagement, expect.any(Function));
      expect(mocks.storage.mkdir).toHaveBeenCalledWith(join(root, 'a', 'new'));
    });

    it('should report an existing folder as a conflict', async () => {
      mocks.storage.mkdir.mockRejectedValue(errnoError('EEXIST'));

      await expect(sut.create(authStub.user1, { parentPath: root, name: 'a' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it.each(['..', '.', '.hidden', 'a/b', String.raw`a\b`, 'a\0b'])('should refuse the name %j', async (name) => {
      await expect(sut.create(authStub.user1, { parentPath: root, name })).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.storage.mkdir).not.toHaveBeenCalled();
    });

    it('should refuse names that match an exclusion pattern', async () => {
      mocks.library.getAll.mockResolvedValue([libraryFor({ exclusionPatterns: ['**/@eaDir/**'] })]);

      await expect(sut.create(authStub.user1, { parentPath: root, name: '@eaDir' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should refuse paths that leave the library through a symbolic link', async () => {
      await expect(
        sut.create(authStub.user1, { parentPath: join(root, 'escape'), name: 'new' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.storage.mkdir).not.toHaveBeenCalled();
    });

    it('should refuse paths outside of a writable library', async () => {
      mocks.library.getAll.mockResolvedValue([libraryFor({ writable: false })]);

      await expect(sut.create(authStub.user1, { parentPath: root, name: 'new' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('should refuse libraries of other users', async () => {
      mocks.library.getAll.mockResolvedValue([libraryFor({ ownerId: newUuid() })]);

      await expect(sut.create(authStub.user1, { parentPath: root, name: 'new' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('should allow admins to manage libraries of other users', async () => {
      mocks.library.getAll.mockResolvedValue([libraryFor({ ownerId: newUuid() })]);

      await expect(sut.create(authStub.admin, { parentPath: root, name: 'new' })).resolves.toEqual({
        path: join(root, 'new'),
      });
    });
  });

  describe('rename', () => {
    it('should rename a folder and rewrite the asset paths', async () => {
      const library = libraryFor();
      mocks.library.getAll.mockResolvedValue([library]);
      const asset = libraryAsset(join(root, 'a', 'photo.jpg'), { libraryId: library.id });
      mocks.view.getLibraryAssetsByPath.mockResolvedValue([asset]);

      await expect(sut.rename(authStub.user1, { path: join(root, 'a'), name: 'renamed' })).resolves.toEqual({
        path: join(root, 'renamed'),
      });

      const newPath = join(root, 'renamed', 'photo.jpg');
      expect(mocks.view.rewritePaths).toHaveBeenCalledWith(
        {
          assets: [{ id: asset.id, originalPath: newPath, checksum: Buffer.from(`path:${newPath}`) }],
          sidecars: [],
          folders: [{ libraryId: library.id, from: join(root, 'a'), to: join(root, 'renamed') }],
        },
        expect.any(Function),
      );
      expect(mocks.storage.rename).toHaveBeenCalledWith(join(root, 'a'), join(root, 'renamed'));
    });

    it('should refuse to rename the library folder', async () => {
      await expect(sut.rename(authStub.user1, { path: root, name: 'renamed' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should refuse an existing target', async () => {
      await expect(sut.rename(authStub.user1, { path: join(root, 'a'), name: 'b' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mocks.storage.rename).not.toHaveBeenCalled();
    });

    it('should refuse a target that still has assets in the database', async () => {
      mocks.view.hasLibraryAssetsAtPath.mockResolvedValue(true);

      await expect(sut.rename(authStub.user1, { path: join(root, 'a'), name: 'c' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('should move the folder back when the database update fails', async () => {
      mocks.view.rewritePaths.mockImplementation(async (_, beforeCommit) => {
        await beforeCommit();
        throw new Error('commit failed');
      });

      await expect(sut.rename(authStub.user1, { path: join(root, 'a'), name: 'c' })).rejects.toThrow('commit failed');

      expect(mocks.storage.rename).toHaveBeenNthCalledWith(1, join(root, 'a'), join(root, 'c'));
      expect(mocks.storage.rename).toHaveBeenNthCalledWith(2, join(root, 'c'), join(root, 'a'));
    });

    it('should not touch the disk when the rename fails', async () => {
      mocks.storage.rename.mockRejectedValue(errnoError('EXDEV'));

      await expect(sut.rename(authStub.user1, { path: join(root, 'a'), name: 'c' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.storage.rename).toHaveBeenCalledTimes(1);
    });
  });

  describe('move', () => {
    it('should refuse to move a folder into itself', async () => {
      await expect(
        sut.move(authStub.user1, { folderPaths: [join(root, 'a')], destination: join(root, 'a', 'x') }),
      ).resolves.toEqual({
        moved: 0,
        failed: [{ path: join(root, 'a'), reason: 'A folder cannot be moved into itself' }],
      });
      expect(mocks.storage.rename).not.toHaveBeenCalled();
    });

    it('should refuse to move between libraries', async () => {
      const other = join(base, 'other');
      await mkdir(other);
      mocks.library.getAll.mockResolvedValue([libraryFor(), libraryFor({ importPaths: [other] })]);

      const result = await sut.move(authStub.user1, { folderPaths: [join(root, 'a')], destination: other });

      expect(result.moved).toBe(0);
      expect(result.failed[0].reason).toBe('Folders can only be moved inside the same library');
    });

    it('should move a folder', async () => {
      await expect(
        sut.move(authStub.user1, { folderPaths: [join(root, 'a')], destination: join(root, 'b') }),
      ).resolves.toEqual({ moved: 1, failed: [] });
      expect(mocks.storage.rename).toHaveBeenCalledWith(join(root, 'a'), join(root, 'b', 'a'));
    });

    it('should move files of a writable library with their sidecar', async () => {
      const library = libraryFor();
      mocks.library.getAll.mockResolvedValue([library]);
      await writeFile(join(root, 'a', 'photo.jpg.xmp'), 'xmp');
      const asset = libraryAsset(join(root, 'a', 'photo.jpg'), {
        libraryId: library.id,
        sidecarPath: join(root, 'a', 'photo.jpg.xmp'),
      });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.view.getAssetPathsByIds.mockResolvedValue([asset]);

      await expect(sut.move(authStub.user1, { assetIds: [asset.id], destination: join(root, 'b') })).resolves.toEqual({
        moved: 1,
        failed: [],
      });

      expect(mocks.storage.link).toHaveBeenCalledWith(join(root, 'a', 'photo.jpg'), join(root, 'b', 'photo.jpg'));
      expect(mocks.storage.link).toHaveBeenCalledWith(
        join(root, 'a', 'photo.jpg.xmp'),
        join(root, 'b', 'photo.jpg.xmp'),
      );
      expect(mocks.storage.unlink).toHaveBeenCalledWith(join(root, 'a', 'photo.jpg'));
      expect(mocks.view.rewritePaths).toHaveBeenCalledWith(
        expect.objectContaining({
          assets: [expect.objectContaining({ id: asset.id, originalPath: join(root, 'b', 'photo.jpg') })],
          sidecars: [{ assetId: asset.id, path: join(root, 'b', 'photo.jpg.xmp') }],
        }),
        expect.any(Function),
      );
    });

    it('should copy when hard links are not possible', async () => {
      const library = libraryFor();
      mocks.library.getAll.mockResolvedValue([library]);
      const asset = libraryAsset(join(root, 'a', 'photo.jpg'), { libraryId: library.id });
      const stats = await lstat(join(root, 'a', 'photo.jpg'));
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.view.getAssetPathsByIds.mockResolvedValue([asset]);
      mocks.storage.link.mockRejectedValue(errnoError('EXDEV'));
      mocks.storage.stat.mockResolvedValue(stats);

      await expect(sut.move(authStub.user1, { assetIds: [asset.id], destination: join(root, 'b') })).resolves.toEqual({
        moved: 1,
        failed: [],
      });

      expect(mocks.storage.copyFileExclusive).toHaveBeenCalledWith(
        join(root, 'a', 'photo.jpg'),
        join(root, 'b', 'photo.jpg'),
      );
      expect(mocks.storage.utimes).toHaveBeenCalledWith(join(root, 'b', 'photo.jpg'), stats.atime, stats.mtime);
      expect(mocks.storage.unlink).toHaveBeenCalledWith(join(root, 'a', 'photo.jpg'));
    });

    it('should move the live photo video next to the photo', async () => {
      const library = libraryFor();
      mocks.library.getAll.mockResolvedValue([library]);
      await writeFile(join(root, 'a', 'photo.mov'), 'video');
      const motion = libraryAsset(join(root, 'a', 'photo.mov'), { libraryId: library.id });
      const asset = libraryAsset(join(root, 'a', 'photo.jpg'), { libraryId: library.id, livePhotoVideoId: motion.id });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.view.getAssetPathsByIds.mockImplementation((ids) =>
        Promise.resolve(ids.includes(motion.id) ? [motion] : [asset]),
      );
      mocks.asset.getLivePhotoCount.mockResolvedValue(1);

      await sut.move(authStub.user1, { assetIds: [asset.id], destination: join(root, 'b') });

      expect(mocks.storage.link).toHaveBeenCalledWith(join(root, 'a', 'photo.mov'), join(root, 'b', 'photo.mov'));
      expect(mocks.view.rewritePaths).toHaveBeenCalledWith(
        expect.objectContaining({
          assets: [
            expect.objectContaining({ id: asset.id }),
            expect.objectContaining({ id: motion.id, originalPath: join(root, 'b', 'photo.mov') }),
          ],
        }),
        expect.any(Function),
      );
    });

    it('should restore moved files when the database update fails', async () => {
      const library = libraryFor();
      mocks.library.getAll.mockResolvedValue([library]);
      const asset = libraryAsset(join(root, 'a', 'photo.jpg'), { libraryId: library.id });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.view.getAssetPathsByIds.mockResolvedValue([asset]);
      mocks.view.rewritePaths.mockImplementation(async (_, beforeCommit) => {
        await beforeCommit();
        throw new Error('commit failed');
      });

      const result = await sut.move(authStub.user1, { assetIds: [asset.id], destination: join(root, 'b') });

      expect(result).toEqual({ moved: 0, failed: [{ assetId: asset.id, reason: 'Unexpected error' }] });
      expect(mocks.storage.link).toHaveBeenNthCalledWith(2, join(root, 'b', 'photo.jpg'), join(root, 'a', 'photo.jpg'));
    });

    it('should refuse uploaded assets and assets without access', async () => {
      const asset = libraryAsset(join(root, 'a', 'photo.jpg'));
      const forbiddenId = newUuid();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.view.getAssetPathsByIds.mockResolvedValue([asset]);

      await expect(
        sut.move(authStub.user1, { assetIds: [asset.id, forbiddenId], destination: join(root, 'b') }),
      ).resolves.toEqual({
        moved: 0,
        failed: [
          { assetId: forbiddenId, reason: 'No access' },
          { assetId: asset.id, reason: 'Only assets of writable external libraries can be managed' },
        ],
      });
      expect(mocks.storage.link).not.toHaveBeenCalled();
    });
  });

  describe('renameAsset', () => {
    it('should rename a file and keep the extension', async () => {
      const library = libraryFor();
      mocks.library.getAll.mockResolvedValue([library]);
      const asset = libraryAsset(join(root, 'a', 'photo.jpg'), { libraryId: library.id });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.view.getAssetPathsByIds.mockResolvedValue([asset]);

      await expect(sut.renameAsset(authStub.user1, asset.id, { name: 'beach.JPG' })).resolves.toEqual({
        id: asset.id,
        originalPath: join(root, 'a', 'beach.JPG'),
        originalFileName: 'beach.JPG',
      });
      expect(mocks.view.rewritePaths).toHaveBeenCalledWith(
        expect.objectContaining({
          assets: [expect.objectContaining({ id: asset.id, originalFileName: 'beach.JPG' })],
        }),
        expect.any(Function),
      );
    });

    it('should refuse a different extension', async () => {
      const library = libraryFor();
      mocks.library.getAll.mockResolvedValue([library]);
      const asset = libraryAsset(join(root, 'a', 'photo.jpg'), { libraryId: library.id });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.view.getAssetPathsByIds.mockResolvedValue([asset]);

      await expect(sut.renameAsset(authStub.user1, asset.id, { name: 'photo.png' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should require access to the asset', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.renameAsset(authStub.user1, newUuid(), { name: 'photo.jpg' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('delete', () => {
    it('should trash assets of a writable library', async () => {
      const library = libraryFor();
      mocks.library.getAll.mockResolvedValue([library]);
      const asset = libraryAsset(join(root, 'a', 'photo.jpg'), { libraryId: library.id });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.view.getAssetPathsByIds.mockResolvedValue([asset]);

      await expect(sut.delete(authStub.user1, { assetIds: [asset.id] })).resolves.toEqual({
        trashed: 1,
        deleted: 0,
        removedFolders: 0,
        failed: [],
      });

      expect(mocks.asset.updateAll).toHaveBeenCalledWith([asset.id], {
        deletedAt: expect.any(Date),
        status: AssetStatus.Trashed,
      });
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetTrashAll', {
        assetIds: [asset.id],
        userId: authStub.user1.user.id,
      });
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('should delete folders permanently with force', async () => {
      const library = libraryFor();
      mocks.library.getAll.mockResolvedValue([library]);
      const id = newUuid();
      mocks.view.trashLibraryFolder.mockResolvedValue([{ id, originalPath: join(root, 'a', 'photo.jpg') }]);

      await expect(sut.delete(authStub.user1, { folderPaths: [join(root, 'a')], force: true })).resolves.toEqual({
        trashed: 0,
        deleted: 1,
        removedFolders: 0,
        failed: [],
      });

      expect(mocks.view.trashLibraryFolder).toHaveBeenCalledWith(library.id, join(root, 'a'), AssetStatus.Deleted);
      expect(mocks.storage.removeEmptyDirs).toHaveBeenCalledWith(join(root, 'a'), true);
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetDeleteAll', {
        assetIds: [id],
        userId: authStub.user1.user.id,
      });
    });

    it('should count removed empty folders', async () => {
      mocks.view.trashLibraryFolder.mockResolvedValue([]);
      mocks.storage.removeEmptyDirs.mockImplementation((path) => rm(path, { recursive: true }));

      await expect(sut.delete(authStub.user1, { folderPaths: [join(root, 'b')] })).resolves.toEqual({
        trashed: 0,
        deleted: 0,
        removedFolders: 1,
        failed: [],
      });
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('should refuse to delete the library folder', async () => {
      await expect(sut.delete(authStub.user1, { folderPaths: [root] })).resolves.toEqual({
        trashed: 0,
        deleted: 0,
        removedFolders: 0,
        failed: [{ path: root, reason: 'The library folder itself cannot be changed' }],
      });
      expect(mocks.view.trashLibraryFolder).not.toHaveBeenCalled();
    });

    it('should refuse uploaded assets', async () => {
      const asset = libraryAsset('/upload/photo.jpg');
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.view.getAssetPathsByIds.mockResolvedValue([asset]);

      const result = await sut.delete(authStub.user1, { assetIds: [asset.id] });

      expect(result.failed).toEqual([
        { assetId: asset.id, reason: 'Only assets of writable external libraries can be managed' },
      ]);
      expect(mocks.asset.updateAll).not.toHaveBeenCalled();
    });
  });
});
