<script lang="ts">
  import { authManager } from '#lib/managers/auth-manager.svelte.ts';
  import FolderUploadModal from '#lib/modals/FolderUploadModal.svelte';
  import { getUploadLibrariesQuery } from '#lib/queries/upload-session.query.ts';
  import { openFolderPicker, toFolderUploadEntries } from '#lib/utils/chunked-upload.ts';
  import { Button, IconButton, modalManager } from '@immich/ui';
  import { mdiFolderUploadOutline } from '@mdi/js';
  import { createQuery } from '@tanstack/svelte-query';
  import { t } from 'svelte-i18n';

  const query = createQuery(() => ({
    ...getUploadLibrariesQuery(),
    enabled: authManager.authenticated && !authManager.isSharedLink,
  }));
  const hasWritableLibrary = $derived((query.data?.length ?? 0) > 0);

  const onClick = async () => {
    const files = await openFolderPicker();
    if (files.length === 0) {
      return;
    }
    await modalManager.show(FolderUploadModal, { entries: toFolderUploadEntries(files) });
  };
</script>

{#if hasWritableLibrary}
  <Button
    leadingIcon={mdiFolderUploadOutline}
    onclick={onClick}
    class="hidden lg:flex"
    variant="ghost"
    size="medium"
    color="secondary"
  >
    {$t('upload_folder')}
  </Button>
  <IconButton
    color="secondary"
    shape="round"
    variant="ghost"
    size="medium"
    onclick={onClick}
    title={$t('upload_folder')}
    aria-label={$t('upload_folder')}
    icon={mdiFolderUploadOutline}
    class="lg:hidden"
  />
{/if}
