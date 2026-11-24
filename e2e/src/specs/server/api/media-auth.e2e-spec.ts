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

type Kind = 'image' | 'video';
type Result = { status: number; body: { message?: unknown } };

type MediaRoute = {
  name: string;
  kind: Kind;
  method: 'get' | 'post';
  path: (assetId: string) => string;
  body?: (assetId: string) => object;
  file: boolean;
  needsDownload?: boolean;
  allowed: ((result: Result) => boolean) | null;
};

const ok =
  (...statuses: number[]) =>
  (result: Result) =>
    statuses.includes(result.status);

const message = (status: number, text: string) => (result: Result) =>
  result.status === status && typeof result.body?.message === 'string' && result.body.message.includes(text);

const mediaRoutes: MediaRoute[] = [
  {
    name: 'thumbnail',
    kind: 'image',
    method: 'get',
    path: (id) => `/assets/${id}/thumbnail`,
    file: true,
    allowed: ok(200),
  },
  {
    name: 'preview',
    kind: 'image',
    method: 'get',
    path: (id) => `/assets/${id}/thumbnail?size=preview`,
    file: true,
    allowed: ok(200),
  },
  {
    name: 'fullsize',
    kind: 'image',
    method: 'get',
    path: (id) => `/assets/${id}/thumbnail?size=fullsize`,
    file: true,
    allowed: ok(200, 302),
  },
  {
    name: 'original',
    kind: 'image',
    method: 'get',
    path: (id) => `/assets/${id}/original`,
    file: true,
    needsDownload: true,
    allowed: ok(200),
  },
  {
    name: 'video playback',
    kind: 'video',
    method: 'get',
    path: (id) => `/assets/${id}/video/playback`,
    file: true,
    allowed: ok(200),
  },
  {
    name: 'hls main playlist',
    kind: 'video',
    method: 'get',
    path: (id) => `/assets/${id}/video/stream/main.m3u8`,
    file: false,
    allowed: message(400, 'Real-time transcoding is not enabled'),
  },
  {
    name: 'hls media playlist',
    kind: 'video',
    method: 'get',
    path: (id) => `/assets/${id}/video/stream/${id}/0/playlist.m3u8`,
    file: false,
    allowed: message(404, 'not yet ready for streaming'),
  },
  {
    name: 'hls segment',
    kind: 'video',
    method: 'get',
    path: (id) => `/assets/${id}/video/stream/${id}/0/seg_0.m4s`,
    file: true,
    allowed: null,
  },
  {
    name: 'asset metadata',
    kind: 'image',
    method: 'get',
    path: (id) => `/assets/${id}`,
    file: false,
    allowed: ok(200),
  },
  {
    name: 'download info',
    kind: 'image',
    method: 'post',
    path: () => '/download/info',
    body: (id) => ({ assetIds: [id] }),
    file: false,
    needsDownload: true,
    allowed: ok(201),
  },
  {
    name: 'download archive',
    kind: 'image',
    method: 'post',
    path: () => '/download/archive',
    body: (id) => ({ assetIds: [id] }),
    file: false,
    needsDownload: true,
    allowed: ok(200),
  },
];

const send = async (route: MediaRoute, assetId: string, headers: Record<string, string> = {}, query = '') => {
  const path = route.path(assetId);
  const url = query ? `${path}${path.includes('?') ? '&' : '?'}${query}` : path;
  const req = route.method === 'get' ? request(app).get(url) : request(app).post(url).send(route.body!(assetId));
  const { status, body } = await req.set(headers);
  return { status, body } as Result;
};

const isDenied = (route: MediaRoute, { status, body }: Result) => {
  if (status === 401 || status === 403) {
    return true;
  }

  if (route.file) {
    return status === 404;
  }

  return status === 400 && typeof body?.message === 'string' && body.message.includes('access');
};

const expectDenied = (route: MediaRoute, result: Result) => {
  expect(isDenied(route, result), JSON.stringify(result)).toBe(true);
};

const expectAllowed = (route: MediaRoute, result: Result) => {
  if (route.allowed) {
    expect(route.allowed(result), JSON.stringify(result)).toBe(true);
  } else {
    expect([401, 403], JSON.stringify(result)).not.toContain(result.status);
  }
};

