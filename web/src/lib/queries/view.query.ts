import { TreeNode } from '#lib/utils/tree-utils.ts';
import { getAssetsByOriginalPath, getFolderRoots, getFolderSummary, getUniqueOriginalPaths } from '@immich/sdk';
import { queryOptions } from '@tanstack/svelte-query';

export const folderViewQueryKey = ['view', 'folder'] as const;

const toTree = (paths: string[]) => {
  const tree = TreeNode.fromPaths(paths);
  tree.collapse();
  return tree;
};

export const getUniqueOriginalPathsQuery = () =>
  queryOptions({
    queryKey: [...folderViewQueryKey, 'unique-paths'],
    queryFn: ({ signal }) => getUniqueOriginalPaths({ signal }),
  });

export const getFolderTreeQuery = () =>
  queryOptions({
    ...getUniqueOriginalPathsQuery(),
    select: toTree,
  });

export const getAssetsByOriginalPathQuery = (path: string) =>
  queryOptions({
    queryKey: [...folderViewQueryKey, 'assets', path],
    queryFn: ({ signal }) => getAssetsByOriginalPath({ path }, { signal }),
  });

export const getFolderSummaryQuery = (path: string) =>
  queryOptions({
    queryKey: [...folderViewQueryKey, 'summary', path],
    queryFn: ({ signal }) => getFolderSummary({ path }, { signal }),
    staleTime: 60_000,
  });

export const getFolderRootsQuery = () =>
  queryOptions({
    queryKey: [...folderViewQueryKey, 'roots'],
    queryFn: ({ signal }) => getFolderRoots({ signal }),
    staleTime: 60_000,
  });
