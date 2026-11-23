import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { constants } from 'node:fs';
import { posix } from 'node:path';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  AssetFileRenameDto,
  FolderAssetResponseDto,
  FolderBrowseQueryDto,
  FolderBrowseResponseDto,
  FolderCreateDto,
  FolderDeleteDto,
  FolderDeleteResponseDto,
  FolderMoveDto,
  FolderMoveResponseDto,
  FolderRenameDto,
  FolderResponseDto,
} from 'src/dtos/folder.dto.js';
import { AssetStatus, DatabaseLock, Permission } from 'src/enum.js';
import { AssetPathRewrite, LibraryAssetPath, SidecarPathRewrite } from 'src/repositories/view-repository.js';
import { BaseService } from 'src/services/base.service.js';
import { isPathInside, parseSafeName, resolveSafePath } from 'src/utils/safe-path.js';
import {
  canManageLibrary,
  createExclusionMatcher,
  findWritableLibrary,
  getWritableRoot,
  normalizeFolderPath,
} from 'src/utils/writable-library.js';

type Library = Awaited<ReturnType<BaseService['libraryRepository']['getAll']>>[number];

type Target = {
  library: Library;
  root: string;
  path: string;
  realPath: string;
};

type FileMove = { from: string; to: string };

type AssetWithSidecar = LibraryAssetPath & { sidecarPath: string | null };

const isErrorCode = (error: unknown, ...codes: string[]) =>
  codes.includes((error as NodeJS.ErrnoException)?.code ?? '');

const LINK_FALLBACK_CODES = ['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK', 'ENOSYS'];

const getErrorMessage = (error: unknown) => {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'object' && response && 'message' in response) {
      const message = (response as { message: unknown }).message;
      return Array.isArray(message) ? message.join(', ') : String(message);
    }
    return error.message;
  }

  return 'Unexpected error';
};

@Injectable()
export class FolderService extends BaseService {
  async browse(auth: AuthDto, dto: FolderBrowseQueryDto): Promise<FolderBrowseResponseDto> {
    const libraries = await this.getManageableLibraries(auth);

    if (!dto.path) {
      const roots = new Set(libraries.map((library) => getWritableRoot(library)).filter((root) => root !== null));
      return {
        path: null,
        parentPath: null,
        entries: [...roots].toSorted().map((root) => ({ name: root, path: root })),
      };
    }

    const target = await this.resolveTarget(libraries, dto.path);
    const isExcluded = createExclusionMatcher(target.library.exclusionPatterns);
    const entries = await this.readDirectory(target.realPath);

    return {
      path: target.path,
      parentPath: target.path === target.root ? null : posix.dirname(target.path),
      entries: entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => ({ name: entry.name, path: posix.join(target.path, entry.name) }))
        .filter((entry) => !isExcluded(entry.path, true))
        .toSorted((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async create(auth: AuthDto, dto: FolderCreateDto): Promise<FolderResponseDto> {
    return this.withLock(async () => {
      const libraries = await this.getManageableLibraries(auth);
      const parent = await this.resolveTarget(libraries, dto.parentPath);
      await this.requireDirectory(parent.realPath);
      const name = this.validateName(dto.name);
      const path = posix.join(parent.path, name);
      this.requireNotExcluded(parent.library, path, true);

      try {
        await this.storageRepository.mkdir(posix.join(parent.realPath, name));
      } catch (error) {
        if (isErrorCode(error, 'EEXIST')) {
          throw new ConflictException('A file or folder with this name already exists');
        }
        throw error;
      }

      this.logger.log(`Created folder ${path} in library ${parent.library.id}`);
      return { path };
    });
  }

  async rename(auth: AuthDto, dto: FolderRenameDto): Promise<FolderResponseDto> {
    return this.withLock(async () => {
      const libraries = await this.getManageableLibraries(auth);
      const path = normalizeFolderPath(dto.path);
      const name = this.validateName(dto.name);
      const newPath = await this.moveFolder(libraries, path, posix.dirname(path), name);
      return { path: newPath };
    });
  }

  async renameAsset(auth: AuthDto, id: string, dto: AssetFileRenameDto): Promise<FolderAssetResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [id] });

    return this.withLock(async () => {
      const libraries = await this.getManageableLibraries(auth);
      const [asset] = await this.viewRepository.getAssetPathsByIds([id]);
      if (!asset) {
        throw new NotFoundException('Asset not found');
      }

      const name = this.validateName(dto.name);
      const currentName = posix.basename(asset.originalPath);
      if (posix.extname(name).toLowerCase() !== posix.extname(currentName).toLowerCase()) {
        throw new BadRequestException('The file extension must stay the same');
      }

      const originalPath = await this.moveAsset(libraries, asset, posix.dirname(asset.originalPath), name);
      return { id, originalPath, originalFileName: posix.basename(originalPath) };
    });
  }

