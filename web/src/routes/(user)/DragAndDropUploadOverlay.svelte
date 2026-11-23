<script lang="ts">
  import { shouldIgnoreEvent } from '#lib/actions/shortcut.ts';
  import { authManager } from '#lib/managers/auth-manager.svelte.ts';
  import FolderUploadModal from '#lib/modals/FolderUploadModal.svelte';
  import { queryClient } from '#lib/queries/client.ts';
  import { getUploadLibrariesQuery } from '#lib/queries/upload-session.query.ts';
  import { dragAndDropFilesStore } from '#lib/stores/drag-and-drop-files.store.ts';
  import { getEntryRelativePath, type FolderUploadEntry } from '#lib/utils/chunked-upload.ts';
  import { fileUploadHandler } from '#lib/utils/file-uploader.ts';
  import { isAlbumsRoute, isLockedFolderRoute } from '#lib/utils/navigation.ts';
  import { Icon, Logo, modalManager } from '@immich/ui';
  import { mdiFolderUploadOutline } from '@mdi/js';
  import { createQuery } from '@tanstack/svelte-query';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';
  import { page } from '$app/state';

  let albumId = $derived(isAlbumsRoute(page.route?.id) ? page.params.albumId : undefined);
  let isInLockedFolder = $derived(isLockedFolderRoute(page.route.id));

  const uploadLibrariesQuery = createQuery(() => ({
    ...getUploadLibrariesQuery(),
    enabled: authManager.authenticated && !authManager.isSharedLink,
  }));
  const canUploadFolders = $derived((uploadLibrariesQuery.data?.length ?? 0) > 0);

  let dragStartTarget: EventTarget | null = $state(null);
  let isInternalDrag = false;

  const onDragEnter = (e: DragEvent) => {
    if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
      dragStartTarget = e.target;
    }
  };

  const onDragLeave = (e: DragEvent) => {
    if (dragStartTarget === e.target) {
      dragStartTarget = null;
    }
  };

  const onDrop = async (e: DragEvent) => {
    dragStartTarget = null;
    await handleDataTransfer(e.dataTransfer);
  };

  const onPaste = (event: ClipboardEvent) => {
    if (shouldIgnoreEvent(event)) {
      return;
    }

    return handleDataTransfer(event.clipboardData);
  };

  const handleDataTransfer = async (dataTransfer?: DataTransfer | null) => {
    if (!dataTransfer) {
      return;
    }

    if (!browserSupportsDirectoryUpload()) {
      return handleFiles(dataTransfer.files);
    }

    const entries: FileSystemEntry[] = [];
    const files: File[] = [];
    for (const item of dataTransfer.items) {
      const entry = item.webkitGetAsEntry();
      if (entry) {
        entries.push(entry);
        continue;
      }

      const file = item.getAsFile();
      if (file) {
        files.push(file);
      }
    }

    const directoryEntries = await getAllFilesFromTransferEntries(entries);
    const hasDirectory = entries.some((entry) => entry.isDirectory);
    if (hasDirectory && (await hasWritableLibrary())) {
      const folderEntries = [...files.map((file) => ({ file, relativePath: file.name })), ...directoryEntries];
      await modalManager.show(FolderUploadModal, { entries: folderEntries });
      return;
    }

    return handleFiles([...files, ...directoryEntries.map(({ file }) => file)]);
  };

  const hasWritableLibrary = async () => {
    if (authManager.isSharedLink) {
      return false;
    }

    try {
      const libraries = await queryClient.fetchQuery(getUploadLibrariesQuery());
      return libraries.length > 0;
    } catch {
      return false;
    }
  };

  const browserSupportsDirectoryUpload = () => typeof DataTransferItem.prototype.webkitGetAsEntry === 'function';

  const getAllFilesFromTransferEntries = async (transferEntries: FileSystemEntry[]): Promise<FolderUploadEntry[]> => {
    const allFiles: FolderUploadEntry[] = [];
    let entriesToCheckForSubDirectories = [...transferEntries];
    while (entriesToCheckForSubDirectories.length > 0) {
      const currentEntry = entriesToCheckForSubDirectories.pop();

      if (isFileSystemDirectoryEntry(currentEntry)) {
        entriesToCheckForSubDirectories = entriesToCheckForSubDirectories.concat(
          await getContentsFromFileSystemDirectoryEntry(currentEntry),
        );
      } else if (isFileSystemFileEntry(currentEntry)) {
        const file = await getFileFromFileSystemEntry(currentEntry);
        allFiles.push({ file, relativePath: getEntryRelativePath(file, currentEntry.fullPath) });
      }
    }

    return allFiles;
  };

  const isFileSystemDirectoryEntry = (entry?: FileSystemEntry): entry is FileSystemDirectoryEntry =>
    !!entry && entry.isDirectory;
  const isFileSystemFileEntry = (entry?: FileSystemEntry): entry is FileSystemFileEntry => !!entry && entry.isFile;

  const getFileFromFileSystemEntry = async (fileSystemFileEntry: FileSystemFileEntry): Promise<File> => {
    return new Promise((resolve, reject) => {
      fileSystemFileEntry.file(resolve, reject);
    });
  };

  const readEntriesAsync = (reader: FileSystemDirectoryReader) => {
    return new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
  };

  const getContentsFromFileSystemDirectoryEntry = async (
    fileSystemDirectoryEntry: FileSystemDirectoryEntry,
  ): Promise<FileSystemEntry[]> => {
    const reader = fileSystemDirectoryEntry.createReader();
    const files: FileSystemEntry[] = [];
    let entries: FileSystemEntry[];

    do {
      entries = await readEntriesAsync(reader);
      files.push(...entries);
    } while (entries.length > 0);

    return files;
  };

  const handleFiles = async (files?: FileList | File[]) => {
    if (!files) {
      return;
    }

    const filesArray: File[] = Array.from<File>(files);
    if (authManager.isSharedLink) {
      dragAndDropFilesStore.set({ isDragging: true, files: filesArray });
    } else {
      await fileUploadHandler({ files: filesArray, albumId, isLockedAssets: isInLockedFolder });
    }
  };

  const ondragstart = () => {
    isInternalDrag = true;
  };

  const ondragend = () => {
    isInternalDrag = false;
  };

  const ondragenter = (e: DragEvent) => {
    if (isInternalDrag) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    onDragEnter(e);
  };

  const ondragleave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onDragLeave(e);
  };

  const ondrop = async (e: DragEvent) => {
    if (isInternalDrag) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    await onDrop(e);
  };

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
</script>

<svelte:window onpaste={onPaste} />

<svelte:body {ondragstart} {ondragend} {ondragenter} {ondragleave} {ondrop} />

{#if dragStartTarget}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-9999 flex size-full flex-col items-center justify-center bg-gray-100/95 p-6 text-immich-dark-gray dark:bg-immich-dark-bg/95 dark:text-immich-gray"
    transition:fade={{ duration: 150 }}
    ondragover={onDragOver}
    data-testid="drop-overlay"
  >
    <div
      class="pointer-events-none flex size-full flex-col items-center justify-center gap-6 rounded-3xl border-4 border-dashed border-primary bg-primary/5"
    >
      <Logo variant="icon" size="giant" class="animate-bounce" />
      <div class="flex items-center gap-3 text-center text-3xl font-medium text-primary">
        {#if canUploadFolders}
          <Icon icon={mdiFolderUploadOutline} size="40" />
          {$t('drop_files_or_folders_to_upload')}
        {:else}
          {$t('drop_files_to_upload')}
        {/if}
      </div>
    </div>
  </div>
{/if}
