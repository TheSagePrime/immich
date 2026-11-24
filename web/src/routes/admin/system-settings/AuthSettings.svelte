<script lang="ts">
  import SettingAccordion from '#lib/components/shared-components/settings/SettingAccordion.svelte';
  import SettingInputField from '#lib/components/shared-components/settings/SettingInputField.svelte';
  import SettingSwitch from '#lib/components/shared-components/settings/SettingSwitch.svelte';
  import SettingButtonsRow from '#lib/components/shared-components/settings/SystemConfigButtonRow.svelte';
  import { SettingInputFieldType } from '#lib/constants.ts';
  import FormatMessage from '#lib/elements/FormatMessage.svelte';
  import { featureFlagsManager } from '#lib/managers/feature-flags-manager.svelte.ts';
  import AuthDisableLoginConfirmModal from '#lib/modals/AuthDisableLoginConfirmModal.svelte';
  import { createPreloadedQuery } from '#lib/queries/client.ts';
  import { getAdminConfigQuery } from '#lib/queries/config-admin.query.ts';
  import { handleError } from '#lib/utils/handle-error.ts';
  import { OAuthTokenEndpointAuthMethod, unlinkAllOAuthAccountsAdmin } from '@immich/sdk';
  import { Button, Link, Text, modalManager, toastManager } from '@immich/ui';
  import { mdiRestart } from '@mdi/js';
  import { cloneDeep } from 'lodash-es';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';
  import SettingSelect from './SettingSelect.svelte';

  const query = createPreloadedQuery(getAdminConfigQuery);
  const config = $derived(query.data);

  const disabled = $derived(featureFlagsManager.value.configFile);
  let configToEdit = $state(cloneDeep(config));

  const handleToggleOverride = () => {
    // click runs before bind
    const previouslyEnabled = configToEdit.oauth.mobileOverrideEnabled;
    if (!previouslyEnabled && !configToEdit.oauth.mobileRedirectUri) {
      configToEdit.oauth.mobileRedirectUri = location.origin + '/api/oauth/mobile-redirect';
    }
  };

  const onBeforeSave = async () => {
    const allMethodsDisabled =
      !configToEdit.oauth.enabled && !configToEdit.passkey.enabled && !configToEdit.passwordLogin.enabled;

    if (allMethodsDisabled) {
      const confirmed = await modalManager.show(AuthDisableLoginConfirmModal);
      if (!confirmed) {
        return false;
      }
    }

    return true;
  };

  const handleUnlinkAllOAuthAccounts = async () => {
    const confirmed = await modalManager.showDialog({
      icon: mdiRestart,
      title: $t('admin.unlink_all_oauth_accounts'),
      prompt: $t('admin.unlink_all_oauth_accounts_prompt'),
      confirmColor: 'danger',
    });

    if (!confirmed) {
      return;
    }

    try {
      await unlinkAllOAuthAccountsAdmin();
      toastManager.primary();
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    }
  };
</script>

