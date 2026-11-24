<script lang="ts">
  import { isValidFolderEntryName } from '#lib/utils/folder-utils.ts';
  import { Field, FormModal, HelperText, Input, Text } from '@immich/ui';
  import { mdiFolderEditOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    title: string;
    submitText: string;
    initialName?: string;
    extension?: string;
    description?: string;
    onClose: (name?: string) => void;
  };

  const { title, submitText, initialName = '', extension = '', description, onClose }: Props = $props();

  let value = $state(initialName);
  const name = $derived(value.trim() + extension);
  const valid = $derived(isValidFolderEntryName(name) && value.trim().length > 0);
  const changed = $derived(name !== initialName + extension);

  const onSubmit = () => {
    if (valid && changed) {
      onClose(name);
    }
  };
</script>

<FormModal
  {title}
  icon={mdiFolderEditOutline}
  size="small"
  {submitText}
  disabled={!valid || !changed}
  onClose={() => onClose()}
  {onSubmit}
>
  {#if description}
    <Text size="small" class="mb-4">{description}</Text>
  {/if}
  <Field label={$t('name')}>
    <div class="flex items-center gap-2">
      <Input bind:value class="grow" />
      {#if extension}
        <Text class="shrink-0" data-testid="folder-name-extension">{extension}</Text>
      {/if}
    </div>
    {#if value.trim().length > 0 && !valid}
      <HelperText color="danger">{$t('invalid_folder_name')}</HelperText>
    {/if}
  </Field>
</FormModal>
