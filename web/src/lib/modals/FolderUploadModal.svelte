<script lang="ts">
  import DestinationFolderPicker from '#lib/components/folder-upload/DestinationFolderPicker.svelte';
  import { folderUploadManager } from '#lib/managers/folder-upload-manager.svelte.ts';
  import { uploadManager } from '#lib/managers/upload-manager.svelte.ts';
  import { queryClient } from '#lib/queries/client.ts';
  import { getUploadLibrariesQuery } from '#lib/queries/upload-session.query.ts';
  import { locale } from '#lib/stores/preferences.store.ts';
  import { getByteUnitString } from '#lib/utils/byte-units.ts';
  import {
    UPLOAD_CHECK_BATCH_SIZE,
    chunkArray,
    filterUploadableEntries,
    joinUploadPath,
    type FolderUploadEntry,
  } from '#lib/utils/chunked-upload.ts';
  import { UploadDuplicatePolicy, checkUploadSessions } from '@immich/sdk';
  import { Button, Field, HStack, LoadingSpinner, Modal, ModalBody, ModalFooter, Select, Text } from '@immich/ui';
  import { mdiFolderUploadOutline } from '@mdi/js';
  import { createQuery } from '@tanstack/svelte-query';
  import { t } from 'svelte-i18n';

  type Props = {
    entries: FolderUploadEntry[];
    libraryId?: string;
    destination?: string;
    onClose: (started?: boolean) => void;
  };

  const { entries, libraryId: initialLibraryId, destination: initialDestination = '', onClose }: Props = $props();

  const librariesQuery = createQuery(
    () => getUploadLibrariesQuery(),
    () => queryClient,
  );
  const libraries = $derived(librariesQuery.data ?? []);

  let selectedLibraryId = $state<string | undefined>(initialLibraryId);
  const libraryId = $derived(
    libraries.some((library) => library.id === selectedLibraryId) ? selectedLibraryId : libraries[0]?.id,
  );
  let destination = $state(initialLibraryId ? initialDestination : '');
  let duplicatePolicy = $state(UploadDuplicatePolicy.Skip);
  let existingCount = $state<number>();
  let isChecking = $state(false);

  const filtered = $derived(filterUploadableEntries(entries, uploadManager.getExtensions()));
  const totalSize = $derived(filtered.accepted.reduce((sum, { file }) => sum + file.size, 0));

  const policies = $derived([
    { value: UploadDuplicatePolicy.Skip, label: $t('upload_duplicate_skip') },
    { value: UploadDuplicatePolicy.KeepBoth, label: $t('upload_duplicate_keep_both') },
    { value: UploadDuplicatePolicy.Fail, label: $t('upload_duplicate_fail') },
  ]);

  const runCheck = async (id: string, path: string, items: FolderUploadEntry[], signal: AbortSignal) => {
    isChecking = true;
    existingCount = undefined;
    let count = 0;
    try {
      const batches = chunkArray(items, UPLOAD_CHECK_BATCH_SIZE);
      for (const [batchIndex, batch] of batches.entries()) {
        const { results } = await checkUploadSessions(
          {
            uploadSessionCheckDto: {
              libraryId: id,
              items: batch.map((entry, index) => ({
                id: String(batchIndex * UPLOAD_CHECK_BATCH_SIZE + index),
                relativePath: joinUploadPath(path, entry.relativePath),
              })),
            },
          },
          { signal },
        );
        count += results.filter((result) => result.exists).length;
      }
      if (!signal.aborted) {
        existingCount = count;
      }
    } catch {
      if (!signal.aborted) {
        existingCount = undefined;
      }
    } finally {
      if (!signal.aborted) {
        isChecking = false;
      }
    }
  };

  $effect(() => {
    const id = libraryId;
    const path = destination;
    const items = filtered.accepted;
    if (!id || items.length === 0) {
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => void runCheck(id, path, items, controller.signal), 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });

  const onStart = () => {
    if (!libraryId) {
      return;
    }
    folderUploadManager.start({ libraryId, destination, duplicatePolicy, entries: filtered.accepted });
    onClose(true);
  };
</script>

<Modal title={$t('upload_folder_title')} icon={mdiFolderUploadOutline} onClose={() => onClose()} size="medium">
  <ModalBody>
    {#if librariesQuery.isPending}
      <div class="flex justify-center p-4"><LoadingSpinner /></div>
    {:else if libraries.length === 0}
      <Text>{$t('upload_folder_no_writable_library')}</Text>
    {:else}
      <div class="flex flex-col gap-4">
        <Text size="small" data-testid="folder-upload-summary">
          {$t('upload_folder_summary', {
            values: { count: filtered.accepted.length, size: getByteUnitString(totalSize, $locale) },
          })}
        </Text>
        {#if filtered.ignored.length > 0}
          <Text size="small" color="warning">
            {$t('upload_folder_ignored', { values: { count: filtered.ignored.length } })}
          </Text>
        {/if}

        {#if libraries.length > 1}
          <Field label={$t('upload_folder_library')}>
            <Select
              value={libraryId}
              options={libraries.map((library) => ({ value: library.id, label: library.name }))}
              onChange={(value: string) => {
                selectedLibraryId = value;
                destination = '';
              }}
            />
          </Field>
        {/if}

        {#if libraryId}
          <Field label={$t('upload_folder_destination')}>
            {#key libraryId}
              <DestinationFolderPicker {libraryId} bind:path={destination} />
            {/key}
          </Field>
        {/if}

        <fieldset class="flex flex-col gap-2">
          <legend class="mb-1 text-sm font-medium">{$t('upload_duplicate_policy')}</legend>
          {#each policies as policy (policy.value)}
            <label class="flex items-center gap-2 text-sm">
              <input type="radio" name="duplicate-policy" value={policy.value} bind:group={duplicatePolicy} />
              {policy.label}
            </label>
          {/each}
        </fieldset>

        <Text size="small" data-testid="folder-upload-existing">
          {#if isChecking}
            {$t('upload_checking_destination')}
          {:else if existingCount !== undefined && existingCount > 0}
            {$t('upload_already_exist_count', { values: { count: existingCount } })}
          {/if}
        </Text>
      </div>
    {/if}
  </ModalBody>

  <ModalFooter>
    <HStack fullWidth>
      <Button shape="round" color="secondary" fullWidth onclick={() => onClose()}>{$t('cancel')}</Button>
      <Button shape="round" fullWidth disabled={!libraryId || filtered.accepted.length === 0} onclick={onStart}>
        {$t('upload_folder_start')}
      </Button>
    </HStack>
  </ModalFooter>
</Modal>