<div>
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" onsubmit={(e) => e.preventDefault()}>
      <div class="ms-4 mt-4 flex flex-col">
        <SettingAccordion
          key="oauth"
          title={$t('admin.oauth_settings')}
          subtitle={$t('admin.oauth_settings_description')}
        >
          <div class="ms-4 mt-4 flex flex-col gap-4">
            <Text size="small">
              <FormatMessage key="admin.oauth_settings_more_details">
                {#snippet children({ message })}
                  <Link href="https://docs.immich.app/administration/oauth">{message}</Link>
                {/snippet}
              </FormatMessage>
            </Text>

            <SettingSwitch
              {disabled}
              title={$t('admin.oauth_enable_description')}
              bind:checked={configToEdit.oauth.enabled}
            />

            {#if configToEdit.oauth.enabled}
              <hr />

              <div class="flex items-center justify-between gap-2">
                <Text size="small">{$t('admin.unlink_all_oauth_accounts_description')}</Text>
                <Button size="small" onclick={handleUnlinkAllOAuthAccounts}
                  >{$t('admin.unlink_all_oauth_accounts')}</Button
                >
              </div>

              <SettingInputField
                inputType={SettingInputFieldType.TEXT}
                label="issuer_url"
                bind:value={configToEdit.oauth.issuerUrl}
                required={true}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.issuerUrl !== config.oauth.issuerUrl}
              />

              <SettingInputField
                inputType={SettingInputFieldType.TEXT}
                label="client_id"
                bind:value={configToEdit.oauth.clientId}
                required={true}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.clientId !== config.oauth.clientId}
              />

              <SettingInputField
                inputType={SettingInputFieldType.TEXT}
                label="client_secret"
                description={$t('admin.oauth_client_secret_description')}
                bind:value={configToEdit.oauth.clientSecret}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.clientSecret !== config.oauth.clientSecret}
              />

              {#if configToEdit.oauth.clientSecret}
                <SettingSelect
                  label="token_endpoint_auth_method"
                  bind:value={configToEdit.oauth.tokenEndpointAuthMethod}
                  disabled={disabled || !configToEdit.oauth.enabled || !configToEdit.oauth.clientSecret}
                  isEdited={configToEdit.oauth.tokenEndpointAuthMethod !== config.oauth.tokenEndpointAuthMethod}
                  options={[
                    { value: OAuthTokenEndpointAuthMethod.ClientSecretPost, text: 'client_secret_post' },
                    { value: OAuthTokenEndpointAuthMethod.ClientSecretBasic, text: 'client_secret_basic' },
                  ]}
                  name="tokenEndpointAuthMethod"
                />
              {/if}

              <SettingInputField
                inputType={SettingInputFieldType.TEXT}
                label="scope"
                bind:value={configToEdit.oauth.scope}
                required={true}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.scope !== config.oauth.scope}
              />

              <SettingInputField
                inputType={SettingInputFieldType.TEXT}
                label="id_token_signed_response_alg"
                bind:value={configToEdit.oauth.signingAlgorithm}
                required={true}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.signingAlgorithm !== config.oauth.signingAlgorithm}
              />

              <SettingInputField
                inputType={SettingInputFieldType.TEXT}
                label="userinfo_signed_response_alg"
                bind:value={configToEdit.oauth.profileSigningAlgorithm}
                required={true}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.profileSigningAlgorithm !== config.oauth.profileSigningAlgorithm}
              />

              <SettingInputField
                inputType={SettingInputFieldType.TEXT}
                label="prompt"
                description={$t('admin.oauth_prompt_description')}
                bind:value={configToEdit.oauth.prompt}
                required={false}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.prompt !== config.oauth.prompt}
              />

              <SettingInputField
                inputType={SettingInputFieldType.TEXT}
                label="end_session_endpoint"
                description={$t('admin.oauth_end_session_url_description')}
                bind:value={configToEdit.oauth.endSessionEndpoint}
                required={false}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.endSessionEndpoint !== config.oauth.endSessionEndpoint}
              />

              <SettingInputField
                inputType={SettingInputFieldType.NUMBER}
                label={$t('admin.oauth_timeout')}
                description={$t('admin.oauth_timeout_description')}
                required={true}
                bind:value={configToEdit.oauth.timeout}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.timeout !== config.oauth.timeout}
              />

              <SettingSwitch
                title={$t('admin.oauth_allow_insecure_requests')}
                subtitle={$t('admin.oauth_allow_insecure_requests_description')}
                bind:checked={configToEdit.oauth.allowInsecureRequests}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.allowInsecureRequests !== config.oauth.allowInsecureRequests}
              />

              <SettingInputField
                inputType={SettingInputFieldType.TEXT}
                label={$t('admin.oauth_storage_label_claim')}
                description={$t('admin.oauth_storage_label_claim_description')}
                bind:value={configToEdit.oauth.storageLabelClaim}
                required={true}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.storageLabelClaim !== config.oauth.storageLabelClaim}
              />

              <SettingInputField
                inputType={SettingInputFieldType.TEXT}
                label={$t('admin.oauth_role_claim')}
                description={$t('admin.oauth_role_claim_description')}
                bind:value={configToEdit.oauth.roleClaim}
                required={true}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.roleClaim !== config.oauth.roleClaim}
              />

              <SettingInputField
                inputType={SettingInputFieldType.TEXT}
                label={$t('admin.oauth_storage_quota_claim')}
                description={$t('admin.oauth_storage_quota_claim_description')}
                bind:value={configToEdit.oauth.storageQuotaClaim}
                required={true}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.storageQuotaClaim !== config.oauth.storageQuotaClaim}
              />

              <SettingInputField
                inputType={SettingInputFieldType.NUMBER}
                label={$t('admin.oauth_storage_quota_default')}
                description={$t('admin.oauth_storage_quota_default_description')}
                bind:value={configToEdit.oauth.defaultStorageQuota}
                required={false}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.defaultStorageQuota !== config.oauth.defaultStorageQuota}
              />

              <SettingInputField
                inputType={SettingInputFieldType.TEXT}
                label={$t('admin.oauth_button_text')}
                bind:value={configToEdit.oauth.buttonText}
                required={false}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.buttonText !== config.oauth.buttonText}
              />

              <SettingInputField
                inputType={SettingInputFieldType.TEXT}
                label={$t('admin.oauth_account_management_url')}
                description={$t('admin.oauth_account_management_url_description')}
                bind:value={configToEdit.oauth.accountManagementUrl}
                required={false}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.accountManagementUrl !== config.oauth.accountManagementUrl}
              />

              <SettingSwitch
                title={$t('admin.oauth_auto_register')}
                subtitle={$t('admin.oauth_auto_register_description')}
                bind:checked={configToEdit.oauth.autoRegister}
                disabled={disabled || !configToEdit.oauth.enabled}
              />

              <SettingSwitch
                title={$t('admin.oauth_auto_launch')}
                subtitle={$t('admin.oauth_auto_launch_description')}
                disabled={disabled || !configToEdit.oauth.enabled}
                bind:checked={configToEdit.oauth.autoLaunch}
              />

              <SettingSwitch
                title={$t('admin.oauth_mobile_redirect_uri_override')}
                subtitle={$t('admin.oauth_mobile_redirect_uri_override_description', {
                  values: { callback: 'app.immich:///oauth-callback' },
                })}
                disabled={disabled || !configToEdit.oauth.enabled}
                onToggle={() => handleToggleOverride()}
                bind:checked={configToEdit.oauth.mobileOverrideEnabled}
              />

              {#if configToEdit.oauth.mobileOverrideEnabled}
                <SettingInputField
                  inputType={SettingInputFieldType.TEXT}
                  label={$t('admin.oauth_mobile_redirect_uri')}
                  bind:value={configToEdit.oauth.mobileRedirectUri}
                  required={true}
                  disabled={disabled || !configToEdit.oauth.enabled}
                  isEdited={configToEdit.oauth.mobileRedirectUri !== config.oauth.mobileRedirectUri}
                />
              {/if}
            {/if}
          </div>
        </SettingAccordion>

        <SettingAccordion
          key="password"
          title={$t('admin.password_settings')}
          subtitle={$t('admin.password_settings_description')}
        >
          <div class="ms-4 mt-4 flex flex-col gap-4">
            <div class="ms-4 mt-4 flex flex-col">
              <SettingSwitch
                title={$t('admin.password_enable_description')}
                {disabled}
                bind:checked={configToEdit.passwordLogin.enabled}
              />

              <SettingSwitch
                title={$t('admin.password_rate_limit_enable')}
                subtitle={$t('admin.password_rate_limit_description')}
                disabled={disabled || !configToEdit.passwordLogin.enabled}
                bind:checked={configToEdit.passwordLogin.rateLimit.enabled}
                isEdited={configToEdit.passwordLogin.rateLimit.enabled !== config.passwordLogin.rateLimit.enabled}
              />

              {#if configToEdit.passwordLogin.rateLimit.enabled}
                <div class="mt-4 flex flex-col gap-4">
                  <SettingInputField
                    inputType={SettingInputFieldType.NUMBER}
                    label={$t('admin.password_rate_limit_account_max_failures')}
                    description={$t('admin.password_rate_limit_account_max_failures_description')}
                    min={1}
                    max={1000}
                    required={true}
                    disabled={disabled || !configToEdit.passwordLogin.enabled}
                    bind:value={configToEdit.passwordLogin.rateLimit.accountMaxFailures}
                    isEdited={configToEdit.passwordLogin.rateLimit.accountMaxFailures !==
                      config.passwordLogin.rateLimit.accountMaxFailures}
                  />

                  <SettingInputField
                    inputType={SettingInputFieldType.NUMBER}
                    label={$t('admin.password_rate_limit_ip_max_failures')}
                    description={$t('admin.password_rate_limit_ip_max_failures_description')}
                    min={0}
                    max={100_000}
                    required={true}
                    disabled={disabled || !configToEdit.passwordLogin.enabled}
                    bind:value={configToEdit.passwordLogin.rateLimit.ipMaxFailures}
                    isEdited={configToEdit.passwordLogin.rateLimit.ipMaxFailures !==
                      config.passwordLogin.rateLimit.ipMaxFailures}
                  />

                  <SettingInputField
                    inputType={SettingInputFieldType.NUMBER}
                    label={$t('admin.password_rate_limit_window')}
                    description={$t('admin.password_rate_limit_window_description')}
                    min={1}
                    max={1440}
                    required={true}
                    disabled={disabled || !configToEdit.passwordLogin.enabled}
                    bind:value={configToEdit.passwordLogin.rateLimit.windowMinutes}
                    isEdited={configToEdit.passwordLogin.rateLimit.windowMinutes !==
                      config.passwordLogin.rateLimit.windowMinutes}
                  />

                  <SettingInputField
                    inputType={SettingInputFieldType.NUMBER}
                    label={$t('admin.password_rate_limit_lockout')}
                    min={1}
                    max={1440}
                    required={true}
                    disabled={disabled || !configToEdit.passwordLogin.enabled}
                    bind:value={configToEdit.passwordLogin.rateLimit.lockoutMinutes}
                    isEdited={configToEdit.passwordLogin.rateLimit.lockoutMinutes !==
                      config.passwordLogin.rateLimit.lockoutMinutes}
                  />

                  <SettingInputField
                    inputType={SettingInputFieldType.NUMBER}
                    label={$t('admin.password_rate_limit_max_lockout')}
                    min={1}
                    max={10_080}
                    required={true}
                    disabled={disabled || !configToEdit.passwordLogin.enabled}
                    bind:value={configToEdit.passwordLogin.rateLimit.maxLockoutMinutes}
                    isEdited={configToEdit.passwordLogin.rateLimit.maxLockoutMinutes !==
                      config.passwordLogin.rateLimit.maxLockoutMinutes}
                  />
                </div>
              {/if}
            </div>
          </div>
        </SettingAccordion>

        <SettingButtonsRow bind:configToEdit keys={['passkey', 'passwordLogin', 'oauth']} {onBeforeSave} {disabled} />
      </div>
    </form>
  </div>
</div>
