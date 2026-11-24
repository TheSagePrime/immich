<script lang="ts">
  import SettingInputField from '#lib/components/shared-components/settings/SettingInputField.svelte';
  import SettingButtonsRow from '#lib/components/shared-components/settings/SystemConfigButtonRow.svelte';
  import { SettingInputFieldType } from '#lib/constants.ts';
  import { featureFlagsManager } from '#lib/managers/feature-flags-manager.svelte.ts';
  import { createPreloadedQuery } from '#lib/queries/client.ts';
  import { getAdminConfigQuery } from '#lib/queries/config-admin.query.ts';
  import { cloneDeep } from 'lodash-es';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  const query = createPreloadedQuery(getAdminConfigQuery);
  const config = $derived(query.data);

  const disabled = $derived(featureFlagsManager.value.configFile);
  let configToEdit = $state(cloneDeep(config));
</script>

<div>
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" onsubmit={(event) => event.preventDefault()}>
      <div class="ms-4 mt-4 flex flex-col gap-4">
        <SettingInputField
          inputType={SettingInputFieldType.NUMBER}
          label={$t('admin.shared_link_default_expiry_days')}
          description={$t('admin.shared_link_default_expiry_days_description')}
          bind:value={configToEdit.sharedLink.defaultExpiryDays}
          min={0}
          required={true}
          {disabled}
          isEdited={configToEdit.sharedLink.defaultExpiryDays !== config.sharedLink.defaultExpiryDays}
        />

        <SettingButtonsRow bind:configToEdit keys={['sharedLink']} {disabled} />
      </div>
    </form>
  </div>
</div>