describe('media endpoints require authentication', () => {
  let admin: LoginResponseDto;
  let owner: LoginResponseDto;
  let stranger: LoginResponseDto;
  const shared = {} as Record<Kind, AssetMediaResponseDto>;
  const hidden = {} as Record<Kind, AssetMediaResponseDto>;
  const inAlbum = {} as Record<Kind, AssetMediaResponseDto>;
  let album: AlbumResponseDto;
  let linkWithDownload: SharedLinkResponseDto;
  let linkWithoutDownload: SharedLinkResponseDto;
  let linkWithPassword: SharedLinkResponseDto;
  let albumLink: SharedLinkResponseDto;
  let foreignLink: SharedLinkResponseDto;
  let passwordCookies: string[];
  let readOnlyKey: string;

  const createAsset = (kind: Kind) =>
    utils.createAsset(owner.accessToken, kind === 'video' ? { assetData: { filename: 'example.mp4' } } : undefined);

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    [owner, stranger] = await Promise.all([
      utils.userSetup(admin.accessToken, createUserDto.user1),
      utils.userSetup(admin.accessToken, createUserDto.user2),
    ]);

    for (const kind of ['image', 'video'] as const) {
      const assets = await Promise.all([createAsset(kind), createAsset(kind), createAsset(kind)]);
      shared[kind] = assets[0];
      hidden[kind] = assets[1];
      inAlbum[kind] = assets[2];
    }
    const strangerAsset = await utils.createAsset(stranger.accessToken);

    album = await utils.createAlbum(owner.accessToken, { albumName: 'shared album' });
    await addAssetsToAlbum(
      { id: album.id, bulkIdsDto: { ids: [inAlbum.image.id, inAlbum.video.id] } },
      { headers: asBearerAuth(owner.accessToken) },
    );

    const sharedIds = [shared.image.id, shared.video.id];
    [linkWithDownload, linkWithoutDownload, linkWithPassword, albumLink, foreignLink] = await Promise.all([
      utils.createSharedLink(owner.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: sharedIds,
        allowDownload: true,
      }),
      utils.createSharedLink(owner.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: sharedIds,
        allowDownload: false,
      }),
      utils.createSharedLink(owner.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: sharedIds,
        password: 'secret',
      }),
      utils.createSharedLink(owner.accessToken, { type: SharedLinkType.Album, albumId: album.id, allowDownload: true }),
      utils.createSharedLink(stranger.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [strangerAsset.id],
        allowDownload: true,
      }),
    ]);

    const loginResponse = await request(app)
      .post('/shared-links/login')
      .query({ key: linkWithPassword.key })
      .send({ password: 'secret' });
    expect(loginResponse.status).toBe(201);
    passwordCookies = loginResponse.get('Set-Cookie') ?? [];

    const { secret } = await utils.createApiKey(owner.accessToken, [Permission.AssetRead]);
    readOnlyKey = secret;

    await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');
    await utils.waitForQueueFinish(admin.accessToken, 'thumbnailGeneration');
  });

  describe.each(mediaRoutes)('$name', (route) => {
    const id = (group: Record<Kind, AssetMediaResponseDto>) => group[route.kind].id;

    it('should reject a request without credentials', async () => {
      const { status } = await send(route, id(shared));
      expect(status).toBe(401);
    });

    it('should reject an invalid session token', async () => {
      const { status } = await send(route, id(shared), asBearerAuth('not-a-real-token'));
      expect(status).toBe(401);
    });

    it('should reject an invalid shared link key', async () => {
      const { status } = await send(route, id(shared), {}, 'key=not-a-real-key');
      expect(status).toBe(401);
    });

    it('should reject another user', async () => {
      expectDenied(route, await send(route, id(shared), asBearerAuth(stranger.accessToken)));
    });

    it('should allow the owner', async () => {
      expectAllowed(route, await send(route, id(shared), asBearerAuth(owner.accessToken)));
    });

    it('should reject an API key without the required permission', async () => {
      if (route.name === 'asset metadata') {
        return;
      }
      const { status } = await send(route, id(shared), asKeyAuth(readOnlyKey));
      expect(status).toBe(403);
    });

    it('should not let a shared link reach an asset outside of the link', async () => {
      expectDenied(route, await send(route, id(hidden), {}, `key=${linkWithDownload.key}`));
    });

    it("should not let a shared link of another user reach the owner's asset", async () => {
      expectDenied(route, await send(route, id(shared), {}, `key=${foreignLink.key}`));
    });

    it('should not let a shared link widen the access of a logged in user', async () => {
      expectDenied(route, await send(route, id(hidden), asBearerAuth(owner.accessToken), `key=${foreignLink.key}`));
    });

    it('should require the password of a protected shared link', async () => {
      const { status, body } = await send(route, id(shared), {}, `key=${linkWithPassword.key}`);
      expect(status).toBe(401);
      if (!route.file) {
        expect(body).toEqual(expect.objectContaining({ message: 'Password required' }));
      }
    });

    it('should allow a protected shared link after its password was entered', async () => {
      const result = await send(
        route,
        id(shared),
        { Cookie: passwordCookies.join('; ') },
        `key=${linkWithPassword.key}`,
      );
      expectAllowed(route, result);
    });

    it('should allow a shared link for its own asset', async () => {
      expectAllowed(route, await send(route, id(shared), {}, `key=${linkWithDownload.key}`));
    });

    it('should allow an album shared link for an asset in the album', async () => {
      expectAllowed(route, await send(route, id(inAlbum), {}, `key=${albumLink.key}`));
    });

    it('should not let an album shared link reach an asset outside of the album', async () => {
      expectDenied(route, await send(route, id(hidden), {}, `key=${albumLink.key}`));
    });

    it(`should ${route.needsDownload ? 'reject' : 'allow'} a shared link without download permission`, async () => {
      const result = await send(route, id(shared), {}, `key=${linkWithoutDownload.key}`);
      if (route.needsDownload) {
        expectDenied(route, result);
      } else {
        expectAllowed(route, result);
      }
    });
  });

  describe('asset file download', () => {
    it('should only serve asset files to their owner', async () => {
      const files = await searchAssetFiles({ assetId: shared.image.id }, { headers: asBearerAuth(owner.accessToken) });
      expect(files.length).toBeGreaterThan(0);
      const fileId = files[0].id;

      const anonymous = await request(app).get(`/asset-files/${fileId}/download`);
      expect(anonymous.status).toBe(401);

      const sharedLink = await request(app).get(`/asset-files/${fileId}/download?key=${linkWithDownload.key}`);
      expect(sharedLink.status).toBe(403);

      const other = await request(app).get(`/asset-files/${fileId}/download`).set(asBearerAuth(stranger.accessToken));
      expect(other.status).toBe(404);

      const own = await request(app).get(`/asset-files/${fileId}/download`).set(asBearerAuth(owner.accessToken));
      expect(own.status).toBe(200);
    });
  });

  describe('people and profile images', () => {
    it('should protect person thumbnails', async () => {
      const person = await utils.createPerson(owner.accessToken, { name: 'Someone' });
      const [file] = await searchAssetFiles({ assetId: shared.image.id }, { headers: asBearerAuth(owner.accessToken) });
      const client = await utils.connectDatabase();
      const { rows } = await client.query('SELECT "path" FROM "asset_file" WHERE "id" = $1', [file.id]);
      await client.query('UPDATE "person" SET "thumbnailPath" = $1 WHERE "personGroupId" = $2', [
        rows[0].path,
        person.id,
      ]);

      const anonymous = await request(app).get(`/people/${person.id}/thumbnail`);
      expect(anonymous.status).toBe(401);

      const sharedLink = await request(app).get(`/people/${person.id}/thumbnail?key=${linkWithDownload.key}`);
      expect(sharedLink.status).toBe(403);

      const other = await request(app).get(`/people/${person.id}/thumbnail`).set(asBearerAuth(stranger.accessToken));
      expect(other.status).toBe(404);

      const own = await request(app).get(`/people/${person.id}/thumbnail`).set(asBearerAuth(owner.accessToken));
      expect(own.status).toBe(200);
    });

    it('should protect profile images', async () => {
      const anonymous = await request(app).get(`/users/${owner.userId}/profile-image`);
      expect(anonymous.status).toBe(401);

      const sharedLink = await request(app).get(`/users/${owner.userId}/profile-image?key=${linkWithDownload.key}`);
      expect(sharedLink.status).toBe(403);

      const loggedIn = await request(app)
        .get(`/users/${owner.userId}/profile-image`)
        .set(asBearerAuth(stranger.accessToken));
      expect([401, 403]).not.toContain(loggedIn.status);
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

  describe('password protected shared links', () => {
    it('should still reach the shared link login without the password cookie', async () => {
      const { status, body } = await request(app)
        .post('/shared-links/login')
        .query({ key: linkWithPassword.key })
        .send({ password: 'wrong' });
      expect(status).toBe(401);
      expect(body).toEqual(expect.objectContaining({ message: 'Invalid password' }));
    });

    it('should not accept the password cookie of another shared link', async () => {
      const otherLink = await utils.createSharedLink(owner.accessToken, {
        type: SharedLinkType.Individual,
        assetIds: [shared.image.id],
        password: 'other',
      });

      const { status } = await request(app)
        .get(`/assets/${shared.image.id}/thumbnail`)
        .query({ key: otherLink.key })
        .set('Cookie', passwordCookies);
      expect(status).toBe(401);
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
      await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');
      await utils.waitForQueueFinish(admin.accessToken, 'thumbnailGeneration');

      const before = await request(app).get(`/assets/${asset.id}/thumbnail?key=${link.key}`);
      expect(before.status).toBe(200);

      await updateAssets(
        { assetBulkUpdateDto: { ids: [asset.id], visibility: AssetVisibility.Locked } },
        { headers: asBearerAuth(owner.accessToken) },
      );

      const thumbnail = await request(app).get(`/assets/${asset.id}/thumbnail?key=${link.key}`);
      expect(thumbnail.status).toBe(404);
      const original = await request(app).get(`/assets/${asset.id}/original?key=${link.key}`);
      expect(original.status).toBe(404);
      const metadata = await request(app).get(`/assets/${asset.id}?key=${link.key}`);
      expect(metadata.status).toBe(400);

      const { status, body } = await request(app).get(`/shared-links/me?key=${link.key}`);
      expect(status).toBe(200);
      expect(body.assets).toEqual([]);
    });
  });
});
