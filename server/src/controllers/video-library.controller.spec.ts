import request from 'supertest';
import { VideoLibraryController } from 'src/controllers/video-library.controller.js';
import { Permission } from 'src/enum.js';
import { VideoLibraryService } from 'src/services/video-library.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(VideoLibraryController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(VideoLibraryService);

  beforeAll(async () => {
    ctx = await controllerSetup(VideoLibraryController, [{ provide: VideoLibraryService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  const expectPermission = (permission: Permission, sharedLinkRoute: boolean) =>
    expect(ctx.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ permission, sharedLinkRoute }) }),
    );

  describe('GET /assets/:id/playback-position', () => {
    it('should require asset.read without shared links', async () => {
      await request(ctx.getHttpServer()).get(`/assets/${factory.uuid()}/playback-position`);
      expectPermission(Permission.AssetRead, false);
    });

    it('should require a valid id', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/assets/invalid/playback-position');
      expect(status).toBe(400);
      expect(service.getPlaybackPosition).not.toHaveBeenCalled();
    });
  });

  describe('PUT /assets/:id/playback-position', () => {
    it('should require a position', async () => {
      const { status } = await request(ctx.getHttpServer()).put(`/assets/${factory.uuid()}/playback-position`).send({});
      expect(status).toBe(400);
      expect(service.updatePlaybackPosition).not.toHaveBeenCalled();
    });

    it('should reject a negative position', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put(`/assets/${factory.uuid()}/playback-position`)
        .send({ position: -1 });
      expect(status).toBe(400);
    });

    it('should reject a zero duration', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put(`/assets/${factory.uuid()}/playback-position`)
        .send({ position: 1, duration: 0 });
      expect(status).toBe(400);
    });

    it('should reject a non-numeric position', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put(`/assets/${factory.uuid()}/playback-position`)
        .send({ position: '12' });
      expect(status).toBe(400);
    });

    it('should pass a valid body to the service', async () => {
      const id = factory.uuid();
      await request(ctx.getHttpServer()).put(`/assets/${id}/playback-position`).send({ position: 12.5, duration: 60 });
      expect(service.updatePlaybackPosition).toHaveBeenCalledWith(undefined, id, { position: 12.5, duration: 60 });
      expectPermission(Permission.AssetRead, false);
    });
  });

  describe('DELETE /assets/:id/playback-position', () => {
    it('should respond with no content', async () => {
      const id = factory.uuid();
      const { status } = await request(ctx.getHttpServer()).delete(`/assets/${id}/playback-position`);
      expect(status).toBe(204);
      expect(service.deletePlaybackPosition).toHaveBeenCalledWith(undefined, id);
    });
  });

  describe('GET /assets/:id/subtitles', () => {
    it('should be reachable with shared links and require asset.view', async () => {
      await request(ctx.getHttpServer()).get(`/assets/${factory.uuid()}/subtitles`);
      expectPermission(Permission.AssetView, true);
    });
  });

  describe('GET /assets/:id/subtitles/:name', () => {
    it('should respond with WebVTT', async () => {
      const id = factory.uuid();
      service.getSubtitle.mockResolvedValue('WEBVTT\n');

      const { status, headers, text } = await request(ctx.getHttpServer()).get(`/assets/${id}/subtitles/movie.en.srt`);

      expect(status).toBe(200);
      expect(headers['content-type']).toBe('text/vtt; charset=utf-8');
      expect(text).toBe('WEBVTT\n');
      expect(service.getSubtitle).toHaveBeenCalledWith(undefined, id, 'movie.en.srt');
      expectPermission(Permission.AssetView, true);
    });

    it('should decode the file name', async () => {
      const id = factory.uuid();
      service.getSubtitle.mockResolvedValue('WEBVTT\n');

      await request(ctx.getHttpServer()).get(`/assets/${id}/subtitles/${encodeURIComponent('my movie.de.vtt')}`);

      expect(service.getSubtitle).toHaveBeenCalledWith(undefined, id, 'my movie.de.vtt');
    });
  });

  describe('GET /video-library/folders', () => {
    it('should require folder.read', async () => {
      await request(ctx.getHttpServer()).get('/video-library/folders');
      expectPermission(Permission.FolderRead, false);
    });
  });
});
