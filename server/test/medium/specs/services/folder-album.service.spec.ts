import { Kysely } from 'kysely';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetVisibility, JobStatus, UserMetadataKey } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { FolderAlbumRepository } from 'src/repositories/folder-album.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { FolderAlbumService } from 'src/services/folder-album.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = () => {
  const { sut, ctx } = newMediumService(FolderAlbumService, {
    database: defaultDatabase,
    real: [
      AlbumRepository,
      AssetRepository,
      CryptoRepository,
      DatabaseRepository,
      FolderAlbumRepository,
      LibraryRepository,
      UserRepository,
    ],
    mock: [JobRepository, LoggingRepository],
  });
  ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  return { sut, ctx };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
  StorageCore.setMediaLocation('/data');
});

describe(FolderAlbumService.name, () => {
  const createContext = async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const libraryFolder = `/data/library/${user.id}`;

    const newAsset = async (originalPath: string, dto: Parameters<typeof ctx.newAsset>[0] = {}) => {
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath, ...dto });
      return asset;
    };

    const getAlbums = (userId = user.id) =>
      ctx.database
        .selectFrom('album')
        .select(['id', 'albumName', 'folderPath', 'parentAlbumId', 'updateId', 'deletedAt'])
        .where('folderOwnerId', '=', userId)
        .orderBy('folderPath')
        .execute();

    const getAlbumByPath = async (path: string, userId = user.id) => {
      const albums = await getAlbums(userId);
      return albums.find((album) => album.folderPath === path);
    };

    const getMembers = async (albumId: string) => {
      const rows = await ctx.database
        .selectFrom('album_asset')
        .select('assetId')
        .where('albumId', '=', albumId)
        .execute();
      return rows.map(({ assetId }) => assetId).toSorted();
    };

    const sync = (full?: boolean) => sut.handleSync({ userId: user.id, full });

    return { sut, ctx, user, libraryFolder, newAsset, getAlbums, getAlbumByPath, getMembers, sync };
  };

  it('should mirror a nested folder tree with continuous intermediate albums', async () => {
    const { libraryFolder, newAsset, getAlbums, getMembers, sync, user } = await createContext();
    const deep = `${libraryFolder}/a/b/c/d/e/f`;
    const top = await newAsset(`${libraryFolder}/a/top.jpg`);
    const leaf1 = await newAsset(`${deep}/1.jpg`);
    const leaf2 = await newAsset(`${deep}/2.jpg`);

    await expect(sync()).resolves.toBe(JobStatus.Success);

    const albums = await getAlbums();
    expect(albums.map(({ folderPath }) => folderPath)).toEqual([
      libraryFolder,
      `${libraryFolder}/a`,
      `${libraryFolder}/a/b`,
      `${libraryFolder}/a/b/c`,
      `${libraryFolder}/a/b/c/d`,
      `${libraryFolder}/a/b/c/d/e`,
      deep,
    ]);
    const byPath = new Map(albums.map((album) => [album.folderPath, album]));
    expect(byPath.get(libraryFolder)).toMatchObject({ albumName: 'Library', parentAlbumId: null });
    for (const album of albums.slice(1)) {
      const parentPath = album.folderPath!.slice(0, album.folderPath!.lastIndexOf('/'));
      expect(album.parentAlbumId).toBe(byPath.get(parentPath)!.id);
      expect(album.albumName).toBe(album.folderPath!.split('/').pop());
    }

    expect(await getMembers(byPath.get(`${libraryFolder}/a`)!.id)).toEqual([top.id]);
    expect(await getMembers(byPath.get(deep)!.id)).toEqual([leaf1.id, leaf2.id].toSorted());
    expect(await getMembers(byPath.get(`${libraryFolder}/a/b/c`)!.id)).toEqual([]);

    const owners = await defaultDatabase
      .selectFrom('album_user')
      .select(['userId', 'role'])
      .where(
        'albumId',
        'in',
        albums.map(({ id }) => id),
      )
      .execute();
    expect(owners).toHaveLength(albums.length);
    expect(owners.every((owner) => owner.userId === user.id && owner.role === 'owner')).toBe(true);
  });

  it('should be idempotent', async () => {
    const { libraryFolder, newAsset, getAlbums, sync, ctx } = await createContext();
    await newAsset(`${libraryFolder}/2024/a.jpg`);
    await newAsset(`${libraryFolder}/2024/trip/b.jpg`);

    await sync();
    const before = await getAlbums();
    const membersBefore = await ctx.database
      .selectFrom('album_asset')
      .select(['albumId', 'assetId', 'updateId'])
      .where(
        'albumId',
        'in',
        before.map(({ id }) => id),
      )
      .orderBy('assetId')
      .execute();

    await sync();
    await sync(true);

    await expect(getAlbums()).resolves.toEqual(before);
    await expect(
      ctx.database
        .selectFrom('album_asset')
        .select(['albumId', 'assetId', 'updateId'])
        .where(
          'albumId',
          'in',
          before.map(({ id }) => id),
        )
        .orderBy('assetId')
        .execute(),
    ).resolves.toEqual(membersBefore);
  });

  it('should move membership with the file and prune the empty folder', async () => {
    const { libraryFolder, newAsset, getAlbumByPath, getMembers, sync, ctx } = await createContext();
    const asset = await newAsset(`${libraryFolder}/old/a.jpg`);
    await newAsset(`${libraryFolder}/keep/b.jpg`);
    await sync();
    const oldAlbum = await getAlbumByPath(`${libraryFolder}/old`);
    expect(await getMembers(oldAlbum!.id)).toEqual([asset.id]);

    await ctx.get(AssetRepository).update({ id: asset.id, originalPath: `${libraryFolder}/new/deeper/a.jpg` });
    await sync();

    await expect(getAlbumByPath(`${libraryFolder}/old`)).resolves.toBeUndefined();
    const newAlbum = await getAlbumByPath(`${libraryFolder}/new/deeper`);
    expect(await getMembers(newAlbum!.id)).toEqual([asset.id]);
    await expect(getAlbumByPath(`${libraryFolder}/new`)).resolves.toBeDefined();
    await expect(getAlbumByPath(`${libraryFolder}/keep`)).resolves.toBeDefined();
  });

  it('should remove trashed assets, add them back when restored and prune after a hard delete', async () => {
    const { libraryFolder, newAsset, getAlbumByPath, getMembers, sync, ctx } = await createContext();
    const asset = await newAsset(`${libraryFolder}/trash/a.jpg`);
    const other = await newAsset(`${libraryFolder}/trash/b.jpg`);
    await sync();
    const album = await getAlbumByPath(`${libraryFolder}/trash`);

    await ctx.get(AssetRepository).update({ id: asset.id, deletedAt: new Date() });
    await sync();
    expect(await getMembers(album!.id)).toEqual([other.id]);

    await ctx.get(AssetRepository).update({ id: asset.id, deletedAt: null });
    await sync();
    expect(await getMembers(album!.id)).toEqual([asset.id, other.id].toSorted());

    await ctx.database.deleteFrom('asset').where('id', 'in', [asset.id, other.id]).execute();
    await sync();
    await expect(getAlbumByPath(`${libraryFolder}/trash`)).resolves.toBeUndefined();
    await expect(getAlbumByPath(libraryFolder)).resolves.toBeUndefined();
  });

  it('should exclude hidden and locked assets, include archived ones and skip upload hash folders', async () => {
    const { libraryFolder, newAsset, getAlbums, getAlbumByPath, getMembers, sync, user } = await createContext();
    const archived = await newAsset(`${libraryFolder}/v/archived.jpg`, { visibility: AssetVisibility.Archive });
    await newAsset(`${libraryFolder}/v/hidden.mov`, { visibility: AssetVisibility.Hidden });
    await newAsset(`${libraryFolder}/locked/locked.jpg`, { visibility: AssetVisibility.Locked });
    await newAsset(`/data/upload/${user.id}/ab/cd/upload.jpg`);

    await sync();

    expect((await getAlbums()).map(({ folderPath }) => folderPath)).toEqual([libraryFolder, `${libraryFolder}/v`]);
    expect(await getMembers((await getAlbumByPath(`${libraryFolder}/v`))!.id)).toEqual([archived.id]);
  });

  it('should use external library import paths as roots and remove albums of a deleted library', async () => {
    const { ctx, user, newAsset, getAlbums, getAlbumByPath, getMembers, sync } = await createContext();
    const library = await ctx.get(LibraryRepository).create({
      ownerId: user.id,
      name: 'external',
      importPaths: ['/mnt/photos/'],
      exclusionPatterns: [],
    });
    const asset = await newAsset('/mnt/photos/2024/a.jpg', { libraryId: library.id, isExternal: true });
    await newAsset('/mnt/outside/b.jpg', { libraryId: library.id, isExternal: true });

    await sync();

    expect((await getAlbums()).map(({ folderPath, albumName }) => [folderPath, albumName])).toEqual([
      ['/mnt/photos', 'photos'],
      ['/mnt/photos/2024', '2024'],
    ]);
    expect(await getMembers((await getAlbumByPath('/mnt/photos/2024'))!.id)).toEqual([asset.id]);

    await ctx.get(LibraryRepository).update(library.id, { importPaths: ['/mnt/photos/2024'] });
    await sync();
    expect((await getAlbums()).map(({ folderPath, albumName }) => [folderPath, albumName])).toEqual([
      ['/mnt/photos/2024', '2024'],
    ]);
    expect((await getAlbumByPath('/mnt/photos/2024'))!.parentAlbumId).toBeNull();

    await ctx.get(LibraryRepository).softDelete(library.id);
    await sync();
    await expect(getAlbums()).resolves.toEqual([]);
  });

  it('should keep the folder albums of two users apart', async () => {
    const first = await createContext();
    const { user: other } = await first.ctx.newUser();
    await first.newAsset(`${first.libraryFolder}/shared-name/a.jpg`);
    await first.ctx.newAsset({ ownerId: other.id, originalPath: `/data/library/${other.id}/shared-name/b.jpg` });

    await first.sync();

    expect(await first.getAlbums()).toHaveLength(2);
    await expect(first.getAlbums(other.id)).resolves.toEqual([]);

    await first.sut.handleSync({ userId: other.id });
    const otherAlbums = await first.getAlbums(other.id);
    expect(otherAlbums).toHaveLength(2);
    expect(await first.getMembers(otherAlbums[1].id)).toHaveLength(1);
  });

  it('should delete all folder albums when the preference is turned off and recreate them when turned on', async () => {
    const { ctx, user, libraryFolder, newAsset, getAlbums, sync } = await createContext();
    const manual = await ctx.newAlbum({ ownerId: user.id, albumName: 'Hand made' });
    await newAsset(`${libraryFolder}/x/a.jpg`);
    await sync();
    expect(await getAlbums()).toHaveLength(2);

    await ctx.get(UserRepository).upsertMetadata(user.id, {
      key: UserMetadataKey.Preferences,
      value: { folderAlbums: { enabled: false } },
    });
    await sync();
    await expect(getAlbums()).resolves.toEqual([]);
    await expect(ctx.get(FolderAlbumRepository).getState(user.id)).resolves.toBeUndefined();
    await expect(ctx.get(AlbumRepository).getById(manual.album.id)).resolves.toBeDefined();

    await ctx.get(UserRepository).upsertMetadata(user.id, {
      key: UserMetadataKey.Preferences,
      value: { folderAlbums: { enabled: true } },
    });
    await sync();
    expect(await getAlbums()).toHaveLength(2);
  });

  it('should backfill when the state row is missing and be safe to rerun', async () => {
    const { ctx, user, libraryFolder, newAsset, getAlbums, sync } = await createContext();
    await newAsset(`${libraryFolder}/backfill/a.jpg`);
    await sync();
    const before = await getAlbums();

    await ctx.get(FolderAlbumRepository).deleteState(user.id);
    await sync();

    await expect(getAlbums()).resolves.toEqual(before);
    await expect(ctx.get(FolderAlbumRepository).getState(user.id)).resolves.toMatchObject({
      checkpointAt: expect.any(Date),
      fullSyncAt: expect.any(Date),
    });
  });

  it('should pick up changes made shortly before the checkpoint', async () => {
    const { ctx, user, libraryFolder, newAsset, getAlbumByPath, getMembers, sync } = await createContext();
    await newAsset(`${libraryFolder}/first/a.jpg`);
    await sync();

    const late = await newAsset(`${libraryFolder}/late/b.jpg`);
    const state = await ctx.get(FolderAlbumRepository).getState(user.id);
    await ctx.get(FolderAlbumRepository).saveState({
      userId: user.id,
      checkpointAt: new Date(Date.now() + 5 * 60 * 1000),
      rootsKey: state!.rootsKey!,
    });
    await sync();

    const album = await getAlbumByPath(`${libraryFolder}/late`);
    expect(album).toBeDefined();
    expect(await getMembers(album!.id)).toEqual([late.id]);
  });

  it('should keep album ids and shares when folder paths are rewritten', async () => {
    const { ctx, user, newAsset, getAlbumByPath, getMembers, sync } = await createContext();
    const { user: friend } = await ctx.newUser();
    const library = await ctx.get(LibraryRepository).create({
      ownerId: user.id,
      name: 'writable',
      importPaths: ['/mnt/rewrite'],
      exclusionPatterns: [],
      writable: true,
    });
    const asset = await newAsset('/mnt/rewrite/old/sub/a.jpg', { libraryId: library.id, isExternal: true });
    await sync();
    const sub = await getAlbumByPath('/mnt/rewrite/old/sub');
    await ctx.newAlbumUser({ albumId: sub!.id, userId: friend.id });

    await ctx.database
      .updateTable('asset')
      .set({ originalPath: '/mnt/rewrite/new/sub/a.jpg' })
      .where('id', '=', asset.id)
      .execute();
    await ctx.database
      .updateTable('album')
      .set((eb) => ({
        folderPath: eb.fn('replace', ['folderPath', eb.val('/mnt/rewrite/old'), eb.val('/mnt/rewrite/new')]),
      }))
      .where('folderOwnerId', '=', user.id)
      .where('folderPath', 'like', '/mnt/rewrite/old%')
      .execute();
    await sync();

    const moved = await getAlbumByPath('/mnt/rewrite/new/sub');
    expect(moved!.id).toBe(sub!.id);
    expect(await getMembers(moved!.id)).toEqual([asset.id]);
    const parent = await getAlbumByPath('/mnt/rewrite/new');
    expect(parent).toMatchObject({ albumName: 'new' });
    expect(moved!.parentAlbumId).toBe(parent!.id);
    await expect(
      ctx.database
        .selectFrom('album_user')
        .select('userId')
        .where('albumId', '=', sub!.id)
        .where('userId', '=', friend.id)
        .execute(),
    ).resolves.toHaveLength(1);
  });
});
