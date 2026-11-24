import {
  AlbumResponseDto,
  AssetMediaResponseDto,
  AssetVisibility,
  LoginResponseDto,
  Permission,
  SharedLinkResponseDto,
  SharedLinkType,
  addAssetsToAlbum,
  searchAssetFiles,
  updateAssets,
} from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, asKeyAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

type MediaRoute = {
  name: string;
  method: 'get' | 'post';
  path: (assetId: string) => string;
  body?: (assetId: string) => object;
  sharedLink: boolean;
  needsDownload?: boolean;
};

const mediaRoutes: MediaRoute[] = [
  { name: 'thumbnail', method: 'get', path: (id) => `/assets/${id}/thumbnail`, sharedLink: true },
  { name: 'preview', method: 'get', path: (id) => `/assets/${id}/thumbnail?size=preview`, sharedLink: true },
  { name: 'fullsize', method: 'get', path: (id) => `/assets/${id}/thumbnail?size=fullsize`, sharedLink: true },
  {
    name: 'original',
    method: 'get',
    path: (id) => `/assets/${id}/original`,
    sharedLink: true,
    needsDownload: true,
  },
  { name: 'video playback', method: 'get', path: (id) => `/assets/${id}/video/playback`, sharedLink: true },
  { name: 'hls main playlist', method: 'get', path: (id) => `/assets/${id}/video/stream/main.m3u8`, sharedLink: true },
  {
    name: 'hls media playlist',
    method: 'get',
    path: (id) => `/assets/${id}/video/stream/${id}/0/playlist.m3u8`,
    sharedLink: true,
  },
  {
    name: 'hls segment',
    method: 'get',
    path: (id) => `/assets/${id}/video/stream/${id}/0/seg_0.m4s`,
    sharedLink: true,
  },
  { name: 'asset metadata', method: 'get', path: (id) => `/assets/${id}`, sharedLink: true },
  {
    name: 'download info',
    method: 'post',
    path: () => '/download/info',
    body: (id) => ({ assetIds: [id] }),
    sharedLink: true,
    needsDownload: true,
  },
  {
    name: 'download archive',
    method: 'post',
    path: () => '/download/archive',
    body: (id) => ({ assetIds: [id] }),
    sharedLink: true,
    needsDownload: true,
  },
];

const send = (route: MediaRoute, assetId: string, headers: Record<string, string> = {}, query = '') => {
  const path = route.path(assetId);
  const url = query ? `${path}${path.includes('?') ? '&' : '?'}${query}` : path;
  const req = route.method === 'get' ? request(app).get(url) : request(app).post(url).send(route.body!(assetId));
  return req.set(headers);
};

const isAccessDenied = (status: number, body: { message?: string }) =>
  status === 401 ||
  status === 403 ||
  (status === 400 && typeof body?.message === 'string' && body.message.includes('access'));

