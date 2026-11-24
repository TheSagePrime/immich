<script lang="ts">
  import SharedLinkFormFields from '#lib/components/SharedLinkFormFields.svelte';
  import { executeMutation, readPreloadedQuery } from '#lib/queries/client.ts';
  import { getUserConfigQuery } from '#lib/queries/config-user.query.ts';
  import { createSharedLinkMutation } from '#lib/queries/shared-link.query.ts';
  import { showSharedLinkQrCode } from '#lib/services/shared-link.service.ts';
  import { SharedLinkType } from '@immich/sdk';
  import { FormModal } from '@immich/ui';
  import { mdiLink } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  interface Props {
    onClose: () => void;
    albumId?: string;
    assetIds?: string[];
  }

  let { onClose, albumId, assetIds }: Props = $props();

  let description = $state('');
  let allowDownload = $state(true);
  let allowUpload = $state(false);
  let showMetadata = $state(true);
  let password = $state('');
  let slug = $state('');
  const defaultExpiryDays = readPreloadedQuery(getUserConfigQuery()).sharedLink.defaultExpiryDays;
  let expiresAt = $state<string | null>(
    defaultExpiryDays > 0 ? DateTime.now().plus({ days: defaultExpiryDays }).toUTC().toISO() : null,
  );

  let type = $derived(albumId ? SharedLinkType.Album : SharedLinkType.Individual);

  const onSubmit = async () => {
    const sharedLinkCreateDto = {
      type,
      albumId,
      assetIds,
      expiresAt,
      allowUpload,
      description,
      password,
      allowDownload,
      showMetadata,
      slug,
    };
    await executeMutation(createSharedLinkMutation, [{ sharedLinkCreateDto }], {
      onSuccess: (sharedLink) => {
        onClose();
        void showSharedLinkQrCode(sharedLink);
      },
    });
  };
</script>

<FormModal
  title={$t('create_link_to_share')}
  icon={mdiLink}
  size="small"
  {onClose}
  {onSubmit}
  submitText={$t('create_link')}
>
  {#if type === SharedLinkType.Album}
    <div>{$t('album_with_link_access')}</div>
  {/if}

  {#if type === SharedLinkType.Individual}
    <div>{$t('create_link_to_share_description')}</div>
  {/if}

  <SharedLinkFormFields
    bind:slug
    bind:password
    bind:description
    bind:allowDownload
    bind:allowUpload
    bind:showMetadata
    bind:expiresAt
    defaultExpiryDays={defaultExpiryDays > 0 ? defaultExpiryDays : undefined}
  />
</FormModal>
