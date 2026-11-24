<script lang="ts">
  import { authManager } from '#lib/managers/auth-manager.svelte.ts';
  import { featureFlagsManager } from '#lib/managers/feature-flags-manager.svelte.ts';
  import { createPreloadedQuery } from '#lib/queries/client.ts';
  import { getUserConfigQuery } from '#lib/queries/config-user.query.ts';
  import { Route } from '#lib/route.ts';
  import { hideBackupsReminder } from '#lib/stores/preferences.store.ts';
  import { isSimpleMode } from '#lib/utils/sidebar-visibility.ts';
  import { ImmichBackupsSidebarItem } from '@futo-org/backups-orchestrator-ui';
  import PurchaseInfo from './PurchaseInfo.svelte';
  import ServerStatus from './ServerStatus.svelte';
  import StorageSpace from './StorageSpace.svelte';

  const query = createPreloadedQuery(getUserConfigQuery);
  const simpleMode = $derived(isSimpleMode(query.data));
</script>

<div class="ms-4 mt-auto overflow-hidden rounded-lg">
  <StorageSpace />

  {#if authManager.user.isAdmin && featureFlagsManager.value.backups && !$hideBackupsReminder}
    <ImmichBackupsSidebarItem href={Route.backups()} />
  {/if}
</div>

{#if !simpleMode}
  <PurchaseInfo />
{/if}

<div class="mt-2 mb-6">
  <ServerStatus />
</div>
