<script lang="ts">
  import { Alert, ConfirmModal, Field, Switch, Text } from '@immich/ui';
  import { mdiDeleteOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    folderCount: number;
    assetCount: number;
    onClose: (force?: boolean) => void;
  };

  const { folderCount, assetCount, onClose }: Props = $props();

  let force = $state(false);
</script>

<ConfirmModal
  title={$t('delete_from_disk_folder')}
  confirmText={force ? $t('delete_permanently') : $t('delete')}
  confirmColor="danger"
  icon={mdiDeleteOutline}
  onClose={(confirmed) => onClose(confirmed ? force : undefined)}
>
  {#snippet prompt()}
    <div class="flex flex-col gap-4">
      <Text>{$t('delete_folders_confirmation', { values: { folders: folderCount, files: assetCount } })}</Text>
      <Field label={$t('delete_permanently')}>
        <Switch bind:checked={force} />
      </Field>
      {#if force}
        <Alert color="danger" title={$t('delete_folder_permanent_description')} />
      {:else}
        <Text size="small">{$t('delete_folder_trash_description')}</Text>
        <Alert color="warning" title={$t('empty_trash_deletes_files_warning')} />
      {/if}
    </div>
  {/snippet}
</ConfirmModal>
