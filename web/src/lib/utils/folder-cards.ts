import { normalizeTreePath, type TreeNode } from '#lib/utils/tree-utils.ts';
import type { FolderSummaryResponseDto } from '@immich/sdk';

export type FolderCard = {
  label: string;
  path: string;
  assetCount?: number;
  coverAssetId?: string | null;
};

const getFirstSegment = (value: string) => {
  const [segment] = value.replace(/^\/+/, '').split('/', 1);
  return segment;
};

export const getFolderCards = (summary: FolderSummaryResponseDto, tree: TreeNode | undefined): FolderCard[] => {
  const byName = new Map(summary.children.map((child) => [child.name, child]));
  const cards: FolderCard[] = [];
  const covered = new Set<string>();

  if (tree && !summary.writable) {
    for (const child of tree.children) {
      const name = getFirstSegment(child.value);
      const item = byName.get(name);
      covered.add(name);
      cards.push({
        label: child.value,
        path: normalizeTreePath(child.path),
        assetCount: item?.assetCount,
        coverAssetId: item?.coverAssetId,
      });
    }
  }

  for (const child of summary.children) {
    if (!covered.has(child.name)) {
      cards.push({
        label: child.name,
        path: child.path,
        assetCount: child.assetCount,
        coverAssetId: child.coverAssetId,
      });
    }
  }

  return cards.sort((a, b) => a.label.localeCompare(b.label));
};
