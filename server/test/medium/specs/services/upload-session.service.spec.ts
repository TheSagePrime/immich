import { Kysely } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { UPLOAD_SESSION_TTL_MS, UPLOAD_TEMP_DIR_NAME } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  ChecksumAlgorithm,
  JobName,
  JobStatus,
  UploadDuplicatePolicy,
  UploadOutcome,
  UploadSessionStatus,
} from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UploadSessionRepository } from 'src/repositories/upload-session.repository.js';
import { DB } from 'src/schema/index.js';
import { UploadSessionService } from 'src/services/upload-session.service.js';
import { MediumTestContext } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

StorageCore.setMediaLocation('/photos');

let defaultDatabase: Kysely<DB>;

const sha1 = (data: Buffer) => createHash('sha1').update(data).digest('hex');

const interruptedStream = (data: Buffer, bytesBeforeError: number) => {
  const stream = new PassThrough();
  stream.write(data.subarray(0, bytesBeforeError));
  setTimeout(() => stream.destroy(new Error('aborted')), 50);
  return stream;
};

class UploadSessionTestContext extends MediumTestContext<typeof UploadSessionService> {
  constructor(database: Kysely<DB>) {
    super(UploadSessionService, {
      database,
      real: [AssetRepository, CryptoRepository, LibraryRepository, StorageRepository, UploadSessionRepository],
      mock: [DatabaseRepository, EventRepository, JobRepository, LoggingRepository],
    });

    this.getMock(JobRepository).queue.mockResolvedValue();
    this.getMock(EventRepository).emit.mockResolvedValue();
    this.getMock(DatabaseRepository).withLock.mockImplementation((_lock, callback) => callback());
  }

  async setup(options: { writable?: boolean; exclusionPatterns?: string[] } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'upload-session-medium-'));
    const { user } = await this.newUser();
    const library = await this.get(LibraryRepository).create({
      ownerId: user.id,
      name: 'Writable library',
      importPaths: [root],
      exclusionPatterns: options.exclusionPatterns ?? [],
      writable: options.writable ?? true,
    });
    const auth = factory.auth({ user: { id: user.id } });
    return { root, library, auth, user };
  }

  async upload(
    auth: AuthDto,
    libraryId: string,
    relativePath: string,
    data: Buffer,
    options: { duplicatePolicy?: UploadDuplicatePolicy; chunkSize?: number; fileModifiedAt?: Date } = {},
  ) {
    const session = await this.sut.create(auth, {
      libraryId,
      relativePath,
      size: data.length,
      checksum: sha1(data),
      duplicatePolicy: options.duplicatePolicy ?? UploadDuplicatePolicy.KeepBoth,
      fileModifiedAt: options.fileModifiedAt,
    });

    if (session.status !== UploadSessionStatus.Active) {
      return session;
    }

    const chunkSize = options.chunkSize ?? data.length;
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      const chunk = data.subarray(offset, offset + chunkSize);
      await this.sut.writeChunk(auth, session.id, { offset, contentLength: chunk.length }, Readable.from([chunk]));
    }

    return this.sut.complete(auth, session.id);
  }

  getAsset(id: string) {
    return this.database.selectFrom('asset').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
  }
}