describe('media endpoints require authentication', () => {
  let admin: LoginResponseDto;
  let owner: LoginResponseDto;
  let stranger: LoginResponseDto;
  let sharedAsset: AssetMediaResponseDto;
  let privateAsset: AssetMediaResponseDto;
  let albumAsset: AssetMediaResponseDto;
  let album: AlbumResponseDto;
  let linkWithDownload: SharedLinkResponseDto;
  let linkWithoutDownload: SharedLinkResponseDto;
  let linkWithPassword: SharedLinkResponseDto;
  let albumLink: SharedLinkResponseDto;
  let foreignLink: SharedLinkResponseDto;
  let readOnlyKey: string;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    [owner, stranger] = await Promise.all([
      utils.userSetup(admin.accessToken, createUserDto.user1),
      utils.userSetup(admin.accessToken, createUserDto.user2),
    ]);

    [sharedAsset, privateAsset, albumAsset] = await Promise.all([
      utils.createAsset(owner.accessToken),
      utils.createAsset(owner.accessToken),
      utils.createAsset(owner.accessToken),
    ]);
    const strangerAsset = await utils.createAsset(stranger.accessToken);

    album = await utils.createAlbum(owner.accessToken, { albumName: 'shared album' });
    await addAssetsToAlbum(
      { id: album.id, bulkIdsDto: { ids: [albumAsset.id] } },
      { headers: asBearerAuth(owner.accessToken) },
    );

    [linkWithDownload, linkWithoutDownload, linkWithPassword, albumLink, foreignLink] = await Promise.all([
      utils.createSharedLink(owner.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [sharedAsset.id],
        allowDownload: true,
      }),
      utils.createSharedLink(owner.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [sharedAsset.id],
        allowDownload: false,
      }),
      utils.createSharedLink(owner.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [sharedAsset.id],
        password: 'secret',
      }),
      utils.createSharedLink(owner.accessToken, { type: SharedLinkType.Album, albumId: album.id, allowDownload: true }),
      utils.createSharedLink(stranger.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [strangerAsset.id],
        allowDownload: true,
      }),
    ]);

    const { secret } = await utils.createApiKey(owner.accessToken, [Permission.AssetRead]);
    readOnlyKey = secret;

    await utils.waitForQueueFinish(admin.accessToken, 'thumbnailGeneration');
  });

  describe.each(mediaRoutes)('$name', (route) => {
    it('should reject a request without credentials', async () => {
      const { status } = await send(route, sharedAsset.id);
      expect(status).toBe(401);
    });

    it('should reject an invalid session token', async () => {
      const { status } = await send(route, sharedAsset.id, asBearerAuth('not-a-real-token'));
      expect(status).toBe(401);
    });

    it('should reject an invalid shared link key', async () => {
      const { status } = await send(route, sharedAsset.id, {}, 'key=not-a-real-key');
      expect(status).toBe(401);
    });

    it('should reject another user', async () => {
      const { status, body } = await send(route, sharedAsset.id, asBearerAuth(stranger.accessToken));
      expect(isAccessDenied(status, body)).toBe(true);
    });

    it('should allow the owner', async () => {
      const { status, body } = await send(route, sharedAsset.id, asBearerAuth(owner.accessToken));
      expect(isAccessDenied(status, body)).toBe(false);
    });

    it('should reject an API key without the required permission', async () => {
      if (route.name === 'asset metadata') {
        return;
      }
      const { status } = await send(route, sharedAsset.id, asKeyAuth(readOnlyKey));
      expect(status).toBe(403);
    });

    it('should not let a shared link reach an asset outside of the link', async () => {
      const { status, body } = await send(route, privateAsset.id, {}, `key=${linkWithDownload.key}`);
      expect(isAccessDenied(status, body)).toBe(true);
    });

    it("should not let a shared link of another user reach the owner's asset", async () => {
      const { status, body } = await send(route, sharedAsset.id, {}, `key=${foreignLink.key}`);
      expect(isAccessDenied(status, body)).toBe(true);
    });

    it('should not let a shared link override the session of a logged in user', async () => {
      const { status, body } = await send(
        route,
        privateAsset.id,
        asBearerAuth(owner.accessToken),
        `key=${foreignLink.key}`,
      );
      expect(isAccessDenied(status, body)).toBe(true);
    });

    it('should require the password of a protected shared link', async () => {
      const { status } = await send(route, sharedAsset.id, {}, `key=${linkWithPassword.key}`);
      expect(status).toBe(401);
    });

    it('should allow a shared link for its own asset', async () => {
      const { status, body } = await send(route, sharedAsset.id, {}, `key=${linkWithDownload.key}`);
      expect(isAccessDenied(status, body)).toBe(false);
    });

    it('should allow an album shared link for an asset in the album', async () => {
      const { status, body } = await send(route, albumAsset.id, {}, `key=${albumLink.key}`);
      expect(isAccessDenied(status, body)).toBe(false);
    });

    it('should not let an album shared link reach an asset outside of the album', async () => {
      const { status, body } = await send(route, privateAsset.id, {}, `key=${albumLink.key}`);
      expect(isAccessDenied(status, body)).toBe(true);
    });

    it(`should ${route.needsDownload ? 'reject' : 'allow'} a shared link without download permission`, async () => {
      const { status, body } = await send(route, sharedAsset.id, {}, `key=${linkWithoutDownload.key}`);
      expect(isAccessDenied(status, body)).toBe(!!route.needsDownload);
    });
  });

  describe('media content', () => {
    it('should serve the thumbnail and original to a shared link', async () => {
      const thumbnail = await request(app).get(`/assets/${sharedAsset.id}/thumbnail?key=${linkWithDownload.key}`);
      expect(thumbnail.status).toBe(200);
      expect(thumbnail.headers['content-type']).toMatch(/^image\//);

      const original = await request(app).get(`/assets/${sharedAsset.id}/original?key=${linkWithDownload.key}`);
      expect(original.status).toBe(200);
    });

    it('should not serve the thumbnail of another asset to a shared link', async () => {
      const { status } = await request(app).get(`/assets/${privateAsset.id}/thumbnail?key=${linkWithDownload.key}`);
      expect(status).toBe(400);
    });
  });

  describe('asset file download', () => {
    it('should only serve asset files to their owner', async () => {
      const files = await searchAssetFiles({ assetId: sharedAsset.id }, { headers: asBearerAuth(owner.accessToken) });
      expect(files.length).toBeGreaterThan(0);
      const fileId = files[0].id;

      const anonymous = await request(app).get(`/asset-files/${fileId}/download`);
      expect(anonymous.status).toBe(401);

      const shared = await request(app).get(`/asset-files/${fileId}/download?key=${linkWithDownload.key}`);
      expect(shared.status).toBe(403);

      const other = await request(app).get(`/asset-files/${fileId}/download`).set(asBearerAuth(stranger.accessToken));
      expect(other.status).toBe(400);

      const own = await request(app).get(`/asset-files/${fileId}/download`).set(asBearerAuth(owner.accessToken));
      expect(own.status).toBe(200);
    });
  });

  describe('people and profile images', () => {
    it('should protect person thumbnails', async () => {
      const person = await utils.createPerson(owner.accessToken, { name: 'Someone' });

      const anonymous = await request(app).get(`/people/${person.id}/thumbnail`);
      expect(anonymous.status).toBe(401);

      const shared = await request(app).get(`/people/${person.id}/thumbnail?key=${linkWithDownload.key}`);
      expect(shared.status).toBe(403);

      const other = await request(app).get(`/people/${person.id}/thumbnail`).set(asBearerAuth(stranger.accessToken));
      expect(isAccessDenied(other.status, other.body)).toBe(true);

      const own = await request(app).get(`/people/${person.id}/thumbnail`).set(asBearerAuth(owner.accessToken));
      expect(isAccessDenied(own.status, own.body)).toBe(false);
    });

    it('should protect profile images', async () => {
      const anonymous = await request(app).get(`/users/${owner.userId}/profile-image`);
      expect(anonymous.status).toBe(401);

      const shared = await request(app).get(`/users/${owner.userId}/profile-image?key=${linkWithDownload.key}`);
      expect(shared.status).toBe(403);

      const loggedIn = await request(app)
        .get(`/users/${owner.userId}/profile-image`)
        .set(asBearerAuth(stranger.accessToken));
      expect(isAccessDenied(loggedIn.status, loggedIn.body)).toBe(false);
    });
  });

  describe('album and timeline downloads', () => {
    it('should only give a shared link download info for its own album', async () => {
      const own = await request(app).post(`/download/info?key=${albumLink.key}`).send({ albumId: album.id });
      expect(own.status).toBe(201);

      const timeline = await request(app).post(`/download/info?key=${albumLink.key}`).send({ userId: owner.userId });
      expect(timeline.status).toBe(400);

      const other = await request(app).post(`/download/info?key=${foreignLink.key}`).send({ albumId: album.id });
      expect(other.status).toBe(400);
    });

    it("should not give another user download info for someone's timeline", async () => {
      const { status } = await request(app)
        .post('/download/info')
        .set(asBearerAuth(stranger.accessToken))
        .send({ userId: owner.userId });
      expect(status).toBe(400);
    });
  });

  describe('locked assets', () => {
    it('should stop serving an asset to its shared link once it is moved to the locked folder', async () => {
      const asset = await utils.createAsset(owner.accessToken);
      const link = await utils.createSharedLink(owner.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [asset.id],
        allowDownload: true,
      });
      await utils.waitForQueueFinish(admin.accessToken, 'thumbnailGeneration');

      const before = await request(app).get(`/assets/${asset.id}/thumbnail?key=${link.key}`);
      expect(before.status).toBe(200);

      await updateAssets(
        { assetBulkUpdateDto: { ids: [asset.id], visibility: AssetVisibility.Locked } },
        { headers: asBearerAuth(owner.accessToken) },
      );

      for (const path of [`/assets/${asset.id}/thumbnail`, `/assets/${asset.id}/original`, `/assets/${asset.id}`]) {
        const { status } = await request(app).get(`${path}?key=${link.key}`);
        expect(status).toBe(400);
      }

      const { status, body } = await request(app).get(`/shared-links/me?key=${link.key}`);
      expect(status).toBe(200);
      expect(body.assets).toEqual([]);
    });
  });
});
