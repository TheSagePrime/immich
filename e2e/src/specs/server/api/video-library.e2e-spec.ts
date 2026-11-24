import { AssetTypeEnum, LoginResponseDto, SharedLinkType } from '@immich/sdk';
import { mkdirSync, writeFileSync } from 'node:fs';
import { app, asBearerAuth, testAssetDir, testAssetDirInternal, utils } from 'src/utils.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hostRoot = `${testAssetDir}/temp/videos`;
const root = `${testAssetDirInternal}/temp/videos`;

const writeFile = (path: string, content: string | Buffer) => {
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  writeFileSync(path, content);
};

describe('/video-library', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;
  let videoId: string;

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
    utils.createImageFile(`${hostRoot}/photos/photo.png`);

    const library = await utils.createLibrary(admin.accessToken, { ownerId: admin.userId, importPaths: [root] });
    await utils.scan(admin.accessToken, library.id);

    videoId = await findAsset('movie.mp4');
  });

  afterAll(() => {
    utils.resetTempFolder();
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
