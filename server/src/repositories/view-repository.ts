import { sql, type Kysely } from 'kysely';
import { trim } from 'lodash-es';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetFileType, AssetStatus, AssetVisibility, ChecksumAlgorithm } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { anyUuid, asUuid, withExif } from 'src/utils/database.js';

export const escapeLikePattern = (value: string) => value.replaceAll(/[\\%_]/g, String.raw`\$&`);

const toDirectoryPrefix = (partialPath: string) => {
  const directory = trim(partialPath, '/');
  return directory ? `/${directory}/` : '/';
};

const PATH_REWRITE_CHUNK_SIZE = 2000;

export type FolderSummaryRow = {
  name: string | null;
  assetCount: number;
  coverAssetId: string | null;
  newestTakenAt: Date | null;
  oldestTakenAt: Date | null;
  newestAddedAt: Date | null;
  oldestAddedAt: Date | null;
  totalSize: number;
};

export type FolderDirectoryRow = {
  libraryId: string | null;
  directoryPath: string;
  assetCount: number;
  coverAssetId: string;
  newestTakenAt: Date;
};

export type LibraryAssetPath = {
  id: string;
  originalPath: string;
  livePhotoVideoId: string | null;
  libraryId: string | null;
  ownerId: string;
  deletedAt: Date | null;
};

export type AssetPathRewrite = {
  id: string;
  originalPath: string;
  checksum: Buffer;
  originalFileName?: string;
};

export type SidecarPathRewrite = {
  assetId: string;
  path: string;
};

export type FolderPrefixRewrite = {
  libraryId: string;
  from: string;
  to: string;
};

