<script lang="ts">
  import BottomInfo from '#lib/components/shared-components/side-bar/BottomInfo.svelte';
  import RecentAlbums from '#lib/components/shared-components/side-bar/RecentAlbums.svelte';
  import Sidebar from '#lib/components/sidebar/Sidebar.svelte';
  import { authManager } from '#lib/managers/auth-manager.svelte.ts';
  import { createPreloadedQuery } from '#lib/queries/client.ts';
  import { getUserConfigQuery } from '#lib/queries/config-user.query.ts';
  import { Route } from '#lib/route.ts';
  import { recentAlbumsDropdown } from '#lib/stores/preferences.store.ts';
  import { getSidebarVisibility } from '#lib/utils/sidebar-visibility.ts';
  import { NavbarGroup, NavbarItem } from '@immich/ui';
  import {
    mdiAccount,
    mdiAccountMultiple,
    mdiAccountMultipleOutline,
    mdiAccountOutline,
    mdiArchiveArrowDown,
    mdiArchiveArrowDownOutline,
    mdiCards,
    mdiCardsOutline,
    mdiFolderOutline,
    mdiHeart,
    mdiHeartOutline,
    mdiImageAlbum,
    mdiImageMultiple,
    mdiImageMultipleOutline,
    mdiLink,
    mdiLock,
    mdiLockOutline,
    mdiMagnify,
    mdiMap,
    mdiMapOutline,
    mdiTagMultipleOutline,
    mdiToolbox,
    mdiToolboxOutline,
    mdiTrashCan,
    mdiTrashCanOutline,
    mdiUploadOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { fly } from 'svelte/transition';

  const query = createPreloadedQuery(getUserConfigQuery);
  const config = $derived(query.data);
  const visible = $derived(getSidebarVisibility(config, authManager.preferences));
</script>

<Sidebar ariaLabel={$t('primary')}>
  <NavbarItem title={$t('photos')} href={Route.photos()} icon={mdiImageMultipleOutline} activeIcon={mdiImageMultiple} />

  {#if visible.explore}
    <NavbarItem title={$t('explore')} href={Route.explore()} icon={mdiMagnify} />
  {/if}

  {#if visible.map}
    <NavbarItem title={$t('map')} href={Route.map()} icon={mdiMapOutline} activeIcon={mdiMap} />
  {/if}

  {#if visible.memories}
    <NavbarItem title={$t('memories')} href={Route.memories()} icon={mdiCardsOutline} activeIcon={mdiCards} />
  {/if}

  {#if visible.people}
    <NavbarItem title={$t('people')} href={Route.people()} icon={mdiAccountOutline} activeIcon={mdiAccount} />
  {/if}

  {#if visible.sharedLinks}
    <NavbarItem title={$t('shared_links')} href={Route.sharedLinks()} icon={mdiLink} />
  {/if}

  <NavbarItem
    title={$t('sharing')}
    href={Route.sharing()}
    icon={mdiAccountMultipleOutline}
    activeIcon={mdiAccountMultiple}
  />

  <NavbarGroup title={$t('library')} size="tiny" />

  <NavbarItem title={$t('favorites')} href={Route.favorites()} icon={mdiHeartOutline} activeIcon={mdiHeart} />

  <NavbarItem
    title={$t('albums')}
    href={Route.albums()}
    icon={{ icon: mdiImageAlbum, flipped: true }}
    bind:expanded={$recentAlbumsDropdown}
  >
    {#snippet items()}
      <span in:fly={{ y: -20 }} class="hidden md:block">
        <RecentAlbums />
      </span>
    {/snippet}
  </NavbarItem>

  {#if visible.tags}
    <NavbarItem title={$t('tags')} href={Route.tags()} icon={{ icon: mdiTagMultipleOutline, flipped: true }} />
  {/if}

  {#if visible.recentlyAdded}
    <NavbarItem
      title={$t('recently_added')}
      href={Route.recentlyAdded()}
      icon={{ icon: mdiUploadOutline, flipped: true }}
    />
  {/if}

  {#if visible.folders}
    <NavbarItem title={$t('folders')} href={Route.folders()} icon={{ icon: mdiFolderOutline, flipped: true }} />
  {/if}

  {#if visible.utilities}
    <NavbarItem title={$t('utilities')} href={Route.utilities()} icon={mdiToolboxOutline} activeIcon={mdiToolbox} />
  {/if}

  <NavbarItem
    title={$t('archive')}
    href={Route.archive()}
    icon={mdiArchiveArrowDownOutline}
    activeIcon={mdiArchiveArrowDown}
  />

  {#if visible.lockedFolder}
    <NavbarItem title={$t('locked_folder')} href={Route.locked()} icon={mdiLockOutline} activeIcon={mdiLock} />
  {/if}

  {#if visible.trash}
    <NavbarItem title={$t('trash')} href={Route.trash()} icon={mdiTrashCanOutline} activeIcon={mdiTrashCan} />
  {/if}

  <BottomInfo />
</Sidebar>
