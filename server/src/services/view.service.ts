import { BadRequestException, Injectable } from '@nestjs/common';
import { posix } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetResponseDto, mapAsset } from 'src/dtos/asset-response.dto.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  FolderRootDto,
  FolderSummaryItemDto,
  FolderSummaryQueryDto,
  FolderSummaryResponseDto,
} from 'src/dtos/folder.dto.js';
import { StorageFolder } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { asDateTimeString } from 'src/utils/date.js';
import { FolderUploadLocation, buildFolderRoots } from 'src/utils/folder-roots.js';
import { compareNatural } from 'src/utils/natural-sort.js';
import { isPathInside, resolveSafePath } from 'src/utils/safe-path.js';
import {
  canManageLibrary,
  createExclusionMatcher,
  findWritableLibrary,
  getWritableRoot,
  normalizeFolderPath,
} from 'src/utils/writable-library.js';

@Injectable()
export class ViewService extends BaseService {
  getUniqueOriginalPaths(auth: AuthDto): Promise<string[]> {
    return this.viewRepository.getUniqueOriginalPaths(auth.user.id);
  }

  async getFolderRoots(auth: AuthDto): Promise<FolderRootDto[]> {
    const [directories, libraries, user] = await Promise.all([
      this.viewRepository.getFolderDirectories(auth.user.id),
      this.libraryRepository.getAll(),
      this.userRepository.get(auth.user.id, {}),
    ]);

    const libraryFolder = StorageCore.getBaseFolder(StorageFolder.Library);
    const uploadLocations: FolderUploadLocation[] = [
      { name: 'library', path: posix.join(libraryFolder, auth.user.id) },
      { name: 'upload', path: StorageCore.getFolderLocation(StorageFolder.Upload, auth.user.id) },
    ];
    if (user?.storageLabel) {
      uploadLocations.push({ name: 'library', path: posix.join(libraryFolder, user.storageLabel) });
    }

    return buildFolderRoots({ auth, libraries, directories, uploadLocations });
  }

  async getAssetsByOriginalPath(auth: AuthDto, path: string): Promise<AssetResponseDto[]> {
    const assets = await this.viewRepository.getAssetsByOriginalPath(auth.user.id, path);
    return assets.map((asset) => mapAsset(asset, { auth }));
  }

  async getFolderSummary(auth: AuthDto, dto: FolderSummaryQueryDto): Promise<FolderSummaryResponseDto> {
    if (dto.path.includes('\0')) {
      throw new BadRequestException('Path must not contain NUL bytes');
    }

    const path = normalizeFolderPath(dto.path);
    const rows = await this.viewRepository.getFolderSummary(auth.user.id, path);

    let directAssetCount = 0;
    const children = new Map<string, FolderSummaryItemDto>();
    for (const row of rows) {
      if (row.name === null) {
        directAssetCount = row.assetCount;
        continue;
      }

      children.set(row.name, {
        name: row.name,
        path: posix.join(path, row.name),
        assetCount: row.assetCount,
        coverAssetId: row.coverAssetId,
        newestTakenAt: asDateTimeString(row.newestTakenAt),
        oldestTakenAt: asDateTimeString(row.oldestTakenAt),
        newestAddedAt: asDateTimeString(row.newestAddedAt),
        oldestAddedAt: asDateTimeString(row.oldestAddedAt),
        totalSize: row.totalSize,
      });
    }

    const allLibraries = await this.libraryRepository.getAll();
    const libraries = allLibraries.filter((library) => canManageLibrary(auth, library));
    const match = findWritableLibrary(libraries, path);

    for (const library of libraries) {
      const root = getWritableRoot(library);
      if (!root || root === path || !isPathInside(path, root)) {
        continue;
      }

      const [name] = posix.relative(path, root).split('/', 1);
      if (!children.has(name)) {
        children.set(name, { name, path: posix.join(path, name), assetCount: 0, coverAssetId: null });
      }
    }

    if (match) {
      for (const name of await this.getDiskFolders(match.root, path, match.library.exclusionPatterns)) {
        if (!children.has(name)) {
          children.set(name, { name, path: posix.join(path, name), assetCount: 0, coverAssetId: null });
        }
      }
    }

    return {
      path,
      directAssetCount,
      children: children
        .values()
        .toArray()
        .toSorted((a, b) => compareNatural(a.name, b.name)),
      writable: !!match,
      libraryId: match?.library.id,
      isLibraryRoot: match?.root === path,
    };
  }

  private async getDiskFolders(root: string, path: string, exclusionPatterns: string[]): Promise<string[]> {
    const isExcluded = createExclusionMatcher(exclusionPatterns);
    try {
      const realPath = await resolveSafePath(root, posix.relative(root, path));
      const entries = await this.storageRepository.readdirWithTypes(realPath);
      return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .filter((name) => !isExcluded(posix.join(path, name), true));
    } catch (error) {
      this.logger.warn(`Unable to list folders in ${path}: ${error}`);
      return [];
    }
  }
}