export class ViewRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID] })
  async getUniqueOriginalPaths(userId: string) {
    const results = await this.db
      .selectFrom('asset')
      .select((eb) => eb.fn<string>('substring', ['asset.originalPath', eb.val('^(.*/)[^/]*$')]).as('directoryPath'))
      .distinct()
      .where('ownerId', '=', asUuid(userId))
      .where('visibility', '=', AssetVisibility.Timeline)
      .where('deletedAt', 'is', null)
      .where('fileCreatedAt', 'is not', null)
      .where('fileModifiedAt', 'is not', null)
      .where('localDateTime', 'is not', null)
      .orderBy('directoryPath', 'asc')
      .execute();

    return results.map((row) => row.directoryPath.replaceAll(/\/$/g, ''));
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getFolderDirectories(userId: string): Promise<FolderDirectoryRow[]> {
    const { rows } = await sql<FolderDirectoryRow>`
      with "scoped" as (
        select
          "id",
          "libraryId",
          "fileCreatedAt",
          substring("originalPath", '^(.*)/[^/]*$') as "directoryPath"
        from "asset"
        where
          "ownerId" = ${userId}::uuid
          and "visibility" = ${AssetVisibility.Timeline}
          and "deletedAt" is null
          and "fileCreatedAt" is not null
          and "fileModifiedAt" is not null
          and "localDateTime" is not null
      ),
      "counts" as (
        select "libraryId", "directoryPath", count(*)::int as "assetCount"
        from "scoped"
        group by "libraryId", "directoryPath"
      ),
      "covers" as (
        select distinct on ("libraryId", "directoryPath")
          "libraryId",
          "directoryPath",
          "id" as "coverAssetId",
          "fileCreatedAt" as "newestTakenAt"
        from "scoped"
        order by "libraryId", "directoryPath", "fileCreatedAt" desc, "id"
      )
      select
        "counts"."libraryId",
        coalesce("counts"."directoryPath", '') as "directoryPath",
        "counts"."assetCount",
        "covers"."coverAssetId",
        "covers"."newestTakenAt"
      from "counts"
      inner join "covers"
        on "covers"."libraryId" is not distinct from "counts"."libraryId"
        and "covers"."directoryPath" is not distinct from "counts"."directoryPath"
      order by "directoryPath"
    `.execute(this.db);

    return rows;
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  async getAssetsByOriginalPath(userId: string, partialPath: string) {
    const prefix = escapeLikePattern(toDirectoryPrefix(partialPath));

    return this.db
      .selectFrom('asset')
      .selectAll('asset')
      .$call(withExif)
      .where('ownerId', '=', asUuid(userId))
      .where('visibility', '=', AssetVisibility.Timeline)
      .where('deletedAt', 'is', null)
      .where('fileCreatedAt', 'is not', null)
      .where('fileModifiedAt', 'is not', null)
      .where('localDateTime', 'is not', null)
      .where('originalPath', 'like', `${prefix}%`)
      .where('originalPath', 'not like', `${prefix}%/%`)
      .orderBy(
        (eb) => eb.fn('regexp_replace', ['asset.originalPath', eb.val('.*/(.+)'), eb.val(String.raw`\1`)]),
        'asc',
      )
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  async getFolderSummary(userId: string, partialPath: string): Promise<FolderSummaryRow[]> {
    const prefix = toDirectoryPrefix(partialPath);
    const pattern = `${escapeLikePattern(prefix)}%`;

    const { rows } = await sql<FolderSummaryRow>`
      with "scoped" as (
        select
          "asset"."id",
          "asset"."fileCreatedAt",
          "asset"."createdAt",
          "asset_exif"."fileSizeInByte",
          case
            when strpos(substr("asset"."originalPath", length(${prefix}::text) + 1), '/') > 0
            then split_part(substr("asset"."originalPath", length(${prefix}::text) + 1), '/', 1)
          end as "name"
        from "asset"
        left join "asset_exif" on "asset_exif"."assetId" = "asset"."id"
        where
          "asset"."ownerId" = ${userId}::uuid
          and "asset"."originalPath" like ${pattern}
          and "asset"."visibility" = ${AssetVisibility.Timeline}
          and "asset"."deletedAt" is null
          and "asset"."fileCreatedAt" is not null
          and "asset"."fileModifiedAt" is not null
          and "asset"."localDateTime" is not null
      ),
      "counts" as (
        select
          "name",
          count(*)::int as "assetCount",
          max("fileCreatedAt") as "newestTakenAt",
          min("fileCreatedAt") as "oldestTakenAt",
          max("createdAt") as "newestAddedAt",
          min("createdAt") as "oldestAddedAt",
          coalesce(sum("fileSizeInByte"), 0)::float8 as "totalSize"
        from "scoped"
        group by "name"
      ),
      "covers" as (
        select distinct on ("name") "name", "id" as "coverAssetId"
        from "scoped"
        where "name" is not null
        order by "name", "fileCreatedAt" desc, "id"
      )
      select
        "counts"."name",
        "counts"."assetCount",
        "covers"."coverAssetId",
        "counts"."newestTakenAt",
        "counts"."oldestTakenAt",
        "counts"."newestAddedAt",
        "counts"."oldestAddedAt",
        "counts"."totalSize"
      from "counts"
      left join "covers" on "covers"."name" = "counts"."name"
      order by "counts"."name" asc nulls first
    `.execute(this.db);

    return rows;
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  getLibraryAssetsByPath(libraryId: string, originalPath: string, isFolder: boolean) {
    return this.db
      .selectFrom('asset')
      .select(['id', 'originalPath', 'livePhotoVideoId', 'libraryId', 'ownerId', 'deletedAt'])
      .where('libraryId', '=', asUuid(libraryId))
      .$if(isFolder, (qb) => qb.where('originalPath', 'like', `${escapeLikePattern(`${originalPath}/`)}%`))
      .$if(!isFolder, (qb) => qb.where('originalPath', '=', originalPath))
      .orderBy('originalPath')
      .execute() as Promise<LibraryAssetPath[]>;
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  getAssetPathsByIds(ids: string[]) {
    if (ids.length === 0) {
      return Promise.resolve([] as (LibraryAssetPath & { sidecarPath: string | null })[]);
    }

    return this.db
      .selectFrom('asset')
      .leftJoin('asset_file', (join) =>
        join
          .onRef('asset_file.assetId', '=', 'asset.id')
          .on('asset_file.type', '=', AssetFileType.Sidecar)
          .on('asset_file.isEdited', '=', false),
      )
      .select([
        'asset.id',
        'asset.originalPath',
        'asset.livePhotoVideoId',
        'asset.libraryId',
        'asset.ownerId',
        'asset.deletedAt',
        'asset_file.path as sidecarPath',
      ])
      .where('asset.id', '=', anyUuid(ids))
      .execute() as Promise<(LibraryAssetPath & { sidecarPath: string | null })[]>;
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  async hasLibraryAssetsAtPath(libraryId: string, originalPath: string) {
    const result = await this.db
      .selectFrom('asset')
      .select('id')
      .where('libraryId', '=', asUuid(libraryId))
      .where((eb) =>
        eb.or([
          eb('originalPath', '=', originalPath),
          eb('originalPath', 'like', `${escapeLikePattern(`${originalPath}/`)}%`),
        ]),
      )
      .limit(1)
      .executeTakeFirst();

    return !!result;
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, DummyValue.STRING] })
  async hasOtherAssetsWithStem(assetId: string, ownerId: string, pathWithoutExtension: string) {
    const prefix = escapeLikePattern(`${pathWithoutExtension}.`);
    const result = await this.db
      .selectFrom('asset')
      .select('id')
      .where('ownerId', '=', asUuid(ownerId))
      .where('originalPath', 'like', `${prefix}%`)
      .where('originalPath', 'not like', `${prefix}%/%`)
      .where('id', '!=', asUuid(assetId))
      .limit(1)
      .executeTakeFirst();

    return !!result;
  }

  async rewritePaths(
    changes: { assets: AssetPathRewrite[]; sidecars: SidecarPathRewrite[]; folders: FolderPrefixRewrite[] },
    beforeCommit: () => Promise<void>,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      for (let index = 0; index < changes.assets.length; index += PATH_REWRITE_CHUNK_SIZE) {
        const rows = changes.assets.slice(index, index + PATH_REWRITE_CHUNK_SIZE);
        const values = sql.join(
          rows.map(
            (row) =>
              sql`(${row.id}::uuid, ${row.originalPath}::text, ${row.checksum}::bytea, ${row.originalFileName ?? null}::text)`,
          ),
        );
        await sql`
          update "asset"
          set
            "originalPath" = "changes"."originalPath",
            "checksum" = case
              when "asset"."checksumAlgorithm" = ${ChecksumAlgorithm.sha1Path} then "changes"."checksum"
              else "asset"."checksum"
            end,
            "originalFileName" = coalesce("changes"."originalFileName", "asset"."originalFileName")
          from (values ${values}) as "changes"("id", "originalPath", "checksum", "originalFileName")
          where "asset"."id" = "changes"."id"
        `.execute(trx);
      }

      for (const folder of changes.folders) {
        const from = `${folder.from}/`;
        const to = `${folder.to}/`;
        await sql`
          update "asset_file"
          set "path" = ${to}::text || substr("asset_file"."path", length(${from}::text) + 1)
          from "asset"
          where
            "asset_file"."assetId" = "asset"."id"
            and "asset"."libraryId" = ${folder.libraryId}::uuid
            and "asset_file"."type" = ${AssetFileType.Sidecar}
            and "asset_file"."path" like ${`${escapeLikePattern(from)}%`}
        `.execute(trx);

        await sql`
          delete from "album"
          using "library"
          where
            "library"."id" = ${folder.libraryId}::uuid
            and "album"."folderOwnerId" = "library"."ownerId"
            and ("album"."folderPath" = ${folder.to}::text or "album"."folderPath" like ${`${escapeLikePattern(to)}%`})
        `.execute(trx);

        await sql`
          update "album"
          set "folderPath" = ${folder.to}::text || substr("album"."folderPath", length(${folder.from}::text) + 1)
          from "library"
          where
            "library"."id" = ${folder.libraryId}::uuid
            and "album"."folderOwnerId" = "library"."ownerId"
            and ("album"."folderPath" = ${folder.from}::text or "album"."folderPath" like ${`${escapeLikePattern(from)}%`})
        `.execute(trx);
      }

      for (const sidecar of changes.sidecars) {
        await trx
          .updateTable('asset_file')
          .set({ path: sidecar.path })
          .where('assetId', '=', asUuid(sidecar.assetId))
          .where('type', '=', AssetFileType.Sidecar)
          .where('isEdited', '=', false)
          .execute();
      }

      await beforeCommit();
    });
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING, AssetStatus.Trashed] })
  async trashLibraryFolder(libraryId: string, folderPath: string, status: AssetStatus.Trashed | AssetStatus.Deleted) {
    const rows = await this.db
      .updateTable('asset')
      .set({ deletedAt: new Date(), status })
      .where('libraryId', '=', asUuid(libraryId))
      .where('originalPath', 'like', `${escapeLikePattern(`${folderPath}/`)}%`)
      .$if(status === AssetStatus.Trashed, (qb) => qb.where('deletedAt', 'is', null))
      .$if(status === AssetStatus.Deleted, (qb) => qb.where('status', '!=', AssetStatus.Deleted))
      .where('visibility', '!=', AssetVisibility.Hidden)
      .returning(['id', 'originalPath'])
      .execute();

    return rows;
  }
}