  async move(auth: AuthDto, dto: FolderMoveDto): Promise<FolderMoveResponseDto> {
    const allowedIds = await this.getAllowedAssetIds(auth, Permission.AssetUpdate, dto.assetIds ?? []);

    return this.withLock(async () => {
      const libraries = await this.getManageableLibraries(auth);
      const destination = normalizeFolderPath(dto.destination);
      const result: FolderMoveResponseDto = { moved: 0, failed: [] };

      for (const folderPath of dto.folderPaths ?? []) {
        try {
          await this.moveFolder(libraries, normalizeFolderPath(folderPath), destination);
          result.moved++;
        } catch (error) {
          result.failed.push({ path: folderPath, reason: this.toFailureReason(error, `move folder ${folderPath}`) });
        }
      }

      const assets = await this.getAssets(dto.assetIds ?? [], allowedIds, result.failed);
      for (const asset of assets) {
        try {
          await this.moveAsset(libraries, asset, destination);
          result.moved++;
        } catch (error) {
          result.failed.push({ assetId: asset.id, reason: this.toFailureReason(error, `move asset ${asset.id}`) });
        }
      }

      return result;
    });
  }

  async delete(auth: AuthDto, dto: FolderDeleteDto): Promise<FolderDeleteResponseDto> {
    const allowedIds = await this.getAllowedAssetIds(auth, Permission.AssetDelete, dto.assetIds ?? []);
    const status = dto.force ? AssetStatus.Deleted : AssetStatus.Trashed;

    return this.withLock(async () => {
      const libraries = await this.getManageableLibraries(auth);
      const failed: FolderDeleteResponseDto['failed'] = [];
      const deletedIds: string[] = [];
      let removedFolders = 0;

      const assets = await this.getAssets(dto.assetIds ?? [], allowedIds, failed);
      const assetIds: string[] = [];
      for (const asset of assets) {
        try {
          if (asset.deletedAt) {
            throw new BadRequestException('Asset is already in the trash');
          }
          await this.resolveAssetTarget(libraries, asset);
          assetIds.push(asset.id);
        } catch (error) {
          failed.push({ assetId: asset.id, reason: this.toFailureReason(error, `delete asset ${asset.id}`) });
        }
      }

      if (assetIds.length > 0) {
        await this.assetRepository.updateAll(assetIds, { deletedAt: new Date(), status });
        deletedIds.push(...assetIds);
      }

      for (const folderPath of dto.folderPaths ?? []) {
        try {
          const folder = await this.resolveTarget(libraries, folderPath);
          this.requireNotRoot(folder);
          await this.requireDirectory(folder.realPath);
          await this.requireWritable(folder);

          const rows = await this.viewRepository.trashLibraryFolder(folder.library.id, folder.path, status);
          deletedIds.push(...rows.map(({ id }) => id));

          await this.storageRepository.removeEmptyDirs(folder.realPath, true);
          if (!(await this.entryExists(folder.realPath))) {
            removedFolders++;
          }
          this.logger.log(
            `Deleted folder ${folder.path} in library ${folder.library.id}: ${rows.length} asset(s) ${dto.force ? 'deleted' : 'trashed'}`,
          );
        } catch (error) {
          failed.push({ path: folderPath, reason: this.toFailureReason(error, `delete folder ${folderPath}`) });
        }
      }

      if (deletedIds.length > 0) {
        await this.eventRepository.emit(dto.force ? 'AssetDeleteAll' : 'AssetTrashAll', {
          assetIds: deletedIds,
          userId: auth.user.id,
        });
      }

      return {
        trashed: dto.force ? 0 : deletedIds.length,
        deleted: dto.force ? deletedIds.length : 0,
        removedFolders,
        failed,
      };
    });
  }

  private withLock<T>(callback: () => Promise<T>): Promise<T> {
    return this.databaseRepository.withLock(DatabaseLock.FolderManagement, callback);
  }

