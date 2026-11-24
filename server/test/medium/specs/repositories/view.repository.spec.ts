import { Kysely, sql } from 'kysely';
import { AssetFileType, AssetStatus, AssetVisibility } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ViewRepository } from 'src/repositories/view-repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, {
    database: defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(ViewRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

const date = (day: number) => new Date(Date.UTC(2024, 0, day));

describe(ViewRepository.name, () => {
  describe('getAssetsByOriginalPath', () => {
    it('should only return assets directly in the folder', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: '/photos/a_b/1.jpg' });
      await ctx.newAsset({ ownerId: user.id, originalPath: '/photos/a_b/sub/2.jpg' });
      await ctx.newAsset({ ownerId: user.id, originalPath: '/photos/a-b/3.jpg' });
      await ctx.newAsset({ ownerId: user.id, originalPath: '/backup/photos/a_b/4.jpg' });
      const { asset: rootAsset } = await ctx.newAsset({ ownerId: user.id, originalPath: '/5.jpg' });

      const getIds = async (path: string) => {
        const assets = await sut.getAssetsByOriginalPath(user.id, path);
        return assets.map(({ id }) => id);
      };

      for (const path of ['/photos/a_b', '/photos/a_b/', 'photos/a_b']) {
        await expect(getIds(path)).resolves.toEqual([asset.id]);
      }
      await expect(getIds('/')).resolves.toEqual([rootAsset.id]);
    });
  });

  describe('getFolderDirectories', () => {
    it('should count the assets of the user per library and directory with the newest cover', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const library = await ctx.database
        .insertInto('library')
        .values({ ownerId: user.id, name: 'Media', importPaths: ['/mnt/media'], exclusionPatterns: [] })
        .returningAll()
        .executeTakeFirstOrThrow();

      await ctx.newAsset({
        ownerId: user.id,
        libraryId: library.id,
        originalPath: '/mnt/media/Trips/a.jpg',
        fileCreatedAt: date(1),
      });
      const { asset: newest } = await ctx.newAsset({
        ownerId: user.id,
        libraryId: library.id,
        originalPath: '/mnt/media/Trips/b.jpg',
        fileCreatedAt: date(4),
      });
      const { asset: upload } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: '/data/library/admin/2026/c.jpg',
        fileCreatedAt: date(2),
      });
      const { asset: atRoot } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: '/d.jpg',
        fileCreatedAt: date(3),
      });
      await ctx.newAsset({ ownerId: user.id, originalPath: '/data/library/admin/2026/e.jpg', deletedAt: date(5) });
      await ctx.newAsset({ ownerId: otherUser.id, originalPath: '/mnt/media/Trips/f.jpg' });

      await expect(sut.getFolderDirectories(user.id)).resolves.toEqual([
        { libraryId: null, directoryPath: '', assetCount: 1, coverAssetId: atRoot.id, newestTakenAt: date(3) },
        {
          libraryId: null,
          directoryPath: '/data/library/admin/2026',
          assetCount: 1,
          coverAssetId: upload.id,
          newestTakenAt: date(2),
        },
        {
          libraryId: library.id,
          directoryPath: '/mnt/media/Trips',
          assetCount: 2,
          coverAssetId: newest.id,
          newestTakenAt: date(4),
        },
      ]);
    });
  });

  describe('getFolderSummary', () => {
    it('should count assets per child folder and pick the newest asset as cover', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();

      await ctx.newAsset({ ownerId: user.id, originalPath: '/photos/a_b/1.jpg', fileCreatedAt: date(1) });
      const { asset: newest } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: '/photos/a_b/sub/2.jpg',
        fileCreatedAt: date(5),
      });
      const { asset: other } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: '/photos/axb/3.jpg',
        fileCreatedAt: date(2),
      });
      await ctx.newAsset({ ownerId: user.id, originalPath: '/photos/direct.jpg' });
      await ctx.newAsset({
        ownerId: user.id,
        originalPath: '/photos/a_b/trashed.jpg',
        deletedAt: date(9),
        fileCreatedAt: date(9),
      });
      await ctx.newAsset({
        ownerId: user.id,
        originalPath: '/photos/a_b/hidden.mov',
        visibility: AssetVisibility.Hidden,
        fileCreatedAt: date(9),
      });
      await ctx.newAsset({ ownerId: otherUser.id, originalPath: '/photos/a_b/other.jpg', fileCreatedAt: date(9) });
      await ctx.newAsset({ ownerId: user.id, originalPath: '/photosx/4.jpg' });

      await expect(sut.getFolderSummary(user.id, '/photos/')).resolves.toMatchObject([
        { name: null, assetCount: 1, coverAssetId: null },
        { name: 'a_b', assetCount: 2, coverAssetId: newest.id },
        { name: 'axb', assetCount: 1, coverAssetId: other.id },
      ]);

      await expect(sut.getFolderSummary(user.id, 'photos/a_')).resolves.toMatchObject([]);
    });

    it('should return the date and size metrics of each child folder', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const { asset: first } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: '/photos/trip/1.jpg',
        fileCreatedAt: date(3),
        createdAt: date(20),
      });
      const { asset: second } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: '/photos/trip/day 2/2.jpg',
        fileCreatedAt: date(7),
        createdAt: date(15),
      });
      await ctx.newAsset({
        ownerId: user.id,
        originalPath: '/photos/trip/3.jpg',
        fileCreatedAt: date(5),
        createdAt: date(25),
      });
      const { asset: direct } = await ctx.newAsset({
        ownerId: user.id,
        originalPath: '/photos/direct.jpg',
        fileCreatedAt: date(1),
        createdAt: date(1),
      });
      await ctx.newExif({ assetId: first.id, fileSizeInByte: 1000 });
      await ctx.newExif({ assetId: second.id, fileSizeInByte: 2500 });
      await ctx.newExif({ assetId: direct.id, fileSizeInByte: 9 });

      await expect(sut.getFolderSummary(user.id, '/photos')).resolves.toEqual([
        {
          name: null,
          assetCount: 1,
          coverAssetId: null,
          newestTakenAt: date(1),
          oldestTakenAt: date(1),
          newestAddedAt: date(1),
          oldestAddedAt: date(1),
          totalSize: 9,
        },
        {
          name: 'trip',
          assetCount: 3,
          coverAssetId: second.id,
          newestTakenAt: date(7),
          oldestTakenAt: date(3),
          newestAddedAt: date(25),
          oldestAddedAt: date(15),
          totalSize: 3500,
        },
      ]);
    });

    it('should summarize the root folder', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      await ctx.newAsset({ ownerId: user.id, originalPath: '/root.jpg' });
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: '/photos/1.jpg' });

      await expect(sut.getFolderSummary(user.id, '/')).resolves.toMatchObject([
        { name: null, assetCount: 1, coverAssetId: null },
        { name: 'photos', assetCount: 1, coverAssetId: asset.id },
      ]);
    });

    it('should escape like patterns', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      await ctx.newAsset({ ownerId: user.id, originalPath: '/a%b/1.jpg' });
      await ctx.newAsset({ ownerId: user.id, originalPath: '/aXb/sub/1.jpg' });

      await expect(sut.getFolderSummary(user.id, '/a%b')).resolves.toMatchObject([
        { name: null, assetCount: 1, coverAssetId: null },
      ]);
    });

    it('should use the original path pattern index', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      for (let index = 0; index < 300; index++) {
        await ctx.newAsset({ ownerId: user.id, originalPath: `/folder-${index % 30}/${index}.jpg` });
      }
      await sql`ANALYZE "asset"`.execute(ctx.database);

      const plan = await ctx.database.transaction().execute(async (trx) => {
        await sql`SET LOCAL enable_seqscan = off`.execute(trx);
        const { rows } = await sql<{ 'QUERY PLAN': string }>`
          EXPLAIN SELECT "id" FROM "asset" WHERE "ownerId" = ${user.id}::uuid AND "originalPath" LIKE '/folder-7/%'
        `.execute(trx);
        return rows.map((row) => row['QUERY PLAN']).join('\n');
      });

      expect(plan).toContain('asset_ownerId_originalPath_pattern_idx');
    });
  });

  describe('folder management', () => {
    it('should rewrite asset and sidecar paths in one transaction', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const library = await ctx.database
        .insertInto('library')
        .values({ ownerId: user.id, name: 'library', importPaths: ['/library'], exclusionPatterns: [] })
        .returningAll()
        .executeTakeFirstOrThrow();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        libraryId: library.id,
        originalPath: '/library/a/1.jpg',
      });
      const { asset: trashed } = await ctx.newAsset({
        ownerId: user.id,
        libraryId: library.id,
        originalPath: '/library/a/sub/2.jpg',
        deletedAt: new Date(),
        status: AssetStatus.Trashed,
      });
      await ctx.newAsset({ ownerId: user.id, libraryId: library.id, originalPath: '/library/ab/3.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Sidecar, path: '/library/a/1.jpg.xmp' });

      const assets = await sut.getLibraryAssetsByPath(library.id, '/library/a', true);
      expect(assets.map(({ id }) => id)).toEqual([asset.id, trashed.id]);
      await expect(sut.hasLibraryAssetsAtPath(library.id, '/library/a')).resolves.toBe(true);
      await expect(sut.hasLibraryAssetsAtPath(library.id, '/library/c')).resolves.toBe(false);

      const beforeCommit = vi.fn();
      await sut.rewritePaths(
        {
          assets: assets.map(({ id, originalPath }) => ({
            id,
            originalPath: originalPath.replace('/library/a/', '/library/c/'),
            checksum: Buffer.from(id),
          })),
          sidecars: [],
          folders: [{ libraryId: library.id, from: '/library/a', to: '/library/c' }],
        },
        beforeCommit,
      );
      expect(beforeCommit).toHaveBeenCalledTimes(1);

      const [updated] = await sut.getAssetPathsByIds([asset.id]);
      expect(updated).toMatchObject({ originalPath: '/library/c/1.jpg', sidecarPath: '/library/c/1.jpg.xmp' });
      const [updatedTrashed] = await sut.getAssetPathsByIds([trashed.id]);
      expect(updatedTrashed.originalPath).toBe('/library/c/sub/2.jpg');
    });

    it('should roll back when the callback fails', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: '/library/a/1.jpg' });

      await expect(
        sut.rewritePaths(
          {
            assets: [
              { id: asset.id, originalPath: '/library/b/1.jpg', checksum: Buffer.from('x'), originalFileName: '1.jpg' },
            ],
            sidecars: [],
            folders: [],
          },
          () => Promise.reject(new Error('rename failed')),
        ),
      ).rejects.toThrow('rename failed');

      const [unchanged] = await sut.getAssetPathsByIds([asset.id]);
      expect(unchanged.originalPath).toBe('/library/a/1.jpg');
    });
  });
});
