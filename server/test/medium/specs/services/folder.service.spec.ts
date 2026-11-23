import { BadRequestException, ConflictException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetFileType, AssetStatus, ChecksumAlgorithm } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { ViewRepository } from 'src/repositories/view-repository.js';
import { DB } from 'src/schema/index.js';
import { FolderService } from 'src/services/folder.service.js';
import { ViewService } from 'src/services/view.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const real = [
  AccessRepository,
  AssetRepository,
  CryptoRepository,
  DatabaseRepository,
  LibraryRepository,
  StorageRepository,
  ViewRepository,
];

const setup = () => {
  const { sut, ctx } = newMediumService(FolderService, {
    database: defaultDatabase,
    real,
    mock: [EventRepository, JobRepository, LoggingRepository],
  });
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  const { sut: viewService } = newMediumService(ViewService, {
    database: defaultDatabase,
    real,
    mock: [LoggingRepository],
  });
  return { sut, ctx, viewService };
};

const createFile = async (path: string, content = 'content') => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(FolderService.name, () => {
  let base: string;
  let root: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'immich-folders-')));
    root = join(base, 'library');
    await mkdir(root);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const createContext = async () => {
    const { sut, ctx, viewService } = setup();
    const { user } = await ctx.newUser();
    const auth: AuthDto = factory.auth({ user: { id: user.id } });
    const library = await ctx.get(LibraryRepository).create({
      ownerId: user.id,
      name: 'writable',
      importPaths: [root],
      exclusionPatterns: ['**/@eaDir/**'],
      writable: true,
    });
    const crypto = ctx.get(CryptoRepository);

    const newLibraryAsset = async (path: string, dto: Record<string, unknown> = {}) => {
      await createFile(path);
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        libraryId: library.id,
        isExternal: true,
        originalPath: path,
        originalFileName: path.split('/').pop(),
        checksum: crypto.hashSha1(`path:${path}`),
        checksumAlgorithm: ChecksumAlgorithm.sha1Path,
        ...dto,
      });
      return asset;
    };

    const getAsset = (id: string) =>
      ctx.database
        .selectFrom('asset')
        .select(['originalPath', 'originalFileName', 'checksum', 'deletedAt', 'status'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

    return { sut, ctx, viewService, auth, user, library, crypto, newLibraryAsset, getAsset };
  };

  it('should rename a folder and rewrite paths, checksums and sidecars, including trashed assets', async () => {
    const { sut, ctx, auth, crypto, newLibraryAsset, getAsset } = await createContext();
    const photo = await newLibraryAsset(join(root, 'trip', 'photo.jpg'));
    const trashed = await newLibraryAsset(join(root, 'trip', 'day 1', 'old.jpg'), {
      deletedAt: new Date(),
      status: AssetStatus.Trashed,
    });
    const neighbour = await newLibraryAsset(join(root, 'trip2', 'photo.jpg'));
    await createFile(join(root, 'trip', 'photo.jpg.xmp'));
    await ctx.newAssetFile({
      assetId: photo.id,
      type: AssetFileType.Sidecar,
      path: join(root, 'trip', 'photo.jpg.xmp'),
    });

    await expect(sut.rename(auth, { path: join(root, 'trip'), name: 'holiday' })).resolves.toEqual({
      path: join(root, 'holiday'),
    });

    expect(existsSync(join(root, 'trip'))).toBe(false);
    expect(existsSync(join(root, 'holiday', 'photo.jpg.xmp'))).toBe(true);

    const newPath = join(root, 'holiday', 'photo.jpg');
    await expect(getAsset(photo.id)).resolves.toMatchObject({
      originalPath: newPath,
      checksum: crypto.hashSha1(`path:${newPath}`),
    });
    await expect(getAsset(trashed.id)).resolves.toMatchObject({
      originalPath: join(root, 'holiday', 'day 1', 'old.jpg'),
    });
    await expect(getAsset(neighbour.id)).resolves.toMatchObject({ originalPath: join(root, 'trip2', 'photo.jpg') });

    const sidecar = await ctx.database
      .selectFrom('asset_file')
      .select('path')
      .where('assetId', '=', photo.id)
      .executeTakeFirstOrThrow();
    expect(sidecar.path).toBe(join(root, 'holiday', 'photo.jpg.xmp'));
  });

  it('should move and rename files', async () => {
    const { sut, auth, newLibraryAsset, getAsset } = await createContext();
    const photo = await newLibraryAsset(join(root, 'a', 'photo.jpg'));
    await mkdir(join(root, 'b'));

    await expect(sut.move(auth, { assetIds: [photo.id], destination: join(root, 'b') })).resolves.toEqual({
      moved: 1,
      failed: [],
    });
    expect(existsSync(join(root, 'a', 'photo.jpg'))).toBe(false);
    await expect(readFile(join(root, 'b', 'photo.jpg'), 'utf8')).resolves.toBe('content');

    await expect(sut.renameAsset(auth, photo.id, { name: 'beach.jpg' })).resolves.toEqual({
      id: photo.id,
      originalPath: join(root, 'b', 'beach.jpg'),
      originalFileName: 'beach.jpg',
    });
    await expect(getAsset(photo.id)).resolves.toMatchObject({
      originalPath: join(root, 'b', 'beach.jpg'),
      originalFileName: 'beach.jpg',
    });
  });

  it('should not overwrite existing files', async () => {
    const { sut, auth, newLibraryAsset, getAsset } = await createContext();
    const photo = await newLibraryAsset(join(root, 'a', 'photo.jpg'));
    await createFile(join(root, 'b', 'photo.jpg'), 'other');

    const result = await sut.move(auth, { assetIds: [photo.id], destination: join(root, 'b') });

    expect(result).toEqual({
      moved: 0,
      failed: [{ assetId: photo.id, reason: 'A file or folder with this name already exists' }],
    });
    await expect(readFile(join(root, 'b', 'photo.jpg'), 'utf8')).resolves.toBe('other');
    await expect(readFile(join(root, 'a', 'photo.jpg'), 'utf8')).resolves.toBe('content');
    await expect(getAsset(photo.id)).resolves.toMatchObject({ originalPath: join(root, 'a', 'photo.jpg') });
  });

  it('should refuse to rename onto an existing folder', async () => {
    const { sut, auth } = await createContext();
    await createFile(join(root, 'a', 'one.jpg'));
    await mkdir(join(root, 'b'));

    await expect(sut.rename(auth, { path: join(root, 'a'), name: 'b' })).rejects.toBeInstanceOf(ConflictException);
    expect(existsSync(join(root, 'a', 'one.jpg'))).toBe(true);
  });

  it('should refuse symbolic links that leave the library', async () => {
    const { sut, auth } = await createContext();
    const outside = join(base, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'escape'));

    await expect(sut.create(auth, { parentPath: join(root, 'escape'), name: 'new' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(sut.create(auth, { parentPath: `${root}/../outside`, name: 'new' })).rejects.toBeInstanceOf(Error);
    expect(existsSync(join(outside, 'new'))).toBe(false);
  });

  it('should create folders that show up in the folder summary', async () => {
    const { sut, viewService, auth, library } = await createContext();

    await expect(sut.create(auth, { parentPath: root, name: 'new' })).resolves.toEqual({ path: join(root, 'new') });
    await expect(sut.create(auth, { parentPath: root, name: 'new' })).rejects.toBeInstanceOf(ConflictException);

    await expect(viewService.getFolderSummary(auth, { path: root })).resolves.toEqual({
      path: root,
      directAssetCount: 0,
      children: [{ name: 'new', path: join(root, 'new'), assetCount: 0, coverAssetId: null }],
      writable: true,
      libraryId: library.id,
      isLibraryRoot: true,
    });
  });

  it('should trash folder assets, keep files and remove empty folders', async () => {
    const { sut, auth, newLibraryAsset, getAsset } = await createContext();
    const photo = await newLibraryAsset(join(root, 'a', 'photo.jpg'));
    await mkdir(join(root, 'empty', 'nested'), { recursive: true });

    await expect(sut.delete(auth, { folderPaths: [join(root, 'a'), join(root, 'empty')] })).resolves.toEqual({
      trashed: 1,
      deleted: 0,
      removedFolders: 1,
      failed: [],
    });

    await expect(getAsset(photo.id)).resolves.toMatchObject({ status: AssetStatus.Trashed });
    expect(existsSync(join(root, 'a', 'photo.jpg'))).toBe(true);
    expect(existsSync(join(root, 'empty'))).toBe(false);
  });

  it('should refuse libraries that are not writable', async () => {
    const { sut, ctx, auth, library } = await createContext();
    await ctx.get(LibraryRepository).update(library.id, { writable: false });
    await mkdir(join(root, 'a'));

    await expect(sut.rename(auth, { path: join(root, 'a'), name: 'b' })).rejects.toThrow(
      'Path is not inside a writable library you can manage',
    );
    expect(existsSync(join(root, 'a'))).toBe(true);
  });
});