  private async getManageableLibraries(auth: AuthDto) {
    const libraries = await this.libraryRepository.getAll();
    return libraries.filter((library) => getWritableRoot(library) !== null && canManageLibrary(auth, library));
  }

  private async getAllowedAssetIds(auth: AuthDto, permission: Permission, ids: string[]) {
    if (ids.length === 0) {
      return new Set<string>();
    }

    return this.checkAccess({ auth, permission, ids });
  }

  private async getAssets(ids: string[], allowedIds: Set<string>, failed: { assetId?: string; reason: string }[]) {
    const uniqueIds = [...new Set(ids)];
    const accessibleIds: string[] = [];
    for (const id of uniqueIds) {
      if (allowedIds.has(id)) {
        accessibleIds.push(id);
      } else {
        failed.push({ assetId: id, reason: 'No access' });
      }
    }

    const assets = await this.viewRepository.getAssetPathsByIds(accessibleIds);
    const found = new Set(assets.map(({ id }) => id));
    for (const id of accessibleIds) {
      if (!found.has(id)) {
        failed.push({ assetId: id, reason: 'Asset not found' });
      }
    }

    return assets;
  }

  private toFailureReason(error: unknown, action: string) {
    if (!(error instanceof HttpException)) {
      this.logger.error(`Failed to ${action}: ${error}`, (error as Error)?.stack);
    }
    return getErrorMessage(error);
  }

  private async resolveTarget(libraries: Library[], input: string): Promise<Target> {
    const path = normalizeFolderPath(input);
    const match = findWritableLibrary(libraries, path);
    if (!match) {
      throw new ForbiddenException('Path is not inside a writable library you can manage');
    }

    const relativePath = posix.relative(match.root, path);
    let realRoot: string;
    try {
      realRoot = await this.storageRepository.realpath(match.root);
    } catch {
      throw new BadRequestException('Library folder is not accessible');
    }

    const realPath = await resolveSafePath(match.root, relativePath);
    if (realPath !== posix.join(realRoot, relativePath)) {
      throw new BadRequestException('Path must not contain symbolic links');
    }

    return { library: match.library, root: match.root, path, realPath };
  }

  private async resolveAssetTarget(libraries: Library[], asset: LibraryAssetPath) {
    if (!asset.libraryId) {
      throw new BadRequestException('Only assets of writable external libraries can be managed');
    }

    const target = await this.resolveTarget(libraries, asset.originalPath);
    if (target.library.id !== asset.libraryId) {
      throw new BadRequestException('Asset does not belong to the library of its folder');
    }

    return target;
  }

  private validateName(input: string) {
    const name = parseSafeName(input.trim());
    if (name.startsWith('.')) {
      throw new BadRequestException('Name must not start with a dot');
    }
    if (Buffer.byteLength(name, 'utf8') > 255) {
      throw new BadRequestException('Name must be at most 255 bytes');
    }
    return name;
  }

  private requireNotExcluded(library: Library, path: string, isDirectory: boolean) {
    if (createExclusionMatcher(library.exclusionPatterns)(path, isDirectory)) {
      throw new BadRequestException('The new path matches an exclusion pattern of the library');
    }
  }

  private requireNotRoot(target: Target) {
    if (target.path === target.root) {
      throw new BadRequestException('The library folder itself cannot be changed');
    }
  }

  private async requireWritable(target: Target) {
    if (!(await this.storageRepository.checkFileExists(target.realPath, constants.W_OK))) {
      throw new BadRequestException('Folder is not writable by the server');
    }
  }

  private async requireDirectory(realPath: string) {
    const stats = await this.storageRepository.lstat(realPath).catch((error) => {
      if (isErrorCode(error, 'ENOENT', 'ENOTDIR')) {
        throw new NotFoundException('Folder not found');
      }
      throw error;
    });
    if (!stats.isDirectory()) {
      throw new BadRequestException('Path is not a folder');
    }
  }

  private async requireFile(realPath: string) {
    const stats = await this.storageRepository.lstat(realPath).catch((error) => {
      if (isErrorCode(error, 'ENOENT', 'ENOTDIR')) {
        throw new NotFoundException('File not found on disk');
      }
      throw error;
    });
    if (!stats.isFile()) {
      throw new BadRequestException('Path is not a regular file');
    }
  }

