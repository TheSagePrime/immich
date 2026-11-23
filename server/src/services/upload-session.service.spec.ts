import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Stats } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import {
  UPLOAD_MAX_ACTIVE_SESSIONS_PER_USER,
  UPLOAD_MAX_CHUNK_SIZE,
  UPLOAD_SESSION_TTL_MS,
  UPLOAD_TEMP_DIR_NAME,
} from 'src/constants.js';
import { UploadSession } from 'src/dtos/upload-session.dto.js';
import { JobName, JobStatus, UploadDuplicatePolicy, UploadOutcome, UploadSessionStatus } from 'src/enum.js';
import { UploadSessionService } from 'src/services/upload-session.service.js';
import { factory, newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const errorWithCode = (code: string) => Object.assign(new Error(code), { code });

const fileStats = (size = 0) =>
  ({ size, dev: 1, mtime: new Date('2024-01-01'), isDirectory: () => false, isFile: () => true }) as Stats;
const directoryStats = () =>
  ({ size: 0, dev: 1, mtime: new Date('2024-01-01'), isDirectory: () => true, isFile: () => false }) as Stats;

const entry = (name: string, isDirectory = true) => ({ name, isDirectory: () => isDirectory });

const sha1 = (data: Buffer) => createHash('sha1').update(data).digest();

const collectingStream = (chunks: Buffer[]) =>
  new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });

const createDto = (overrides: Record<string, unknown> = {}) => ({
  libraryId: newUuid(),
  relativePath: 'trip/photo.jpg',
  size: 3,
  checksum: sha1(Buffer.from('abc')).toString('hex'),
  duplicatePolicy: UploadDuplicatePolicy.KeepBoth,
  ...overrides,
});

