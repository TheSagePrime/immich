import { folderUploadManager } from '#lib/managers/folder-upload-manager.svelte.ts';
import type { UploadDropTarget } from '#lib/managers/upload-drop-target-manager.svelte.ts';
import { uploadManager } from '#lib/managers/upload-manager.svelte.ts';
import FolderDeleteConfirmModal from '#lib/modals/FolderDeleteConfirmModal.svelte';
import FolderNameModal from '#lib/modals/FolderNameModal.svelte';
import FolderPickerModal from '#lib/modals/FolderPickerModal.svelte';
import FolderUploadModal from '#lib/modals/FolderUploadModal.svelte';
import { executeMutation, queryClient } from '#lib/queries/client.ts';
import {
  createFolderMutation,
  deleteFolderItemsMutation,
  moveFolderItemsMutation,
  renameFolderAssetMutation,
  renameFolderMutation,
} from '#lib/queries/folder.query.ts';
import { getFolderSummaryQuery } from '#lib/queries/view.query.ts';
import { handleDownloadAsset } from '#lib/services/asset.service.ts';
import { downloadArchive } from '#lib/utils/asset-utils.ts';
import {
  filterUploadableEntries,
  isHiddenPath,
  openFolderPicker,
  toFolderUploadEntries,
  type FolderUploadEntry,
} from '#lib/utils/chunked-upload.ts';
import type { FolderCard } from '#lib/utils/folder-cards.ts';
import { findLibraryRootPath, getFolderName, getRelativeFolderPath, splitFileName } from '#lib/utils/folder-utils.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import { UploadDuplicatePolicy, type AssetResponseDto, type FolderBulkFailureDto } from '@immich/sdk';
import { modalManager, toastManager, type ActionItem } from '@immich/ui';
import {
  mdiDeleteOutline,
  mdiDownload,
  mdiFileEditOutline,
  mdiFolderEditOutline,
  mdiFolderMoveOutline,
  mdiFolderOpenOutline,
  mdiFolderPlusOutline,
  mdiFolderUploadOutline,
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

  return handleMoveSelectionTo(selection, destination, onChanged);
};

