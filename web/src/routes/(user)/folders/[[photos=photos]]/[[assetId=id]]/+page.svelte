<script lang="ts">
  import ActionMenuItem from '#lib/components/ActionMenuItem.svelte';
  import OnEvents from '#lib/components/OnEvents.svelte';
  import FolderBreadcrumbs from '#lib/components/folders/FolderBreadcrumbs.svelte';
  import FolderCards from '#lib/components/folders/FolderCards.svelte';
  import UserPageLayout from '#lib/components/layouts/UserPageLayout.svelte';
  import ControlAppBar from '#lib/components/shared-components/ControlAppBar.svelte';
  import ButtonContextMenu from '#lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import GalleryViewer from '#lib/components/shared-components/gallery-viewer/GalleryViewer.svelte';
  import AssetSelectControlBar from '#lib/components/timeline/AssetSelectControlBar.svelte';
  import ChangeDate from '#lib/components/timeline/actions/ChangeDateAction.svelte';
  import ChangeDescription from '#lib/components/timeline/actions/ChangeDescriptionAction.svelte';
  import ChangeLocation from '#lib/components/timeline/actions/ChangeLocationAction.svelte';
  import DeleteAssets from '#lib/components/timeline/actions/DeleteAssetsAction.svelte';
  import DownloadAction from '#lib/components/timeline/actions/DownloadAction.svelte';
  import FavoriteAction from '#lib/components/timeline/actions/FavoriteAction.svelte';
  import SetVisibilityAction from '#lib/components/timeline/actions/SetVisibilityAction.svelte';
  import { assetMultiSelectManager } from '#lib/managers/asset-multi-select-manager.svelte.ts';
  import type { Viewport } from '#lib/managers/timeline-manager/types.ts';
  import { createPreloadedQuery, queryClient } from '#lib/queries/client.ts';
  import { folderViewQueryKey, getAssetsByOriginalPathQuery, getFolderSummaryQuery } from '#lib/queries/view.query.ts';
  import { Route } from '#lib/route.ts';
  import { getAssetBulkActions } from '#lib/services/asset.service.ts';
  import {
    getFolderActions,
    getFolderAssetActions,
    getFolderItemActions,
    getFolderSelectionActions,
  } from '#lib/services/folder.service.ts';
  import type { HeaderButtonActionItem } from '#lib/types.ts';
  import { getFolderCards, type FolderCard } from '#lib/utils/folder-cards.ts';
  import { isAssetViewerRoute } from '#lib/utils/navigation.ts';
  import { toTimelineAsset } from '#lib/utils/timeline-util.ts';
  import { ActionButton, CommandPaletteDefaultProvider, IconButton } from '@immich/ui';
  import {
    mdiCheckboxMultipleMarkedOutline,
    mdiClose,
    mdiDotsVertical,
    mdiFolder,
    mdiFolderHome,
    mdiSelectAll,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { SvelteSet } from 'svelte/reactivity';
  import { afterNavigate, beforeNavigate, goto, refreshAll } from '$app/navigation';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const summaryQuery = createPreloadedQuery(() => getFolderSummaryQuery(data.folderPath));
  const summary = $derived(summaryQuery.data);
  const writable = $derived(summary.writable);
  const cards = $derived(getFolderCards(summary, data.isTreeNode ? data.tree : undefined));

  const selectedFolders = new SvelteSet<string>();
  let selectingFolders = $state(false);

  const viewport: Viewport = $state({ width: 0, height: 0 });
  let folderScrollContainer: HTMLElement | undefined = $state();
  let savedScrollTop = 0;

  const handleNavigateToFolder = (card: FolderCard) => navigateToView(card.path);

  const handleToggleFolder = (card: FolderCard) => {
    if (selectedFolders.has(card.path)) {
      selectedFolders.delete(card.path);
    } else {
      selectedFolders.add(card.path);
    }
  };

  const clearFolderSelection = () => {
    selectedFolders.clear();
    selectingFolders = false;
  };

  const handleFolderChange = async () => {
    clearFolderSelection();
    assetMultiSelectManager.clear();
    await queryClient.invalidateQueries({ queryKey: folderViewQueryKey });
    await refreshAll();
  };

  const getSelection = () => ({
    folderPaths: [...selectedFolders],
    assetIds: assetMultiSelectManager.assets.map((asset) => asset.id),
  });

  const getCardActions = (card: FolderCard) => {
    if (!writable) {
      return [];
    }

    const { Rename, Move, Delete } = getFolderItemActions($t, card.path, handleFolderChange);
    return [Rename, Move, Delete];
  };

  const headerActions = $derived.by((): HeaderButtonActionItem[] => {
    if (!writable) {
      return [];
    }

    const { CreateFolder, UploadFolder } = getFolderActions($t, data.folderPath, handleFolderChange, summary.libraryId);
    return [
      CreateFolder,
      UploadFolder,
      {
        title: selectingFolders ? $t('cancel') : $t('select_folders'),
        icon: selectingFolders ? mdiClose : mdiCheckboxMultipleMarkedOutline,
        onAction: () => (selectingFolders ? clearFolderSelection() : (selectingFolders = true)),
      },
    ];
  });

  const selectionActions = $derived(getFolderSelectionActions($t, getSelection, data.folderPath, handleFolderChange));
  const singleSelectedAsset = $derived(
    assetMultiSelectManager.assets.length === 1
      ? data.pathAssets?.find((asset) => asset.id === assetMultiSelectManager.assets[0].id)
      : undefined,
  );

  const getLinkForPath = (path: string) => Route.folders({ path });

  beforeNavigate(({ to, shallow, type }) => {
    if (shallow && type === 'goto') return;

    if (isAssetViewerRoute(to)) {
      savedScrollTop = folderScrollContainer?.scrollTop ?? 0;
    }
  });

  afterNavigate(({ from, shallow, type }) => {
    if (shallow && type === 'goto') return;

    assetMultiSelectManager.clear();
    clearFolderSelection();

    if (isAssetViewerRoute(from) && folderScrollContainer) {
      folderScrollContainer.scrollTop = savedScrollTop;
    }
  });

  const navigateToView = (path: string) => {
    return goto(getLinkForPath(path), { reset: false });
  };

  const triggerAssetUpdate = async () => {
    assetMultiSelectManager.clear();
    await queryClient.invalidateQueries({ queryKey: getAssetsByOriginalPathQuery(data.folderPath).queryKey });
    await queryClient.invalidateQueries({ queryKey: getFolderSummaryQuery(data.folderPath).queryKey });
    await refreshAll();
  };

  const handleSetVisibility = () => {
    void triggerAssetUpdate();
  };

  const handleSelectAllAssets = () => {
    if (!data.pathAssets) {
      return;
    }

    assetMultiSelectManager.selectAssets(data.pathAssets.map((asset) => toTimelineAsset(asset)));
  };
</script>

<UserPageLayout
  title={data.meta.title}
  description={summary.directAssetCount > 0
    ? $t('items_count', { values: { count: summary.directAssetCount } })
    : undefined}
  actions={headerActions}
>
  <OnEvents onAssetsDelete={refreshAll} onAssetsArchive={triggerAssetUpdate} onAssetsUnarchive={triggerAssetUpdate} />

  <FolderBreadcrumbs path={data.folderPath} icon={mdiFolderHome} title={$t('folders')} getLink={getLinkForPath} />

  <section class="mt-2 h-[calc(100%-(--spacing(25)))] immich-scrollbar overflow-auto" bind:this={folderScrollContainer}>
    <FolderCards
      items={cards}
      icon={mdiFolder}
      selectable={selectingFolders}
      selected={selectedFolders}
      getActions={writable ? getCardActions : undefined}
      onClick={handleNavigateToFolder}
      onToggle={handleToggleFolder}
    />

    <!-- Assets -->
    {#if data.pathAssets && data.pathAssets.length > 0}
      <div bind:clientHeight={viewport.height} bind:clientWidth={viewport.width} class="mt-2">
        <GalleryViewer
          assets={data.pathAssets}
          assetInteraction={assetMultiSelectManager}
          {viewport}
          showAssetName={true}
          pageHeaderOffset={54}
          onReload={triggerAssetUpdate}
        />
      </div>
    {/if}
  </section>
</UserPageLayout>

{#if assetMultiSelectManager.selectionActive}
  <div class="fixed inset-s-0 top-0 w-full">
    <AssetSelectControlBar>
      {const Actions = $derived(getAssetBulkActions($t))}
      <CommandPaletteDefaultProvider name={$t('assets')} actions={Object.values(Actions)} />
      <ActionButton action={Actions.CreateSharedLink} />
      <IconButton
        shape="round"
        color="secondary"
        variant="ghost"
        aria-label={$t('select_all')}
        icon={mdiSelectAll}
        onclick={handleSelectAllAssets}
      />
      <ActionButton action={Actions.AddToAlbum} />
      <FavoriteAction
        removeFavorite={assetMultiSelectManager.isAllFavorite}
        onFavorite={function handleFavoriteUpdate(ids, isFavorite) {
          if (data.pathAssets && data.pathAssets.length > 0) {
            for (const id of ids) {
              const asset = data.pathAssets.find((asset) => asset.id === id);
              if (asset) {
                asset.isFavorite = isFavorite;
              }
            }
          }
        }}
      />

      {#if writable}
        <ActionButton action={selectionActions.Move} />
      {/if}

      <ButtonContextMenu icon={mdiDotsVertical} title={$t('menu')}>
        {#if writable}
          {#if singleSelectedAsset}
            <ActionMenuItem action={getFolderAssetActions($t, singleSelectedAsset, handleFolderChange).RenameFile} />
          {/if}
          <ActionMenuItem action={selectionActions.Delete} />
          <hr />
        {/if}
        <DownloadAction menuItem />
        <ChangeDate menuItem />
        <ChangeDescription menuItem />
        <ChangeLocation menuItem />
        <ActionMenuItem action={Actions.Archive} />
        <ActionMenuItem action={Actions.Unarchive} />
        <SetVisibilityAction menuItem onVisibilitySet={handleSetVisibility} />
        <ActionMenuItem action={Actions.Tag} />
        <DeleteAssets menuItem onAssetDelete={triggerAssetUpdate} onUndoDelete={triggerAssetUpdate} />
        <hr />

        <ActionMenuItem action={Actions.RegenerateThumbnailJob} />
        <ActionMenuItem action={Actions.RefreshMetadataJob} />
        <ActionMenuItem action={Actions.TranscodeVideoJob} />
      </ButtonContextMenu>
    </AssetSelectControlBar>
  </div>
{:else if writable && selectedFolders.size > 0}
  <div class="fixed inset-s-0 top-0 w-full">
    <ControlAppBar onClose={clearFolderSelection} backIcon={mdiClose}>
      {#snippet leading()}
        <div class="font-medium text-primary">
          {$t('selected_folders_count', { values: { count: selectedFolders.size } })}
        </div>
      {/snippet}
      {#snippet trailing()}
        <ActionButton action={selectionActions.Move} />
        <ActionButton action={selectionActions.Delete} />
      {/snippet}
    </ControlAppBar>
  </div>
{/if}
