import { posix } from 'node:path';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { FOLDER_ROOT_UPLOADS_ID, FolderRootDto, FolderRootFolderDto } from 'src/dtos/folder.dto.js';
import { FolderRootKind } from 'src/enum.js';
import type { FolderDirectoryRow } from 'src/repositories/view-repository.js';
import { compareNatural } from 'src/utils/natural-sort.js';
import { isPathInside } from 'src/utils/safe-path.js';
import { canManageLibrary, getWritableRoot, normalizeFolderPath } from 'src/utils/writable-library.js';

export type FolderRootLibrary = {
  id: string;
  name: string;
  ownerId: string;
  importPaths: string[];
  exclusionPatterns: string[];
  writable: boolean;
  deletedAt: Date | string | null;
};

export type FolderUploadLocation = {
  name: string;
  path: string;
};

type Candidate = { name: string; path: string; writable: boolean };

type Stats = { assetCount: number; coverAssetId: string | null; newest: number };

const emptyStats = (): Stats => ({ assetCount: 0, coverAssetId: null, newest: -Infinity });

const addStats = (stats: Stats, row: FolderDirectoryRow) => {
  stats.assetCount += row.assetCount;
  const newest = new Date(row.newestTakenAt).getTime();
  if (newest <= stats.newest) {
    return;
  }

  stats.newest = newest;
  stats.coverAssetId = row.coverAssetId;
};

const toDirectory = (row: FolderDirectoryRow) => normalizeFolderPath(row.directoryPath || '/');

export const getFolderDisplayNames = (paths: string[]): string[] => {
  const segments = paths.map((path) => path.split('/').filter(Boolean));
  const depth = paths.map(() => 1);

  for (let attempt = 0; attempt < 64; attempt++) {
    const names = segments.map((parts, index) => parts.slice(-depth[index]).join('/') || '/');
    let changed = false;
    for (let index = 0; index < names.length; index++) {
      const duplicate = names.some((name, other) => other !== index && name === names[index]);
      if (!duplicate || depth[index] >= segments[index].length) {
        continue;
      }

      depth[index]++;
      changed = true;
    }

    if (!changed) {
      return names;
    }
  }

  return segments.map((parts) => parts.join('/') || '/');
};

const getCommonDirectory = (paths: string[]) => {
  const [first, ...rest] = paths.map((path) => path.split('/').filter(Boolean));
  let length = first.length;
  for (const parts of rest) {
    let index = 0;
    while (index < length && index < parts.length && parts[index] === first[index]) {
      index++;
    }
    length = index;
  }

  return '/' + first.slice(0, length).join('/');
};

const toFolders = (candidates: Candidate[]): FolderRootFolderDto[] => {
  const fallback = getFolderDisplayNames(candidates.map(({ path }) => path));
  const preferred = candidates.map((candidate, index) => candidate.name || fallback[index]);
  return candidates
    .map((candidate, index) => ({
      name: preferred.filter((name) => name === preferred[index]).length > 1 ? fallback[index] : preferred[index],
      path: candidate.path,
      writable: candidate.writable,
    }))
    .toSorted((a, b) => compareNatural(a.name, b.name));
};

const toRoot = (
  root: Omit<FolderRootDto, 'assetCount' | 'coverAssetId' | 'folders' | 'writable'>,
  candidates: Candidate[],
  stats: Stats,
): FolderRootDto => ({
  ...root,
  writable: candidates.some(({ writable }) => writable),
  assetCount: stats.assetCount,
  coverAssetId: stats.coverAssetId,
  folders: toFolders(candidates),
});

export const buildFolderRoots = ({
  auth,
  libraries,
  directories,
  uploadLocations,
}: {
  auth: AuthDto;
  libraries: FolderRootLibrary[];
  directories: FolderDirectoryRow[];
  uploadLocations: FolderUploadLocation[];
}): FolderRootDto[] => {
  const roots: FolderRootDto[] = [];

  for (const library of libraries) {
    if (library.deletedAt) {
      continue;
    }

    const owned = library.ownerId === auth.user.id;
    const writableRoot = canManageLibrary(auth, library) ? getWritableRoot(library) : null;
    if (!owned && !writableRoot) {
      continue;
    }

    const rows = owned ? directories.filter((row) => row.libraryId === library.id) : [];
    const stats = emptyStats();
    const candidates: Candidate[] = [];
    const importPaths = [...new Set(library.importPaths.map((path) => normalizeFolderPath(path)))];

    for (const importPath of importPaths) {
      const inside = rows.filter((row) => isPathInside(importPath, toDirectory(row)));
      const writable = importPath === writableRoot;
      if (inside.length === 0 && !writable) {
        continue;
      }

      for (const row of inside) {
        addStats(stats, row);
      }
      candidates.push({ name: '', path: importPath, writable });
    }

    if (candidates.length > 0) {
      roots.push(toRoot({ id: library.id, kind: FolderRootKind.Library, name: library.name }, candidates, stats));
    }
  }

  roots.sort((a, b) => compareNatural(a.name, b.name));

  const uploads = directories.filter((row) => row.libraryId === null);
  if (uploads.length > 0) {
    const stats = emptyStats();
    const candidates: Candidate[] = [];
    const leftover: FolderDirectoryRow[] = [];
    const locations = uploadLocations
      .map((location) => ({ ...location, path: normalizeFolderPath(location.path), rows: [] as FolderDirectoryRow[] }))
      .toSorted((a, b) => b.path.length - a.path.length);

    for (const row of uploads) {
      addStats(stats, row);
      const location = locations.find(({ path }) => isPathInside(path, toDirectory(row)));
      if (location) {
        location.rows.push(row);
      } else {
        leftover.push(row);
      }
    }

    for (const location of locations) {
      if (location.rows.length > 0) {
        candidates.push({ name: location.name, path: location.path, writable: false });
      }
    }

    if (leftover.length > 0) {
      const path = getCommonDirectory(leftover.map((row) => toDirectory(row)));
      candidates.push({ name: posix.basename(path) || '/', path, writable: false });
    }

    roots.push(
      toRoot({ id: FOLDER_ROOT_UPLOADS_ID, kind: FolderRootKind.Uploads, name: 'Uploads' }, candidates, stats),
    );
  }

  return roots;
};
