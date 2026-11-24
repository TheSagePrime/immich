import { TreeNode } from '#lib/utils/tree-utils.ts';
import { getPlaybackPosition, getSubtitles, getVideoFolders } from '@immich/sdk';
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

export const getPlaybackPositionQuery = (id: string) =>
  queryOptions({
    queryKey: [...videoLibraryQueryKey, 'playback-position', id],
    queryFn: ({ signal }) => getPlaybackPosition({ id }, { signal }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

export const getSubtitlesQuery = (id: string, params: { key?: string; slug?: string }) =>
  queryOptions({
    queryKey: [...videoLibraryQueryKey, 'subtitles', id, params],
    queryFn: ({ signal }) => getSubtitles({ id, ...params }, { signal }),
    retry: false,
  });
