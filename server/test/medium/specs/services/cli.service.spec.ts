import { Kysely, sql } from 'kysely';
import { OFFICIAL_BASELINE_MIGRATION } from 'src/constants.js';
import { AssetOrder } from 'src/enum.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { FolderAlbumRepository } from 'src/repositories/folder-album.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { CliService } from 'src/services/cli.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

const setup = (database: Kysely<DB>) =>
  newMediumService(CliService, {
    database,
    real: [DatabaseRepository],
    mock: [LoggingRepository],
  });

const getAppliedMigrations = async (database: Kysely<DB>) => {
  const rows = await database.selectFrom('kysely_migrations').select('name').orderBy('name', 'asc').execute();
  return rows.map(({ name }) => name);
};

const hasWritableColumn = async (database: Kysely<DB>) => {
  const { rows } = await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_name = 'library' AND column_name = 'writable'
    ) AS "exists"
  `.execute(database);
  return rows[0].exists;
};

describe(CliService.name, () => {
  describe('revertForkMigrations', () => {
    it('should revert every migration newer than the official baseline and allow migrating up again', async () => {
      const database = await getKyselyDB();
      const { sut, ctx } = setup(database);

      const before = await getAppliedMigrations(database);
      const expectedForkMigrations = before.filter((name) => name > OFFICIAL_BASELINE_MIGRATION).toReversed();
      expect(expectedForkMigrations).toContain('1795470129477-AddLibraryWritable');
      await expect(sut.getForkMigrations()).resolves.toEqual(expectedForkMigrations);
      expect(await hasWritableColumn(database)).toBe(true);

      await expect(sut.revertForkMigrations()).resolves.toEqual(expectedForkMigrations);

      const after = await getAppliedMigrations(database);
      expect(after.at(-1)).toBe(OFFICIAL_BASELINE_MIGRATION);
      expect(after).toEqual(before.filter((name) => name <= OFFICIAL_BASELINE_MIGRATION));
      expect(await hasWritableColumn(database)).toBe(false);
      await expect(sut.getForkMigrations()).resolves.toEqual([]);
      await expect(sut.revertForkMigrations()).resolves.toEqual([]);

      await ctx.get(DatabaseRepository).runMigrations();
      await expect(getAppliedMigrations(database)).resolves.toEqual(before);
      expect(await hasWritableColumn(database)).toBe(true);

      await database.destroy();
    });

    it('should drop the upload session table and bring it back when migrating up again', async () => {
      const database = await getKyselyDB();
      const { sut, ctx } = setup(database);
      const hasUploadSessionTable = async () => {
        const result = await sql<{
          exists: boolean;
        }>`select to_regclass('public.upload_session') is not null as "exists"`.execute(database);
        return result.rows[0].exists;
      };

      expect(await hasUploadSessionTable()).toBe(true);
      await sut.revertForkMigrations();
      expect(await hasUploadSessionTable()).toBe(false);
      await ctx.get(DatabaseRepository).runMigrations();
      expect(await hasUploadSessionTable()).toBe(true);

      await database.destroy();
    });

    it('should delete folder albums, keep hand-made albums and drop the folder album schema', async () => {
      const database = await getKyselyDB();
      const { sut, ctx } = setup(database);
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: '/data/library/x/folder/a.jpg' });
      const { album: manual } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Hand made' }, [asset.id]);
      const folderAlbumId = newUuid();
      await ctx
        .get(FolderAlbumRepository)
        .createFolderAlbums(
          [{ id: folderAlbumId, folderPath: '/data/library/x/folder', albumName: 'folder', parentAlbumId: null }],
          user.id,
          AssetOrder.Desc,
        );
      await ctx.get(FolderAlbumRepository).addMembers(user.id);
      await ctx
        .get(FolderAlbumRepository)
        .saveState({ userId: user.id, checkpointAt: new Date(), rootsKey: 'key', fullSyncAt: new Date() });

      const hasColumn = async (column: string) => {
        const { rows } = await sql<{ exists: boolean }>`
          SELECT EXISTS (
            SELECT 1 FROM information_schema.columns WHERE table_name = 'album' AND column_name = ${column}
          ) AS "exists"
        `.execute(database);
        return rows[0].exists;
      };
      const hasSyncTable = async () => {
        const { rows } = await sql<{
          exists: boolean;
        }>`select to_regclass('public.folder_album_sync') is not null as "exists"`.execute(database);
        return rows[0].exists;
      };

      await sut.revertForkMigrations();

      for (const column of ['parentAlbumId', 'folderOwnerId', 'folderPath']) {
        expect(await hasColumn(column)).toBe(false);
      }
      expect(await hasSyncTable()).toBe(false);
      const { rows: albums } = await sql<{ id: string }>`select "id" from "album"`.execute(database);
      expect(albums.map(({ id }) => id)).toEqual([manual.id]);
      const { rows: members } = await sql<{
        assetId: string;
      }>`select "assetId" from "album_asset" where "albumId" = ${manual.id}::uuid`.execute(database);
      expect(members).toEqual([{ assetId: asset.id }]);
      const { rows: audit } = await sql<{
        albumId: string;
      }>`select "albumId" from "album_audit" where "albumId" = ${folderAlbumId}::uuid`.execute(database);
      expect(audit).toEqual([{ albumId: folderAlbumId }]);

      await ctx.get(DatabaseRepository).runMigrations();
      for (const column of ['parentAlbumId', 'folderOwnerId', 'folderPath']) {
        expect(await hasColumn(column)).toBe(true);
      }
      expect(await hasSyncTable()).toBe(true);

      await database.destroy();
    });
  });
});
