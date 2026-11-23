import { Injectable } from '@nestjs/common';
import type { Insertable, Kysely, Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { UploadSessionStatus } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { UploadSessionTable } from 'src/schema/tables/upload-session.table.js';
import { asUuid } from 'src/utils/database.js';

export interface UploadSessionSearchOptions {
  ownerId: string;
  libraryId?: string;
  batchId?: string;
  status?: UploadSessionStatus;
}

const UPLOAD_SESSION_SEARCH_LIMIT = 5000;

const releasableStatuses = [UploadSessionStatus.Active, UploadSessionStatus.Completing, UploadSessionStatus.Failed];
const terminalStatuses = [UploadSessionStatus.Completed, UploadSessionStatus.Cancelled];

@Injectable()
export class UploadSessionRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  create(dto: Insertable<UploadSessionTable>) {
    return this.db.insertInto('upload_session').values(dto).returningAll().executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  get(id: string, ownerId: string) {
    return this.db
      .selectFrom('upload_session')
      .selectAll()
      .where('id', '=', asUuid(id))
      .where('ownerId', '=', asUuid(ownerId))
      .executeTakeFirst();
  }

  @GenerateSql({ params: [{ ownerId: DummyValue.UUID, libraryId: DummyValue.UUID, batchId: DummyValue.UUID }] })
  search({ ownerId, libraryId, batchId, status }: UploadSessionSearchOptions) {
    return this.db
      .selectFrom('upload_session')
      .selectAll()
      .where('ownerId', '=', asUuid(ownerId))
      .$if(!!libraryId, (qb) => qb.where('libraryId', '=', asUuid(libraryId!)))
      .$if(!!batchId, (qb) => qb.where('batchId', '=', asUuid(batchId!)))
      .$if(!!status, (qb) => qb.where('status', '=', status!))
      .orderBy('createdAt', 'asc')
      .limit(UPLOAD_SESSION_SEARCH_LIMIT)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, { status: UploadSessionStatus.Cancelled }] })
  update(id: string, dto: Updateable<UploadSessionTable>) {
    return this.db
      .updateTable('upload_session')
      .set(dto)
      .where('id', '=', asUuid(id))
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, UploadSessionStatus.Active, { status: UploadSessionStatus.Completing }] })
  updateIfStatus(id: string, status: UploadSessionStatus, dto: Updateable<UploadSessionTable>) {
    return this.db
      .updateTable('upload_session')
      .set(dto)
      .where('id', '=', asUuid(id))
      .where('status', '=', status)
      .returningAll()
      .executeTakeFirst();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async countActive(ownerId: string) {
    const { count } = await this.db
      .selectFrom('upload_session')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('ownerId', '=', asUuid(ownerId))
      .where('status', 'in', [UploadSessionStatus.Active, UploadSessionStatus.Completing])
      .executeTakeFirstOrThrow();
    return Number(count);
  }

  @GenerateSql({ params: [DummyValue.DATE] })
  getExpired(now: Date) {
    return this.db
      .selectFrom('upload_session')
      .select(['id', 'tempPath', 'status'])
      .where('expiresAt', '<', now)
      .where('status', 'in', releasableStatuses)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.DATE] })
  async deleteTerminalBefore(before: Date) {
    const result = await this.db
      .deleteFrom('upload_session')
      .where('status', 'in', terminalStatuses)
      .where('updatedAt', '<', before)
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  async deleteAll(ids: string[]) {
    if (ids.length === 0) {
      return;
    }

    await this.db
      .deleteFrom('upload_session')
      .where(
        'id',
        'in',
        ids.map((id) => asUuid(id)),
      )
      .execute();
  }

  @GenerateSql({ params: [[DummyValue.STRING]] })
  async getKnownTempPaths(paths: string[]) {
    if (paths.length === 0) {
      return new Set<string>();
    }

    const rows = await this.db.selectFrom('upload_session').select('tempPath').where('tempPath', 'in', paths).execute();
    return new Set(rows.map(({ tempPath }) => tempPath as string));
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  getWritableLibraries(ownerId: string) {
    return this.db
      .selectFrom('library')
      .select(['id', 'name', 'importPaths', 'exclusionPatterns'])
      .where('ownerId', '=', asUuid(ownerId))
      .where('writable', '=', true)
      .where('deletedAt', 'is', null)
      .orderBy('name', 'asc')
      .execute();
  }

  @GenerateSql()
  getAllWritableLibraries() {
    return this.db
      .selectFrom('library')
      .select(['id', 'importPaths'])
      .where('writable', '=', true)
      .where('deletedAt', 'is', null)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.STRING]] })
  async getAssetIdsByPaths(libraryId: string, paths: string[]) {
    if (paths.length === 0) {
      return new Map<string, string>();
    }

    const rows = await this.db
      .selectFrom('asset')
      .select(['asset.id', 'asset.originalPath'])
      .where('asset.libraryId', '=', asUuid(libraryId))
      .where('asset.isExternal', '=', true)
      .where('asset.originalPath', 'in', paths)
      .execute();

    return new Map(rows.map((row) => [row.originalPath, row.id]));
  }
}
