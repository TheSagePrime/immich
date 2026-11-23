<script lang="ts">
  import { queryClient } from '#lib/queries/client.ts';
  import { getUploadDirectoriesQuery } from '#lib/queries/upload-session.query.ts';
  import { isValidFolderName, joinUploadPath } from '#lib/utils/chunked-upload.ts';
  import { Button, HelperText, Icon, Input, LoadingSpinner } from '@immich/ui';
  import { mdiChevronRight, mdiFolderOutline, mdiFolderPlusOutline, mdiHome } from '@mdi/js';
  import { createQuery } from '@tanstack/svelte-query';
  import { t } from 'svelte-i18n';

  type Props = {
    libraryId: string;
    path?: string;
  };

  let { libraryId, path = $bindable('') }: Props = $props();

  let newFolder = $state('');
  const segments = $derived(path === '' ? [] : path.split('/'));
  const query = createQuery(
    () => getUploadDirectoriesQuery(libraryId, path),
    () => queryClient,
  );
  const directories = $derived(query.data?.directories ?? []);
  const isNewFolderValid = $derived(isValidFolderName(newFolder));

  const openSegment = (index: number) => {
    path = segments.slice(0, index + 1).join('/');
  };

  const addFolder = () => {
    if (!isNewFolderValid) {
      return;
    }
    path = joinUploadPath(path, newFolder);
    newFolder = '';
  };
</script>

<div class="flex flex-col gap-2" data-testid="destination-folder-picker">
  <nav class="flex flex-wrap items-center gap-1 text-sm" aria-label={$t('upload_folder_destination')}>
    <button type="button" class="flex items-center gap-1 rounded-sm px-1 hover:bg-light" onclick={() => (path = '')}>
      <Icon icon={mdiHome} size="16" />
      {$t('upload_folder_root')}
    </button>
    {#each segments as segment, index (index)}
      <Icon icon={mdiChevronRight} size="16" />
      <button type="button" class="rounded-sm px-1 hover:bg-light" onclick={() => openSegment(index)}>{segment}</button>
    {/each}
  </nav>

  <ul class="flex max-h-48 min-h-16 flex-col overflow-y-auto rounded-lg border border-gray-200 p-1 dark:border-subtle">
    {#if query.isPending}
      <li class="flex justify-center p-2"><LoadingSpinner /></li>
    {:else if directories.length === 0}
      <li class="p-2 text-sm text-gray-500">{$t('upload_folder_empty')}</li>
    {:else}
      {#each directories as directory (directory)}
        <li>
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-start text-sm hover:bg-light"
            onclick={() => (path = joinUploadPath(path, directory))}
          >
            <Icon icon={mdiFolderOutline} size="18" />
            <span class="truncate">{directory}</span>
          </button>
        </li>
      {/each}
    {/if}
  </ul>

  <div class="flex items-start gap-2">
    <div class="grow">
      <Input
        bind:value={newFolder}
        placeholder={$t('upload_folder_new_subfolder')}
        aria-label={$t('upload_folder_new_subfolder')}
        size="small"
        onkeydown={(event: KeyboardEvent) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            addFolder();
          }
        }}
      />
      {#if newFolder !== '' && !isNewFolderValid}
        <HelperText color="danger">{$t('upload_folder_invalid_name')}</HelperText>
      {/if}
    </div>
    <Button
      size="small"
      variant="ghost"
      leadingIcon={mdiFolderPlusOutline}
      disabled={!isNewFolderValid}
      onclick={addFolder}
    >
      {$t('upload_folder_add_subfolder')}
    </Button>
  </div>
</div>
