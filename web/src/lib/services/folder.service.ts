import FolderDeleteConfirmModal from '#lib/modals/FolderDeleteConfirmModal.svelte';
import FolderNameModal from '#lib/modals/FolderNameModal.svelte';
import FolderPickerModal from '#lib/modals/FolderPickerModal.svelte';
import { executeMutation } from '#lib/queries/client.ts';
import {
  createFolderMutation,
  deleteFolderItemsMutation,
  moveFolderItemsMutation,
  renameFolderAssetMutation,
  renameFolderMutation,
} from '#lib/queries/folder.query.ts';
import { getFolderName, splitFileName } from '#lib/utils/folder-utils.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import type { FolderBulkFailureDto } from '@immich/sdk';
import { modalManager, toastManager, type ActionItem } from '@immich/ui';
import {
  mdiDeleteOutline,
  mdiFileEditOutline,
  mdiFolderEditOutline,
  mdiFolderMoveOutline,
  mdiFolderPlusOutline,
} from '@mdi/js';
import type { MessageFormatter } from 'svelte-i18n';

type OnChanged = () => unknown;

export type FolderSelection = {
  folderPaths: string[];
  assetIds: string[];
};

const reportFailures = async (failed: FolderBulkFailureDto[]) => {
  if (failed.length === 0) {
    return;
  }

  const $t = await getFormatter();
  toastManager.warning($t('move_partially_failed', { values: { count: failed.length, reason: failed[0].reason } }));
};

export const handleCreateFolder = async (parentPath: string, onChanged?: OnChanged) => {
  const $t = await getFormatter();
  const name = await modalManager.show(FolderNameModal, { title: $t('new_folder'), submitText: $t('create') });
  if (!name) {
    return;
  }

  const created = await executeMutation(createFolderMutation, [{ folderCreateDto: { parentPath, name } }]);
  if (created) {
    await onChanged?.();
  }
  return created;
};

export const handleRenameFolder = async (path: string, onChanged?: OnChanged) => {
  const $t = await getFormatter();
  const name = await modalManager.show(FolderNameModal, {
    title: $t('rename_folder'),
    submitText: $t('rename'),
    initialName: getFolderName(path),
  });
  if (!name) {
    return;
  }

  const renamed = await executeMutation(renameFolderMutation, [{ folderRenameDto: { path, name } }]);
  if (renamed) {
    await onChanged?.();
  }
  return renamed;
};

export const handleRenameFile = async (asset: { id: string; originalFileName: string }, onChanged?: OnChanged) => {
  const $t = await getFormatter();
  const { stem, extension } = splitFileName(asset.originalFileName);
  const name = await modalManager.show(FolderNameModal, {
    title: $t('rename_file'),
    submitText: $t('rename'),
    initialName: stem,
    extension,
  });
  if (!name) {
    return;
  }

  const renamed = await executeMutation(renameFolderAssetMutation, [{ id: asset.id, assetFileRenameDto: { name } }]);
  if (renamed) {
    await onChanged?.();
  }
  return renamed;
};

export const handleMoveSelection = async (selection: FolderSelection, initialPath?: string, onChanged?: OnChanged) => {
  const destination = await modalManager.show(FolderPickerModal, {
    folderPaths: selection.folderPaths,
    initialPath,
  });
  if (!destination) {
    return;
  }

  const result = await executeMutation(moveFolderItemsMutation, [
    {
      folderMoveDto: {
        destination,
        folderPaths: selection.folderPaths.length > 0 ? selection.folderPaths : undefined,
        assetIds: selection.assetIds.length > 0 ? selection.assetIds : undefined,
      },
    },
  ]);
  if (!result) {
    return;
  }

  const $t = await getFormatter();
  if (result.moved > 0) {
    toastManager.primary($t('items_moved_count', { values: { count: result.moved } }));
  }
  await reportFailures(result.failed);
  await onChanged?.();
  return result;
};

export const handleDeleteSelection = async (selection: FolderSelection, onChanged?: OnChanged) => {
  const force = await modalManager.show(FolderDeleteConfirmModal, {
    folderCount: selection.folderPaths.length,
    assetCount: selection.assetIds.length,
  });
  if (force === undefined) {
    return;
  }

  const result = await executeMutation(deleteFolderItemsMutation, [
    {
      folderDeleteDto: {
        force,
        folderPaths: selection.folderPaths.length > 0 ? selection.folderPaths : undefined,
        assetIds: selection.assetIds.length > 0 ? selection.assetIds : undefined,
      },
    },
  ]);
  if (!result) {
    return;
  }

  const $t = await getFormatter();
  toastManager.primary(
    force
      ? $t('items_deleted_count', { values: { count: result.deleted } })
      : $t('items_trashed_count', { values: { count: result.trashed } }),
  );
  if (result.removedFolders > 0) {
    toastManager.primary($t('folders_removed_count', { values: { count: result.removedFolders } }));
  }
  await reportFailures(result.failed);
  await onChanged?.();
  return result;
};

export const getFolderActions = ($t: MessageFormatter, path: string, onChanged?: OnChanged) => {
  const CreateFolder: ActionItem = {
    title: $t('new_folder'),
    icon: mdiFolderPlusOutline,
    onAction: () => handleCreateFolder(path, onChanged),
  };

  return { CreateFolder };
};

export const getFolderItemActions = ($t: MessageFormatter, path: string, onChanged?: OnChanged) => {
  const Rename: ActionItem = {
    title: $t('rename'),
    icon: mdiFolderEditOutline,
    onAction: () => handleRenameFolder(path, onChanged),
  };

  const Move: ActionItem = {
    title: $t('move_to_folder'),
    icon: mdiFolderMoveOutline,
    onAction: () => handleMoveSelection({ folderPaths: [path], assetIds: [] }, undefined, onChanged),
  };

  const Delete: ActionItem = {
    title: $t('delete'),
    icon: mdiDeleteOutline,
    color: 'danger',
    onAction: () => handleDeleteSelection({ folderPaths: [path], assetIds: [] }, onChanged),
  };

  return { Rename, Move, Delete };
};

export const getFolderSelectionActions = (
  $t: MessageFormatter,
  getSelection: () => FolderSelection,
  currentPath: string,
  onChanged?: OnChanged,
) => {
  const isEmpty = () => {
    const { folderPaths, assetIds } = getSelection();
    return folderPaths.length + assetIds.length === 0;
  };

  const Move: ActionItem = {
    title: $t('move_to_folder'),
    icon: mdiFolderMoveOutline,
    $if: () => !isEmpty(),
    onAction: () => handleMoveSelection(getSelection(), currentPath, onChanged),
  };

  const Delete: ActionItem = {
    title: $t('delete_from_disk_folder'),
    icon: mdiDeleteOutline,
    color: 'danger',
    $if: () => !isEmpty(),
    onAction: () => handleDeleteSelection(getSelection(), onChanged),
  };

  return { Move, Delete };
};

export const getFolderAssetActions = (
  $t: MessageFormatter,
  asset: { id: string; originalFileName: string },
  onChanged?: OnChanged,
) => {
  const RenameFile: ActionItem = {
    title: $t('rename_file'),
    icon: mdiFileEditOutline,
    onAction: () => handleRenameFile(asset, onChanged),
  };

  return { RenameFile };
};
