import { asMutation, queryClient } from '#lib/queries/client.ts';
import { folderViewQueryKey } from '#lib/queries/view.query.ts';
import {
  browseFolders,
  createFolder,
  deleteFolderItems,
  moveFolderItems,
  renameFolder,
  renameFolderAsset,
} from '@immich/sdk';
import { queryOptions } from '@tanstack/svelte-query';

export const folderBrowseQueryKey = ['folders', 'browse'] as const;

export const getFolderBrowseQuery = (path?: string) =>
  queryOptions({
    queryKey: [...folderBrowseQueryKey, path ?? null],
    queryFn: ({ signal }) => browseFolders({ path }, { signal }),
    staleTime: 0,
  });

const invalidateFolders = async () => {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: folderViewQueryKey }),
    queryClient.invalidateQueries({ queryKey: folderBrowseQueryKey }),
  ]);
};

export const createFolderMutation = () =>
  asMutation(createFolder, {
    onSuccess: invalidateFolders,
    meta: { success: { toast: 'folder_created' }, error: { toast: 'errors.unable_to_create_folder' } },
  });

export const renameFolderMutation = () =>
  asMutation(renameFolder, {
    onSuccess: invalidateFolders,
    meta: { success: { toast: 'folder_renamed' }, error: { toast: 'errors.unable_to_rename_folder' } },
  });

export const renameFolderAssetMutation = () =>
  asMutation(renameFolderAsset, {
    onSuccess: invalidateFolders,
    meta: { success: { toast: 'file_renamed' }, error: { toast: 'errors.unable_to_rename_file' } },
  });

export const moveFolderItemsMutation = () =>
  asMutation(moveFolderItems, {
    onSuccess: invalidateFolders,
    meta: { error: { toast: 'errors.unable_to_move_items' } },
  });

export const deleteFolderItemsMutation = () =>
  asMutation(deleteFolderItems, {
    onSuccess: invalidateFolders,
    meta: { error: { toast: 'errors.unable_to_delete_items' } },
  });
