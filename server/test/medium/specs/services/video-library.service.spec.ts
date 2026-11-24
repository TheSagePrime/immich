import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetPlaybackRepository } from 'src/repositories/asset-playback.repository.js';
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
    real: [AccessRepository, AssetRepository, AssetPlaybackRepository],
    mock: [LoggingRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(VideoLibraryService.name, () => {
  describe('playback positions', () => {
    it('should save, update, read and delete a position per user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      await ctx.newPartner({ sharedById: user.id, sharedWithId: partner.id });
      const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
      const auth = factory.auth({ user });
      const partnerAuth = factory.auth({ user: partner });

      await expect(sut.getPlaybackPosition(auth, asset.id)).resolves.toEqual({
        assetId: asset.id,
        position: 0,
        duration: null,
        updatedAt: null,
      });

      const first = await sut.updatePlaybackPosition(auth, asset.id, { position: 10, duration: 100 });
      expect(first).toEqual({ assetId: asset.id, position: 10, duration: 100, updatedAt: expect.any(Date) });

      const second = await sut.updatePlaybackPosition(auth, asset.id, { position: 25.5 });
      expect(second).toEqual({ assetId: asset.id, position: 25.5, duration: null, updatedAt: expect.any(Date) });
      expect(second.updatedAt!.getTime()).toBeGreaterThanOrEqual(first.updatedAt!.getTime());

      await sut.updatePlaybackPosition(partnerAuth, asset.id, { position: 3 });

      await expect(sut.getPlaybackPosition(auth, asset.id)).resolves.toMatchObject({ position: 25.5 });
      await expect(sut.getPlaybackPosition(partnerAuth, asset.id)).resolves.toMatchObject({ position: 3 });

      await sut.deletePlaybackPosition(auth, asset.id);
      await expect(sut.getPlaybackPosition(auth, asset.id)).resolves.toMatchObject({ position: 0, updatedAt: null });
      await expect(sut.getPlaybackPosition(partnerAuth, asset.id)).resolves.toMatchObject({ position: 3 });
    });

    it('should not allow access to assets of other users', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: other.id, type: AssetType.Video });
      const auth = factory.auth({ user });

      await expect(sut.getPlaybackPosition(auth, asset.id)).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.updatePlaybackPosition(auth, asset.id, { position: 1 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(sut.deletePlaybackPosition(auth, asset.id)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should not save positions for images', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });

      await expect(
        sut.updatePlaybackPosition(factory.auth({ user }), asset.id, { position: 1 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should remove positions when the asset is deleted', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
      await sut.updatePlaybackPosition(factory.auth({ user }), asset.id, { position: 1 });

      await ctx.database.deleteFrom('asset').where('id', '=', asset.id).execute();

      const rows = await ctx.database
        .selectFrom('asset_playback_position')
        .selectAll()
        .where('assetId', '=', asset.id)
        .execute();
      expect(rows).toEqual([]);
    });
  });

  describe('subtitles', () => {
    let directory: string;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'immich-medium-subtitles-'));
    });

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it('should list and serve sidecar subtitles', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const originalPath = join(directory, 'clip.mp4');
      const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video, originalPath });
      await writeFile(originalPath, '');
      await writeFile(join(directory, 'clip.en.srt'), '1\n00:00:00,500 --> 00:00:01,000\nHello\n');
      await writeFile(join(directory, 'clip.de.forced.vtt'), 'WEBVTT\n\n00:00.500 --> 00:01.000\nHallo\n');
      const auth = factory.auth({ user });

      await expect(sut.getSubtitles(auth, asset.id)).resolves.toEqual([
        {
          name: 'clip.de.forced.vtt',
          format: 'vtt',
          language: 'de',
          label: null,
          forced: true,
          hearingImpaired: false,
        },
        { name: 'clip.en.srt', format: 'srt', language: 'en', label: null, forced: false, hearingImpaired: false },
      ]);
      await expect(sut.getSubtitle(auth, asset.id, 'clip.en.srt')).resolves.toBe(
        'WEBVTT\n\n00:00:00.500 --> 00:00:01.000\nHello\n',
      );
    });

    it('should not list subtitles of videos the user cannot see', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: other.id,
        type: AssetType.Video,
        originalPath: join(directory, 'clip.mp4'),
      });

      await expect(sut.getSubtitles(factory.auth({ user }), asset.id)).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.getSubtitle(factory.auth({ user }), asset.id, 'clip.srt')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

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
