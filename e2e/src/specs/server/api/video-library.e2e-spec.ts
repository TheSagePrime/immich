import { AssetTypeEnum, LoginResponseDto, SharedLinkType } from '@immich/sdk';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { app, asBearerAuth, testAssetDir, testAssetDirInternal, utils } from 'src/utils.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hostRoot = `${testAssetDir}/temp/videos`;
const root = `${testAssetDirInternal}/temp/videos`;

const srt = ['1', '00:00:01,000 --> 00:00:02,500', 'Hello <font color="red">world</font>', '', ''].join('\r\n');
const vtt = ['WEBVTT', '', 'STYLE', '::cue { color: red }', '', '00:00:01.000 --> 00:00:02.000', 'Hallo', ''].join(
  '\n',
);

const writeFile = (path: string, content: string | Buffer) => {
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  writeFileSync(path, content);
};

describe('/video-library', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;
  let videoId: string;
  let imageId: string;

  const findAsset = async (originalFileName: string) => {
    const { assets } = await utils.searchAssets(admin.accessToken, { originalFileName });
    expect(assets.items).toHaveLength(1);
    return assets.items[0].id;
  };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    await utils.resetAdminConfig(admin.accessToken);
    user = await utils.userSetup(admin.accessToken, {
      email: 'video-user@immich.cloud',
      name: 'Video User',
      password: 'password',
    });

    utils.resetTempFolder();
    writeFile(`${hostRoot}/movies/movie.mp4`, Buffer.alloc(1024));
    writeFile(`${hostRoot}/movies/movie.en.srt`, srt);
    writeFile(`${hostRoot}/movies/movie.de.forced.vtt`, vtt);
    writeFile(`${hostRoot}/movies/movie.txt`, 'not a subtitle');
    writeFile(`${hostRoot}/movies/other.srt`, srt);
    writeFile(`${testAssetDir}/temp/outside/secret.srt`, srt);
    symlinkSync(`${testAssetDirInternal}/temp/outside/secret.srt`, `${hostRoot}/movies/movie.fr.srt`);
    utils.createImageFile(`${hostRoot}/photos/photo.png`);

    const library = await utils.createLibrary(admin.accessToken, { ownerId: admin.userId, importPaths: [root] });
    await utils.scan(admin.accessToken, library.id);

    videoId = await findAsset('movie.mp4');
    imageId = await findAsset('photo.png');
  });

  afterAll(() => {
    utils.resetTempFolder();
  });

  describe('playback position', () => {
    it('should require authentication', async () => {
      const { status } = await request(app).get(`/assets/${videoId}/playback-position`);
      expect(status).toBe(401);
    });

    it('should return an empty position when nothing is saved', async () => {
      const { status, body } = await request(app)
        .get(`/assets/${videoId}/playback-position`)
        .set(asBearerAuth(admin.accessToken));

      expect(status).toBe(200);
      expect(body).toEqual({ assetId: videoId, position: 0, duration: null, updatedAt: null });
    });

    it('should save and return the position', async () => {
      const { status, body } = await request(app)
        .put(`/assets/${videoId}/playback-position`)
        .send({ position: 42.5, duration: 120 })
        .set(asBearerAuth(admin.accessToken));

      expect(status).toBe(200);
      expect(body).toEqual({ assetId: videoId, position: 42.5, duration: 120, updatedAt: expect.any(String) });

      const { body: saved } = await request(app)
        .get(`/assets/${videoId}/playback-position`)
        .set(asBearerAuth(admin.accessToken));
      expect(saved).toEqual(body);
    });

    it('should clamp the position to the duration', async () => {
      const { status, body } = await request(app)
        .put(`/assets/${videoId}/playback-position`)
        .send({ position: 500, duration: 120 })
        .set(asBearerAuth(admin.accessToken));

      expect(status).toBe(200);
      expect(body).toMatchObject({ position: 120, duration: 120 });
    });

    it('should reject an invalid position', async () => {
      const { status } = await request(app)
        .put(`/assets/${videoId}/playback-position`)
        .send({ position: -1 })
        .set(asBearerAuth(admin.accessToken));

      expect(status).toBe(400);
    });

    it('should not allow saving a position for an image', async () => {
      const { status } = await request(app)
        .put(`/assets/${imageId}/playback-position`)
        .send({ position: 1 })
        .set(asBearerAuth(admin.accessToken));

      expect(status).toBe(404);
    });

    it('should not allow access to videos of other users', async () => {
      const { status } = await request(app)
        .get(`/assets/${videoId}/playback-position`)
        .set(asBearerAuth(user.accessToken));
      expect(status).toBe(400);

      const { status: putStatus } = await request(app)
        .put(`/assets/${videoId}/playback-position`)
        .send({ position: 1 })
        .set(asBearerAuth(user.accessToken));
      expect(putStatus).toBe(400);
    });

    it('should clear the position', async () => {
      const { status } = await request(app)
        .delete(`/assets/${videoId}/playback-position`)
        .set(asBearerAuth(admin.accessToken));
      expect(status).toBe(204);

      const { body } = await request(app)
        .get(`/assets/${videoId}/playback-position`)
        .set(asBearerAuth(admin.accessToken));
      expect(body).toMatchObject({ position: 0, updatedAt: null });
    });
  });

  describe('sidecar subtitles', () => {
    it('should list subtitles next to the video and skip escaping symlinks', async () => {
      const { status, body } = await request(app)
        .get(`/assets/${videoId}/subtitles`)
        .set(asBearerAuth(admin.accessToken));

      expect(status).toBe(200);
      expect(body).toEqual([
        {
          name: 'movie.de.forced.vtt',
          format: 'vtt',
          language: 'de',
          label: null,
          forced: true,
          hearingImpaired: false,
        },
        { name: 'movie.en.srt', format: 'srt', language: 'en', label: null, forced: false, hearingImpaired: false },
      ]);
    });

    it('should serve srt files as WebVTT', async () => {
      const { status, headers, text } = await request(app)
        .get(`/assets/${videoId}/subtitles/movie.en.srt`)
        .set(asBearerAuth(admin.accessToken));

      expect(status).toBe(200);
      expect(headers['content-type']).toContain('text/vtt');
      expect(text).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello world\n');
    });

    it('should strip style blocks from vtt files', async () => {
      const { status, text } = await request(app)
        .get(`/assets/${videoId}/subtitles/movie.de.forced.vtt`)
        .set(asBearerAuth(admin.accessToken));

      expect(status).toBe(200);
      expect(text).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHallo\n');
    });

    it.each(['other.srt', 'movie.txt', 'movie.fr.srt', '..%2Foutside%2Fsecret.srt', 'movie.es.srt'])(
      'should not serve %s',
      async (name) => {
        const { status } = await request(app)
          .get(`/assets/${videoId}/subtitles/${name}`)
          .set(asBearerAuth(admin.accessToken));

        expect([400, 404]).toContain(status);
      },
    );

    it('should not allow access to subtitles of other users', async () => {
      const { status } = await request(app).get(`/assets/${videoId}/subtitles`).set(asBearerAuth(user.accessToken));
      expect(status).toBe(400);

      const { status: fileStatus } = await request(app)
        .get(`/assets/${videoId}/subtitles/movie.en.srt`)
        .set(asBearerAuth(user.accessToken));
      expect(fileStatus).toBe(400);
    });

    it('should return 404 for images', async () => {
      const { status } = await request(app).get(`/assets/${imageId}/subtitles`).set(asBearerAuth(admin.accessToken));
      expect(status).toBe(404);
    });

    it('should serve subtitles through a shared link of the video', async () => {
      const sharedLink = await utils.createSharedLink(admin.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [videoId],
      });

      const { status, body } = await request(app).get(`/assets/${videoId}/subtitles`).query({ key: sharedLink.key });
      expect(status).toBe(200);
      expect(body).toHaveLength(2);

      const { status: fileStatus, text } = await request(app)
        .get(`/assets/${videoId}/subtitles/movie.en.srt`)
        .query({ key: sharedLink.key });
      expect(fileStatus).toBe(200);
      expect(text).toContain('WEBVTT');

      const { status: positionStatus } = await request(app)
        .get(`/assets/${videoId}/playback-position`)
        .query({ key: sharedLink.key });
      expect(positionStatus).toBe(403);
    });

    it('should not serve subtitles of a video that is not in the shared link', async () => {
      const sharedLink = await utils.createSharedLink(admin.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [imageId],
      });

      const { status } = await request(app).get(`/assets/${videoId}/subtitles`).query({ key: sharedLink.key });
      expect(status).toBe(400);
    });
  });

  describe('videos page', () => {
    it('should list folders that contain videos', async () => {
      const { status, body } = await request(app).get('/video-library/folders').set(asBearerAuth(admin.accessToken));

      expect(status).toBe(200);
      expect(body).toEqual([`${root}/movies`]);
    });

    it('should not list folders of other users', async () => {
      const { status, body } = await request(app).get('/video-library/folders').set(asBearerAuth(user.accessToken));

      expect(status).toBe(200);
      expect(body).toEqual([]);
    });

    it('should filter time buckets by asset type and folder', async () => {
      const count = async (query: Record<string, string>) => {
        const { status, body } = await request(app)
          .get('/timeline/buckets')
          .query(query)
          .set(asBearerAuth(admin.accessToken));
        expect(status).toBe(200);
        return (body as { count: number }[]).reduce((sum, bucket) => sum + bucket.count, 0);
      };

      await expect(count({})).resolves.toBe(2);
      await expect(count({ assetType: AssetTypeEnum.Video })).resolves.toBe(1);
      await expect(count({ assetType: AssetTypeEnum.Video, folder: `${root}/movies` })).resolves.toBe(1);
      await expect(count({ assetType: AssetTypeEnum.Video, folder: `${root}/photos` })).resolves.toBe(0);
      await expect(count({ folder: `${root}/mov` })).resolves.toBe(0);
    });

    it('should reject the folder filter for shared links', async () => {
      const sharedLink = await utils.createSharedLink(admin.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [videoId],
      });

      const { status } = await request(app).get('/timeline/buckets').query({ key: sharedLink.key, folder: root });
      expect(status).toBe(400);
    });
  });
});
