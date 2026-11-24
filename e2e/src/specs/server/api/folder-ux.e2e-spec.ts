import { LoginResponseDto } from '@immich/sdk';
import { writeFileSync } from 'node:fs';
import { app, asBearerAuth, testAssetDir, testAssetDirInternal, utils } from 'src/utils.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hostRoot = `${testAssetDir}/temp/folder-ux`;
const root = `${testAssetDirInternal}/temp/folder-ux`;
const readOnlyHostRoot = `${testAssetDir}/temp/folder-ux-readonly`;
const readOnlyRoot = `${testAssetDirInternal}/temp/folder-ux-readonly`;

const padImage = (path: string, extraBytes: number) => {
  utils.createImageFile(path);
  writeFileSync(path, Buffer.alloc(extraBytes), { flag: 'a' });
};

describe('folder roots, sort and download', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;
  let writableId: string;
  let readOnlyId: string;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    await utils.resetAdminConfig(admin.accessToken);
    user = await utils.userSetup(admin.accessToken, {
      email: 'folder-ux-user@immich.cloud',
      name: 'Folder UX User',
      password: 'password',
    });

    utils.resetTempFolder();
    padImage(`${hostRoot}/Day 10/a.png`, 1000);
    padImage(`${hostRoot}/Day 2/b.png`, 5000);
    padImage(`${hostRoot}/Day 2/c.png`, 10);
    padImage(`${readOnlyHostRoot}/Trips/d.png`, 0);

    const writable = await utils.createLibrary(admin.accessToken, {
      ownerId: admin.userId,
      name: 'Uploads',
      importPaths: [root],
      writable: true,
    });
    writableId = writable.id;
    await utils.scan(admin.accessToken, writable.id);

    const readOnly = await utils.createLibrary(admin.accessToken, {
      ownerId: admin.userId,
      name: 'Media',
      importPaths: [readOnlyRoot],
    });
    readOnlyId = readOnly.id;
    await utils.scan(admin.accessToken, readOnly.id);

    await utils.createAsset(admin.accessToken);

    for (const folder of ['Day 2', 'Day 10']) {
      await utils.poll(
        () =>
          request(app)
            .get('/view/folder')
            .query({ path: `${root}/${folder}` })
            .set(asBearerAuth(admin.accessToken)),
        ({ body }) =>
          Array.isArray(body) &&
          body.length > 0 &&
          body.every((asset: { exifInfo?: { fileSizeInByte?: number } }) => !!asset.exifInfo?.fileSizeInByte),
      );
    }
  });

  afterAll(() => {
    utils.resetTempFolder();
  });

  describe('GET /view/folder/roots', () => {
    it('should require authentication', async () => {
      const { status } = await request(app).get('/view/folder/roots');
      expect(status).toBe(401);
    });

    it('should list one root per library and one for uploaded assets', async () => {
      const { status, body } = await request(app).get('/view/folder/roots').set(asBearerAuth(admin.accessToken));

      expect(status).toBe(200);
      expect(body).toEqual([
        {
          id: readOnlyId,
          kind: 'library',
          name: 'Media',
          writable: false,
          assetCount: 1,
          coverAssetId: expect.any(String),
          folders: [{ name: 'folder-ux-readonly', path: readOnlyRoot, writable: false }],
        },
        {
          id: writableId,
          kind: 'library',
          name: 'Uploads',
          writable: true,
          assetCount: 3,
          coverAssetId: expect.any(String),
          folders: [{ name: 'folder-ux', path: root, writable: true }],
        },
        {
          id: 'uploads',
          kind: 'uploads',
          name: 'Uploads',
          writable: false,
          assetCount: 1,
          coverAssetId: expect.any(String),
          folders: [{ name: expect.any(String), path: expect.stringMatching(/^\//), writable: false }],
        },
      ]);
    });

    it('should not show the libraries or assets of other users', async () => {
      const { status, body } = await request(app).get('/view/folder/roots').set(asBearerAuth(user.accessToken));

      expect(status).toBe(200);
      expect(body).toEqual([]);
    });
  });

  describe('GET /view/folder/summary metrics', () => {
    it('should return the date and size metrics of child folders in natural order', async () => {
      const { status, body } = await request(app)
        .get('/view/folder/summary')
        .query({ path: root })
        .set(asBearerAuth(admin.accessToken));

      expect(status).toBe(200);
      expect(body.children.map(({ name }: { name: string }) => name)).toEqual(['Day 2', 'Day 10']);

      const [day2, day10] = body.children;
      expect(day2).toEqual({
        name: 'Day 2',
        path: `${root}/Day 2`,
        assetCount: 2,
        coverAssetId: expect.any(String),
        newestTakenAt: expect.any(String),
        oldestTakenAt: expect.any(String),
        newestAddedAt: expect.any(String),
        oldestAddedAt: expect.any(String),
        totalSize: expect.any(Number),
      });
      expect(day2.totalSize).toBeGreaterThan(day10.totalSize);
      expect(new Date(day2.newestAddedAt).getTime()).toBeGreaterThanOrEqual(new Date(day2.oldestAddedAt).getTime());

      const assets = await request(app)
        .get('/view/folder')
        .query({ path: `${root}/Day 2` })
        .set(asBearerAuth(admin.accessToken));
      const sizes = (assets.body as { exifInfo?: { fileSizeInByte?: number } }[]).map(
        ({ exifInfo }) => exifInfo?.fileSizeInByte ?? 0,
      );
      expect(day2.totalSize).toBe(sizes.reduce((sum, size) => sum + size, 0));
    });
  });

  describe('PUT /users/me/preferences folder sort', () => {
    it('should default to name A-Z and store the sort per folder', async () => {
      const before = await request(app).get('/users/me/preferences').set(asBearerAuth(admin.accessToken));
      expect(before.body.folders).toEqual(
        expect.objectContaining({ sortBy: 'name', sortOrder: 'asc', sortOverrides: [] }),
      );

      const sortOverrides = [{ path: `${root}/Day 2`, sortBy: 'fileSize', sortOrder: 'desc' }];
      const { status } = await request(app)
        .put('/users/me/preferences')
        .send({ folders: { sortBy: 'dateTaken', sortOrder: 'desc', sortOverrides } })
        .set(asBearerAuth(admin.accessToken));
      expect(status).toBe(200);

      const after = await request(app).get('/users/me/preferences').set(asBearerAuth(admin.accessToken));
      expect(after.body.folders).toEqual(
        expect.objectContaining({ enabled: true, sortBy: 'dateTaken', sortOrder: 'desc', sortOverrides }),
      );
    });

    it('should reject an unknown sort', async () => {
      const { status } = await request(app)
        .put('/users/me/preferences')
        .send({ folders: { sortBy: 'colour' } })
        .set(asBearerAuth(admin.accessToken));
      expect(status).toBe(400);
    });
  });

  describe('POST /download/info folderPath', () => {
    it('should list the assets of the folder and its subfolders', async () => {
      const { status, body } = await request(app)
        .post('/download/info')
        .send({ folderPath: root })
        .set(asBearerAuth(admin.accessToken));

      expect(status).toBe(201);
      expect(body.archives.flatMap(({ assetIds }: { assetIds: string[] }) => assetIds)).toHaveLength(3);
    });

    it('should not return the assets of another user', async () => {
      const { status, body } = await request(app)
        .post('/download/info')
        .send({ folderPath: root })
        .set(asBearerAuth(user.accessToken));

      expect(status).toBe(201);
      expect(body.archives.flatMap(({ assetIds }: { assetIds: string[] }) => assetIds)).toHaveLength(0);
    });

    it('should reject a relative path', async () => {
      const { status } = await request(app)
        .post('/download/info')
        .send({ folderPath: 'relative/path' })
        .set(asBearerAuth(admin.accessToken));
      expect(status).toBe(400);
    });
  });
});
