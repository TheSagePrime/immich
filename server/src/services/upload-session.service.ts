import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Hash } from 'node:crypto';
import { basename, dirname, join, relative } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import picomatch from 'picomatch';
import {
  UPLOAD_CHUNK_SIZE,
  UPLOAD_COMPLETING_STALE_MS,
  UPLOAD_FREE_SPACE_MARGIN,
  UPLOAD_MAX_ACTIVE_SESSIONS_PER_USER,
  UPLOAD_MAX_CHUNK_SIZE,
  UPLOAD_MAX_DIRECTORY_ENTRIES,
  UPLOAD_MAX_NUMBERED_NAMES,
  UPLOAD_SESSION_EXPIRY_REFRESH_MS,
  UPLOAD_SESSION_TTL_MS,
  UPLOAD_TEMP_DIR_NAME,
  UPLOAD_TEMP_FILE_EXTENSION,
  UPLOAD_TERMINAL_SESSION_RETENTION_MS,
} from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  CreateUploadSessionDto,
  UploadDirectoryQueryDto,
  UploadDirectoryResponseDto,
  UploadLibraryResponseDto,
  UploadSession,
  UploadSessionCheckDto,
  UploadSessionCheckResponseDto,
  UploadSessionCheckResultDto,
  UploadSessionChunk,
  UploadSessionResponseDto,
  UploadSessionSearchDto,
  mapUploadSession,
} from 'src/dtos/upload-session.dto.js';
import {
  AssetStatus,
  DatabaseLock,
  ImmichWorker,
  JobName,
  JobStatus,
  QueueName,
  UploadDuplicatePolicy,
  UploadOutcome,
  UploadSessionStatus,
} from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { toExternalAssetInsert } from 'src/utils/library.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import { createLibraryMatcher } from 'src/utils/misc.js';
import { fromChecksum } from 'src/utils/request.js';
import { isPathInside, resolveSafePath } from 'src/utils/safe-path.js';
import {
  isErrorCode,
  mapWithConcurrency,
  numberedName,
  parseUploadDirectory,
  parseUploadPath,
  validatePathSegments,
} from 'src/utils/upload.js';

interface WritableLibrary {
  id: string;
  ownerId: string;
  importPath: string;
  realRoot: string;
  exclusionPatterns: string[];
}

interface UploadTarget {
  realPath: string;
  relativePath: string;
  assetPath: string;
}

interface PlacedFile {
  outcome: UploadOutcome;
  target: UploadTarget;
  message?: string;
}

interface HashState {
  hash: Hash;
  offset: number;
}

const UPLOAD_CHECK_CONCURRENCY = 16;
const NO_HARD_LINK_ERRORS = ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK'];
const MESSAGE_EXISTS = 'exists';
const MESSAGE_CHECKSUM_MISMATCH = 'checksum_mismatch';
const MESSAGE_PARTIAL_GONE = 'partial_gone';

const terminalStatuses = new Set([
  UploadSessionStatus.Completed,
  UploadSessionStatus.Failed,
  UploadSessionStatus.Cancelled,
]);

@Injectable()
export class UploadSessionService extends BaseService {
  private activeWrites = new Set<string>();
  private hashes = new Map<string, HashState>();

  async getLibraries(auth: AuthDto): Promise<UploadLibraryResponseDto[]> {
    const libraries = await this.uploadSessionRepository.getWritableLibraries(auth.user.id);
    return libraries.filter(({ importPaths }) => importPaths.length > 0).map(({ id, name }) => ({ id, name }));
  }

