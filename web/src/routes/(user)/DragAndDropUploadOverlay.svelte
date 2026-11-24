<script lang="ts">
  import { shouldIgnoreEvent } from '#lib/actions/shortcut.ts';
  import { authManager } from '#lib/managers/auth-manager.svelte.ts';
  import {
    uploadDropTargetManager,
    type UploadDropTarget,
    type UploadDropTargetMatch,
  } from '#lib/managers/upload-drop-target-manager.svelte.ts';
  import { getAlbumInfoQuery } from '#lib/queries/album.query.ts';
  import { queryClient } from '#lib/queries/client.ts';
  import { getUploadLibrariesQuery } from '#lib/queries/upload-session.query.ts';
  import { handleUploadDrop } from '#lib/services/folder.service.ts';
  import { dragAndDropFilesStore } from '#lib/stores/drag-and-drop-files.store.ts';
  import { getEntryRelativePath, type FolderUploadEntry } from '#lib/utils/chunked-upload.ts';
  import { fileUploadHandler } from '#lib/utils/file-uploader.ts';
  import { isAlbumsRoute, isLockedFolderRoute } from '#lib/utils/navigation.ts';
  import { getUploadAlbumId } from '#lib/utils/upload-album.ts';
  import type { UploadLibraryResponseDto } from '@immich/sdk';
  import { Icon, Logo, toastManager } from '@immich/ui';
  import { mdiFolderLockOutline, mdiFolderUploadOutline } from '@mdi/js';
  import { createQuery } from '@tanstack/svelte-query';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';
  import { page } from '$app/state';

  const routeAlbumId = $derived(isAlbumsRoute(page.route?.id) ? page.params.albumId : undefined);
  let albumId = $derived(
    getUploadAlbumId(
      routeAlbumId,
      routeAlbumId ? queryClient.getQueryData(getAlbumInfoQuery(routeAlbumId).queryKey) : undefined,
    ),
  );
  let isInLockedFolder = $derived(isLockedFolderRoute(page.route.id));

  const uploadLibrariesQuery = createQuery(() => ({
    ...getUploadLibrariesQuery(),
    enabled: authManager.authenticated && !authManager.isSharedLink,
  }));
  const canUploadIntoLibraries = $derived(!albumId && !isInLockedFolder && !authManager.isSharedLink);

  const toLibraryTarget = (library?: UploadLibraryResponseDto): UploadDropTarget | undefined =>
    library && { label: library.name, writable: true, libraryId: library.id, destination: '' };

  const libraryTarget = $derived(toLibraryTarget(uploadLibrariesQuery.data?.[0]));

  let dragStartTarget: EventTarget | null = $state(null);
  let dropMatch = $state<UploadDropTargetMatch>();
  let isInternalDrag = false;

  const findDropMatch = (element: EventTarget | null) =>
    canUploadIntoLibraries
      ? uploadDropTargetManager.find(element instanceof Element ? element : null, libraryTarget)
      : undefined;

  const updateDropMatch = (match?: UploadDropTargetMatch) => {
    dropMatch = match;
    uploadDropTargetManager.hover(match);
  };

  const getMatchKey = (match?: UploadDropTargetMatch) =>
    match && `${match.cardPath ?? ''}|${match.target.label}|${match.target.writable}`;

  const isFileDrag = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');

  const onDragEnter = (e: DragEvent) => {
    if (isFileDrag(e)) {
      dragStartTarget = e.target;
      updateDropMatch(findDropMatch(e.target));
    }
  };

  const onDragLeave = (e: DragEvent) => {
    if (dragStartTarget === e.target) {
      dragStartTarget = null;
      updateDropMatch();
    }
  };

  const onDrop = async (e: DragEvent) => {
    const match = findDropMatch(e.target);
    dragStartTarget = null;
    updateDropMatch();

    if (match && !match.target.writable) {
      toastManager.warning($t('upload_target_read_only', { values: { name: match.target.label } }));
      return;
    }

    await handleDataTransfer(e.dataTransfer, match?.target);
  };

  const onPaste = (event: ClipboardEvent) => {
    if (shouldIgnoreEvent(event)) {
      return;
    }

    const match = findDropMatch(null);
    if (match && !match.target.writable) {
      toastManager.warning($t('upload_target_read_only', { values: { name: match.target.label } }));
      return;
    }

    return handleDataTransfer(event.clipboardData, match?.target);
  };

  const fetchLibraryTarget = async () => {
    try {
      const libraries = await queryClient.fetchQuery(getUploadLibrariesQuery());
      return toLibraryTarget(libraries[0]);
    } catch {
      return;
    }
  };

  const resolveTarget = async (target?: UploadDropTarget) =>
    target ?? (canUploadIntoLibraries ? await fetchLibraryTarget() : undefined);

  const handleDataTransfer = async (dataTransfer?: DataTransfer | null, dropTarget?: UploadDropTarget) => {
    if (!dataTransfer) {
      return;
    }

    if (!browserSupportsDirectoryUpload()) {
      const plainFiles = Array.from(dataTransfer.files);
      const target = await resolveTarget(dropTarget);
      if (target) {
        await handleUploadDrop(
          target,
          plainFiles.map((file) => ({ file, relativePath: file.name })),
        );
        return;
      }
      return handleFiles(plainFiles);
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
    const target = await resolveTarget(dropTarget);
    if (target) {
      await handleUploadDrop(target, [
        ...files.map((file) => ({ file, relativePath: file.name })),
        ...directoryEntries,
      ]);
      return;
    }

    return handleFiles([...files, ...directoryEntries.map(({ file }) => file)]);
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

  const ondragover = (e: DragEvent) => {
    if (isInternalDrag || !isFileDrag(e)) {
      return;
    }

    e.preventDefault();
    const match = findDropMatch(e.target);
    if (getMatchKey(match) !== getMatchKey(dropMatch)) {
      updateDropMatch(match);
    }
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = match && !match.target.writable ? 'none' : 'copy';
    }
  };

  const isReadOnly = $derived(!!dropMatch && !dropMatch.target.writable);
</script>

<svelte:window onpaste={onPaste} />

<svelte:body {ondragstart} {ondragend} {ondragenter} {ondragleave} {ondragover} {ondrop} />

{#if dragStartTarget}
  <div
    class="pointer-events-none fixed inset-0 z-9999 flex size-full flex-col items-center p-4 text-immich-dark-gray dark:text-immich-gray"
    transition:fade={{ duration: 150 }}
    data-testid="drop-overlay"
    data-read-only={isReadOnly || undefined}
  >
    <div
      class="flex size-full flex-col items-center justify-end rounded-3xl border-4 border-dashed p-6 {isReadOnly
        ? 'border-danger bg-danger/5'
        : 'border-primary bg-primary/5'}"
    >
      <div
        class="flex max-w-full items-center gap-3 rounded-2xl bg-light px-6 py-4 text-center text-xl font-medium shadow-lg md:text-2xl {isReadOnly
          ? 'text-danger'
          : 'text-primary'}"
        role="status"
        data-testid="drop-overlay-message"
        data-target={dropMatch?.target.label}
      >
        {#if dropMatch && isReadOnly}
          <Icon icon={mdiFolderLockOutline} size="32" />
          <span class="min-w-0 wrap-break-word">
            {$t('upload_target_read_only', { values: { name: dropMatch.target.label } })}
          </span>
        {:else if dropMatch}
          <Icon icon={mdiFolderUploadOutline} size="32" />
          <span class="min-w-0 wrap-break-word">
            {$t('drop_to_upload_to', { values: { name: dropMatch.target.label } })}
          </span>
        {:else}
          <Logo variant="icon" size="medium" />
          {$t('drop_files_to_upload')}
        {/if}
      </div>
    </div>
  </div>
{/if}