describe(UploadSessionService.name, () => {
  let ctx: UploadSessionTestContext;
  const roots: string[] = [];

  beforeAll(async () => {
    defaultDatabase = await getKyselyDB();
  });

  beforeEach(() => {
    ctx = new UploadSessionTestContext(defaultDatabase);
  });

  afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  const setup = async (options?: Parameters<UploadSessionTestContext['setup']>[0]) => {
    const result = await ctx.setup(options);
    roots.push(result.root);
    return result;
  };

  it('should upload a file in chunks and import it as a library asset', async () => {
    const { root, library, auth, user } = await setup();
    const data = randomBytes(3 * 1024 + 17);
    const fileModifiedAt = new Date('2021-06-01T12:00:00.000Z');

    const result = await ctx.upload(auth, library.id, 'Holidays/2021/beach.jpg', data, {
      chunkSize: 1024,
      fileModifiedAt,
    });

    expect(result.status).toBe(UploadSessionStatus.Completed);
    expect(result.result).toMatchObject({ outcome: UploadOutcome.Created, relativePath: 'Holidays/2021/beach.jpg' });

    const finalPath = join(root, 'Holidays/2021/beach.jpg');
    expect(sha1(await readFile(finalPath))).toBe(sha1(data));
    const { mtime } = await stat(finalPath);
    expect(mtime).toEqual(fileModifiedAt);
    expect(await readdir(join(root, UPLOAD_TEMP_DIR_NAME))).toEqual([]);

    const asset = await ctx.getAsset(result.result!.assetId!);
    expect(asset).toMatchObject({
      ownerId: user.id,
      libraryId: library.id,
      originalPath: finalPath,
      originalFileName: 'beach.jpg',
      isExternal: true,
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      fileModifiedAt,
    });
    expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
      name: JobName.SidecarCheck,
      data: { id: asset.id, source: 'upload' },
    });

    await expect(ctx.sut.complete(auth, result.id)).resolves.toEqual(result);
  });

  it('should store HEIC and MOV originals byte for byte', async () => {
    const { root, library, auth } = await setup();
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), randomBytes(4096)]);
    const mov = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), randomBytes(5000)]);

    const heicResult = await ctx.upload(auth, library.id, 'IMG_0001.HEIC', heic, { chunkSize: 1000 });
    const movResult = await ctx.upload(auth, library.id, 'IMG_0001.MOV', mov, { chunkSize: 999 });

    expect(heicResult.result?.outcome).toBe(UploadOutcome.Created);
    expect(movResult.result?.outcome).toBe(UploadOutcome.Created);
    expect(sha1(await readFile(join(root, 'IMG_0001.HEIC')))).toBe(sha1(heic));
    expect(sha1(await readFile(join(root, 'IMG_0001.MOV')))).toBe(sha1(mov));
  });

  it('should resume after an interrupted chunk', async () => {
    const { root, library, auth } = await setup();
    const data = randomBytes(10_000);

    const session = await ctx.sut.create(auth, {
      libraryId: library.id,
      relativePath: 'resume.jpg',
      size: data.length,
      checksum: sha1(data),
      duplicatePolicy: UploadDuplicatePolicy.Fail,
    });

    await expect(
      ctx.sut.writeChunk(auth, session.id, { offset: 0, contentLength: 6000 }, interruptedStream(data, 2500)),
    ).rejects.toThrow('Chunk upload was interrupted');

    const { offset } = await ctx.sut.get(auth, session.id);
    expect(offset).toBe(2500);

    await expect(
      ctx.sut.writeChunk(auth, session.id, { offset: 0, contentLength: 10 }, Readable.from([data.subarray(0, 10)])),
    ).rejects.toThrow('Upload-Offset does not match the stored size');

    await ctx.sut.writeChunk(
      auth,
      session.id,
      { offset, contentLength: data.length - offset },
      Readable.from([data.subarray(offset)]),
    );
    const result = await ctx.sut.complete(auth, session.id);

    expect(result.result?.outcome).toBe(UploadOutcome.Created);
    expect(sha1(await readFile(join(root, 'resume.jpg')))).toBe(sha1(data));
  });

  it('should refuse to complete a file with a wrong checksum', async () => {
    const { root, library, auth } = await setup();
    const data = randomBytes(100);

    const session = await ctx.sut.create(auth, {
      libraryId: library.id,
      relativePath: 'bad.jpg',
      size: data.length,
      checksum: sha1(randomBytes(100)),
      duplicatePolicy: UploadDuplicatePolicy.Fail,
    });
    await ctx.sut.writeChunk(auth, session.id, { offset: 0, contentLength: data.length }, Readable.from([data]));
    const result = await ctx.sut.complete(auth, session.id);

    expect(result.status).toBe(UploadSessionStatus.Failed);
    expect(result.result).toMatchObject({ outcome: UploadOutcome.Failed, message: 'checksum_mismatch' });
    expect(existsSync(join(root, 'bad.jpg'))).toBe(false);
    expect(await readdir(join(root, UPLOAD_TEMP_DIR_NAME))).toEqual([]);
  });

  describe('duplicate policies', () => {
    it('should skip, fail or number a file that already exists', async () => {
      const { root, library, auth } = await setup();
      const original = Buffer.from('original');
      await writeFile(join(root, 'photo.jpg'), original);

      const skipped = await ctx.upload(auth, library.id, 'photo.jpg', Buffer.from('new 1'), {
        duplicatePolicy: UploadDuplicatePolicy.Skip,
      });
      const failed = await ctx.upload(auth, library.id, 'photo.jpg', Buffer.from('new 2'), {
        duplicatePolicy: UploadDuplicatePolicy.Fail,
      });
      const kept = await ctx.upload(auth, library.id, 'photo.jpg', Buffer.from('new 3'));
      const keptAgain = await ctx.upload(auth, library.id, 'photo.jpg', Buffer.from('new 4'));

      expect(skipped.result).toMatchObject({ outcome: UploadOutcome.Skipped, relativePath: 'photo.jpg' });
      expect(failed.result).toMatchObject({ outcome: UploadOutcome.Failed, message: 'exists' });
      expect(kept.result).toMatchObject({ outcome: UploadOutcome.Renamed, relativePath: 'photo (1).jpg' });
      expect(keptAgain.result).toMatchObject({ outcome: UploadOutcome.Renamed, relativePath: 'photo (2).jpg' });

      expect(await readFile(join(root, 'photo.jpg'))).toEqual(original);
      expect(await readFile(join(root, 'photo (1).jpg'))).toEqual(Buffer.from('new 3'));
      expect(await readFile(join(root, 'photo (2).jpg'))).toEqual(Buffer.from('new 4'));
    });

    it('should not overwrite a file that appears while the upload is running', async () => {
      const { root, library, auth } = await setup();
      const data = Buffer.from('uploaded');
      const session = await ctx.sut.create(auth, {
        libraryId: library.id,
        relativePath: 'race.jpg',
        size: data.length,
        checksum: sha1(data),
        duplicatePolicy: UploadDuplicatePolicy.Skip,
      });
      await ctx.sut.writeChunk(auth, session.id, { offset: 0, contentLength: data.length }, Readable.from([data]));
      await writeFile(join(root, 'race.jpg'), 'someone else');

      const result = await ctx.sut.complete(auth, session.id);

      expect(result.result?.outcome).toBe(UploadOutcome.Skipped);
      expect(await readFile(join(root, 'race.jpg'), 'utf8')).toBe('someone else');
    });

    it('should report existing paths in a check', async () => {
      const { root, library, auth } = await setup();
      await mkdir(join(root, 'a'));
      await writeFile(join(root, 'a/one.jpg'), 'x');

      const { results } = await ctx.sut.check(auth, {
        libraryId: library.id,
        items: [
          { id: '1', relativePath: 'a/one.jpg' },
          { id: '2', relativePath: 'a/two.jpg' },
        ],
      });

      expect(results).toEqual([
        expect.objectContaining({ id: '1', exists: true, suggestedRelativePath: 'a/one (1).jpg' }),
        expect.objectContaining({ id: '2', exists: false }),
      ]);
    });
  });

  describe('path safety', () => {
    it('should refuse a symbolic link that leads outside the library', async () => {
      const { root, library, auth } = await setup();
      const outside = await mkdtemp(join(tmpdir(), 'upload-session-outside-'));
      roots.push(outside);
      await symlink(outside, join(root, 'link'));

      await expect(ctx.upload(auth, library.id, 'link/escaped.jpg', Buffer.from('data'))).rejects.toThrow(
        'Path must stay inside the root',
      );
      expect(await readdir(outside)).toEqual([]);
    });

    it('should refuse a library that is not writable', async () => {
      const { library, auth } = await setup({ writable: false });
      await expect(ctx.upload(auth, library.id, 'photo.jpg', Buffer.from('data'))).rejects.toThrow(
        'Library is not writable',
      );
    });

    it('should refuse an excluded path', async () => {
      const { library, auth } = await setup({ exclusionPatterns: ['**/Raw/**'] });
      await expect(ctx.upload(auth, library.id, 'Raw/photo.jpg', Buffer.from('data'))).rejects.toThrow(
        'Path is excluded by the library settings',
      );
    });

    it('should hide partial uploads from the library scanner', async () => {
      const { root, library, auth } = await setup();
      const data = randomBytes(100);
      await writeFile(join(root, 'visible.jpg'), 'x');
      const session = await ctx.sut.create(auth, {
        libraryId: library.id,
        relativePath: 'partial.jpg',
        size: data.length,
        checksum: sha1(data),
        duplicatePolicy: UploadDuplicatePolicy.Fail,
      });
      await ctx.sut.writeChunk(
        auth,
        session.id,
        { offset: 0, contentLength: 50 },
        Readable.from([data.subarray(0, 50)]),
      );

      const crawled: string[] = [];
      for await (const batch of ctx.get(StorageRepository).walk({
        pathsToCrawl: [root],
        includeHidden: false,
        exclusionPatterns: [],
        take: 100,
      })) {
        crawled.push(...batch);
      }

      expect(crawled).toEqual([join(root, 'visible.jpg')]);
      expect(await readdir(join(root, UPLOAD_TEMP_DIR_NAME))).toEqual([`${session.id}.part`]);
    });
  });

  it('should list the folders of a library', async () => {
    const { root, library, auth } = await setup();
    await mkdir(join(root, 'b/c'), { recursive: true });
    await mkdir(join(root, 'a'));
    await mkdir(join(root, '.hidden'));

    await expect(ctx.sut.getDirectories(auth, library.id, {})).resolves.toEqual({
      path: '',
      directories: ['a', 'b'],
      truncated: false,
    });
    await expect(ctx.sut.getDirectories(auth, library.id, { path: 'b' })).resolves.toEqual({
      path: 'b',
      directories: ['c'],
      truncated: false,
    });
  });

  it('should cancel a session and delete the partial file', async () => {
    const { root, library, auth } = await setup();
    const data = randomBytes(100);
    const session = await ctx.sut.create(auth, {
      libraryId: library.id,
      relativePath: 'cancel.jpg',
      size: data.length,
      checksum: sha1(data),
      duplicatePolicy: UploadDuplicatePolicy.Fail,
    });

    await ctx.sut.cancel(auth, session.id);

    await expect(ctx.sut.get(auth, session.id)).resolves.toMatchObject({ status: UploadSessionStatus.Cancelled });
    expect(await readdir(join(root, UPLOAD_TEMP_DIR_NAME))).toEqual([]);
  });

  it('should clean up expired sessions and orphaned partial files', async () => {
    const { root, library, auth } = await setup();
    const data = randomBytes(100);
    const expired = await ctx.sut.create(auth, {
      libraryId: library.id,
      relativePath: 'expired.jpg',
      size: data.length,
      checksum: sha1(data),
      duplicatePolicy: UploadDuplicatePolicy.Fail,
    });
    const active = await ctx.sut.create(auth, {
      libraryId: library.id,
      relativePath: 'active.jpg',
      size: data.length,
      checksum: sha1(data),
      duplicatePolicy: UploadDuplicatePolicy.Fail,
    });
    await ctx.get(UploadSessionRepository).update(expired.id, { expiresAt: new Date(Date.now() - 1000) });

    const tempDirectory = join(root, UPLOAD_TEMP_DIR_NAME);
    const orphan = join(tempDirectory, 'orphan.part');
    await writeFile(orphan, 'x');
    const old = new Date(Date.now() - UPLOAD_SESSION_TTL_MS - 60_000);
    await utimes(orphan, old, old);

    await expect(ctx.sut.handleCleanup()).resolves.toBe(JobStatus.Success);

    const remaining = await readdir(tempDirectory);
    expect(remaining).toEqual([`${active.id}.part`]);
    await expect(ctx.sut.get(auth, expired.id)).rejects.toThrow('Upload session not found');
    await expect(ctx.sut.get(auth, active.id)).resolves.toMatchObject({ status: UploadSessionStatus.Active });
  });
});
