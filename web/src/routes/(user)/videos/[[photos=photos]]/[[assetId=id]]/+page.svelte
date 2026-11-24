<script lang="ts">
  import ActionMenuItem from '#lib/components/ActionMenuItem.svelte';
  import UserPageLayout, { headerId } from '#lib/components/layouts/UserPageLayout.svelte';
  import EmptyPlaceholder from '#lib/components/shared-components/EmptyPlaceholder.svelte';
  import ButtonContextMenu from '#lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import TreeBreadcrumbs from '#lib/components/shared-components/tree/TreeBreadcrumbs.svelte';
  import TreeItems from '#lib/components/shared-components/tree/TreeItems.svelte';
  import Sidebar from '#lib/components/sidebar/Sidebar.svelte';
  import AssetSelectControlBar from '#lib/components/timeline/AssetSelectControlBar.svelte';
  import Timeline from '#lib/components/timeline/Timeline.svelte';
  import ChangeDate from '#lib/components/timeline/actions/ChangeDateAction.svelte';
  import ChangeDescription from '#lib/components/timeline/actions/ChangeDescriptionAction.svelte';
  import ChangeLocation from '#lib/components/timeline/actions/ChangeLocationAction.svelte';
  import DeleteAssets from '#lib/components/timeline/actions/DeleteAssetsAction.svelte';
  import DownloadAction from '#lib/components/timeline/actions/DownloadAction.svelte';
  import FavoriteAction from '#lib/components/timeline/actions/FavoriteAction.svelte';
  import SelectAllAssets from '#lib/components/timeline/actions/SelectAllAction.svelte';
  import SetVisibilityAction from '#lib/components/timeline/actions/SetVisibilityAction.svelte';
  import { AssetAction } from '#lib/constants.ts';
  import SkipLink from '#lib/elements/SkipLink.svelte';
  import { assetMultiSelectManager } from '#lib/managers/asset-multi-select-manager.svelte.ts';
  import { assetViewerManager } from '#lib/managers/asset-viewer-manager.svelte.ts';
  import { TimelineManager } from '#lib/managers/timeline-manager/timeline-manager.svelte.ts';
  import type { TimelineManagerOptions } from '#lib/managers/timeline-manager/types.ts';
  import { createPreloadedQuery } from '#lib/queries/client.ts';
  import { getVideoFolderTreeQuery } from '#lib/queries/video-library.query.ts';
  import { Route } from '#lib/route.ts';
  import { getAssetBulkActions } from '#lib/services/asset.service.ts';
  import { AssetTypeEnum, AssetVisibility } from '@immich/sdk';
  import { ActionButton, CommandPaletteDefaultProvider, Text } from '@immich/ui';
  import { mdiDotsVertical, mdiFolder, mdiFolderOutline, mdiVideoBox } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  let { data }: Props = $props();

  const query = createPreloadedQuery(getVideoFolderTreeQuery);
  const root = $derived(query.data);
  const folder = $derived(root.traverse(data.path));

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  const options: TimelineManagerOptions = $derived({
    visibility: AssetVisibility.Timeline,
    assetType: AssetTypeEnum.Video,
    ...(folder.path && { folder: folder.path }),
  });

  const getLink = (path: string) => Route.videos(path ? { path } : undefined);

  const handleEscape = () => {
    if (assetViewerManager.isViewing) {
      return;
    }

    if (assetMultiSelectManager.selectionActive) {
      assetMultiSelectManager.clear();
    }
  };

  const handleSetVisibility = (assetIds: string[]) => {
    timelineManager.removeAssets(assetIds);
    assetMultiSelectManager.clear();
  };
</script>

<UserPageLayout hideNavbar={assetMultiSelectManager.selectionActive} title={data.meta.title} scrollbar={false}>
  {#snippet sidebar()}
    <Sidebar>
      <SkipLink target={`#${headerId}`} text={$t('skip_to_folders')} breakpoint="md" />
      <section>
        <Text class="mb-4 ps-4" size="small">{$t('video_folders')}</Text>
        <div class="h-full" data-testid="video-folder-tree">
          <TreeItems
            icons={{ default: mdiFolderOutline, active: mdiFolder }}
            tree={root}
            active={folder.path}
            {getLink}
          />
        </div>
      </section>
    </Sidebar>
  {/snippet}

  <div class="flex h-full flex-col">
    {#if root.size > 0}
      <TreeBreadcrumbs node={folder} icon={mdiVideoBox} title={$t('all_videos')} {getLink} />
    {/if}

    {#if folder.children.length > 0}
      <nav class="flex gap-2 overflow-x-auto px-2 pb-2" aria-label={$t('video_folders')} data-testid="video-subfolders">
        {#each folder.children as child (child.path)}
          <a
            href={getLink(child.path)}
            class="shrink-0 rounded-full border border-light-300 px-3 py-1 text-sm whitespace-nowrap hover:bg-light-100"
          >
            {child.value}
          </a>
        {/each}
      </nav>
    {/if}

    <section class="min-h-0 grow">
      <Timeline
        enableRouting={true}
        bind:timelineManager
        {options}
        assetInteraction={assetMultiSelectManager}
        removeAction={AssetAction.ARCHIVE}
        onEscape={handleEscape}
      >
        {#snippet empty()}
          <EmptyPlaceholder text={$t('no_videos_message')} class="mx-auto mt-10" />
        {/snippet}
      </Timeline>
    </section>
  </div>
</UserPageLayout>

{#if assetMultiSelectManager.selectionActive}
  <AssetSelectControlBar>
    {const Actions = $derived(getAssetBulkActions($t))}
    <CommandPaletteDefaultProvider name={$t('assets')} actions={Object.values(Actions)} />

    <ActionButton action={Actions.CreateSharedLink} />
    <SelectAllAssets {timelineManager} assetInteraction={assetMultiSelectManager} />
    <ActionButton action={Actions.AddToAlbum} />

    {#if assetMultiSelectManager.isAllUserOwned}
      <FavoriteAction
        removeFavorite={assetMultiSelectManager.isAllFavorite}
        onFavorite={(ids, isFavorite) => timelineManager.update(ids, (asset) => (asset.isFavorite = isFavorite))}
      />

      <ButtonContextMenu icon={mdiDotsVertical} title={$t('menu')}>
        <DownloadAction menuItem />
        <ChangeDate menuItem />
        <ChangeDescription menuItem />
        <ChangeLocation menuItem />
        <ActionMenuItem action={Actions.Archive} />
        <ActionMenuItem action={Actions.Tag} />
        <DeleteAssets
          menuItem
          onAssetDelete={(assetIds) => timelineManager.removeAssets(assetIds)}
          onUndoDelete={(assets) => timelineManager.upsertAssets(assets)}
        />
        <SetVisibilityAction menuItem onVisibilitySet={handleSetVisibility} />
        <hr />
        <ActionMenuItem action={Actions.RegenerateThumbnailJob} />
        <ActionMenuItem action={Actions.RefreshMetadataJob} />
        <ActionMenuItem action={Actions.TranscodeVideoJob} />
      </ButtonContextMenu>
    {:else}
      <DownloadAction />
    {/if}
  </AssetSelectControlBar>
{/if}
