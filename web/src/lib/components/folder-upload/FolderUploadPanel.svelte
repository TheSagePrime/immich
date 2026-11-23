<script lang="ts">
  import {
    FolderUploadState,
    folderUploadManager,
    isActiveState,
    type FolderUploadFilter,
    type FolderUploadItem,
    type FolderUploadManager,
  } from '#lib/managers/folder-upload-manager.svelte.ts';
  import { locale } from '#lib/stores/preferences.store.ts';
  import { getByteUnitString } from '#lib/utils/byte-units.ts';
  import { Button, Icon, IconButton, ProgressBar } from '@immich/ui';
  import { mdiClose, mdiCloseCircleOutline, mdiFolderUploadOutline, mdiRefresh, mdiWindowMinimize } from '@mdi/js';
  import { Duration } from 'luxon';
  import { t } from 'svelte-i18n';

  type Props = {
    manager?: FolderUploadManager;
    rowLimit?: number;
  };

  const { manager = folderUploadManager, rowLimit = 200 }: Props = $props();

  let filter = $state<FolderUploadFilter>('active');
  let minimized = $state(false);

  const view = $derived(manager.getItems(filter, rowLimit));
  const failedCount = $derived(manager.failedFiles);
  const progress = $derived(manager.totalBytes > 0 ? manager.sentBytes / manager.totalBytes : 0);
  const formatBytes = (bytes: number) => getByteUnitString(bytes, $locale);
  const remaining = $derived(
    manager.remainingSeconds === undefined
      ? undefined
      : Duration.fromObject({ seconds: manager.remainingSeconds })
          .shiftTo('hours', 'minutes', 'seconds')
          .toHuman({ unitDisplay: 'short', maximumFractionDigits: 0 }),
  );

  const filters: Array<{ value: FolderUploadFilter; label: string }> = $derived([
    { value: 'active', label: $t('upload_filter_active') },
    { value: 'failed', label: $t('upload_filter_failed') },
    { value: 'done', label: $t('upload_filter_done') },
  ]);

  const stateLabel = (item: FolderUploadItem) => {
    switch (item.state) {
      case FolderUploadState.Done: {
        return $t('upload_outcome_created');
      }
      case FolderUploadState.Renamed: {
        return $t('upload_outcome_renamed');
      }
      case FolderUploadState.Skipped: {
        return $t('upload_outcome_skipped');
      }
      case FolderUploadState.Failed: {
        return $t('upload_outcome_failed');
      }
      case FolderUploadState.Cancelled: {
        return $t('upload_outcome_cancelled');
      }
      default: {
        return '';
      }
    }
  };

  const stateColor = (state: FolderUploadState) => {
    switch (state) {
      case FolderUploadState.Done: {
        return 'text-success';
      }
      case FolderUploadState.Renamed:
      case FolderUploadState.Skipped: {
        return 'text-warning';
      }
      default: {
        return 'text-danger';
      }
    }
  };

  const messageLabel = (message?: string) => {
    if (message === 'checksum_mismatch') {
      return $t('errors.upload_checksum_mismatch');
    }
    if (message === 'exists') {
      return $t('errors.upload_file_exists');
    }
    return message;
  };
</script>

