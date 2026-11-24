import { Route } from '#lib/route.ts';
import { getFolderCrumbs, isSameOrInsidePath } from '#lib/utils/folder-utils.ts';
import { FolderRootKind, type FolderRootDto, type FolderRootFolderDto } from '@immich/sdk';
import type { MessageFormatter } from 'svelte-i18n';

export type FolderLocation = {
  root: FolderRootDto;
  folder?: FolderRootFolderDto;
  relativePath: string;
  absolutePath?: string;
};

export type FolderView =
  | { mode: 'roots' }
  | { mode: 'folders'; location: FolderLocation }
  | { mode: 'folder'; location?: FolderLocation; folderPath: string };

export type FolderCrumb = {
  title: string;
  href?: string;
  path?: string;
  writable: boolean;
};

const trimSlashes = (value: string) => value.replaceAll(/^\/+|\/+$/g, '');

export const normalizeRelativePath = (value?: string | null) =>
  trimSlashes(value ?? '')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');

const joinPath = (base: string, relative: string) => {
  if (!relative) {
    return base;
  }

  return base === '/' ? `/${relative}` : `${base}/${relative}`;
};

const isMultiFolder = (root: FolderRootDto) => root.folders.length !== 1;

export const getRootName = ($t: MessageFormatter, root: FolderRootDto) =>
  root.kind === FolderRootKind.Uploads ? $t('phone_uploads') : root.name;

export const getFolderLink = (rootId: string, relativePath = '') =>
  Route.folders({ root: rootId, path: relativePath || undefined });

const findFolder = (root: FolderRootDto, relativePath: string) => {
  if (!isMultiFolder(root)) {
    return { folder: root.folders[0], rest: relativePath };
  }

  const matches = root.folders
    .filter(({ name }) => relativePath === name || relativePath.startsWith(`${name}/`))
    .sort((a, b) => b.name.length - a.name.length);
  const folder = matches[0];
  if (!folder) {
    return;
  }

  return { folder, rest: trimSlashes(relativePath.slice(folder.name.length)) };
};

export const resolveFolderLocation = (
  roots: FolderRootDto[],
  rootId: string,
  path?: string | null,
): FolderLocation | undefined => {
  const root = roots.find(({ id }) => id === rootId);
  if (!root) {
    return;
  }

  const relativePath = normalizeRelativePath(path);
  if (!relativePath && isMultiFolder(root)) {
    return { root, relativePath };
  }

  const match = findFolder(root, relativePath);
  if (!match?.folder) {
    return;
  }

  return { root, folder: match.folder, relativePath, absolutePath: joinPath(match.folder.path, match.rest) };
};

export const locateFolderPath = (roots: FolderRootDto[], absolutePath: string) => {
  let best: { root: FolderRootDto; folder: FolderRootFolderDto } | undefined;
  for (const root of roots) {
    for (const folder of root.folders) {
      if (isSameOrInsidePath(folder.path, absolutePath) && (!best || folder.path.length > best.folder.path.length)) {
        best = { root, folder };
      }
    }
  }

  if (!best) {
    return;
  }

  const rest = trimSlashes(absolutePath.slice(best.folder.path.length));
  const relativePath = isMultiFolder(best.root) ? [best.folder.name, rest].filter(Boolean).join('/') : rest;
  return { rootId: best.root.id, relativePath };
};

export const getChildRelativePath = (location: FolderLocation, name: string) =>
  [location.relativePath, name].filter(Boolean).join('/');

export const getFolderLocationCrumbs = ($t: MessageFormatter, location: FolderLocation): FolderCrumb[] => {
  const { root, folder } = location;
  const crumbs: FolderCrumb[] = [];
  const multi = isMultiFolder(root);

  crumbs.push({
    title: getRootName($t, root),
    href: getFolderLink(root.id),
    path: multi ? undefined : folder?.path,
    writable: !multi && !!folder?.writable,
  });

  if (!folder || !location.absolutePath) {
    return crumbs;
  }

  if (multi) {
    crumbs.push({
      title: folder.name,
      href: getFolderLink(root.id, folder.name),
      path: folder.path,
      writable: folder.writable,
    });
  }

  const prefix = multi ? folder.name : '';
  const inner = location.absolutePath === folder.path ? '' : location.absolutePath.slice(folder.path.length);
  for (const crumb of getFolderCrumbs(inner)) {
    const relative = [prefix, trimSlashes(crumb.path)].filter(Boolean).join('/');
    crumbs.push({
      title: crumb.name,
      href: getFolderLink(root.id, relative),
      path: joinPath(folder.path, trimSlashes(crumb.path)),
      writable: folder.writable,
    });
  }

  return crumbs;
};

export const getFriendlyFolderPath = ($t: MessageFormatter, roots: FolderRootDto[], absolutePath: string) => {
  const located = locateFolderPath(roots, absolutePath);
  if (!located) {
    return;
  }

  const location = resolveFolderLocation(roots, located.rootId, located.relativePath);
  return location ? getFolderLocationCrumbs($t, location).map(({ title }) => title) : undefined;
};
