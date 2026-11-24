<script lang="ts">
  import FolderNameModal from '#lib/modals/FolderNameModal.svelte';
  import { executeMutation, queryClient } from '#lib/queries/client.ts';
  import { createFolderMutation, getFolderBrowseQuery } from '#lib/queries/folder.query.ts';
  import { canMoveFoldersTo } from '#lib/utils/folder-utils.ts';
  import { Button, HStack, Icon, IconButton, Modal, ModalBody, ModalFooter, Text, modalManager } from '@immich/ui';
  import { mdiArrowUpLeft, mdiFolderMoveOutline, mdiFolderOutline, mdiFolderPlusOutline } from '@mdi/js';
  import { createQuery } from '@tanstack/svelte-query';
  import { t } from 'svelte-i18n';

  type Props = {
    title?: string;
    folderPaths?: string[];
    initialPath?: string;
    onClose: (destination?: string) => void;
  };

  const { title, folderPaths = [], initialPath, onClose }: Props = $props();

  let path = $state<string | undefined>(initialPath);

  const query = createQuery(
    () => getFolderBrowseQuery(path),
    () => queryClient,
  );
  const result = $derived(query.data);
  const canConfirm = $derived(!!result?.path && canMoveFoldersTo(result.path, folderPaths));
  const isSource = (entryPath: string) => !canMoveFoldersTo(entryPath, folderPaths);

  const goUp = () => {
    path = result?.parentPath ?? undefined;
  };

  const handleCreate = async () => {
    const parentPath = result?.path;
    if (!parentPath) {
      return;
    }

    const name = await modalManager.show(FolderNameModal, {
      title: $t('new_folder'),
      submitText: $t('create'),
    });
    if (!name) {
      return;
    }

    const created = await executeMutation(createFolderMutation, [{ folderCreateDto: { parentPath, name } }]);
    if (created) {
      path = created.path;
    }
  };
</script>

<Modal title={title ?? $t('choose_destination_folder')} icon={mdiFolderMoveOutline} {onClose} size="small">
  <ModalBody>
    <HStack class="mb-2" gap={2}>
      <IconButton
        shape="round"
        color="secondary"
        variant="ghost"
        icon={mdiArrowUpLeft}
        aria-label={$t('to_parent')}
        disabled={!result?.path}
        onclick={goUp}
      />
      <Text class="truncate" size="small" data-testid="folder-picker-path">
        {result?.path ?? $t('writable_library_folders')}
      </Text>
    </HStack>

    {#if query.isPending}
      <Text size="small" class="px-4 py-2">{$t('loading')}</Text>
    {:else if result && result.entries.length === 0}
      <Text size="small" class="px-4 py-2">{$t('empty_folder')}</Text>
    {:else if result}
      <ul class="flex max-h-80 immich-scrollbar flex-col overflow-y-auto">
        {#each result.entries as entry (entry.path)}
          <li>
            <button
              type="button"
              class="flex w-full items-center gap-3 rounded-lg px-4 py-2 text-start hover:bg-immich-primary/10 disabled:opacity-50 dark:hover:bg-immich-primary/40"
              disabled={isSource(entry.path)}
              title={entry.path}
              onclick={() => (path = entry.path)}
            >
              <Icon icon={mdiFolderOutline} class="shrink-0 text-primary" size="1.5rem" />
              <span class="truncate">{entry.name}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </ModalBody>
  <ModalFooter>
    <HStack fullWidth gap={2}>
      <Button
        shape="round"
        color="secondary"
        variant="ghost"
        leadingIcon={mdiFolderPlusOutline}
        disabled={!result?.path}
        onclick={handleCreate}
      >
        {$t('new_folder')}
      </Button>
      <Button shape="round" color="secondary" onclick={() => onClose()}>{$t('cancel')}</Button>
      <Button shape="round" disabled={!canConfirm} onclick={() => onClose(result?.path ?? undefined)}>
        {$t('move_here')}
      </Button>
    </HStack>
  </ModalFooter>
</Modal>
