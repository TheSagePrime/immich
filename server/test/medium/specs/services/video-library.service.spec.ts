import { Kysely } from 'kysely';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { VideoLibraryService } from 'src/services/video-library.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = () => {
  return newMediumService(VideoLibraryService, {
    database: defaultDatabase,
    real: [AssetRepository],
    mock: [LoggingRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(VideoLibraryService.name, () => {
  describe('getVideoFolders', () => {
    it('should list folders containing visible videos of the user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      await ctx.newAsset({ ownerId: user.id, type: AssetType.Video, originalPath: '/media/movies/a.mp4' });
      await ctx.newAsset({ ownerId: user.id, type: AssetType.Video, originalPath: '/media/movies/b.mp4' });
      await ctx.newAsset({ ownerId: user.id, type: AssetType.Video, originalPath: '/media/movies/2024/c.mp4' });
      await ctx.newAsset({ ownerId: user.id, type: AssetType.Image, originalPath: '/media/photos/d.jpg' });
      await ctx.newAsset({
        ownerId: user.id,
        type: AssetType.Video,
        originalPath: '/media/archived/e.mp4',
        visibility: AssetVisibility.Archive,
      });
      await ctx.newAsset({
        ownerId: user.id,
        type: AssetType.Video,
        originalPath: '/media/trashed/f.mp4',
        deletedAt: new Date(),
      });
      await ctx.newAsset({ ownerId: other.id, type: AssetType.Video, originalPath: '/media/other/g.mp4' });

      await expect(sut.getVideoFolders(factory.auth({ user }))).resolves.toEqual([
        '/media/movies',
        '/media/movies/2024',
      ]);
    });
  });
});
