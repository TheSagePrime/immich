import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { FOLDER_ALBUM_SYNC_DELAY_MS } from 'src/constants.js';
import { JobName } from 'src/enum.js';
import type { JobItem } from 'src/types.js';

export type FolderAlbumRoot = {
  path: string;
  name: string;
  libraryId: string | null;
};

export type FolderAlbumLibrary = {
  id: string;
  importPaths: string[];
};

export type DesiredFolderAlbum = {
  path: string;
  name: string;
  parentPath: string | null;
};

export type ExistingFolderAlbum = {
  id: string;
  folderPath: string;
  albumName: string;
  parentAlbumId: string | null;
};

export type FolderAlbumCreate = {
  id: string;
  folderPath: string;
  albumName: string;
  parentAlbumId: string | null;
};

export type FolderAlbumUpdate = {
  id: string;
  albumName: string;
  parentAlbumId: string | null;
};

export type FolderAlbumDiff = {
  create: FolderAlbumCreate[];
  update: FolderAlbumUpdate[];
  delete: string[];
};

export const FOLDER_ALBUM_DEFAULT_ROOT_NAME = 'Library';

export const normalizeFolderAlbumPath = (input: string): string | null => {
  if (!input || !input.startsWith('/') || input.includes('\0')) {
    return null;
  }

  const normalized = posix.normalize(input).replace(/\/+$/, '');
  return normalized || null;
};

export const getFolderAlbumDirectory = (originalPath: string) => {
  const index = originalPath.lastIndexOf('/');
  return index <= 0 ? '' : originalPath.slice(0, index);
};

