import { BadRequestException, NotFoundException } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VideoLibraryService } from 'src/services/video-library.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const saved = (assetId: string, position: number, duration: number | null) => ({
  userId: authStub.admin.user.id,
  assetId,
  position,
  duration,
  updatedAt: new Date() as any,
});

describe(VideoLibraryService.name, () => {
  let sut: VideoLibraryService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(VideoLibraryService));
  });

  describe('getPlaybackPosition', () => {
    it('should require access to the asset', async () => {
      const id = factory.uuid();

      await expect(sut.getPlaybackPosition(authStub.admin, id)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.assetPlayback.get).not.toHaveBeenCalled();
    });

    it('should return a zero position when nothing is saved', async () => {
      const id = factory.uuid();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([id]));
      mocks.assetPlayback.get.mockResolvedValue(undefined);

      await expect(sut.getPlaybackPosition(authStub.admin, id)).resolves.toEqual({
        assetId: id,
        position: 0,
        duration: null,
        updatedAt: null,
      });
      expect(mocks.assetPlayback.get).toHaveBeenCalledWith(authStub.admin.user.id, id);
    });

    it('should return the saved position', async () => {
      const id = factory.uuid();
      const updatedAt = new Date('2026-01-01T00:00:00.000Z');
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([id]));
      mocks.assetPlayback.get.mockResolvedValue({
        userId: authStub.admin.user.id,
        assetId: id,
        position: 42.5,
        duration: 120,
        updatedAt: updatedAt as any,
      });

      await expect(sut.getPlaybackPosition(authStub.admin, id)).resolves.toEqual({
        assetId: id,
        position: 42.5,
        duration: 120,
        updatedAt,
      });
    });
  });

  describe('updatePlaybackPosition', () => {
    it('should require access to the asset', async () => {
      await expect(sut.updatePlaybackPosition(authStub.admin, factory.uuid(), { position: 1 })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(mocks.assetPlayback.upsert).not.toHaveBeenCalled();
    });

    it('should only save positions for videos', async () => {
      const id = factory.uuid();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([id]));
      mocks.asset.getForVideo.mockResolvedValue(undefined);

      await expect(sut.updatePlaybackPosition(authStub.admin, id, { position: 1 })).rejects.toBeInstanceOf(
        NotFoundException,
      );

      expect(mocks.assetPlayback.upsert).not.toHaveBeenCalled();
    });

    it('should allow partner and album assets the user can read', async () => {
      const id = factory.uuid();
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([id]));
      mocks.asset.getForVideo.mockResolvedValue({ originalPath: '/videos/movie.mp4', encodedVideoPath: null });
      mocks.assetPlayback.upsert.mockResolvedValue(saved(id, 5, null));

      await expect(sut.updatePlaybackPosition(authStub.admin, id, { position: 5 })).resolves.toMatchObject({
        assetId: id,
        position: 5,
      });
    });

    it('should save the position for the current user', async () => {
      const id = factory.uuid();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([id]));
      mocks.asset.getForVideo.mockResolvedValue({ originalPath: '/videos/movie.mp4', encodedVideoPath: null });
      mocks.assetPlayback.upsert.mockResolvedValue(saved(id, 30, 60));

      await expect(
        sut.updatePlaybackPosition(authStub.admin, id, { position: 30, duration: 60 }),
      ).resolves.toMatchObject({ assetId: id, position: 30, duration: 60 });

      expect(mocks.assetPlayback.upsert).toHaveBeenCalledWith({
        userId: authStub.admin.user.id,
        assetId: id,
        position: 30,
        duration: 60,
      });
    });

    it('should clamp the position to the duration', async () => {
      const id = factory.uuid();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([id]));
      mocks.asset.getForVideo.mockResolvedValue({ originalPath: '/videos/movie.mp4', encodedVideoPath: null });
      mocks.assetPlayback.upsert.mockResolvedValue(saved(id, 60, 60));

      await sut.updatePlaybackPosition(authStub.admin, id, { position: 75, duration: 60 });

      expect(mocks.assetPlayback.upsert).toHaveBeenCalledWith(expect.objectContaining({ position: 60, duration: 60 }));
    });
  });

  describe('deletePlaybackPosition', () => {
    it('should require access to the asset', async () => {
      await expect(sut.deletePlaybackPosition(authStub.admin, factory.uuid())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.assetPlayback.delete).not.toHaveBeenCalled();
    });

    it('should delete the position of the current user', async () => {
      const id = factory.uuid();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([id]));
      mocks.assetPlayback.delete.mockResolvedValue();

      await sut.deletePlaybackPosition(authStub.admin, id);

      expect(mocks.assetPlayback.delete).toHaveBeenCalledWith(authStub.admin.user.id, id);
    });
  });

  describe('subtitles', () => {
    let directory: string;

    beforeEach(async () => {
      directory = await mkdtemp(join(tmpdir(), 'immich-subtitles-'));
    });

    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it('should require access to the asset', async () => {
      await expect(sut.getSubtitles(authStub.admin, factory.uuid())).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.asset.getForVideo).not.toHaveBeenCalled();
    });

    it('should allow shared link access', async () => {
      const id = factory.uuid();
      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([id]));
      mocks.asset.getForVideo.mockResolvedValue({ originalPath: join(directory, 'movie.mp4'), encodedVideoPath: null });
      await writeFile(join(directory, 'movie.en.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHello\n');

      await expect(sut.getSubtitles(authStub.adminSharedLink, id)).resolves.toEqual([
        expect.objectContaining({ name: 'movie.en.srt', language: 'en' }),
      ]);
      await expect(sut.getSubtitle(authStub.adminSharedLink, id, 'movie.en.srt')).resolves.toBe(
        'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n',
      );
    });

    it('should hide the video file name from shared links that hide metadata', async () => {
      const id = factory.uuid();
      const auth = {
        ...authStub.adminSharedLink,
        sharedLink: { ...authStub.adminSharedLink.sharedLink!, showExif: false },
      };
      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([id]));
      mocks.asset.getForVideo.mockResolvedValue({ originalPath: join(directory, 'movie.mp4'), encodedVideoPath: null });
      await writeFile(join(directory, 'movie.en.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
      await writeFile(join(directory, 'movie.vtt'), 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n');

      const subtitles = await sut.getSubtitles(auth, id);
      expect(subtitles.map(({ name }) => name).toSorted()).toEqual(['.en.srt', '.vtt']);
      expect(JSON.stringify(subtitles)).not.toContain('movie');
      await expect(sut.getSubtitle(auth, id, '.en.srt')).resolves.toBe(
        'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n',
      );
      await expect(sut.getSubtitle(auth, id, '..')).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.getSubtitle(auth, id, './../movie.en.srt')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should reject assets that are not videos', async () => {
      const id = factory.uuid();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([id]));
      mocks.asset.getForVideo.mockResolvedValue(undefined);

      await expect(sut.getSubtitles(authStub.admin, id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.getSubtitle(authStub.admin, id, 'movie.srt')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should not serve files that do not belong to the video', async () => {
      const id = factory.uuid();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([id]));
      mocks.asset.getForVideo.mockResolvedValue({ originalPath: join(directory, 'movie.mp4'), encodedVideoPath: null });
      await writeFile(join(directory, 'other.srt'), '1\n00:00:01,000 --> 00:00:02,000\nSecret\n');

      await expect(sut.getSubtitle(authStub.admin, id, 'other.srt')).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.getSubtitle(authStub.admin, id, '../movie.srt')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getVideoFolders', () => {
    it('should return the folders of the current user', async () => {
      mocks.assetPlayback.getVideoFolders.mockResolvedValue(['/videos', '/videos/holiday']);

      await expect(sut.getVideoFolders(authStub.admin)).resolves.toEqual(['/videos', '/videos/holiday']);
      expect(mocks.assetPlayback.getVideoFolders).toHaveBeenCalledWith(authStub.admin.user.id);
    });
  });
});
