import { AlbumResponseDto, LoginResponseDto, ManualJobName } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, testAssetDir, testAssetDirInternal, utils } from 'src/utils.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = `${testAssetDir}/temp/folder-albums`;
const rootInternal = `${testAssetDirInternal}/temp/folder-albums`;

describe('folder albums', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;
  let manual: AlbumResponseDto;
  let albums: AlbumResponseDto[];

  const byName = (name: string) => {
    const album = albums.find((album) => album.albumName === name && album.isFolderAlbum);
    if (!album) {
      throw new Error(`Folder album ${name} not found`);
    }
    return album;
  };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    await utils.resetAdminConfig(admin.accessToken);
    user = await utils.userSetup(admin.accessToken, createUserDto.user1);

    utils.createImageFile(`${root}/2024/trip/day 1/a.png`);
    utils.createImageFile(`${root}/2024/trip/day 1/b.png`);
    utils.createImageFile(`${root}/2024/c.png`);

    const library = await utils.createLibrary(admin.accessToken, {
      ownerId: admin.userId,
      importPaths: [rootInternal],
    });
    await utils.scan(admin.accessToken, library.id);
    manual = await utils.createAlbum(admin.accessToken, { albumName: 'Hand made' });

    await utils.createJob(admin.accessToken, { name: ManualJobName.FolderAlbumSync });
    await utils.waitForQueueFinish(admin.accessToken, 'backgroundTask');

    const { body } = await request(app).get('/albums').set(asBearerAuth(admin.accessToken));
    albums = body;
  });

  afterAll(() => {
    utils.resetTempFolder();
  });

  describe('GET /albums', () => {
    it('should return every folder album in the flat list with its parent', () => {
      const rootAlbum = byName('folder-albums');
      const year = byName('2024');
      const trip = byName('trip');
      const day = byName('day 1');

      expect(rootAlbum).toMatchObject({ isFolderAlbum: true, parentAlbumId: null, childAlbumCount: 1, assetCount: 0 });
      expect(year).toMatchObject({ parentAlbumId: rootAlbum.id, childAlbumCount: 1, assetCount: 1 });
      expect(trip).toMatchObject({ parentAlbumId: year.id, childAlbumCount: 1, assetCount: 0 });
      expect(day).toMatchObject({ parentAlbumId: trip.id, childAlbumCount: 0, assetCount: 2 });
      expect(day.albumUsers[0].user.id).toBe(admin.userId);
    });

    it('should keep hand-made albums unchanged', () => {
      expect(albums.find(({ id }) => id === manual.id)).toMatchObject({
        albumName: 'Hand made',
        isFolderAlbum: false,
        parentAlbumId: null,
        childAlbumCount: 0,
      });
    });

    it('should only return top-level albums with topLevel=true', async () => {
      const { status, body } = await request(app)
        .get('/albums')
        .query({ topLevel: true })
        .set(asBearerAuth(admin.accessToken));

      expect(status).toBe(200);
      expect((body as AlbumResponseDto[]).map(({ id }) => id).toSorted()).toEqual(
        [manual.id, byName('folder-albums').id].toSorted(),
      );
    });

    it('should not show folder albums of other users', async () => {
      const { body } = await request(app).get('/albums').set(asBearerAuth(user.accessToken));
      expect(body).toEqual([]);
    });
  });

  describe('GET /albums/:id/folder', () => {
    it('should require authentication', async () => {
      const { status } = await request(app).get(`/albums/${byName('trip').id}/folder`);
      expect(status).toBe(401);
    });

    it('should validate the id', async () => {
      const { status } = await request(app).get('/albums/not-a-uuid/folder').set(asBearerAuth(admin.accessToken));
      expect(status).toBe(400);
    });

    it('should return breadcrumbs and child albums', async () => {
      const { status, body } = await request(app)
        .get(`/albums/${byName('trip').id}/folder`)
        .set(asBearerAuth(admin.accessToken));

      expect(status).toBe(200);
      expect(body).toMatchObject({
        isFolderAlbum: true,
        path: 'folder-albums/2024/trip',
        ancestors: [
          { id: byName('folder-albums').id, albumName: 'folder-albums' },
          { id: byName('2024').id, albumName: '2024' },
        ],
      });
      expect(body.children).toHaveLength(1);
      expect(body.children[0]).toMatchObject({ id: byName('day 1').id, assetCount: 2, isFolderAlbum: true });
    });

    it('should return nothing for a hand-made album', async () => {
      const { status, body } = await request(app)
        .get(`/albums/${manual.id}/folder`)
        .set(asBearerAuth(admin.accessToken));

      expect(status).toBe(200);
      expect(body).toEqual({ isFolderAlbum: false, ancestors: [], children: [] });
    });

    it('should not let another user read an album that is not shared with them', async () => {
      const { status } = await request(app)
        .get(`/albums/${byName('trip').id}/folder`)
        .set(asBearerAuth(user.accessToken));

      expect(status).toBe(400);
    });
  });

  describe('read-only parts', () => {
    it('should not rename a folder album', async () => {
      const { status, body } = await request(app)
        .patch(`/albums/${byName('trip').id}`)
        .set(asBearerAuth(admin.accessToken))
        .send({ albumName: 'Other' });

      expect(status).toBe(400);
      expect(body.message).toBe('Folder albums are named after their folder');
    });

    it('should allow editing the description', async () => {
      const { status, body } = await request(app)
        .patch(`/albums/${byName('trip').id}`)
        .set(asBearerAuth(admin.accessToken))
        .send({ description: 'Summer' });

      expect(status).toBe(200);
      expect(body).toMatchObject({ albumName: 'trip', description: 'Summer', isFolderAlbum: true });
    });

    it('should not delete a folder album', async () => {
      const { status } = await request(app)
        .delete(`/albums/${byName('trip').id}`)
        .set(asBearerAuth(admin.accessToken));

      expect(status).toBe(400);
    });

    it('should not add or remove assets', async () => {
      const day = byName('day 1');
      const { body: assets } = await request(app)
        .get(`/albums/${byName('2024').id}`)
        .set(asBearerAuth(admin.accessToken));
      expect(assets.assetCount).toBe(1);

      const { body: dayAlbum } = await request(app)
        .get(`/view/folder`)
        .query({ path: `${rootInternal}/2024` })
        .set(asBearerAuth(admin.accessToken));
      const assetId = dayAlbum[0].id;

      const added = await request(app)
        .put(`/albums/${day.id}/assets`)
        .set(asBearerAuth(admin.accessToken))
        .send({ ids: [assetId] });
      expect(added.status).toBe(200);
      expect(added.body).toEqual([{ id: assetId, success: false, error: 'no_permission' }]);

      const removed = await request(app)
        .delete(`/albums/${byName('2024').id}/assets`)
        .set(asBearerAuth(admin.accessToken))
        .send({ ids: [assetId] });
      expect(removed.status).toBe(200);
      expect(removed.body).toEqual([{ id: assetId, success: false, error: 'no_permission' }]);
    });
  });

  describe('sharing', () => {
    it('should share a folder album and show it at the top level for the other user', async () => {
      const trip = byName('trip');
      const { status } = await request(app)
        .put(`/albums/${trip.id}/users`)
        .set(asBearerAuth(admin.accessToken))
        .send({ albumUsers: [{ userId: user.userId, role: 'viewer' }] });
      expect(status).toBe(200);

      const { body } = await request(app)
        .get('/albums')
        .query({ topLevel: true })
        .set(asBearerAuth(user.accessToken));
      expect((body as AlbumResponseDto[]).map(({ id }) => id)).toEqual([trip.id]);
      expect(body[0]).toMatchObject({ isFolderAlbum: true, childAlbumCount: 0 });

      const { body: folder } = await request(app)
        .get(`/albums/${trip.id}/folder`)
        .set(asBearerAuth(user.accessToken));
      expect(folder).toEqual({ isFolderAlbum: true, ancestors: [], children: [] });
    });
  });

  describe('sync', () => {
    it('should keep folder albums unchanged when synced again', async () => {
      await utils.createJob(admin.accessToken, { name: ManualJobName.FolderAlbumSync });
      await utils.waitForQueueFinish(admin.accessToken, 'backgroundTask');

      const { body } = await request(app).get('/albums').set(asBearerAuth(admin.accessToken));
      const ids = (list: AlbumResponseDto[]) =>
        list
          .filter(({ isFolderAlbum }) => isFolderAlbum)
          .map(({ id }) => id)
          .toSorted();
      expect(ids(body)).toEqual(ids(albums));
    });
  });
});
