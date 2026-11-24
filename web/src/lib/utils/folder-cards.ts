import { Route } from '#lib/route.ts';
import { getChildRelativePath, getFolderLink, getRootName, type FolderLocation } from '#lib/utils/folder-roots.ts';
import { compareNatural } from '#lib/utils/folder-sort.ts';
import type { FolderRootDto, FolderSummaryItemDto, FolderSummaryResponseDto } from '@immich/sdk';
import type { MessageFormatter } from 'svelte-i18n';

export type FolderCardKind = 'root' | 'mount' | 'folder';

export type FolderCard = {
  label: string;
  path: string;
  href: string;
  kind: FolderCardKind;
  writable: boolean;
  folderPath?: string;
  assetCount?: number;
  coverAssetId?: string | null;
  newestTakenAt?: string | null;
  oldestTakenAt?: string | null;
  newestAddedAt?: string | null;
  oldestAddedAt?: string | null;
  totalSize?: number;
};

const getMetrics = (item: FolderSummaryItemDto) => ({
  assetCount: item.assetCount,
  coverAssetId: item.coverAssetId,
  newestTakenAt: item.newestTakenAt,
  oldestTakenAt: item.oldestTakenAt,
  newestAddedAt: item.newestAddedAt,
  oldestAddedAt: item.oldestAddedAt,
  totalSize: item.totalSize,
});

const byLabel = (a: FolderCard, b: FolderCard) => compareNatural(a.label, b.label);

export const getRootCards = ($t: MessageFormatter, roots: FolderRootDto[]): FolderCard[] =>
  roots.map((root) => ({
    label: getRootName($t, root),
    path: `root:${root.id}`,
    href: getFolderLink(root.id),
    kind: 'root',
    writable: root.folders.length === 1 && root.folders[0].writable,
    folderPath: root.folders.length === 1 ? root.folders[0].path : undefined,
    assetCount: root.assetCount,
    coverAssetId: root.coverAssetId,
  }));

export const getMountCards = (location: FolderLocation): FolderCard[] =>
  location.root.folders
    .map((folder): FolderCard => ({
      label: folder.name,
      path: folder.path,
      href: getFolderLink(location.root.id, folder.name),
      kind: 'mount',
      writable: folder.writable,
      folderPath: folder.path,
    }))
    .sort(byLabel);

export const getFolderCards = (summary: FolderSummaryResponseDto, location?: FolderLocation): FolderCard[] =>
  summary.children
    .map((child): FolderCard => ({
      label: child.name,
      path: child.path,
      href: location
        ? getFolderLink(location.root.id, getChildRelativePath(location, child.name))
        : Route.folders({ path: child.path }),
      kind: 'folder',
      writable: summary.writable,
      folderPath: child.path,
      ...getMetrics(child),
    }))
    .sort(byLabel);