  private async requireFree(library: Library, path: string, realPath: string) {
    if (await this.entryExists(realPath)) {
      throw new ConflictException('A file or folder with this name already exists');
    }
    if (await this.viewRepository.hasLibraryAssetsAtPath(library.id, path)) {
      throw new ConflictException('The library still has assets at this path');
    }
  }

  private async entryExists(realPath: string) {
    try {
      await this.storageRepository.lstat(realPath);
      return true;
    } catch (error) {
      if (isErrorCode(error, 'ENOENT', 'ENOTDIR')) {
        return false;
      }
      throw error;
    }
  }

  private async readDirectory(realPath: string) {
    await this.requireDirectory(realPath);
    return this.storageRepository.readdirWithTypes(realPath);
  }

  private toRewrite(id: string, originalPath: string, renamed: boolean): AssetPathRewrite {
    return {
      id,
      originalPath,
      checksum: this.cryptoRepository.hashSha1(`path:${originalPath}`),
      originalFileName: renamed ? posix.basename(originalPath) : undefined,
    };
  }

  private async moveFolder(libraries: Library[], sourcePath: string, destinationPath: string, newName?: string) {
    const source = await this.resolveTarget(libraries, sourcePath);
    this.requireNotRoot(source);
    await this.requireDirectory(source.realPath);
    await this.requireWritable({ ...source, realPath: posix.dirname(source.realPath) });

    const destination = await this.resolveTarget(libraries, destinationPath);
    if (destination.library.id !== source.library.id) {
      throw new BadRequestException('Folders can only be moved inside the same library');
    }
    await this.requireDirectory(destination.realPath);
    await this.requireWritable(destination);

    const name = newName ?? posix.basename(source.path);
    const targetPath = posix.join(destination.path, name);
    const targetRealPath = posix.join(destination.realPath, name);
    if (targetPath === source.path) {
      throw new BadRequestException('The folder is already at this location');
    }
    if (isPathInside(source.path, targetPath)) {
      throw new BadRequestException('A folder cannot be moved into itself');
    }
    this.requireNotExcluded(source.library, targetPath, true);
    await this.requireFree(source.library, targetPath, targetRealPath);

    const assets = await this.viewRepository.getLibraryAssetsByPath(source.library.id, source.path, true);
    const rewrites = assets.map((asset) =>
      this.toRewrite(asset.id, targetPath + asset.originalPath.slice(source.path.length), false),
    );

    let renamed = false;
    try {
      await this.viewRepository.rewritePaths(
        {
          assets: rewrites,
          sidecars: [],
          folders: [{ libraryId: source.library.id, from: source.path, to: targetPath }],
        },
        async () => {
          await this.storageRepository.rename(source.realPath, targetRealPath);
          renamed = true;
        },
      );
    } catch (error) {
      if (renamed) {
        this.logger.error(`Database update failed after moving ${source.path} to ${targetPath}, moving it back`);
        await this.storageRepository.rename(targetRealPath, source.realPath);
      }
      if (isErrorCode(error, 'EXDEV')) {
        throw new BadRequestException('Folders cannot be moved across file systems');
      }
      throw error;
    }

    this.logger.log(`Moved folder ${source.path} to ${targetPath} (${assets.length} asset(s))`);
    return targetPath;
  }

