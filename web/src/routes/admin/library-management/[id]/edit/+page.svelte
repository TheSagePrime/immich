<script lang="ts">
  import { createPreloadedQuery, executeMutation } from '#lib/queries/client.ts';
  import { getLibraryQuery, updateLibraryMutation } from '#lib/queries/library.query.ts';
  import { Route } from '#lib/route.ts';
  import { Field, FormModal, Input, Stack, Switch } from '@immich/ui';
  import { mdiRenameOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { goto } from '$app/navigation';
  import type { PageProps } from './$types';

  const { params }: PageProps = $props();

  const query = createPreloadedQuery(() => getLibraryQuery(params.id));
  const library = $derived(query.data);
  let name = $derived(library.name);
  let writable = $derived(library.writable);

  const onClose = () => void goto(Route.viewLibrary(library));

  const onSubmit = async () => {
    const updateLibraryDto = writable === library.writable ? { name } : { name, writable };
    await executeMutation(updateLibraryMutation, [{ id: library.id, updateLibraryDto }], {
      onSuccess: onClose,
    });
  };
</script>

<FormModal icon={mdiRenameOutline} title={$t('edit')} {onSubmit} {onClose} size="small">
  <Stack gap={4}>
    <Field label={$t('name')}>
      <Input bind:value={name} />
    </Field>
    <Field label={$t('admin.library_writable')} description={$t('admin.library_writable_description')}>
      <Switch bind:checked={writable} />
    </Field>
  </Stack>
</FormModal>
