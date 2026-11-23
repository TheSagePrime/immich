import { BadRequestException } from '@nestjs/common';
import { Dirent } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import { ViewService } from 'src/services/view.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getForAsset } from 'test/mappers.js';
import { factory, newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const dirent = (name: string, isDirectory: boolean) => ({ name, isDirectory: () => isDirectory }) as unknown as Dirent;

describe(ViewService.name, () => {
  let sut: ViewService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(ViewService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getUniqueOriginalPaths', () => {
    it('should return unique original paths', async () => {
      const mockPaths = ['path1', 'path2', 'path3'];
      mocks.view.getUniqueOriginalPaths.mockResolvedValue(mockPaths);

      const result = await sut.getUniqueOriginalPaths(authStub.admin);

      expect(result).toEqual(mockPaths);
      expect(mocks.view.getUniqueOriginalPaths).toHaveBeenCalledWith(authStub.admin.user.id);
    });
  });

  describe('getAssetsByOriginalPath', () => {
    it('should return assets by original path', async () => {
      const path = '/asset';

      const asset1 = AssetFactory.create({ originalPath: '/asset/path1' });
      const asset2 = AssetFactory.create({ originalPath: '/asset/path2' });

      const mockAssets = [asset1, asset2];

      const mockAssetReponseDto = mockAssets.map((asset) => mapAsset(getForAsset(asset), { auth: authStub.admin }));

      mocks.view.getAssetsByOriginalPath.mockResolvedValue(mockAssets as any);

      const result = await sut.getAssetsByOriginalPath(authStub.admin, path);
      expect(result).toEqual(mockAssetReponseDto);
      await expect(mocks.view.getAssetsByOriginalPath(authStub.admin.user.id, path)).resolves.toEqual(mockAssets);
    });
  });

  describe('getFolderSummary', () => {
    let root: string;

    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'immich-view-')));
      await mkdir(join(root, 'empty'));
      mocks.library.getAll.mockResolvedValue([]);
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('should map child folders and the direct asset count', async () => {
      const coverAssetId = newUuid();
      mocks.view.getFolderSummary.mockResolvedValue([
        { name: null, assetCount: 3, coverAssetId: null },
        { name: 'b', assetCount: 1, coverAssetId },
        { name: 'a', assetCount: 5, coverAssetId },
      ]);

      await expect(sut.getFolderSummary(authStub.user1, { path: 'photos/2020/' })).resolves.toEqual({
        path: '/photos/2020',
        directAssetCount: 3,
        children: [
          { name: 'a', path: '/photos/2020/a', assetCount: 5, coverAssetId },
          { name: 'b', path: '/photos/2020/b', assetCount: 1, coverAssetId },
        ],
        writable: false,
        libraryId: undefined,
        isLibraryRoot: false,
      });
      expect(mocks.view.getFolderSummary).toHaveBeenCalledWith(authStub.user1.user.id, '/photos/2020');
      expect(mocks.storage.readdirWithTypes).not.toHaveBeenCalled();
    });

    it('should normalize the root path', async () => {
      mocks.view.getFolderSummary.mockResolvedValue([]);

      await expect(sut.getFolderSummary(authStub.user1, { path: '' })).resolves.toMatchObject({
        path: '/',
        directAssetCount: 0,
        children: [],
      });
      expect(mocks.view.getFolderSummary).toHaveBeenCalledWith(authStub.user1.user.id, '/');
    });

    it('should reject NUL bytes', async () => {
      await expect(sut.getFolderSummary(authStub.user1, { path: '/photos\0' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.view.getFolderSummary).not.toHaveBeenCalled();
    });

    it('should merge empty folders from disk inside a writable library', async () => {
      const library = factory.library({
        ownerId: authStub.user1.user.id,
        importPaths: [root],
        writable: true,
        exclusionPatterns: ['**/@eaDir/**'],
      });
      mocks.library.getAll.mockResolvedValue([library]);
      mocks.view.getFolderSummary.mockResolvedValue([{ name: 'a', assetCount: 2, coverAssetId: newUuid() }]);
      mocks.storage.readdirWithTypes.mockResolvedValue([
        dirent('a', true),
        dirent('empty', true),
        dirent('.hidden', true),
        dirent('@eaDir', true),
        dirent('photo.jpg', false),
      ]);

      const result = await sut.getFolderSummary(authStub.user1, { path: root });

      expect(mocks.storage.readdirWithTypes).toHaveBeenCalledWith(root);
      expect(result).toMatchObject({ path: root, writable: true, libraryId: library.id, isLibraryRoot: true });
      expect(result.children.map(({ name, assetCount }) => ({ name, assetCount }))).toEqual([
        { name: 'a', assetCount: 2 },
        { name: 'empty', assetCount: 0 },
      ]);
    });

    it('should list a writable library root as a child of its ancestors', async () => {
      const library = factory.library({ ownerId: authStub.user1.user.id, importPaths: [root], writable: true });
      mocks.library.getAll.mockResolvedValue([library]);
      mocks.view.getFolderSummary.mockResolvedValue([]);

      const result = await sut.getFolderSummary(authStub.user1, { path: '/' });

      const [, topLevel] = root.split('/', 2);
      expect(result.children).toEqual([{ name: topLevel, path: `/${topLevel}`, assetCount: 0, coverAssetId: null }]);
      expect(result.writable).toBe(false);
    });

    it('should not mark folders of libraries owned by other users as writable', async () => {
      const library = factory.library({ ownerId: newUuid(), importPaths: [root], writable: true });
      mocks.library.getAll.mockResolvedValue([library]);
      mocks.view.getFolderSummary.mockResolvedValue([]);

      await expect(sut.getFolderSummary(authStub.user1, { path: root })).resolves.toMatchObject({ writable: false });
      expect(mocks.storage.readdirWithTypes).not.toHaveBeenCalled();
    });

    it('should not mark read-only libraries as writable', async () => {
      const library = factory.library({ ownerId: authStub.user1.user.id, importPaths: [root], writable: false });
      mocks.library.getAll.mockResolvedValue([library]);
      mocks.view.getFolderSummary.mockResolvedValue([]);

      await expect(sut.getFolderSummary(authStub.user1, { path: root })).resolves.toMatchObject({ writable: false });
    });
  });
});