  private async moveAsset(libraries: Library[], asset: AssetWithSidecar, destinationPath: string, newName?: string) {
    const source = await this.resolveAssetTarget(libraries, asset);
    await this.requireFile(source.realPath);
    await this.requireWritable({ ...source, realPath: posix.dirname(source.realPath) });

    const destination = await this.resolveTarget(libraries, destinationPath);
    if (destination.library.id !== source.library.id) {
      throw new BadRequestException('Files can only be moved inside the same library');
    }
    await this.requireDirectory(destination.realPath);
    await this.requireWritable(destination);

    const sourceName = posix.basename(source.path);
    const name = newName ?? sourceName;
    const targetPath = posix.join(destination.path, name);
    if (targetPath === source.path) {
      throw new BadRequestException('The file is already at this location');
    }
    this.requireNotExcluded(source.library, targetPath, false);

    const toReal = (path: string) => posix.join(destination.realPath, posix.relative(destination.path, path));
    const fromReal = (path: string) =>
      posix.join(posix.dirname(source.realPath), posix.relative(posix.dirname(source.path), path));

    const moves: FileMove[] = [{ from: source.realPath, to: toReal(targetPath) }];
    const rewrites: AssetPathRewrite[] = [this.toRewrite(asset.id, targetPath, true)];
    const sidecars: SidecarPathRewrite[] = [];
    await this.requireFree(source.library, targetPath, toReal(targetPath));

    const sidecarMoves = await this.getSidecarMoves(asset, source.path, targetPath, fromReal);
    for (const sidecar of sidecarMoves) {
      await this.requireFree(source.library, sidecar.to, toReal(sidecar.to));
      moves.push({ from: fromReal(sidecar.from), to: toReal(sidecar.to) });
      if (sidecar.from === asset.sidecarPath) {
        sidecars.push({ assetId: asset.id, path: sidecar.to });
      }
    }

    const motion = await this.getMotionToMove(asset, source.path, destination.path);
    if (motion) {
      const motionTarget = posix.join(destination.path, posix.basename(motion.originalPath));
      await this.requireFile(fromReal(motion.originalPath));
      await this.requireFree(source.library, motionTarget, toReal(motionTarget));
      moves.push({ from: fromReal(motion.originalPath), to: toReal(motionTarget) });
      rewrites.push(this.toRewrite(motion.id, motionTarget, false));
    }

    const done: FileMove[] = [];
    try {
      await this.viewRepository.rewritePaths({ assets: rewrites, sidecars, folders: [] }, async () => {
        for (const move of moves) {
          await this.moveFile(move.from, move.to);
          done.push(move);
        }
      });
    } catch (error) {
      if (done.length > 0) {
        this.logger.error(`Moving ${source.path} to ${targetPath} failed, restoring ${done.length} file(s)`);
        for (const move of done.toReversed()) {
          await this.moveFile(move.to, move.from);
        }
      }
      throw error;
    }

    this.logger.log(`Moved file ${source.path} to ${targetPath}`);
    return targetPath;
  }

  private async getSidecarMoves(
    asset: AssetWithSidecar,
    sourcePath: string,
    targetPath: string,
    toRealPath: (path: string) => string,
  ) {
    const sourceDirectory = posix.dirname(sourcePath);
    const targetDirectory = posix.dirname(targetPath);
    const sourceStem = posix.parse(sourcePath).name;
    const targetStem = posix.parse(targetPath).name;

    const candidates = new Map<string, string>([
      [`${sourcePath}.xmp`, `${targetPath}.xmp`],
      [posix.join(sourceDirectory, `${sourceStem}.xmp`), posix.join(targetDirectory, `${targetStem}.xmp`)],
    ]);
    if (
      asset.sidecarPath &&
      posix.dirname(asset.sidecarPath) === sourceDirectory &&
      !candidates.has(asset.sidecarPath)
    ) {
      candidates.set(asset.sidecarPath, posix.join(targetDirectory, posix.basename(asset.sidecarPath)));
    }

    const moves: FileMove[] = [];
    for (const [from, to] of candidates) {
      const stats = await this.storageRepository.lstat(toRealPath(from)).catch(() => null);
      if (stats?.isFile()) {
        moves.push({ from, to });
      }
    }

    return moves;
  }

  private async getMotionToMove(asset: AssetWithSidecar, sourcePath: string, destinationPath: string) {
    if (!asset.livePhotoVideoId || posix.dirname(sourcePath) === destinationPath) {
      return;
    }

    const [motion] = await this.viewRepository.getAssetPathsByIds([asset.livePhotoVideoId]);
    if (
      !motion ||
      motion.libraryId !== asset.libraryId ||
      posix.dirname(motion.originalPath) !== posix.dirname(sourcePath)
    ) {
      return;
    }

    const visibleUsers = await this.assetRepository.getLivePhotoCount(motion.id);
    if (visibleUsers > 1) {
      return;
    }

    return motion;
  }

  private async moveFile(from: string, to: string) {
    try {
      await this.storageRepository.link(from, to);
    } catch (error) {
      if (!isErrorCode(error, ...LINK_FALLBACK_CODES)) {
        if (isErrorCode(error, 'EEXIST')) {
          throw new ConflictException('A file or folder with this name already exists');
        }
        throw error;
      }

      const stats = await this.storageRepository.stat(from);
      await this.storageRepository.copyFileExclusive(from, to);
      await this.storageRepository.utimes(to, stats.atime, stats.mtime);
    }

    await this.storageRepository.unlink(from);
  }
}
