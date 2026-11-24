import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AlbumUserRole, AssetOrder, AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { anyUuid, asUuid } from 'src/utils/database.js';
import { ExistingFolderAlbum, FolderAlbumCreate, FolderAlbumUpdate } from 'src/utils/folder-album.js';

const FOLDER_ALBUM_CHUNK_SIZE = 1000;

const memberVisibilities = [AssetVisibility.Timeline, AssetVisibility.Archive];

export const toUuidV7LowerBound = (date: Date) => {
  const hex = Math.max(0, Math.floor(date.getTime())).toString(16).padStart(12, '0').slice(-12);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
};

const directoryOf = (column: string) => sql<string>`regexp_replace(${sql.ref(column)}, '/[^/]*$', '')`;

export type FolderAlbumSyncState = {
  userId: string;
  checkpointAt: Date | null;
  fullSyncAt: Date | null;
  rootsKey: string | null;
};

export type FolderAlbumAncestor = {
  id: string;
  albumName: string;
  depth: number;
  accessible: boolean;
};

@Injectable()
export class FolderAlbumRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql()
  async getDatabaseTime() {
    const { rows } = await sql<{ now: Date }>`select clock_timestamp() as "now"`.execute(this.db);
    return rows[0].now;
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getUser(userId: string) {
    return this.db
      .selectFrom('user')
      .select(['user.id', 'user.storageLabel', 'user.deletedAt'])
      .where('user.id', '=', asUuid(userId))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getLibraries(userId: string) {
    return this.db
      .selectFrom('library')
      .select(['library.id', 'library.importPaths'])
      .where('library.ownerId', '=', asUuid(userId))
      .where('library.deletedAt', 'is', null)
      .orderBy('library.createdAt')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getFolderAlbums(userId: string): Promise<ExistingFolderAlbum[]> {
    return this.db
      .selectFrom('album')
      .select(['album.id', 'album.albumName', 'album.parentAlbumId'])
      .select((eb) => eb.ref('album.folderPath').$notNull().as('folderPath'))
      .where('album.folderOwnerId', '=', asUuid(userId))
      .where('album.folderPath', 'is not', null)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.DATE] })
  async getDirectories(userId: string, since?: Date) {
    const directory = directoryOf('asset.originalPath');
    const rows = await this.db
      .selectFrom('asset')
      .select(directory.as('directory'))
      .select('asset.libraryId')
      .where('asset.ownerId', '=', asUuid(userId))
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', 'in', memberVisibilities)
      .$if(!!since, (qb) => qb.where('asset.updateId', '>=', asUuid(toUuidV7LowerBound(since!))))
      .groupBy([directory, 'asset.libraryId'])
      .execute();
    return rows as { directory: string; libraryId: string | null }[];
  }

  @GenerateSql({
    params: [
      [{ id: DummyValue.UUID, albumName: DummyValue.STRING, folderPath: DummyValue.STRING, parentAlbumId: null }],
      DummyValue.UUID,
      AssetOrder.Desc,
    ],
  })
  async createFolderAlbums(rows: FolderAlbumCreate[], userId: string, order: AssetOrder) {
    if (rows.length === 0) {
      return;
    }

    await this.db.transaction().execute(async (trx) => {
      for (let index = 0; index < rows.length; index += FOLDER_ALBUM_CHUNK_SIZE) {
        const chunk = rows.slice(index, index + FOLDER_ALBUM_CHUNK_SIZE);
        await trx
          .insertInto('album')
          .values(
            chunk.map((row) => ({
              id: row.id,
              albumName: row.albumName,
              folderPath: row.folderPath,
              folderOwnerId: userId,
              parentAlbumId: row.parentAlbumId,
              order,
            })),
          )
          .execute();
        await trx
          .insertInto('album_user')
          .values(chunk.map((row) => ({ albumId: row.id, userId, role: AlbumUserRole.Owner })))
          .execute();
      }
    });
  }

  @GenerateSql({ params: [[{ id: DummyValue.UUID, albumName: DummyValue.STRING, parentAlbumId: DummyValue.UUID }]] })
  async updateFolderAlbums(rows: FolderAlbumUpdate[]) {
    for (let index = 0; index < rows.length; index += FOLDER_ALBUM_CHUNK_SIZE) {
      const chunk = rows.slice(index, index + FOLDER_ALBUM_CHUNK_SIZE);
      const values = sql.join(
        chunk.map((row) => sql`(${row.id}::uuid, ${row.albumName}::text, ${row.parentAlbumId}::uuid)`),
      );
      await sql`
        update "album"
        set "albumName" = "changes"."albumName", "parentAlbumId" = "changes"."parentAlbumId"
        from (values ${values}) as "changes"("id", "albumName", "parentAlbumId")
        where
          "album"."id" = "changes"."id"
          and "album"."folderPath" is not null
          and (
            "album"."albumName" is distinct from "changes"."albumName"
            or "album"."parentAlbumId" is distinct from "changes"."parentAlbumId"
          )
      `.execute(this.db);
    }
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  async deleteFolderAlbums(ids: string[]) {
    for (let index = 0; index < ids.length; index += FOLDER_ALBUM_CHUNK_SIZE) {
      const chunk = ids.slice(index, index + FOLDER_ALBUM_CHUNK_SIZE);
      await this.db
        .deleteFrom('album')
        .where('album.id', '=', anyUuid(chunk))
        .where('album.folderPath', 'is not', null)
        .execute();
    }
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteAll(userId: string) {
    await this.db.deleteFrom('album').where('album.folderOwnerId', '=', asUuid(userId)).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.DATE] })
  async removeStaleMembers(userId: string, since?: Date) {
    const result = await sql`
      delete from "album_asset"
      using "album", "asset"
      where
        "album_asset"."albumId" = "album"."id"
        and "album"."folderOwnerId" = ${userId}::uuid
        and "asset"."id" = "album_asset"."assetId"
        ${since ? sql`and "asset"."updateId" >= ${toUuidV7LowerBound(since)}::uuid` : sql``}
        and not (
          "asset"."ownerId" = "album"."folderOwnerId"
          and "asset"."deletedAt" is null
          and "asset"."visibility" in (${sql.join(memberVisibilities)})
          and "album"."folderPath" = regexp_replace("asset"."originalPath", '/[^/]*$', '')
        )
    `.execute(this.db);
    return Number(result.numAffectedRows ?? 0);
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.DATE] })
  async addMembers(userId: string, since?: Date) {
    const result = await sql`
      insert into "album_asset" ("albumId", "assetId")
      select "album"."id", "asset"."id"
      from "asset"
      inner join "album"
        on "album"."folderOwnerId" = "asset"."ownerId"
        and "album"."folderPath" = regexp_replace("asset"."originalPath", '/[^/]*$', '')
      where
        "asset"."ownerId" = ${userId}::uuid
        and "asset"."deletedAt" is null
        and "asset"."visibility" in (${sql.join(memberVisibilities)})
        and "album"."deletedAt" is null
        ${since ? sql`and "asset"."updateId" >= ${toUuidV7LowerBound(since)}::uuid` : sql``}
      on conflict do nothing
    `.execute(this.db);
    return Number(result.numAffectedRows ?? 0);
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getNonEmptyFolderAlbumIds(userId: string) {
    const rows = await this.db
      .selectFrom('album')
      .select('album.id')
      .where('album.folderOwnerId', '=', asUuid(userId))
      .where('album.folderPath', 'is not', null)
      .where((eb) => eb.exists(eb.selectFrom('album_asset').whereRef('album_asset.albumId', '=', 'album.id')))
      .execute();
    return new Set(rows.map(({ id }) => id));
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getState(userId: string): Promise<FolderAlbumSyncState | undefined> {
    return this.db
      .selectFrom('folder_album_sync')
      .selectAll()
      .where('userId', '=', asUuid(userId))
      .executeTakeFirst() as Promise<FolderAlbumSyncState | undefined>;
  }

  @GenerateSql({ params: [{ userId: DummyValue.UUID, checkpointAt: DummyValue.DATE, rootsKey: DummyValue.STRING }] })
  async saveState(state: { userId: string; checkpointAt: Date; rootsKey: string; fullSyncAt?: Date }) {
    await this.db
      .insertInto('folder_album_sync')
      .values({
        userId: state.userId,
        checkpointAt: state.checkpointAt,
        rootsKey: state.rootsKey,
        fullSyncAt: state.fullSyncAt ?? null,
      })
      .onConflict((oc) =>
        oc.column('userId').doUpdateSet((eb) => ({
          checkpointAt: eb.ref('excluded.checkpointAt'),
          rootsKey: eb.ref('excluded.rootsKey'),
          fullSyncAt: state.fullSyncAt ? eb.ref('excluded.fullSyncAt') : eb.ref('folder_album_sync.fullSyncAt'),
        })),
      )
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async deleteState(userId: string) {
    await this.db.deleteFrom('folder_album_sync').where('userId', '=', asUuid(userId)).execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async getAncestors(albumId: string, viewerId: string): Promise<FolderAlbumAncestor[]> {
    const { rows } = await sql<FolderAlbumAncestor>`
      with recursive "ancestors" as (
        select "parent"."id", "parent"."albumName", "parent"."parentAlbumId", 1 as "depth"
        from "album" as "child"
        inner join "album" as "parent" on "parent"."id" = "child"."parentAlbumId"
        where "child"."id" = ${albumId}::uuid and "parent"."deletedAt" is null
        union all
        select "parent"."id", "parent"."albumName", "parent"."parentAlbumId", "ancestors"."depth" + 1
        from "ancestors"
        inner join "album" as "parent" on "parent"."id" = "ancestors"."parentAlbumId"
        where "ancestors"."depth" < 256 and "parent"."deletedAt" is null
      )
      select
        "ancestors"."id",
        "ancestors"."albumName",
        "ancestors"."depth",
        exists (
          select 1 from "album_user"
          where "album_user"."albumId" = "ancestors"."id" and "album_user"."userId" = ${viewerId}::uuid
        ) as "accessible"
      from "ancestors"
      order by "ancestors"."depth" asc
    `.execute(this.db);
    return rows;
  }
}
