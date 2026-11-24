import { TreeNode } from '#lib/utils/tree-utils.ts';
import { getVideoFolders } from '@immich/sdk';
import { queryOptions } from '@tanstack/svelte-query';

export const videoLibraryQueryKey = ['video-library'] as const;

const toTree = (paths: string[]) => {
  const tree = TreeNode.fromPaths(paths);
  tree.collapse();
  return tree;
};

export const getVideoFoldersQuery = () =>
  queryOptions({
    queryKey: [...videoLibraryQueryKey, 'folders'],
    queryFn: ({ signal }) => getVideoFolders({ signal }),
  });

export const getVideoFolderTreeQuery = () =>
  queryOptions({
    ...getVideoFoldersQuery(),
    select: toTree,
  });
