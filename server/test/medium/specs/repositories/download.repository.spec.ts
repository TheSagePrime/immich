import { Kysely } from 'kysely';
import { AssetVisibility } from 'src/enum.js';
import { DownloadRepository } from 'src/repositories/download.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
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
  return { ctx, sut: ctx.get(DownloadRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(DownloadRepository.name, () => {
  describe('downloadFolder', () => {
    it('should stream the assets of the user inside the folder and its subfolders', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();

      const { asset: direct } = await ctx.newAsset({ ownerId: user.id, originalPath: '/photos/trip_1/a.jpg' });
      const { asset: nested } = await ctx.newAsset({ ownerId: user.id, originalPath: '/photos/trip_1/day 2/b.jpg' });
      await ctx.newExif({ assetId: direct.id, fileSizeInByte: 100 });
      await ctx.newExif({ assetId: nested.id, fileSizeInByte: 200 });

      for (const dto of [
        { ownerId: user.id, originalPath: '/photos/tripX1/c.jpg' },
        { ownerId: user.id, originalPath: '/photos/trip_1.jpg' },
        { ownerId: user.id, originalPath: '/photos/trip_1/hidden.mov', visibility: AssetVisibility.Hidden },
        { ownerId: user.id, originalPath: '/photos/trip_1/trashed.jpg', deletedAt: new Date() },
        { ownerId: otherUser.id, originalPath: '/photos/trip_1/other.jpg' },
      ]) {
        const { asset } = await ctx.newAsset(dto);
        await ctx.newExif({ assetId: asset.id, fileSizeInByte: 1 });
      }

      const rows = await Array.fromAsync(sut.downloadFolder(user.id, '/photos/trip_1'));

      expect(rows.toSorted((a, b) => Number(a.size) - Number(b.size))).toEqual([
        { id: direct.id, livePhotoVideoId: null, size: 100 },
        { id: nested.id, livePhotoVideoId: null, size: 200 },
      ]);
    });
  });
});
