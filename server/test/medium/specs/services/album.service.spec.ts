import { Kysely } from 'kysely';
import { AlbumUserRole, AssetOrder } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { FolderAlbumRepository } from 'src/repositories/folder-album.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumService } from 'src/services/album.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory, newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

// eslint-disable-next-line unicorn/no-unnecessary-parameters
const setup = (db?: Kysely<DB>) => {
  return newMediumService(AlbumService, {
    database: db || defaultDatabase,
    real: [AccessRepository, AlbumRepository, AssetRepository, FolderAlbumRepository, UserRepository],
    mock: [EventRepository, LoggingRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AlbumService.name, () => {
  describe('removeAssets', () => {
    it('should not remove assets from an album of another user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { album } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);

      await expect(sut.removeAssets(factory.auth({ user: otherUser }), album.id, { ids: [asset.id] })).rejects.toThrow(
        'Not found or no albumAsset.delete access',
      );
      await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [asset.id])).resolves.toContain(asset.id);
    });
  });

  describe('folder albums', () => {
    const createTree = async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: friend } = await ctx.newUser();
      const root = `/data/library/${user.id}`;
      const ids = { root: newUuid(), year: newUuid(), trip: newUuid(), day: newUuid() };
      await ctx.get(FolderAlbumRepository).createFolderAlbums(
        [
          { id: ids.root, folderPath: root, albumName: 'Library', parentAlbumId: null },
          { id: ids.year, folderPath: `${root}/2024`, albumName: '2024', parentAlbumId: ids.root },
          { id: ids.trip, folderPath: `${root}/2024/trip`, albumName: 'trip', parentAlbumId: ids.year },
          { id: ids.day, folderPath: `${root}/2024/trip/day`, albumName: 'day', parentAlbumId: ids.trip },
        ],
        user.id,
        AssetOrder.Desc,
      );
      const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: `${root}/2024/trip/a.jpg` });
      await ctx.get(FolderAlbumRepository).addMembers(user.id);
      const { album: manual } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Hand made' });
      return { sut, ctx, user, friend, ids, asset, manual };
    };

    it('should list hand-made albums and top-level folder albums only when topLevel is set', async () => {
      const { sut, user, ids, manual } = await createTree();
      const auth = factory.auth({ user });

      const topLevel = await sut.getAll(auth, { topLevel: true });
      expect(topLevel.map(({ id }) => id).toSorted()).toEqual([ids.root, manual.id].toSorted());
      expect(topLevel.find(({ id }) => id === ids.root)).toMatchObject({
        isFolderAlbum: true,
        parentAlbumId: null,
        childAlbumCount: 1,
      });
      expect(topLevel.find(({ id }) => id === manual.id)).toMatchObject({ isFolderAlbum: false, childAlbumCount: 0 });

      const flat = await sut.getAll(auth, {});
      expect(flat).toHaveLength(5);
      expect(flat.find(({ id }) => id === ids.trip)).toMatchObject({
        isFolderAlbum: true,
        parentAlbumId: ids.year,
        assetCount: 1,
      });
    });

    it('should show a shared child album at the top level for the user it was shared with', async () => {
      const { sut, ctx, friend, ids } = await createTree();
      await ctx.newAlbumUser({ albumId: ids.trip, userId: friend.id, role: AlbumUserRole.Viewer });

      const albums = await sut.getAll(factory.auth({ user: friend }), { topLevel: true });
      expect(albums.map(({ id }) => id)).toEqual([ids.trip]);
      expect(albums[0].childAlbumCount).toBe(0);
    });

    it('should return breadcrumbs and children of a folder album', async () => {
      const { sut, user, ids } = await createTree();

      const folder = await sut.getFolder(factory.auth({ user }), ids.trip);

      expect(folder).toMatchObject({
        isFolderAlbum: true,
        path: 'Library/2024/trip',
        ancestors: [
          { id: ids.root, albumName: 'Library' },
          { id: ids.year, albumName: '2024' },
        ],
      });
      expect(folder.children.map(({ id }) => id)).toEqual([ids.day]);
    });

    it('should not let another user read the folder of an album that is not shared', async () => {
      const { sut, friend, ids } = await createTree();
      await expect(sut.getFolder(factory.auth({ user: friend }), ids.trip)).rejects.toThrow();
    });

    it('should cut breadcrumbs and children at albums the viewer cannot access', async () => {
      const { sut, ctx, friend, ids } = await createTree();
      await ctx.newAlbumUser({ albumId: ids.trip, userId: friend.id, role: AlbumUserRole.Viewer });
      await ctx.newAlbumUser({ albumId: ids.root, userId: friend.id, role: AlbumUserRole.Viewer });

      const folder = await sut.getFolder(factory.auth({ user: friend }), ids.trip);

      expect(folder.ancestors).toEqual([]);
      expect(folder.children).toEqual([]);
      expect(folder.path).toBeUndefined();
    });

    it('should keep folder album membership read-only', async () => {
      const { sut, ctx, user, ids, asset } = await createTree();
      const auth = factory.auth({ user });
      const { asset: other } = await ctx.newAsset({ ownerId: user.id });

      await expect(sut.addAssets(auth, ids.trip, { ids: [other.id] })).resolves.toEqual([
        { id: other.id, success: false, error: 'no_permission' },
      ]);
      await expect(sut.removeAssets(auth, ids.trip, { ids: [asset.id] })).resolves.toEqual([
        { id: asset.id, success: false, error: 'no_permission' },
      ]);
      await expect(ctx.get(AlbumRepository).getAssetIds(ids.trip, [asset.id, other.id])).resolves.toEqual(
        new Set([asset.id]),
      );
      await expect(sut.update(auth, ids.trip, { albumName: 'other' })).rejects.toThrow();
      await expect(sut.update(auth, ids.trip, { description: 'Summer' })).resolves.toMatchObject({
        albumName: 'trip',
        description: 'Summer',
        isFolderAlbum: true,
      });
      await expect(sut.delete(auth, ids.trip)).rejects.toThrow();
    });

    it('should keep hand-made albums working as before', async () => {
      const { sut, ctx, user, manual } = await createTree();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      ctx.getMock(EventRepository).emit.mockResolvedValue();

      await expect(sut.addAssets(auth, manual.id, { ids: [asset.id] })).resolves.toEqual([
        { id: asset.id, success: true },
      ]);
      await expect(sut.update(auth, manual.id, { albumName: 'Renamed' })).resolves.toMatchObject({
        albumName: 'Renamed',
        isFolderAlbum: false,
      });
      await expect(sut.getFolder(auth, manual.id)).resolves.toEqual({
        isFolderAlbum: false,
        ancestors: [],
        children: [],
      });
      await sut.delete(auth, manual.id);
    });
  });

  describe('database triggers', () => {
    it('should cascade delete an album when the owner is deleted', async () => {
      const { ctx } = setup();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id });

      await ctx.get(UserRepository).delete({ id: user.id }, true);

      await expect(ctx.database.selectFrom('album').selectAll().where('id', '=', album.id).execute()).resolves.toEqual(
        [],
      );
      await expect(
        ctx.database.selectFrom('album_user').selectAll().where('albumId', '=', album.id).execute(),
      ).resolves.toEqual([]);
    });
  });
});