  async getDirectories(auth: AuthDto, id: string, dto: UploadDirectoryQueryDto): Promise<UploadDirectoryResponseDto> {
    const library = await this.getWritableLibrary(auth, id);
    const segments = parseUploadDirectory(dto.path ?? '');
    const directory = await resolveSafePath(library.realRoot, segments.join('/'));
    const relativeDirectory = relative(library.realRoot, directory);
    validatePathSegments(relativeDirectory === '' ? [] : relativeDirectory.split('/'));

    let entries;
    try {
      entries = await this.storageRepository.readdirWithTypes(directory);
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) {
        return { path: relativeDirectory, directories: [], truncated: false };
      }
      if (isErrorCode(error, 'ENOTDIR')) {
        throw new BadRequestException('Path is not a folder');
      }
      throw error;
    }

    const isExcluded = picomatch(library.exclusionPatterns, { nocase: true });
    const assetDirectory = join(library.importPath, relativeDirectory);
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .filter((name) => {
        const candidate = join(assetDirectory, name);
        return !isExcluded(candidate) && !isExcluded(join(candidate, 'file')) && !StorageCore.isImmichPath(candidate);
      })
      .sort((a, b) => a.localeCompare(b));

    return {
      path: relativeDirectory,
      directories: directories.slice(0, UPLOAD_MAX_DIRECTORY_ENTRIES),
      truncated: directories.length > UPLOAD_MAX_DIRECTORY_ENTRIES,
    };
  }

  async check(auth: AuthDto, dto: UploadSessionCheckDto): Promise<UploadSessionCheckResponseDto> {
    const library = await this.getWritableLibrary(auth, dto.libraryId);

    const resolved = await mapWithConcurrency(dto.items, UPLOAD_CHECK_CONCURRENCY, async (item) => {
      try {
        const target = await this.resolveTarget(library, item.relativePath);
        const exists = await this.pathExists(target.realPath);
        const suggested = exists ? await this.findFreeTarget(library, target) : undefined;
        return { item, target, exists, suggested };
      } catch (error) {
        return { item, error: error instanceof HttpException ? error.message : 'Path is not accessible' };
      }
    });

    const existingPaths = resolved
      .filter((entry) => entry.exists && entry.target)
      .map((entry) => entry.target!.assetPath);
    const assetIds = await this.uploadSessionRepository.getAssetIdsByPaths(library.id, existingPaths);

    const results = resolved.map((entry): UploadSessionCheckResultDto => {
      if (!entry.target) {
        return { id: entry.item.id, exists: false, error: entry.error };
      }

      return {
        id: entry.item.id,
        exists: !!entry.exists,
        assetId: entry.exists ? assetIds.get(entry.target.assetPath) : undefined,
        suggestedRelativePath: entry.suggested?.relativePath,
      };
    });

    return { results };
  }

  async create(auth: AuthDto, dto: CreateUploadSessionDto): Promise<UploadSessionResponseDto> {
    const library = await this.getWritableLibrary(auth, dto.libraryId);
    const target = await this.resolveTarget(library, dto.relativePath);
    const checksum = fromChecksum(dto.checksum);
    const expiresAt = new Date(Date.now() + UPLOAD_SESSION_TTL_MS);
    const base = {
      ownerId: auth.user.id,
      libraryId: library.id,
      batchId: dto.batchId ?? null,
      relativePath: target.relativePath,
      size: dto.size,
      checksum,
      duplicatePolicy: dto.duplicatePolicy,
      fileModifiedAt: dto.fileModifiedAt ?? null,
      expiresAt,
    };

    if (dto.duplicatePolicy !== UploadDuplicatePolicy.KeepBoth && (await this.pathExists(target.realPath))) {
      const skipped = dto.duplicatePolicy === UploadDuplicatePolicy.Skip;
      const assetIds = await this.uploadSessionRepository.getAssetIdsByPaths(library.id, [target.assetPath]);
      const session = await this.uploadSessionRepository.create({
        ...base,
        status: skipped ? UploadSessionStatus.Completed : UploadSessionStatus.Failed,
        outcome: skipped ? UploadOutcome.Skipped : UploadOutcome.Failed,
        message: MESSAGE_EXISTS,
        finalRelativePath: target.relativePath,
        assetId: assetIds.get(target.assetPath) ?? null,
      });
      return this.map(session, 0);
    }

    const activeCount = await this.uploadSessionRepository.countActive(auth.user.id);
    if (activeCount >= UPLOAD_MAX_ACTIVE_SESSIONS_PER_USER) {
      throw new HttpException('Too many unfinished uploads', HttpStatus.TOO_MANY_REQUESTS);
    }

    const tempDirectory = await this.getTempDirectory(library, target);
    const { available } = await this.storageRepository.checkDiskUsage(tempDirectory);
    if (available < dto.size + UPLOAD_FREE_SPACE_MARGIN) {
      throw new HttpException('Not enough free disk space', HttpStatus.INSUFFICIENT_STORAGE);
    }

    const id = this.cryptoRepository.randomUUID();
    const tempPath = join(tempDirectory, `${id}${UPLOAD_TEMP_FILE_EXTENSION}`);
    await this.storageRepository.createFile(tempPath, Buffer.alloc(0));

    try {
      const session = await this.uploadSessionRepository.create({ ...base, id, tempPath });
      this.hashes.set(session.id, { hash: this.cryptoRepository.createSha1(), offset: 0 });
      this.trimHashes();
      return this.map(session, 0);
    } catch (error) {
      await this.storageRepository.unlink(tempPath);
      throw error;
    }
  }

  async search(auth: AuthDto, dto: UploadSessionSearchDto): Promise<UploadSessionResponseDto[]> {
    const sessions = await this.uploadSessionRepository.search({ ownerId: auth.user.id, ...dto });
    return mapWithConcurrency(sessions, UPLOAD_CHECK_CONCURRENCY, async (session) =>
      this.map(session, await this.getOffset(session)),
    );
  }

  async get(auth: AuthDto, id: string): Promise<UploadSessionResponseDto> {
    const session = await this.findOrFailSession(auth, id);
    return this.map(session, await this.getOffset(session));
  }

  async writeChunk(
    auth: AuthDto,
    id: string,
    { offset, contentLength }: UploadSessionChunk,
    body: Readable,
  ): Promise<UploadSessionResponseDto> {
    const session = await this.findOrFailSession(auth, id);
    this.assertActive(session);

    if (contentLength > UPLOAD_MAX_CHUNK_SIZE) {
      throw new HttpException(`Chunks must not exceed ${UPLOAD_MAX_CHUNK_SIZE} bytes`, HttpStatus.PAYLOAD_TOO_LARGE);
    }

    if (this.activeWrites.has(session.id)) {
      throw new ConflictException('Another chunk is being written for this upload');
    }

    this.activeWrites.add(session.id);
    try {
      const tempPath = session.tempPath as string;
      const currentOffset = await this.getTempSize(session);
      if (offset !== currentOffset) {
        throw new ConflictException({ message: 'Upload-Offset does not match the stored size', offset: currentOffset });
      }

      const size = Number(session.size);
      if (offset + contentLength > size) {
        throw new BadRequestException('Chunk exceeds the declared file size');
      }

      const hashState = this.takeHashState(session.id, offset);
      let received = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          received += chunk.length;
          if (received > contentLength) {
            callback(new BadRequestException('Chunk is larger than Content-Length'));
            return;
          }
          hashState?.hash.update(chunk);
          callback(null, chunk);
        },
      });

      try {
        await pipeline(body, counter, this.storageRepository.createAppendStream(tempPath));
      } catch (error) {
        const storedOffset = await this.getTempSize(session);
        this.logger.debug(`Chunk for upload ${session.id} was interrupted at ${storedOffset} bytes: ${error}`);
        if (error instanceof HttpException) {
          throw error;
        }
        throw new BadRequestException({ message: 'Chunk upload was interrupted', offset: storedOffset });
      }

      const newOffset = await this.getTempSize(session);
      if (hashState && received === contentLength && newOffset === offset + received) {
        this.hashes.set(session.id, { hash: hashState.hash, offset: newOffset });
      }

      const updated = await this.refreshExpiry(session);
      return this.map(updated, newOffset);
    } finally {
      this.activeWrites.delete(session.id);
    }
  }

  async complete(auth: AuthDto, id: string): Promise<UploadSessionResponseDto> {
    const session = await this.findOrFailSession(auth, id);
    if (session.status === UploadSessionStatus.Completed || session.status === UploadSessionStatus.Failed) {
      return this.map(session, await this.getOffset(session));
    }

    const staleBefore = new Date(Date.now() - UPLOAD_COMPLETING_STALE_MS);
    const isStale =
      session.status === UploadSessionStatus.Completing &&
      !!session.tempPath &&
      new Date(session.updatedAt).getTime() < staleBefore.getTime();
    if (!isStale) {
      this.assertActive(session);
    }

    if (this.activeWrites.has(session.id)) {
      throw new ConflictException('A chunk is still being written for this upload');
    }

    const completing = isStale
      ? await this.uploadSessionRepository.updateIfStatus(
          session.id,
          UploadSessionStatus.Completing,
          { status: UploadSessionStatus.Completing },
          staleBefore,
        )
      : await this.uploadSessionRepository.updateIfStatus(session.id, UploadSessionStatus.Active, {
          status: UploadSessionStatus.Completing,
        });
    if (!completing) {
      throw new ConflictException('Upload is already being completed');
    }

    const tempPath = session.tempPath as string;
    const size = Number(session.size);
    let storedSize: number;
    try {
      storedSize = await this.getTempSize(session);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === HttpStatus.GONE) {
        await this.uploadSessionRepository.update(session.id, {
          status: UploadSessionStatus.Failed,
          outcome: UploadOutcome.Failed,
          message: MESSAGE_PARTIAL_GONE,
        });
        this.hashes.delete(session.id);
      } else {
        await this.uploadSessionRepository.update(session.id, { status: UploadSessionStatus.Active });
      }
      throw error;
    }

    if (storedSize !== size) {
      await this.uploadSessionRepository.update(session.id, { status: UploadSessionStatus.Active });
      throw new ConflictException({ message: 'Upload is incomplete', offset: storedSize });
    }

    try {
      const checksum = await this.computeChecksum(session.id, tempPath, size);
      if (!checksum.equals(session.checksum)) {
        await this.storageRepository.unlink(tempPath);
        const failed = await this.uploadSessionRepository.update(session.id, {
          status: UploadSessionStatus.Failed,
          outcome: UploadOutcome.Failed,
          message: MESSAGE_CHECKSUM_MISMATCH,
        });
        return this.map(failed, 0);
      }

      const library = await this.getWritableLibrary(auth, session.libraryId);
      const target = await this.resolveTarget(library, session.relativePath);
      await this.ensureParentDirectories(library, target);

      const placed = await this.placeFile(library, tempPath, target, session.duplicatePolicy);
      if (placed.outcome === UploadOutcome.Skipped || placed.outcome === UploadOutcome.Failed) {
        await this.storageRepository.unlink(tempPath);
        const assetIds = await this.uploadSessionRepository.getAssetIdsByPaths(library.id, [placed.target.assetPath]);
        const result = await this.uploadSessionRepository.update(session.id, {
          status: placed.outcome === UploadOutcome.Skipped ? UploadSessionStatus.Completed : UploadSessionStatus.Failed,
          outcome: placed.outcome,
          message: placed.message ?? null,
          finalRelativePath: placed.target.relativePath,
          assetId: assetIds.get(placed.target.assetPath) ?? null,
        });
        return this.map(result, size);
      }

      if (session.fileModifiedAt) {
        await this.storageRepository.utimes(placed.target.realPath, new Date(), new Date(session.fileModifiedAt));
      }

      const assetId = await this.importAsset(library, placed.target);
      const result = await this.uploadSessionRepository.update(session.id, {
        status: UploadSessionStatus.Completed,
        outcome: placed.outcome,
        message: null,
        finalRelativePath: placed.target.relativePath,
        assetId,
      });
      return this.map(result, size);
    } catch (error) {
      this.logger.error(`Failed to complete upload ${session.id}: ${error}`);
      await this.storageRepository.unlink(tempPath).catch(() => {});
      await this.uploadSessionRepository.update(session.id, {
        status: UploadSessionStatus.Failed,
        outcome: UploadOutcome.Failed,
        message: error instanceof HttpException ? error.message : 'Upload could not be stored',
      });
      throw error;
    } finally {
      this.hashes.delete(session.id);
    }
  }

  async cancel(auth: AuthDto, id: string): Promise<void> {
    const session = await this.findOrFailSession(auth, id);
    if (terminalStatuses.has(session.status)) {
      return;
    }

    if (session.status === UploadSessionStatus.Completing) {
      throw new ConflictException('Upload is being completed');
    }

    await this.uploadSessionRepository.update(session.id, { status: UploadSessionStatus.Cancelled });
    this.hashes.delete(session.id);
    if (session.tempPath) {
      await this.storageRepository.unlink(session.tempPath);
    }
  }

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrap() {
    await this.jobRepository.queue({ name: JobName.UploadSessionCleanup });
  }

  @OnJob({ name: JobName.UploadSessionCleanup, queue: QueueName.BackgroundTask })
  async handleCleanup(): Promise<JobStatus> {
    await this.databaseRepository.withLock(DatabaseLock.UploadSessionCleanup, async () => {
      const now = Date.now();
      const expired = await this.uploadSessionRepository.getExpired(new Date(now));
      for (const session of expired) {
        if (session.tempPath) {
          await this.storageRepository.unlink(session.tempPath);
        }
      }
      await this.uploadSessionRepository.deleteAll(expired.map(({ id }) => id));

      const removed = await this.uploadSessionRepository.deleteTerminalBefore(
        new Date(now - UPLOAD_TERMINAL_SESSION_RETENTION_MS),
      );

      const orphans = await this.removeOrphanedTempFiles(now);
      this.logger.log(
        `Upload session cleanup removed ${expired.length} expired session(s), ${removed} finished session(s) and ${orphans} orphaned file(s)`,
      );
    });

    return JobStatus.Success;
  }

  private async removeOrphanedTempFiles(now: number) {
    let removed = 0;
    const libraries = await this.uploadSessionRepository.getAllWritableLibraries();
    for (const library of libraries) {
      const [importPath] = library.importPaths;
      if (!importPath) {
        continue;
      }

      const tempDirectory = join(importPath, UPLOAD_TEMP_DIR_NAME);
      const names = await this.storageRepository.readdir(tempDirectory).catch(() => null);
      if (!names) {
        continue;
      }

      const realDirectory = await this.storageRepository.realpath(tempDirectory);
      const realCandidates = names
        .filter((name) => name.endsWith(UPLOAD_TEMP_FILE_EXTENSION))
        .map((name) => join(realDirectory, name));
      const known = await this.uploadSessionRepository.getKnownTempPaths(realCandidates);

      for (const candidate of realCandidates) {
        if (known.has(candidate)) {
          continue;
        }

        const stats = await this.storageRepository.lstat(candidate).catch(() => null);
        if (!stats?.isFile() || now - stats.mtime.getTime() < UPLOAD_SESSION_TTL_MS) {
          continue;
        }

        await this.storageRepository.unlink(candidate);
        removed++;
      }
    }

    return removed;
  }

  private async getWritableLibrary(auth: AuthDto, id: string): Promise<WritableLibrary> {
    const library = await this.libraryRepository.get(id);
    if (!library) {
      throw new NotFoundException('Library not found');
    }

    if (library.ownerId !== auth.user.id) {
      throw new ForbiddenException('Library belongs to another user');
    }

    const [importPath] = library.importPaths;
    if (!library.writable || !importPath) {
      throw new ForbiddenException('Library is not writable');
    }

    let realRoot: string;
    try {
      realRoot = await this.storageRepository.realpath(importPath);
      const stats = await this.storageRepository.stat(realRoot);
      if (!stats.isDirectory()) {
        throw new Error('Not a directory');
      }
    } catch {
      throw new BadRequestException('The import path of the library is not available');
    }

    if (StorageCore.isImmichPath(realRoot)) {
      throw new BadRequestException('The import path of the library is inside the upload location');
    }

    return {
      id: library.id,
      ownerId: library.ownerId,
      importPath,
      realRoot,
      exclusionPatterns: library.exclusionPatterns,
    };
  }

  private async resolveTarget(library: WritableLibrary, input: string): Promise<UploadTarget> {
    const segments = parseUploadPath(input);
    const realPath = await resolveSafePath(library.realRoot, segments.join('/'));
    return this.toTarget(library, realPath);
  }

  private toTarget(library: WritableLibrary, realPath: string): UploadTarget {
    const relativePath = relative(library.realRoot, realPath);
    if (relativePath === '' || !isPathInside(library.realRoot, realPath)) {
      throw new BadRequestException('Path must point to a file inside the library');
    }

    validatePathSegments(relativePath.split('/'));

    if (!mimeTypes.isAsset(realPath)) {
      throw new BadRequestException('Unsupported file type');
    }

    const assetPath = join(library.importPath, relativePath);
    const isInLibrary = createLibraryMatcher({
      importPaths: [library.importPath],
      exclusionPatterns: library.exclusionPatterns,
    });
    if (!isInLibrary(assetPath)) {
      throw new BadRequestException('Path is excluded by the library settings');
    }

    if (StorageCore.isImmichPath(realPath) || StorageCore.isImmichPath(assetPath)) {
      throw new BadRequestException('Path must not be inside the upload location');
    }

    return { realPath, relativePath, assetPath };
  }

  private async getTempDirectory(library: WritableLibrary, target: UploadTarget) {
    const rootTemp = join(library.realRoot, UPLOAD_TEMP_DIR_NAME);
    await this.ensureDirectory(rootTemp);

    const ancestor = await this.findDeepestExistingAncestor(library, dirname(target.realPath));
    const [rootStats, ancestorStats] = await Promise.all([
      this.storageRepository.stat(rootTemp),
      this.storageRepository.stat(ancestor),
    ]);
    if (rootStats.dev === ancestorStats.dev) {
      return rootTemp;
    }

    const nestedTemp = join(ancestor, UPLOAD_TEMP_DIR_NAME);
    await this.ensureDirectory(nestedTemp);
    return nestedTemp;
  }

  private async ensureDirectory(path: string) {
    try {
      await this.storageRepository.mkdir(path, 0o700);
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) {
        throw error;
      }
    }

    const stats = await this.storageRepository.lstat(path);
    if (!stats.isDirectory()) {
      throw new BadRequestException(`${basename(path)} is not a folder`);
    }
  }

  private async findDeepestExistingAncestor(library: WritableLibrary, path: string) {
    let current = path;
    while (isPathInside(library.realRoot, current)) {
      if (await this.pathExists(current)) {
        const realCurrent = await this.storageRepository.realpath(current);
        if (!isPathInside(library.realRoot, realCurrent)) {
          throw new BadRequestException('Path must stay inside the root');
        }
        return realCurrent;
      }
      current = dirname(current);
    }

    return library.realRoot;
  }

  private async ensureParentDirectories(library: WritableLibrary, target: UploadTarget) {
    const segments = dirname(target.relativePath)
      .split('/')
      .filter((segment) => segment !== '.' && segment !== '');
    let current = library.realRoot;
    for (const segment of segments) {
      current = join(current, segment);
      try {
        await this.storageRepository.mkdir(current);
      } catch (error) {
        if (!isErrorCode(error, 'EEXIST')) {
          throw error;
        }
      }

      const realCurrent = await this.storageRepository.realpath(current);
      if (!isPathInside(library.realRoot, realCurrent)) {
        throw new BadRequestException('Path must stay inside the root');
      }

      const stats = await this.storageRepository.stat(realCurrent);
      if (!stats.isDirectory()) {
        throw new BadRequestException(`${segment} is not a folder`);
      }
      current = realCurrent;
    }
  }

  private async placeFile(
    library: WritableLibrary,
    tempPath: string,
    target: UploadTarget,
    policy: UploadDuplicatePolicy,
  ): Promise<PlacedFile> {
    for (let n = 0; n <= UPLOAD_MAX_NUMBERED_NAMES; n++) {
      const candidate =
        n === 0
          ? target
          : this.toTarget(library, join(dirname(target.realPath), numberedName(basename(target.realPath), n)));

      const placed = await this.placeAt(tempPath, candidate.realPath);
      if (placed) {
        return { outcome: n === 0 ? UploadOutcome.Created : UploadOutcome.Renamed, target: candidate };
      }

      if (policy === UploadDuplicatePolicy.Skip) {
        return { outcome: UploadOutcome.Skipped, target, message: MESSAGE_EXISTS };
      }

      if (policy === UploadDuplicatePolicy.Fail) {
        return { outcome: UploadOutcome.Failed, target, message: MESSAGE_EXISTS };
      }
    }

    throw new ConflictException('Too many files with the same name');
  }

  private async placeAt(tempPath: string, targetPath: string) {
    try {
      await this.storageRepository.link(tempPath, targetPath);
    } catch (error) {
      if (isErrorCode(error, 'EEXIST')) {
        if (await this.isSameFile(tempPath, targetPath)) {
          await this.storageRepository.unlink(tempPath);
          return true;
        }
        return false;
      }

      if (!isErrorCode(error, ...NO_HARD_LINK_ERRORS)) {
        throw error;
      }

      this.logger.warn(`Hard links are not supported for ${targetPath}, falling back to rename: ${error}`);
      if (await this.pathExists(targetPath)) {
        return false;
      }

      await this.storageRepository.rename(tempPath, targetPath);
      return true;
    }

    await this.storageRepository.unlink(tempPath);
    return true;
  }

  private async isSameFile(tempPath: string, targetPath: string) {
    const [tempStats, targetStats] = await Promise.all([
      this.storageRepository.lstat(tempPath),
      this.storageRepository.lstat(targetPath).catch(() => null),
    ]);
    return (
      !!targetStats &&
      targetStats.isFile() &&
      tempStats.nlink > 1 &&
      tempStats.dev === targetStats.dev &&
      tempStats.ino === targetStats.ino
    );
  }

  private async importAsset(library: WritableLibrary, target: UploadTarget) {
    const existing = await this.assetRepository.getByLibraryIdAndOriginalPath(library.id, target.assetPath);
    const stat = await this.storageRepository.stat(target.realPath);

    if (existing) {
      const isTrashed = existing.status === AssetStatus.Trashed;
      await this.assetRepository.updateAll([existing.id], {
        fileModifiedAt: stat.mtime,
        ...(existing.isOffline && { isOffline: false }),
        ...(existing.isOffline && !isTrashed && { deletedAt: null }),
      });
      await this.jobRepository.queue({ name: JobName.SidecarCheck, data: { id: existing.id, source: 'upload' } });
      return existing.id;
    }

    const insert = toExternalAssetInsert({
      ownerId: library.ownerId,
      libraryId: library.id,
      path: target.assetPath,
      stat,
      hashSha1: (value) => this.cryptoRepository.hashSha1(value),
    });

    let assetId: string;
    try {
      const asset = await this.assetRepository.create(insert);
      assetId = asset.id;
    } catch (error) {
      const raced = await this.assetRepository.getByLibraryIdAndOriginalPath(library.id, target.assetPath);
      if (!raced) {
        throw error;
      }
      return raced.id;
    }

    await this.queueImportJobs(assetId, library.ownerId);
    return assetId;
  }

  private async queueImportJobs(assetId: string, ownerId: string) {
    await this.eventRepository.emit('AssetCreate', { asset: { id: assetId, ownerId } });
    await this.jobRepository.queue({ name: JobName.SidecarCheck, data: { id: assetId, source: 'upload' } });
  }

  private async findFreeTarget(library: WritableLibrary, target: UploadTarget) {
    for (let n = 1; n <= UPLOAD_MAX_NUMBERED_NAMES; n++) {
      const candidate = this.toTarget(
        library,
        join(dirname(target.realPath), numberedName(basename(target.realPath), n)),
      );
      if (!(await this.pathExists(candidate.realPath))) {
        return candidate;
      }
    }
  }

  private async computeChecksum(id: string, tempPath: string, size: number) {
    const state = this.hashes.get(id);
    if (state && state.offset === size) {
      return state.hash.digest();
    }

    return this.cryptoRepository.hashFile(tempPath);
  }

  private takeHashState(id: string, offset: number) {
    const state = this.hashes.get(id);
    this.hashes.delete(id);
    if (state && state.offset === offset) {
      return state;
    }

    if (offset === 0) {
      return { hash: this.cryptoRepository.createSha1(), offset: 0 };
    }
  }

  private trimHashes() {
    while (this.hashes.size > UPLOAD_MAX_ACTIVE_SESSIONS_PER_USER) {
      const oldest = this.hashes.keys().next().value as string;
      this.hashes.delete(oldest);
    }
  }

  private async refreshExpiry(session: UploadSession) {
    const now = Date.now();
    if (new Date(session.expiresAt).getTime() - now > UPLOAD_SESSION_TTL_MS - UPLOAD_SESSION_EXPIRY_REFRESH_MS) {
      return session;
    }

    return this.uploadSessionRepository.update(session.id, { expiresAt: new Date(now + UPLOAD_SESSION_TTL_MS) });
  }

  private async findOrFailSession(auth: AuthDto, id: string) {
    const session = await this.uploadSessionRepository.get(id, auth.user.id);
    if (!session) {
      throw new NotFoundException('Upload session not found');
    }
    return session;
  }

  private assertActive(session: UploadSession) {
    if (session.status !== UploadSessionStatus.Active || !session.tempPath) {
      throw new ConflictException(`Upload session is ${session.status}`);
    }

    if (new Date(session.expiresAt).getTime() < Date.now()) {
      throw new HttpException('Upload session has expired', HttpStatus.GONE);
    }
  }

  private async getTempSize(session: UploadSession) {
    try {
      const stats = await this.storageRepository.stat(session.tempPath as string);
      return stats.size;
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) {
        throw new HttpException('The partial upload is gone, start a new upload', HttpStatus.GONE);
      }
      throw error;
    }
  }

  private async getOffset(session: UploadSession) {
    switch (session.status) {
      case UploadSessionStatus.Active: {
        return this.getTempSize(session).catch(() => 0);
      }
      case UploadSessionStatus.Completing:
      case UploadSessionStatus.Completed: {
        return session.outcome === UploadOutcome.Skipped && !session.tempPath ? 0 : Number(session.size);
      }
      default: {
        return 0;
      }
    }
  }

  private pathExists(path: string) {
    return this.storageRepository
      .lstat(path)
      .then(() => true)
      .catch((error) => {
        if (isErrorCode(error, 'ENOENT')) {
          return false;
        }
        throw error;
      });
  }

  private map(session: UploadSession, offset: number) {
    return mapUploadSession(session, { offset, chunkSize: UPLOAD_CHUNK_SIZE, maxChunkSize: UPLOAD_MAX_CHUNK_SIZE });
  }
}
