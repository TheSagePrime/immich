import { LoginResponseDto } from '@immich/sdk';
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { app, asBearerAuth, testAssetDir, testAssetDirInternal, utils } from 'src/utils.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const hostRoot = `${testAssetDir}/temp/folders`;
const root = `${testAssetDirInternal}/temp/folders`;
const readOnlyHostRoot = `${testAssetDir}/temp/folders-readonly`;
const readOnlyRoot = `${testAssetDirInternal}/temp/folders-readonly`;

describe('/folders', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;
  let libraryId: string;

  const getAssetIds = async (path: string) => {
    const { body } = await request(app).get('/view/folder').query({ path }).set(asBearerAuth(admin.accessToken));
    return (body as { id: string }[]).map(({ id }) => id).toSorted((a, b) => a.localeCompare(b));
  };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    await utils.resetAdminConfig(admin.accessToken);
    user = await utils.userSetup(admin.accessToken, {
      email: 'folder-user@immich.cloud',
      name: 'Folder User',
      password: 'password',
    });

    utils.resetTempFolder();
    utils.createImageFile(`${hostRoot}/trip/day1/a.png`);
    utils.createImageFile(`${hostRoot}/trip/day1/b.png`);
    utils.createImageFile(`${hostRoot}/trip/c.png`);
    utils.createImageFile(`${hostRoot}/other/d.png`);
    mkdirSync(`${testAssetDir}/temp/outside`, { recursive: true });
    symlinkSync(`${testAssetDirInternal}/temp/outside`, `${hostRoot}/escape`);
    utils.createImageFile(`${readOnlyHostRoot}/photo.png`);

    const library = await utils.createLibrary(admin.accessToken, {
      ownerId: admin.userId,
      importPaths: [root],
      writable: true,
    });
    libraryId = library.id;
    await utils.scan(admin.accessToken, library.id);

    const readOnly = await utils.createLibrary(admin.accessToken, {
      ownerId: admin.userId,
      importPaths: [readOnlyRoot],
    });
    await utils.scan(admin.accessToken, readOnly.id);
  });

  afterAll(() => {
    utils.resetTempFolder();
  });

  describe('GET /view/folder/summary', () => {
    it('should return child folders with counts and covers', async () => {
      const { status, body } = await request(app)
        .get('/view/folder/summary')
        .query({ path: `${root}/trip` })
        .set(asBearerAuth(admin.accessToken));

      expect(status).toBe(200);
      expect(body).toEqual({
        path: `${root}/trip`,
        directAssetCount: 1,
        children: [
          {
            name: 'day1',
            path: `${root}/trip/day1`,
            assetCount: 2,
            coverAssetId: expect.any(String),
            newestTakenAt: expect.any(String),
            oldestTakenAt: expect.any(String),
            newestAddedAt: expect.any(String),
            oldestAddedAt: expect.any(String),
            totalSize: expect.any(Number),
          },
        ],
        writable: true,
        libraryId,
        isLibraryRoot: false,
      });
    });

    it('should not be writable for read-only libraries', async () => {
      const { status, body } = await request(app)
        .get('/view/folder/summary')
        .query({ path: readOnlyRoot })
        .set(asBearerAuth(admin.accessToken));

      expect(status).toBe(200);
      expect(body).toEqual(expect.objectContaining({ directAssetCount: 1, writable: false }));
    });

    it('should keep the unique paths response a list of strings', async () => {
      const { status, body } = await request(app).get('/view/folder/unique-paths').set(asBearerAuth(admin.accessToken));

      expect(status).toBe(200);
      expect(body).toEqual(expect.arrayContaining([`${root}/trip`, `${root}/trip/day1`, `${root}/other`]));
    });
  });

  describe('POST /folders', () => {
    it('should create a folder that shows up when browsing', async () => {
      const { status, body } = await request(app)
        .post('/folders')
        .set(asBearerAuth(admin.accessToken))
        .send({ parentPath: root, name: 'new' });

      expect(status).toBe(201);
      expect(body).toEqual({ path: `${root}/new` });
      expect(existsSync(`${hostRoot}/new`)).toBe(true);

      const { body: browse } = await request(app)
        .get('/folders/browse')
        .query({ path: root })
        .set(asBearerAuth(admin.accessToken));
      expect(browse.entries.map(({ name }: { name: string }) => name)).toEqual(['new', 'other', 'trip']);
    });

    it('should report existing folders as a conflict', async () => {
      const { status } = await request(app)
        .post('/folders')
        .set(asBearerAuth(admin.accessToken))
        .send({ parentPath: root, name: 'trip' });

      expect(status).toBe(409);
    });

    it.each([
      { parentPath: `${root}/../..`, name: 'evil' },
      { parentPath: root, name: '..' },
      { parentPath: root, name: '../evil' },
      { parentPath: `${root}/escape`, name: 'evil' },
      { parentPath: '/etc', name: 'evil' },
    ])('should refuse $parentPath + $name', async (dto) => {
      const { status } = await request(app).post('/folders').set(asBearerAuth(admin.accessToken)).send(dto);

      expect([400, 403]).toContain(status);
      expect(existsSync(`${testAssetDir}/temp/outside/evil`)).toBe(false);
    });

    it('should refuse read-only libraries', async () => {
      const { status } = await request(app)
        .post('/folders')
        .set(asBearerAuth(admin.accessToken))
        .send({ parentPath: readOnlyRoot, name: 'new' });

      expect(status).toBe(403);
      expect(existsSync(`${readOnlyHostRoot}/new`)).toBe(false);
    });

    it('should refuse libraries of other users', async () => {
      const { status } = await request(app)
        .post('/folders')
        .set(asBearerAuth(user.accessToken))
        .send({ parentPath: root, name: 'from-user' });

      expect(status).toBe(403);
      expect(existsSync(`${hostRoot}/from-user`)).toBe(false);
    });
  });

  describe('PUT /folders/rename', () => {
    it('should rename a folder and keep the asset ids', async () => {
      const before = await getAssetIds(`${root}/trip/day1`);
      expect(before).toHaveLength(2);

      const { status, body } = await request(app)
        .put('/folders/rename')
        .set(asBearerAuth(admin.accessToken))
        .send({ path: `${root}/trip/day1`, name: 'first day' });

      expect(status).toBe(200);
      expect(body).toEqual({ path: `${root}/trip/first day` });
      expect(readdirSync(`${hostRoot}/trip/first day`)).toHaveLength(2);
      await expect(getAssetIds(`${root}/trip/first day`)).resolves.toEqual(before);
      await expect(getAssetIds(`${root}/trip/day1`)).resolves.toEqual([]);
    });
  });

  describe('PUT /folders/rename with a nested library', () => {
    it('should refuse to rename a folder that contains the folder of another library', async () => {
      utils.createImageFile(`${hostRoot}/nested-parent/nested/e.png`);
      await utils.createLibrary(admin.accessToken, {
        ownerId: admin.userId,
        importPaths: [`${root}/nested-parent/nested`],
      });

      const { status, body } = await request(app)
        .put('/folders/rename')
        .set(asBearerAuth(admin.accessToken))
        .send({ path: `${root}/nested-parent`, name: 'renamed-parent' });

      expect(status).toBe(400);
      expect(body).toEqual(expect.objectContaining({ message: 'The folder contains the folder of a library' }));
      expect(existsSync(`${hostRoot}/nested-parent/nested/e.png`)).toBe(true);
      expect(existsSync(`${hostRoot}/renamed-parent`)).toBe(false);
    });
  });

  describe('PUT /folders/move', () => {
    it('should move files into another folder', async () => {
      const [assetId] = await getAssetIds(`${root}/trip`);

      const { status, body } = await request(app)
        .put('/folders/move')
        .set(asBearerAuth(admin.accessToken))
        .send({ assetIds: [assetId], destination: `${root}/other` });

      expect(status).toBe(200);
      expect(body).toEqual({ moved: 1, failed: [] });
      expect(existsSync(`${hostRoot}/other/c.png`)).toBe(true);
      expect(existsSync(`${hostRoot}/trip/c.png`)).toBe(false);
      await expect(getAssetIds(`${root}/other`)).resolves.toContain(assetId);
    });

    it('should not move a folder into itself', async () => {
      const { status, body } = await request(app)
        .put('/folders/move')
        .set(asBearerAuth(admin.accessToken))
        .send({ folderPaths: [`${root}/trip`], destination: `${root}/trip/first day` });

      expect(status).toBe(200);
      expect(body).toEqual({
        moved: 0,
        failed: [{ path: `${root}/trip`, reason: 'A folder cannot be moved into itself' }],
      });
    });

    it('should not move assets of another user', async () => {
      const [assetId] = await getAssetIds(`${root}/other`);

      const { status, body } = await request(app)
        .put('/folders/move')
        .set(asBearerAuth(user.accessToken))
        .send({ assetIds: [assetId], destination: `${root}/trip` });

      expect(status).toBe(200);
      expect(body).toEqual({ moved: 0, failed: [{ assetId, reason: 'No access' }] });
    });
  });

  describe('PUT /folders/assets/:id/rename', () => {
    it('should rename a file and keep its extension', async () => {
      const [assetId] = await getAssetIds(`${root}/trip/first day`);

      const { status } = await request(app)
        .put(`/folders/assets/${assetId}/rename`)
        .set(asBearerAuth(admin.accessToken))
        .send({ name: 'renamed.jpg' });
      expect(status).toBe(400);

      const { status: renamedStatus, body } = await request(app)
        .put(`/folders/assets/${assetId}/rename`)
        .set(asBearerAuth(admin.accessToken))
        .send({ name: 'renamed.png' });
      expect(renamedStatus).toBe(200);
      expect(body).toEqual({
        id: assetId,
        originalPath: `${root}/trip/first day/renamed.png`,
        originalFileName: 'renamed.png',
      });
      expect(existsSync(`${hostRoot}/trip/first day/renamed.png`)).toBe(true);
    });
  });

  describe('DELETE /folders', () => {
    it('should trash the assets of a folder, keep the files and restore them', async () => {
      const ids = await getAssetIds(`${root}/trip/first day`);

      const { status, body } = await request(app)
        .delete('/folders')
        .set(asBearerAuth(admin.accessToken))
        .send({ folderPaths: [`${root}/trip/first day`] });

      expect(status).toBe(200);
      expect(body).toEqual({ trashed: 2, deleted: 0, removedFolders: 0, failed: [] });
      expect(readdirSync(`${hostRoot}/trip/first day`)).toHaveLength(2);
      await expect(getAssetIds(`${root}/trip/first day`)).resolves.toEqual([]);

      const { status: restoreStatus } = await request(app)
        .post('/trash/restore/assets')
        .set(asBearerAuth(admin.accessToken))
        .send({ ids });
      expect(restoreStatus).toBe(200);
      await expect(getAssetIds(`${root}/trip/first day`)).resolves.toEqual(ids);
    });

    it('should remove empty folders', async () => {
      const { status, body } = await request(app)
        .delete('/folders')
        .set(asBearerAuth(admin.accessToken))
        .send({ folderPaths: [`${root}/new`] });

      expect(status).toBe(200);
      expect(body).toEqual({ trashed: 0, deleted: 0, removedFolders: 1, failed: [] });
      expect(existsSync(`${hostRoot}/new`)).toBe(false);
    });

    it('should refuse the library folder itself', async () => {
      const { status, body } = await request(app)
        .delete('/folders')
        .set(asBearerAuth(admin.accessToken))
        .send({ folderPaths: [root] });

      expect(status).toBe(200);
      expect(body.failed).toEqual([{ path: root, reason: 'The library folder itself cannot be changed' }]);
    });
  });
});