export const buildFolderAlbumRoots = (
  libraries: FolderAlbumLibrary[],
  libraryFolder: { path: string; name?: string | null },
): FolderAlbumRoot[] => {
  const roots: FolderAlbumRoot[] = [];
  const seen = new Set<string>();

  const add = (input: string, libraryId: string | null, name?: string | null) => {
    const path = normalizeFolderAlbumPath(input);
    if (!path) {
      return;
    }

    const key = `${libraryId ?? ''}:${path}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    roots.push({ path, libraryId, name: name || posix.basename(path) });
  };

  for (const library of libraries) {
    for (const importPath of library.importPaths) {
      add(importPath, library.id);
    }
  }

  add(libraryFolder.path, null, libraryFolder.name);

  return roots.toSorted((a, b) => b.path.length - a.path.length || a.path.localeCompare(b.path));
};

export const getFolderAlbumRootsKey = (roots: FolderAlbumRoot[]) =>
  createHash('sha1')
    .update(JSON.stringify(roots.map(({ path, name, libraryId }) => [path, name, libraryId]).toSorted()))
    .digest('hex');

const isInside = (root: string, path: string) => path === root || path.startsWith(`${root}/`);

export const findFolderAlbumRoot = (
  directory: string,
  libraryId: string | null | undefined,
  roots: FolderAlbumRoot[],
): FolderAlbumRoot | undefined => {
  for (const root of roots) {
    if (libraryId !== undefined && root.libraryId !== libraryId) {
      continue;
    }

    if (isInside(root.path, directory)) {
      return root;
    }
  }
};

export const expandFolderAlbumPaths = (directory: string, root: FolderAlbumRoot): string[] => {
  if (!isInside(root.path, directory)) {
    return [];
  }

  const paths = [root.path];
  const rest = directory.slice(root.path.length).split('/').filter(Boolean);
  let current = root.path;
  for (const segment of rest) {
    current = `${current}/${segment}`;
    paths.push(current);
  }

  return paths;
};

export const addDesiredFolderAlbums = (
  desired: Map<string, DesiredFolderAlbum>,
  directory: string,
  root: FolderAlbumRoot,
) => {
  let parentPath: string | null = null;
  for (const path of expandFolderAlbumPaths(directory, root)) {
    if (!desired.has(path)) {
      desired.set(path, {
        path,
        name: path === root.path ? root.name : posix.basename(path),
        parentPath,
      });
    }
    parentPath = path;
  }
};

export const buildDesiredFolderAlbums = (
  directories: { directory: string; libraryId?: string | null }[],
  roots: FolderAlbumRoot[],
) => {
  const desired = new Map<string, DesiredFolderAlbum>();
  for (const { directory, libraryId } of directories) {
    const path = normalizeFolderAlbumPath(directory);
    if (!path) {
      continue;
    }

    const root = findFolderAlbumRoot(path, libraryId, roots);
    if (root) {
      addDesiredFolderAlbums(desired, path, root);
    }
  }

  return desired;
};

export const diffFolderAlbums = (
  desired: Map<string, DesiredFolderAlbum>,
  existing: ExistingFolderAlbum[],
  { deleteUndesired, newId }: { deleteUndesired: boolean; newId: () => string },
): FolderAlbumDiff => {
  const idByPath = new Map<string, string>();
  for (const album of existing) {
    idByPath.set(album.folderPath, album.id);
  }

  const create: FolderAlbumCreate[] = [];
  const missing = [...desired.values()]
    .filter(({ path }) => !idByPath.has(path))
    .toSorted((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
  for (const item of missing) {
    idByPath.set(item.path, newId());
  }
  for (const item of missing) {
    create.push({
      id: idByPath.get(item.path)!,
      folderPath: item.path,
      albumName: item.name,
      parentAlbumId: item.parentPath ? (idByPath.get(item.parentPath) ?? null) : null,
    });
  }

  const update: FolderAlbumUpdate[] = [];
  const remove: string[] = [];
  for (const album of existing) {
    const item = desired.get(album.folderPath);
    if (!item) {
      if (deleteUndesired) {
        remove.push(album.id);
      }
      continue;
    }

    const parentAlbumId = item.parentPath ? (idByPath.get(item.parentPath) ?? null) : null;
    if (album.albumName !== item.name || album.parentAlbumId !== parentAlbumId) {
      update.push({ id: album.id, albumName: item.name, parentAlbumId });
    }
  }

  return { create, update, delete: remove };
};

export const getPrunableFolderAlbumIds = (
  albums: { id: string; parentAlbumId: string | null }[],
  nonEmptyIds: Set<string>,
): string[] => {
  const byId = new Map(albums.map((album) => [album.id, album]));
  const keep = new Set<string>();

  for (const id of nonEmptyIds) {
    let current = byId.get(id);
    let depth = 0;
    while (current && !keep.has(current.id) && depth < 4096) {
      keep.add(current.id);
      current = current.parentAlbumId ? byId.get(current.parentAlbumId) : undefined;
      depth++;
    }
  }

  return albums.filter(({ id }) => !keep.has(id)).map(({ id }) => id);
};

const recentlyQueued = new Map<string, number>();

export const resetFolderAlbumSyncThrottle = () => recentlyQueued.clear();

export const queueFolderAlbumSync = async (
  jobRepository: { queueAll: (items: JobItem[]) => Promise<void> },
  userIds: Iterable<string | null | undefined>,
  options: { full?: boolean } = {},
) => {
  const now = Date.now();
  const window = Math.floor(FOLDER_ALBUM_SYNC_DELAY_MS / 2);
  const items: JobItem[] = [];
  for (const userId of new Set(userIds)) {
    if (!userId) {
      continue;
    }

    if (options.full) {
      items.push({ name: JobName.FolderAlbumSync, data: { userId, full: true } });
      continue;
    }

    const last = recentlyQueued.get(userId);
    if (last !== undefined && now - last >= 0 && now - last < window) {
      continue;
    }

    recentlyQueued.set(userId, now);
    items.push({ name: JobName.FolderAlbumSync, data: { userId, debounce: true } });
  }

  if (recentlyQueued.size > 1000) {
    for (const [userId, time] of recentlyQueued) {
      if (now - time >= window) {
        recentlyQueued.delete(userId);
      }
    }
  }

  await jobRepository.queueAll(items);
};