export const handleMoveSelectionTo = async (selection: FolderSelection, destination: string, onChanged?: OnChanged) => {
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

export const handleUploadIntoFolder = async (path: string, libraryId?: string) => {
  const files = await openFolderPicker();
  if (files.length === 0) {
    return;
  }

  const root = await findLibraryRootPath(path, (folder) => queryClient.fetchQuery(getFolderSummaryQuery(folder))).catch(
    () => undefined,
  );
  const destination = root ? getRelativeFolderPath(root, path) : '';

  await modalManager.show(FolderUploadModal, { entries: toFolderUploadEntries(files), libraryId, destination });
};

const resolveUploadDropTarget = async ({ libraryId, folderPath, destination = '', writable }: UploadDropTarget) => {
  if (!writable) {
    return;
  }

  if (!folderPath) {
    return libraryId ? { libraryId, destination } : undefined;
  }

  const getSummary = (path: string) => queryClient.fetchQuery(getFolderSummaryQuery(path));
  const root = await findLibraryRootPath(folderPath, getSummary).catch(() => undefined);
  if (!root) {
    return;
  }

  const rootSummary = libraryId ? undefined : await getSummary(root).catch(() => undefined);
  const rootLibraryId = libraryId ?? rootSummary?.libraryId;
  return rootLibraryId ? { libraryId: rootLibraryId, destination: getRelativeFolderPath(root, folderPath) } : undefined;
};

export const handleUploadDrop = async (target: UploadDropTarget, entries: FolderUploadEntry[]) => {
  const $t = await getFormatter();
  const resolved = await resolveUploadDropTarget(target);
  if (!resolved) {
    toastManager.warning($t('upload_target_read_only', { values: { name: target.label } }));
    return 0;
  }

  const { accepted, ignored } = filterUploadableEntries(entries, uploadManager.getExtensions());
  const unsupported = ignored.filter((entry) => !isHiddenPath(entry.relativePath));
  if (unsupported.length > 0) {
    toastManager.warning($t('upload_folder_ignored', { values: { count: unsupported.length } }));
  }

  return folderUploadManager.start({
    ...resolved,
    duplicatePolicy: UploadDuplicatePolicy.Skip,
    entries: accepted,
    targetLabel: target.label,
  });
};

export const getFolderActions = ($t: MessageFormatter, path: string, onChanged?: OnChanged, libraryId?: string) => {
  const CreateFolder: ActionItem = {
    title: $t('new_folder'),
    icon: mdiFolderPlusOutline,
    onAction: () => handleCreateFolder(path, onChanged),
  };

  const UploadFolder: ActionItem = {
    title: $t('upload_folder_here'),
    icon: mdiFolderUploadOutline,
    onAction: () => handleUploadIntoFolder(path, libraryId),
  };

  return { CreateFolder, UploadFolder };
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

export type FolderMenuItem = {
  id: string;
  title: string;
  icon: string;
  color?: 'danger';
  disabled?: boolean;
  hint?: string;
  onAction: () => unknown;
};

type FolderMenuContext = {
  writable: boolean;
  onOpen: () => unknown;
  onChanged?: OnChanged;
  libraryId?: string;
  selection: FolderSelection;
};

const guardWrite = ($t: MessageFormatter, writable: boolean, item: FolderMenuItem): FolderMenuItem =>
  writable ? item : { ...item, disabled: true, hint: $t('read_only_library') };

export const handleDownloadFolder = (name: string, folderPath: string) =>
  downloadArchive(`${name}.zip`, { folderPath });

export const getFolderCardMenuItems = (
  $t: MessageFormatter,
  card: FolderCard,
  { writable, onOpen, onChanged, libraryId, selection }: FolderMenuContext,
): FolderMenuItem[] => {
  const path = card.folderPath;
  const canWrite = writable && card.writable && !!path;
  const items: FolderMenuItem[] = [{ id: 'open', title: $t('open'), icon: mdiFolderOpenOutline, onAction: onOpen }];

  items.push(
    guardWrite($t, canWrite, {
      id: 'new-folder',
      title: $t('new_folder'),
      icon: mdiFolderPlusOutline,
      onAction: () => path && handleCreateFolder(path, onChanged),
    }),
  );

  if (card.kind === 'folder' && path) {
    items.push(
      guardWrite($t, canWrite, {
        id: 'rename',
        title: $t('rename'),
        icon: mdiFolderEditOutline,
        onAction: () => handleRenameFolder(path, onChanged),
      }),
      guardWrite($t, canWrite, {
        id: 'move',
        title: $t('move_to_folder'),
        icon: mdiFolderMoveOutline,
        onAction: () => handleMoveSelection(selection, undefined, onChanged),
      }),
      guardWrite($t, canWrite, {
        id: 'delete',
        title: $t('delete'),
        icon: mdiDeleteOutline,
        color: 'danger',
        onAction: () => handleDeleteSelection(selection, onChanged),
      }),
    );
  }

  items.push(
    guardWrite($t, canWrite, {
      id: 'upload',
      title: $t('upload_folder_here'),
      icon: mdiFolderUploadOutline,
      onAction: () => path && handleUploadIntoFolder(path, libraryId),
    }),
  );

  if (path) {
    items.push({
      id: 'download',
      title: $t('download'),
      icon: mdiDownload,
      onAction: () => handleDownloadFolder(card.label, path),
    });
  }

  return items;
};

export const getFolderAssetMenuItems = (
  $t: MessageFormatter,
  asset: AssetResponseDto,
  { writable, onOpen, onChanged, libraryId, selection, currentPath }: FolderMenuContext & { currentPath?: string },
): FolderMenuItem[] => [
  { id: 'open', title: $t('open'), icon: mdiFolderOpenOutline, onAction: onOpen },
  guardWrite($t, writable && !!currentPath, {
    id: 'new-folder',
    title: $t('new_folder'),
    icon: mdiFolderPlusOutline,
    onAction: () => currentPath && handleCreateFolder(currentPath, onChanged),
  }),
  guardWrite($t, writable, {
    id: 'rename',
    title: $t('rename'),
    icon: mdiFileEditOutline,
    onAction: () => handleRenameFile(asset, onChanged),
  }),
  guardWrite($t, writable, {
    id: 'move',
    title: $t('move_to_folder'),
    icon: mdiFolderMoveOutline,
    onAction: () => handleMoveSelection(selection, currentPath, onChanged),
  }),
  guardWrite($t, writable, {
    id: 'delete',
    title: $t('delete'),
    icon: mdiDeleteOutline,
    color: 'danger',
    onAction: () => handleDeleteSelection(selection, onChanged),
  }),
  guardWrite($t, writable && !!currentPath, {
    id: 'upload',
    title: $t('upload_folder_here'),
    icon: mdiFolderUploadOutline,
    onAction: () => currentPath && handleUploadIntoFolder(currentPath, libraryId),
  }),
  {
    id: 'download',
    title: $t('download'),
    icon: mdiDownload,
    onAction: () => handleDownloadAsset(asset, { edited: false }),
  },
];