describe(UploadSessionService.name, () => {
  let sut: UploadSessionService;
  let mocks: ServiceMocks;
  let root: string;
  let existing: Map<string, Stats>;

  const auth = factory.auth();
  const makeLibrary = (overrides: Record<string, unknown> = {}) =>
    factory.library({ ownerId: auth.user.id, writable: true, importPaths: [root], ...overrides });

  const makeSession = (overrides: Partial<UploadSession> = {}): UploadSession => ({
    id: newUuid(),
    ownerId: auth.user.id,
    libraryId: newUuid(),
    batchId: null,
    relativePath: 'trip/photo.jpg',
    tempPath: join(root, UPLOAD_TEMP_DIR_NAME, 'session.part'),
    finalRelativePath: null,
    size: 3,
    checksum: sha1(Buffer.from('abc')),
    duplicatePolicy: UploadDuplicatePolicy.KeepBoth,
    status: UploadSessionStatus.Active,
    outcome: null,
    message: null,
    assetId: null,
    fileModifiedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL_MS),
    ...overrides,
  });

  const setupComplete = (overrides: Partial<UploadSession> = {}) => {
    const library = makeLibrary();
    const session = makeSession({ libraryId: library.id, ...overrides });
    mocks.library.get.mockResolvedValue(library);
    mocks.uploadSession.get.mockResolvedValue(session);
    mocks.uploadSession.updateIfStatus.mockResolvedValue({ ...session, status: UploadSessionStatus.Completing });
    existing.set(session.tempPath!, fileStats(Number(session.size)));
    mocks.storage.link.mockImplementation((_source: string, target: string) => {
      if (existing.has(target)) {
        return Promise.reject(errorWithCode('EEXIST'));
      }
      existing.set(target, fileStats(Number(session.size)));
      return Promise.resolve();
    });
    mocks.storage.realpath.mockImplementation((path: string) => Promise.resolve(path));
    mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(void 0);
    mocks.asset.create.mockResolvedValue({ id: 'new-asset' } as never);
    return { library, session };
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'upload-session-unit-'));
    await mkdir(join(root, 'trip'));
    await symlink('/etc', join(root, 'escape'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    ({ sut, mocks } = newTestService(UploadSessionService));
    existing = new Map([
      [root, directoryStats()],
      [join(root, 'trip'), directoryStats()],
      [join(root, UPLOAD_TEMP_DIR_NAME), directoryStats()],
    ]);

    mocks.storage.lstat.mockImplementation((path: string) => {
      const stats = existing.get(path);
      return stats ? Promise.resolve(stats) : Promise.reject(errorWithCode('ENOENT'));
    });
    mocks.storage.stat.mockImplementation((path: string) => {
      const stats = existing.get(path);
      return stats ? Promise.resolve(stats) : Promise.reject(errorWithCode('ENOENT'));
    });
    mocks.storage.mkdir.mockResolvedValue();
    mocks.storage.unlink.mockResolvedValue();
    mocks.storage.utimes.mockResolvedValue();
    mocks.storage.rename.mockResolvedValue();
    mocks.storage.link.mockResolvedValue();
    mocks.asset.updateAll.mockResolvedValue();
    mocks.uploadSession.deleteAll.mockResolvedValue();
    mocks.storage.createFile.mockResolvedValue();
    mocks.storage.checkDiskUsage.mockResolvedValue({ available: 1e15, free: 1e15, total: 1e15 });
    mocks.uploadSession.countActive.mockResolvedValue(0);
    mocks.uploadSession.getAssetIdsByPaths.mockResolvedValue(new Map());
    mocks.uploadSession.create.mockImplementation((dto) =>
      Promise.resolve(makeSession({ ...(dto as Partial<UploadSession>), id: (dto.id as string) ?? newUuid() })),
    );
    mocks.uploadSession.update.mockImplementation((id, dto) =>
      Promise.resolve(makeSession({ id, ...(dto as Partial<UploadSession>) })),
    );
    mocks.crypto.randomUUID.mockReturnValue('5a1b7c6e-8f51-4c37-9fd0-6a4d1c9e2b10');
    mocks.crypto.hashFile.mockResolvedValue(sha1(Buffer.from('abc')));
  });

  describe('getLibraries', () => {
    it('should only list writable libraries with an import path', async () => {
      mocks.uploadSession.getWritableLibraries.mockResolvedValue([
        { id: 'library-1', name: 'Photos', importPaths: [root], exclusionPatterns: [] },
        { id: 'library-2', name: 'Empty', importPaths: [], exclusionPatterns: [] },
      ]);

      await expect(sut.getLibraries(auth)).resolves.toEqual([{ id: 'library-1', name: 'Photos' }]);
      expect(mocks.uploadSession.getWritableLibraries).toHaveBeenCalledWith(auth.user.id);
    });
  });

  describe('create', () => {
    it('should refuse a missing library', async () => {
      mocks.library.get.mockResolvedValue(void 0);
      await expect(sut.create(auth, createDto())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should refuse a library of another user', async () => {
      mocks.library.get.mockResolvedValue(makeLibrary({ ownerId: newUuid() }));
      await expect(sut.create(auth, createDto())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('should refuse a library that is not writable', async () => {
      mocks.library.get.mockResolvedValue(makeLibrary({ writable: false }));
      await expect(sut.create(auth, createDto())).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([
      ['../x.jpg'],
      ['/abs.jpg'],
      ['a/../../b.jpg'],
      ['a\0.jpg'],
      [String.raw`a\..\b.jpg`],
      ['.hidden/photo.jpg'],
      ['trip/.photo.jpg'],
      ['@eaDir/photo.jpg'],
      ['notes.txt'],
      ['escape/passwd.jpg'],
      ['trip'],
      [`${'a'.repeat(256)}.jpg`],
      ['bad\u{1}name.jpg'],
    ])('should refuse the path %s', async (relativePath) => {
      mocks.library.get.mockResolvedValue(makeLibrary({ exclusionPatterns: ['**/@eaDir/**'] }));
      await expect(sut.create(auth, createDto({ relativePath }))).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.uploadSession.create).not.toHaveBeenCalled();
      expect(mocks.storage.createFile).not.toHaveBeenCalled();
    });

    it('should finish right away with "skipped" when the file exists and the policy is skip', async () => {
      const library = makeLibrary();
      mocks.library.get.mockResolvedValue(library);
      existing.set(join(root, 'trip/photo.jpg'), fileStats(3));
      mocks.uploadSession.getAssetIdsByPaths.mockResolvedValue(new Map([[join(root, 'trip/photo.jpg'), 'asset-1']]));

      const result = await sut.create(auth, createDto({ duplicatePolicy: UploadDuplicatePolicy.Skip }));

      expect(result.status).toBe(UploadSessionStatus.Completed);
      expect(result.result).toEqual({
        outcome: UploadOutcome.Skipped,
        assetId: 'asset-1',
        relativePath: 'trip/photo.jpg',
        message: 'exists',
      });
      expect(mocks.storage.createFile).not.toHaveBeenCalled();
    });

    it('should finish right away with "failed" when the file exists and the policy is fail', async () => {
      mocks.library.get.mockResolvedValue(makeLibrary());
      existing.set(join(root, 'trip/photo.jpg'), fileStats(3));

      const result = await sut.create(auth, createDto({ duplicatePolicy: UploadDuplicatePolicy.Fail }));

      expect(result.status).toBe(UploadSessionStatus.Failed);
      expect(result.result).toMatchObject({ outcome: UploadOutcome.Failed, message: 'exists' });
      expect(mocks.storage.createFile).not.toHaveBeenCalled();
    });

    it('should create an empty temporary file in the hidden temp folder', async () => {
      const library = makeLibrary();
      mocks.library.get.mockResolvedValue(library);

      const result = await sut.create(auth, createDto({ batchId: newUuid() }));

      const tempPath = join(root, UPLOAD_TEMP_DIR_NAME, '5a1b7c6e-8f51-4c37-9fd0-6a4d1c9e2b10.part');
      expect(mocks.storage.createFile).toHaveBeenCalledWith(tempPath, Buffer.alloc(0));
      expect(mocks.uploadSession.create).toHaveBeenCalledWith(
        expect.objectContaining({
          id: '5a1b7c6e-8f51-4c37-9fd0-6a4d1c9e2b10',
          libraryId: library.id,
          relativePath: 'trip/photo.jpg',
          tempPath,
          size: 3,
          checksum: sha1(Buffer.from('abc')),
        }),
      );
      expect(result).toMatchObject({ status: UploadSessionStatus.Active, offset: 0, size: 3 });
    });

    it('should accept a base64 checksum', async () => {
      mocks.library.get.mockResolvedValue(makeLibrary());
      await sut.create(auth, createDto({ checksum: sha1(Buffer.from('abc')).toString('base64') }));
      expect(mocks.uploadSession.create).toHaveBeenCalledWith(
        expect.objectContaining({ checksum: sha1(Buffer.from('abc')) }),
      );
    });

    it('should refuse when the user has too many unfinished uploads', async () => {
      mocks.library.get.mockResolvedValue(makeLibrary());
      mocks.uploadSession.countActive.mockResolvedValue(UPLOAD_MAX_ACTIVE_SESSIONS_PER_USER);
      await expect(sut.create(auth, createDto())).rejects.toMatchObject({ status: 429 });
    });

    it('should refuse when the disk does not have enough free space', async () => {
      mocks.library.get.mockResolvedValue(makeLibrary());
      mocks.storage.checkDiskUsage.mockResolvedValue({ available: 10, free: 10, total: 10 });
      await expect(sut.create(auth, createDto())).rejects.toMatchObject({ status: 507 });
      expect(mocks.storage.createFile).not.toHaveBeenCalled();
    });
  });

  describe('writeChunk', () => {
    it('should refuse an offset that does not match the stored size', async () => {
      const session = makeSession();
      mocks.uploadSession.get.mockResolvedValue(session);
      existing.set(session.tempPath!, fileStats(1));

      const error = await sut
        .writeChunk(auth, session.id, { offset: 0, contentLength: 1 }, Readable.from([Buffer.from('a')]))
        .catch((error_) => error_);

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ offset: 1 });
    });

    it('should refuse a chunk larger than the maximum chunk size', async () => {
      const session = makeSession({ size: UPLOAD_MAX_CHUNK_SIZE * 2 });
      mocks.uploadSession.get.mockResolvedValue(session);
      existing.set(session.tempPath!, fileStats(0));

      await expect(
        sut.writeChunk(auth, session.id, { offset: 0, contentLength: UPLOAD_MAX_CHUNK_SIZE + 1 }, Readable.from([])),
      ).rejects.toMatchObject({ status: 413 });
    });

    it('should refuse a chunk that goes past the declared size', async () => {
      const session = makeSession();
      mocks.uploadSession.get.mockResolvedValue(session);
      existing.set(session.tempPath!, fileStats(2));

      await expect(
        sut.writeChunk(auth, session.id, { offset: 2, contentLength: 2 }, Readable.from([Buffer.from('cd')])),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('should refuse a session that is not active', async () => {
      mocks.uploadSession.get.mockResolvedValue(makeSession({ status: UploadSessionStatus.Cancelled }));
      await expect(
        sut.writeChunk(auth, newUuid(), { offset: 0, contentLength: 1 }, Readable.from([])),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('should refuse an unknown session', async () => {
      mocks.uploadSession.get.mockResolvedValue(void 0);
      await expect(
        sut.writeChunk(auth, newUuid(), { offset: 0, contentLength: 1 }, Readable.from([])),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should append the chunk and report the new offset', async () => {
      const session = makeSession();
      mocks.uploadSession.get.mockResolvedValue(session);
      const written: Buffer[] = [];
      mocks.storage.createAppendStream.mockImplementation(() => collectingStream(written));
      mocks.storage.stat.mockResolvedValueOnce(fileStats(0)).mockResolvedValueOnce(fileStats(2));

      const result = await sut.writeChunk(
        auth,
        session.id,
        { offset: 0, contentLength: 2 },
        Readable.from([Buffer.from('ab')]),
      );

      expect(Buffer.concat(written).toString()).toBe('ab');
      expect(result.offset).toBe(2);
      expect(mocks.uploadSession.update).not.toHaveBeenCalled();
    });

    it('should refresh the expiry date when it is older than a minute', async () => {
      const session = makeSession({ expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL_MS - 120_000) });
      mocks.uploadSession.get.mockResolvedValue(session);
      mocks.storage.createAppendStream.mockImplementation(() => collectingStream([]));
      mocks.storage.stat.mockResolvedValueOnce(fileStats(0)).mockResolvedValueOnce(fileStats(1));

      await sut.writeChunk(auth, session.id, { offset: 0, contentLength: 1 }, Readable.from([Buffer.from('a')]));

      expect(mocks.uploadSession.update).toHaveBeenCalledWith(session.id, { expiresAt: expect.any(Date) });
    });

    it('should report the stored offset when the client disconnects', async () => {
      const session = makeSession({ size: 10 });
      mocks.uploadSession.get.mockResolvedValue(session);
      mocks.storage.createAppendStream.mockImplementation(() => collectingStream([]));
      mocks.storage.stat.mockResolvedValueOnce(fileStats(0)).mockResolvedValueOnce(fileStats(4));

      const body = new PassThrough();
      const promise = sut.writeChunk(auth, session.id, { offset: 0, contentLength: 10 }, body);
      body.write(Buffer.from('abcd'));
      setTimeout(() => body.destroy(new Error('aborted')), 5);

      const error = await promise.catch((error_) => error_);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({ offset: 4 });
    });

    it('should refuse a body that is longer than Content-Length', async () => {
      const session = makeSession({ size: 10 });
      mocks.uploadSession.get.mockResolvedValue(session);
      mocks.storage.createAppendStream.mockImplementation(() => collectingStream([]));
      mocks.storage.stat.mockResolvedValue(fileStats(0));

      await expect(
        sut.writeChunk(auth, session.id, { offset: 0, contentLength: 1 }, Readable.from([Buffer.from('abc')])),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('complete', () => {
    it('should return the stored result when already completed', async () => {
      const session = makeSession({
        status: UploadSessionStatus.Completed,
        outcome: UploadOutcome.Created,
        finalRelativePath: 'trip/photo.jpg',
        assetId: 'asset-1',
      });
      mocks.uploadSession.get.mockResolvedValue(session);

      const result = await sut.complete(auth, session.id);

      expect(result.result).toEqual({
        outcome: UploadOutcome.Created,
        assetId: 'asset-1',
        relativePath: 'trip/photo.jpg',
      });
      expect(mocks.uploadSession.updateIfStatus).not.toHaveBeenCalled();
    });

    it('should refuse to complete twice at the same time', async () => {
      const { session } = setupComplete();
      mocks.uploadSession.updateIfStatus.mockResolvedValue(void 0);
      await expect(sut.complete(auth, session.id)).rejects.toBeInstanceOf(ConflictException);
    });

    it('should keep the session active when bytes are missing', async () => {
      const { session } = setupComplete({ size: 10 });
      existing.set(session.tempPath!, fileStats(4));

      const error = await sut.complete(auth, session.id).catch((error_) => error_);

      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ offset: 4 });
      expect(mocks.uploadSession.update).toHaveBeenCalledWith(session.id, { status: UploadSessionStatus.Active });
    });

    it('should fail on a checksum mismatch and delete the partial file', async () => {
      const { session } = setupComplete();
      mocks.crypto.hashFile.mockResolvedValue(sha1(Buffer.from('xyz')));

      const result = await sut.complete(auth, session.id);

      expect(result.status).toBe(UploadSessionStatus.Failed);
      expect(result.result).toMatchObject({ outcome: UploadOutcome.Failed, message: 'checksum_mismatch' });
      expect(mocks.storage.unlink).toHaveBeenCalledWith(session.tempPath);
      expect(mocks.storage.link).not.toHaveBeenCalled();
    });

    it('should place the file, import it and queue the metadata jobs', async () => {
      const { library, session } = setupComplete({ fileModifiedAt: new Date('2020-02-02') });

      const result = await sut.complete(auth, session.id);

      const target = join(root, 'trip/photo.jpg');
      expect(mocks.storage.link).toHaveBeenCalledWith(session.tempPath, target);
      expect(mocks.storage.unlink).toHaveBeenCalledWith(session.tempPath);
      expect(mocks.storage.utimes).toHaveBeenCalledWith(target, expect.any(Date), new Date('2020-02-02'));
      expect(mocks.asset.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: library.ownerId,
          libraryId: library.id,
          originalPath: target,
          isExternal: true,
          originalFileName: 'photo.jpg',
        }),
      );
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetCreate', {
        asset: { id: 'new-asset', ownerId: library.ownerId },
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.SidecarCheck,
        data: { id: 'new-asset', source: 'upload' },
      });
      expect(mocks.uploadSession.update).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({
          status: UploadSessionStatus.Completed,
          outcome: UploadOutcome.Created,
          finalRelativePath: 'trip/photo.jpg',
          assetId: 'new-asset',
        }),
      );
      expect(result.result?.outcome).toBe(UploadOutcome.Created);
    });

    it('should number the file name for keep both', async () => {
      const { session } = setupComplete();
      existing.set(join(root, 'trip/photo.jpg'), fileStats(3));
      existing.set(join(root, 'trip/photo (1).jpg'), fileStats(3));

      await sut.complete(auth, session.id);

      expect(mocks.storage.link).toHaveBeenLastCalledWith(session.tempPath, join(root, 'trip/photo (2).jpg'));
      expect(mocks.uploadSession.update).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({ outcome: UploadOutcome.Renamed, finalRelativePath: 'trip/photo (2).jpg' }),
      );
    });

    it('should skip a file that appeared after the session was created', async () => {
      const { session } = setupComplete({ duplicatePolicy: UploadDuplicatePolicy.Skip });
      existing.set(join(root, 'trip/photo.jpg'), fileStats(3));

      await sut.complete(auth, session.id);

      expect(mocks.storage.unlink).toHaveBeenCalledWith(session.tempPath);
      expect(mocks.asset.create).not.toHaveBeenCalled();
      expect(mocks.uploadSession.update).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({ status: UploadSessionStatus.Completed, outcome: UploadOutcome.Skipped }),
      );
    });

    it('should fail for a file that appeared after the session was created', async () => {
      const { session } = setupComplete({ duplicatePolicy: UploadDuplicatePolicy.Fail });
      existing.set(join(root, 'trip/photo.jpg'), fileStats(3));

      await sut.complete(auth, session.id);

      expect(mocks.asset.create).not.toHaveBeenCalled();
      expect(mocks.uploadSession.update).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({
          status: UploadSessionStatus.Failed,
          outcome: UploadOutcome.Failed,
          message: 'exists',
        }),
      );
    });

    it('should fall back to rename when hard links are not supported', async () => {
      const { session } = setupComplete();
      mocks.storage.link.mockRejectedValue(errorWithCode('ENOTSUP'));
      mocks.storage.rename.mockImplementation((_source: string, target: string) => {
        existing.set(target, fileStats(3));
        return Promise.resolve();
      });

      await sut.complete(auth, session.id);

      expect(mocks.storage.rename).toHaveBeenCalledWith(session.tempPath, join(root, 'trip/photo.jpg'));
      expect(mocks.asset.create).toHaveBeenCalled();
    });

    it('should bring an offline asset at the same path back online', async () => {
      const { session } = setupComplete();
      mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue({
        id: 'offline-asset',
        isOffline: true,
        deletedAt: new Date(),
      } as never);

      const result = await sut.complete(auth, session.id);

      expect(mocks.asset.updateAll).toHaveBeenCalledWith(['offline-asset'], {
        isOffline: false,
        deletedAt: null,
        fileModifiedAt: expect.any(Date),
      });
      expect(mocks.asset.create).not.toHaveBeenCalled();
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.SidecarCheck,
        data: { id: 'offline-asset', source: 'upload' },
      });
      expect(result.result?.assetId).toBe('offline-asset');
    });

    it('should reuse the asset when the library watcher imported it first', async () => {
      const { session } = setupComplete();
      mocks.asset.create.mockRejectedValue(new Error('duplicate key value violates unique constraint'));
      mocks.asset.getByLibraryIdAndOriginalPath
        .mockResolvedValueOnce(void 0)
        .mockResolvedValueOnce({ id: 'watched-asset', isOffline: false, deletedAt: null } as never);

      const result = await sut.complete(auth, session.id);

      expect(result.result?.assetId).toBe('watched-asset');
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it('should use the hash computed while receiving the chunks', async () => {
      const library = makeLibrary();
      mocks.library.get.mockResolvedValue(library);
      await sut.create(auth, createDto({ libraryId: library.id }));
      const session = (await mocks.uploadSession.create.mock.results[0].value) as UploadSession;
      mocks.uploadSession.get.mockResolvedValue(session);
      mocks.storage.createAppendStream.mockImplementation(() => collectingStream([]));
      existing.set(session.tempPath!, fileStats(0));
      mocks.storage.stat.mockResolvedValueOnce(fileStats(0)).mockResolvedValueOnce(fileStats(3));

      await sut.writeChunk(auth, session.id, { offset: 0, contentLength: 3 }, Readable.from([Buffer.from('abc')]));

      existing.set(session.tempPath!, fileStats(3));
      mocks.uploadSession.updateIfStatus.mockResolvedValue(session);
      mocks.storage.link.mockImplementation((_source: string, target: string) => {
        existing.set(target, fileStats(3));
        return Promise.resolve();
      });
      mocks.asset.getByLibraryIdAndOriginalPath.mockResolvedValue(void 0);
      mocks.asset.create.mockResolvedValue({ id: 'new-asset' } as never);

      const result = await sut.complete(auth, session.id);

      expect(result.result?.outcome).toBe(UploadOutcome.Created);
      expect(mocks.crypto.hashFile).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('should delete the partial file', async () => {
      const session = makeSession();
      mocks.uploadSession.get.mockResolvedValue(session);

      await sut.cancel(auth, session.id);

      expect(mocks.uploadSession.update).toHaveBeenCalledWith(session.id, { status: UploadSessionStatus.Cancelled });
      expect(mocks.storage.unlink).toHaveBeenCalledWith(session.tempPath);
    });

    it('should do nothing for a finished session', async () => {
      mocks.uploadSession.get.mockResolvedValue(makeSession({ status: UploadSessionStatus.Completed }));
      await sut.cancel(auth, newUuid());
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });
  });

  describe('check', () => {
    it('should report existing paths, suggested names and invalid paths', async () => {
      const library = makeLibrary();
      mocks.library.get.mockResolvedValue(library);
      existing.set(join(root, 'trip/photo.jpg'), fileStats(3));
      mocks.uploadSession.getAssetIdsByPaths.mockResolvedValue(new Map([[join(root, 'trip/photo.jpg'), 'asset-1']]));

      const { results } = await sut.check(auth, {
        libraryId: library.id,
        items: [
          { id: '1', relativePath: 'trip/photo.jpg' },
          { id: '2', relativePath: 'trip/new.jpg' },
          { id: '3', relativePath: '../escape.jpg' },
        ],
      });

      expect(results).toEqual([
        { id: '1', exists: true, assetId: 'asset-1', suggestedRelativePath: 'trip/photo (1).jpg' },
        { id: '2', exists: false, assetId: undefined, suggestedRelativePath: undefined },
        { id: '3', exists: false, error: 'Path must not contain ".." segments' },
      ]);
      expect(mocks.uploadSession.getAssetIdsByPaths).toHaveBeenCalledWith(library.id, [join(root, 'trip/photo.jpg')]);
    });
  });

  describe('getDirectories', () => {
    it('should list visible, not excluded folders', async () => {
      const library = makeLibrary({ exclusionPatterns: ['**/@eaDir/**'] });
      mocks.library.get.mockResolvedValue(library);
      mocks.storage.readdirWithTypes.mockResolvedValue([
        entry('b'),
        entry('a'),
        entry('.hidden'),
        entry('@eaDir'),
        entry('file.jpg', false),
      ] as never);

      await expect(sut.getDirectories(auth, library.id, {})).resolves.toEqual({
        path: '',
        directories: ['a', 'b'],
        truncated: false,
      });
    });

    it('should refuse a path outside the library', async () => {
      mocks.library.get.mockResolvedValue(makeLibrary());
      await expect(sut.getDirectories(auth, newUuid(), { path: '../' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('handleCleanup', () => {
    it('should remove expired sessions, old finished sessions and orphaned files', async () => {
      mocks.database.withLock.mockImplementation((_lock, callback) => callback());
      mocks.uploadSession.getExpired.mockResolvedValue([
        { id: 'expired', tempPath: '/library/.immich-upload-tmp/expired.part', status: UploadSessionStatus.Active },
      ]);
      mocks.uploadSession.deleteTerminalBefore.mockResolvedValue(2);
      mocks.uploadSession.getAllWritableLibraries.mockResolvedValue([{ id: 'library', importPaths: ['/library'] }]);
      mocks.storage.readdir.mockResolvedValue(['known.part', 'orphan.part', 'fresh.part', 'other.txt']);
      mocks.uploadSession.getKnownTempPaths.mockResolvedValue(new Set(['/library/.immich-upload-tmp/known.part']));
      const old = new Date(Date.now() - UPLOAD_SESSION_TTL_MS - 1000);
      mocks.storage.lstat.mockImplementation((path: string) =>
        Promise.resolve({
          isFile: () => true,
          mtime: path.endsWith('fresh.part') ? new Date() : old,
        } as Stats),
      );

      await expect(sut.handleCleanup()).resolves.toBe(JobStatus.Success);

      expect(mocks.storage.unlink).toHaveBeenCalledWith('/library/.immich-upload-tmp/expired.part');
      expect(mocks.uploadSession.deleteAll).toHaveBeenCalledWith(['expired']);
      expect(mocks.storage.unlink).toHaveBeenCalledWith('/library/.immich-upload-tmp/orphan.part');
      expect(mocks.storage.unlink).not.toHaveBeenCalledWith('/library/.immich-upload-tmp/known.part');
      expect(mocks.storage.unlink).not.toHaveBeenCalledWith('/library/.immich-upload-tmp/fresh.part');
      expect(mocks.storage.unlink).toHaveBeenCalledTimes(2);
    });
  });

  describe('onBootstrap', () => {
    it('should queue a cleanup', async () => {
      await sut.onBootstrap();
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.UploadSessionCleanup });
    });
  });
});
