import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { asUuid } from 'src/utils/database.js';

export type PlaybackPositionUpsert = {
  userId: string;
  assetId: string;
  position: number;
  duration: number | null;
};

@Injectable()
export class AssetPlaybackRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  get(userId: string, assetId: string) {
    return this.db
      .selectFrom('asset_playback_position')
      .selectAll()
      .where('userId', '=', asUuid(userId))
      .where('assetId', '=', asUuid(assetId))
      .executeTakeFirst();
  }

  @GenerateSql({
    params: [{ userId: DummyValue.UUID, assetId: DummyValue.UUID, position: DummyValue.NUMBER, duration: null }],
  })
  upsert(value: PlaybackPositionUpsert) {
    return this.db
      .insertInto('asset_playback_position')
      .values(value)
      .onConflict((oc) =>
        oc.columns(['userId', 'assetId']).doUpdateSet((eb) => ({
          position: eb.ref('excluded.position'),
          duration: eb.ref('excluded.duration'),
          updatedAt: eb.fn('now'),
        })),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  async delete(userId: string, assetId: string): Promise<void> {
    await this.db
      .deleteFrom('asset_playback_position')
      .where('userId', '=', asUuid(userId))
      .where('assetId', '=', asUuid(assetId))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async getVideoFolders(userId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('asset')
      .select((eb) => eb.fn<string>('substring', ['asset.originalPath', eb.val('^(.*)/[^/]*$')]).as('folder'))
      .distinct()
      .where('asset.ownerId', '=', asUuid(userId))
      .where('asset.type', '=', AssetType.Video)
      .where('asset.visibility', '=', AssetVisibility.Timeline)
      .where('asset.deletedAt', 'is', null)
      .orderBy('folder', 'asc')
      .execute();

    return rows.map((row) => row.folder).filter((folder): folder is string => !!folder);
  }
}