{#if manager.isPanelOpen || manager.unfinishedResumeCount > 0}
  <section
    class="fixed bottom-6 left-6 z-60 w-[min(30rem,calc(100vw-3rem))] rounded-xl border border-gray-200 bg-subtle p-4 text-sm shadow-md dark:border-subtle"
    aria-label={$t('upload_folder_uploads')}
    data-testid="folder-upload-panel"
  >
    <header class="flex items-start justify-between gap-2">
      <div class="flex min-w-0 flex-col gap-1">
        <h2 class="flex items-center gap-2 font-medium">
          <Icon icon={mdiFolderUploadOutline} size="20" />
          {$t('upload_folder_uploads')}
        </h2>
        {#if manager.totalFiles > 0}
          <p class="text-xs" data-testid="folder-upload-files">
            {$t('upload_files_progress', { values: { done: manager.finishedFiles, total: manager.totalFiles } })}
            ·
            {$t('upload_bytes_progress', {
              values: { sent: formatBytes(manager.sentBytes), total: formatBytes(manager.totalBytes) },
            })}
          </p>
          {#if manager.isActive && manager.speed > 0}
            <p class="text-xs" data-testid="folder-upload-speed">
              {$t('upload_speed', { values: { speed: formatBytes(manager.speed) } })}
              {#if remaining}
                · {$t('upload_time_remaining', { values: { time: remaining } })}
              {/if}
            </p>
          {/if}
        {/if}
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <IconButton
          icon={mdiWindowMinimize}
          size="small"
          variant="ghost"
          shape="round"
          color="secondary"
          aria-label={$t('minimize')}
          onclick={() => (minimized = !minimized)}
        />
        {#if !manager.isActive}
          <IconButton
            icon={mdiClose}
            size="small"
            variant="ghost"
            shape="round"
            color="secondary"
            aria-label={$t('close')}
            onclick={() => manager.close()}
          />
        {/if}
      </div>
    </header>

    {#if manager.totalFiles > 0}
      <ProgressBar class="mt-3" size="tiny" value={progress} label={$t('upload_folder_uploads')} />
    {/if}

    {#if manager.unfinishedResumeCount > 0 && !manager.isActive}
      <div class="mt-3 flex items-center justify-between gap-2 rounded-lg bg-light p-2 text-xs">
        <span>{$t('upload_resume_reselect', { values: { count: manager.unfinishedResumeCount } })}</span>
        <Button size="tiny" variant="ghost" color="secondary" onclick={() => manager.discardUnfinished()}>
          {$t('upload_discard_unfinished')}
        </Button>
      </div>
    {/if}

    {#if !minimized && manager.totalFiles > 0}
      <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div class="flex gap-1" role="tablist">
          {#each filters as option (option.value)}
            <button
              type="button"
              role="tab"
              aria-selected={filter === option.value}
              class="rounded-full px-3 py-1 text-xs {filter === option.value ? 'bg-primary text-light' : 'bg-light'}"
              onclick={() => (filter = option.value)}
            >
              {option.label}
            </button>
          {/each}
        </div>
        <div class="flex gap-1">
          {#if failedCount > 0}
            <Button size="tiny" variant="ghost" leadingIcon={mdiRefresh} onclick={() => manager.retryAllFailed()}>
              {$t('upload_retry_all_failed')}
            </Button>
          {/if}
          {#if manager.isActive}
            <Button size="tiny" variant="ghost" color="danger" onclick={() => manager.cancelAll()}>
              {$t('upload_cancel_all')}
            </Button>
          {:else}
            <Button size="tiny" variant="ghost" color="secondary" onclick={() => manager.clearFinished()}>
              {$t('upload_clear_finished')}
            </Button>
          {/if}
        </div>
      </div>

      <ul class="mt-2 flex max-h-72 flex-col gap-1 overflow-y-auto" data-testid="folder-upload-rows">
        {#each view.items as item (item.key)}
          <li class="flex items-center gap-2 rounded-lg bg-light p-2" data-testid="folder-upload-row">
            <div class="flex min-w-0 grow flex-col gap-1">
              <span class="truncate text-xs font-medium" title={item.finalRelativePath ?? item.relativePath}>
                {item.finalRelativePath ?? item.relativePath}
              </span>
              {#if isActiveState(item.state)}
                <ProgressBar
                  size="tiny"
                  value={item.size > 0 ? item.bytesSent / item.size : 0}
                  label={item.file.name}
                />
              {:else}
                <span class="text-xs {stateColor(item.state)}" data-testid="folder-upload-outcome">
                  {stateLabel(item)}{#if item.message}: {messageLabel(item.message)}{/if}
                </span>
              {/if}
            </div>
            {#if isActiveState(item.state)}
              <IconButton
                icon={mdiCloseCircleOutline}
                size="small"
                variant="ghost"
                shape="round"
                color="secondary"
                aria-label={$t('cancel')}
                onclick={() => manager.cancel(item.key)}
              />
            {:else if item.state === FolderUploadState.Failed || item.state === FolderUploadState.Cancelled}
              <IconButton
                icon={mdiRefresh}
                size="small"
                variant="ghost"
                shape="round"
                color="primary"
                aria-label={$t('upload_retry')}
                onclick={() => manager.retry(item.key)}
              />
            {/if}
          </li>
        {/each}
        {#if view.total > view.items.length}
          <li class="p-2 text-center text-xs">
            {$t('upload_more_items', { values: { count: view.total - view.items.length } })}
          </li>
        {/if}
      </ul>
    {/if}
  </section>
{/if}
