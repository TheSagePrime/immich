import { Kysely } from 'kysely';
import { StorageCore } from 'src/cores/storage.core.js';
import { SyncEntityType, SyncRequestType } from 'src/enum.js';
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
import { SyncTestContext, newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = async () => {
  const ctx = new SyncTestContext(defaultDatabase);
  const { auth, user } = await ctx.newSyncAuthUser();
  const { sut: folderAlbums, ctx: folderCtx } = newMediumService(FolderAlbumService, {
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
  folderCtx.getMock(JobRepository).queueAll.mockResolvedValue();
  const libraryFolder = `/data/library/${user.id}`;
  const sync = () => folderAlbums.handleSync({ userId: user.id });
  const getFolderAlbum = (path: string) =>
    defaultDatabase
      .selectFrom('album')
      .select(['id', 'albumName'])
      .where('folderOwnerId', '=', user.id)
      .where('folderPath', '=', path)
      .executeTakeFirstOrThrow();
  return { ctx, auth, user, libraryFolder, sync, getFolderAlbum };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
  StorageCore.setMediaLocation('/data');
});

describe('folder albums in the mobile sync stream', () => {
  it.each([SyncRequestType.AlbumsV1, SyncRequestType.AlbumsV2])(
    'should send folder albums with the same %s shape as hand-made albums',
    async (type) => {
      const { ctx, auth, user, libraryFolder, sync, getFolderAlbum } = await setup();
      const { album: manual } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Hand made' });
      await ctx.newAsset({ ownerId: user.id, originalPath: `${libraryFolder}/trip/a.jpg` });
      await sync();
      const root = await getFolderAlbum(libraryFolder);
      const trip = await getFolderAlbum(`${libraryFolder}/trip`);

      const response = await ctx.syncStream(auth, [type]);
      const albums = response.filter((item) => item.type !== SyncEntityType.SyncCompleteV1);
      expect(albums.map(({ data }) => (data as { id: string }).id).toSorted()).toEqual(
        [manual.id, root.id, trip.id].toSorted(),
      );

      const keys = (id: string) =>
        Object.keys(albums.find(({ data }) => (data as { id: string }).id === id)!.data as object).toSorted();
      expect(keys(trip.id)).toEqual(keys(manual.id));
      expect(keys(root.id)).toEqual(keys(manual.id));
      expect(albums.find(({ data }) => (data as { id: string }).id === trip.id)!.data).toMatchObject({ name: 'trip' });

      await ctx.syncAckAll(auth, response);
      await sync();
      await ctx.assertSyncIsComplete(auth, [type]);
    },
  );

  it('should send folder album memberships and their removal', async () => {
    const { ctx, auth, user, libraryFolder, sync, getFolderAlbum } = await setup();
    const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: `${libraryFolder}/trip/a.jpg` });
    const { asset: other } = await ctx.newAsset({ ownerId: user.id, originalPath: `${libraryFolder}/trip/b.jpg` });
    await sync();
    const trip = await getFolderAlbum(`${libraryFolder}/trip`);

    const response = await ctx.syncStream(auth, [SyncRequestType.AlbumToAssetsV1]);
    expect(response).toEqual(
      expect.arrayContaining([
        { ack: expect.any(String), data: { albumId: trip.id, assetId: asset.id }, type: SyncEntityType.AlbumToAssetV1 },
        { ack: expect.any(String), data: { albumId: trip.id, assetId: other.id }, type: SyncEntityType.AlbumToAssetV1 },
      ]),
    );
    await ctx.syncAckAll(auth, response);

    await ctx.get(AssetRepository).update({ id: asset.id, originalPath: `${libraryFolder}/trip/day/a.jpg` });
    await sync();
    const day = await getFolderAlbum(`${libraryFolder}/trip/day`);

    const next = await ctx.syncStream(auth, [SyncRequestType.AlbumToAssetsV1]);
    expect(next).toEqual(
      expect.arrayContaining([
        {
          ack: expect.any(String),
          data: { albumId: trip.id, assetId: asset.id },
          type: SyncEntityType.AlbumToAssetDeleteV1,
        },
        { ack: expect.any(String), data: { albumId: day.id, assetId: asset.id }, type: SyncEntityType.AlbumToAssetV1 },
      ]),
    );
    await ctx.syncAckAll(auth, next);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumToAssetsV1]);
  });

  it('should send a delete for every pruned folder album', async () => {
    const { ctx, auth, user, libraryFolder, sync, getFolderAlbum } = await setup();
    const { asset } = await ctx.newAsset({ ownerId: user.id, originalPath: `${libraryFolder}/a/b/photo.jpg` });
    await sync();
    const albums = await Promise.all(
      [libraryFolder, `${libraryFolder}/a`, `${libraryFolder}/a/b`].map((path) => getFolderAlbum(path)),
    );
    const ids = albums.map(({ id }) => id);

    const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
    await ctx.syncAckAll(auth, response);

    await ctx.get(AssetRepository).update({ id: asset.id, deletedAt: new Date() });
    await sync();

    const next = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
    const deletes = next.filter(({ type }) => type === SyncEntityType.AlbumDeleteV1);
    expect(deletes.map(({ data }) => (data as { albumId: string }).albumId).toSorted()).toEqual(ids.toSorted());
    expect(next.filter(({ type }) => type === SyncEntityType.AlbumV1)).toEqual([]);
    await ctx.syncAckAll(auth, next);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);
  });
});
