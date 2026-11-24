<script lang="ts">
  import { longPress, type LongPressPoint } from '#lib/actions/long-press.ts';
  import { matchesShortcut, shouldIgnoreEvent, type Shortcut } from '#lib/actions/shortcut.ts';
  import ActionMenuItem from '#lib/components/ActionMenuItem.svelte';
  import OnEvents from '#lib/components/OnEvents.svelte';
  import FolderBreadcrumbs from '#lib/components/folders/FolderBreadcrumbs.svelte';
  import FolderCards from '#lib/components/folders/FolderCards.svelte';
  import FolderContextMenu from '#lib/components/folders/FolderContextMenu.svelte';
  import FolderSortMenu from '#lib/components/folders/FolderSortMenu.svelte';
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
  import { assetViewerManager } from '#lib/managers/asset-viewer-manager.svelte.ts';
  import { authManager } from '#lib/managers/auth-manager.svelte.ts';
  import type { Viewport } from '#lib/managers/timeline-manager/types.ts';
  import { queryClient } from '#lib/queries/client.ts';
  import { folderViewQueryKey, getAssetsByOriginalPathQuery, getFolderSummaryQuery } from '#lib/queries/view.query.ts';
  import { Route } from '#lib/route.ts';
  import { getAssetBulkActions } from '#lib/services/asset.service.ts';
  import {
    getFolderActions,
    getFolderAssetActions,
    getFolderAssetMenuItems,
    getFolderCardMenuItems,
    getFolderSelectionActions,
    handleCreateFolder,
    handleDeleteSelection,
    handleMoveSelectionTo,
    handleRenameFile,
    handleRenameFolder,
    type FolderMenuItem,
    type FolderSelection,
  } from '#lib/services/folder.service.ts';
  import type { HeaderButtonActionItem } from '#lib/types.ts';
  import { navigateToAsset } from '#lib/utils/asset-utils.ts';
  import { getFolderCards, getMountCards, getRootCards, type FolderCard } from '#lib/utils/folder-cards.ts';
  import { getFolderLocationCrumbs, type FolderCrumb } from '#lib/utils/folder-roots.ts';
  import { getRangeSelection } from '#lib/utils/folder-selection.ts';
  import {
    getFolderSort,
    getFolderSortUpdate,
    sortFolderAssets,
    sortFolderCards,
    type FolderSort,
  } from '#lib/utils/folder-sort.ts';
  import { getFolderCrumbs, isSameOrInsidePath } from '#lib/utils/folder-utils.ts';
  import { handleError } from '#lib/utils/handle-error.ts';
  import { isAssetViewerRoute } from '#lib/utils/navigation.ts';
  import { toTimelineAsset } from '#lib/utils/timeline-util.ts';
  import { updateMyPreferences, type AssetResponseDto } from '@immich/sdk';
  import { ActionButton, Button, CommandPaletteDefaultProvider, IconButton, isModalOpen } from '@immich/ui';
  import {
    mdiCheckboxMultipleMarkedOutline,
    mdiClose,
    mdiDotsVertical,
    mdiFolder,
    mdiFolderHome,
    mdiFolderPlusOutline,
    mdiSelectAll,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { SvelteSet } from 'svelte/reactivity';
  import { afterNavigate, beforeNavigate, goto, refreshAll } from '$app/navigation';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  type MenuState = { items: FolderMenuItem[]; x: number; y: number; label: string };

  const DRAG_TYPE = 'application/x-immich-folder-items';

  let { data }: Props = $props();

  const location = $derived(data.view.mode === 'roots' ? undefined : data.view.location);
  const folderPath = $derived(data.folderPath);
  const summary = $derived(data.summary);
  const writable = $derived(!!summary?.writable);
  const sortKey = $derived(
    data.view.mode === 'roots'
      ? 'roots'
      : data.view.mode === 'folders'
        ? `root:${data.view.location.root.id}`
        : folderPath!,
  );
  const sort = $derived(getFolderSort(authManager.preferences.folders, sortKey));

  const baseCards = $derived.by((): FolderCard[] => {
    if (data.view.mode === 'roots') {
      return getRootCards($t, data.roots);
    }
    if (data.view.mode === 'folders') {
      return getMountCards(data.view.location);
    }
    return summary ? getFolderCards(summary, location) : [];
  });
  const cards = $derived(sortFolderCards(baseCards, sort));
  const pathAssets = $derived(data.pathAssets ? sortFolderAssets(data.pathAssets, sort) : null);

  const crumbs = $derived.by((): FolderCrumb[] => {
    if (location) {
      return getFolderLocationCrumbs($t, location);
    }
    if (folderPath) {
      return getFolderCrumbs(folderPath).map((crumb) => ({
        title: crumb.name,
        href: Route.folders({ path: crumb.path }),
        path: crumb.path,
        writable: false,
      }));
    }
    return [];
  });

  const selectedFolders = new SvelteSet<string>();
  let selectingFolders = $state(false);
  let anchorIndex = $state<number>();
  let menu = $state<MenuState>();
  let dragging = $state<FolderSelection>();
  let dropTarget = $state<string>();

  const viewport: Viewport = $state({ width: 0, height: 0 });
  let folderScrollContainer: HTMLElement | undefined = $state();
  let savedScrollTop = 0;

  const getSelection = (): FolderSelection => ({
    folderPaths: [...selectedFolders],
    assetIds: assetMultiSelectManager.assets.map((asset) => asset.id),
  });

  const selectionCount = () => selectedFolders.size + assetMultiSelectManager.assets.length;

  const clearFolderSelection = () => {
    selectedFolders.clear();
    selectingFolders = false;
    anchorIndex = undefined;
  };

  const clearAll = () => {
    clearFolderSelection();
    assetMultiSelectManager.clear();
  };

  const handleFolderChange = async () => {
    clearAll();
    await queryClient.invalidateQueries({ queryKey: folderViewQueryKey });
    await refreshAll();
  };

  const isSelectableCard = (card: FolderCard) => card.kind === 'folder';

  const openCard = (card: FolderCard) => goto(card.href, { reset: false });

  const toggleCard = (card: FolderCard) => {
    if (!isSelectableCard(card)) {
      return;
    }

    if (selectedFolders.has(card.path)) {
      selectedFolders.delete(card.path);
    } else {
      selectedFolders.add(card.path);
    }
    anchorIndex = cards.indexOf(card);
  };

  const handleCardClick = (card: FolderCard, event: MouseEvent) => {
    if (isSelectableCard(card) && (event.ctrlKey || event.metaKey)) {
      toggleCard(card);
      return;
    }

    if (isSelectableCard(card) && event.shiftKey) {
      const index = cards.indexOf(card);
      for (const item of getRangeSelection(cards, anchorIndex ?? index, index)) {
        if (isSelectableCard(item)) {
          selectedFolders.add(item.path);
        }
      }
      anchorIndex ??= index;
      return;
    }

    if (selectedFolders.size > 0 || selectingFolders) {
      toggleCard(card);
      return;
    }

    void openCard(card);
  };

  const getSelectionFor = (kind: 'folder' | 'asset', id: string): FolderSelection => {
    const inSelection = kind === 'folder' ? selectedFolders.has(id) : assetMultiSelectManager.hasSelectedAsset(id);
    if (inSelection) {
      return getSelection();
    }
    return kind === 'folder' ? { folderPaths: [id], assetIds: [] } : { folderPaths: [], assetIds: [id] };
  };

  const openCardMenu = (card: FolderCard, point: { x: number; y: number }) => {
    menu = {
      x: point.x,
      y: point.y,
      label: $t('folder_actions', { values: { name: card.label } }),
      items: getFolderCardMenuItems($t, card, {
        writable: card.kind === 'folder' ? writable : card.writable,
        onOpen: () => openCard(card),
        onChanged: handleFolderChange,
        libraryId: summary?.libraryId,
        selection: getSelectionFor('folder', card.path),
      }),
    };
  };

  const findAsset = (target: EventTarget | null) => {
    const element = (target as HTMLElement | null)?.closest<HTMLElement>('[data-asset]');
    const id = element?.dataset.asset;
    return id ? pathAssets?.find((asset) => asset.id === id) : undefined;
  };

  const openAssetMenu = (asset: AssetResponseDto, point: { x: number; y: number }) => {
    menu = {
      x: point.x,
      y: point.y,
      label: $t('folder_actions', { values: { name: asset.originalFileName } }),
      items: getFolderAssetMenuItems($t, asset, {
        writable,
        currentPath: folderPath,
        onOpen: () => navigateToAsset(asset),
        onChanged: handleFolderChange,
        libraryId: summary?.libraryId,
        selection: getSelectionFor('asset', asset.id),
      }),
    };
  };

  const handleAssetContextMenu = (event: MouseEvent) => {
    const asset = findAsset(event.target);
    if (asset) {
      event.preventDefault();
      openAssetMenu(asset, { x: event.clientX, y: event.clientY });
    }
  };

  const handleAssetLongPress = (point: LongPressPoint) => {
    const asset = findAsset(point.target);
    if (asset) {
      openAssetMenu(asset, point);
    }
  };

  const handleAssetClickCapture = (event: MouseEvent) => {
    if (!(event.ctrlKey || event.metaKey)) {
      return;
    }

    const asset = findAsset(event.target);
    if (!asset) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const timelineAsset = toTimelineAsset(asset);
    if (assetMultiSelectManager.hasSelectedAsset(asset.id)) {
      assetMultiSelectManager.removeAssetFromMultiselectGroup(asset.id);
    } else {
      assetMultiSelectManager.selectAsset(timelineAsset);
      assetMultiSelectManager.setAssetSelectionStart(timelineAsset);
    }
  };

  const startDrag = (selection: FolderSelection, event: DragEvent) => {
    dragging = selection;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(selection));
    }
  };

  const endDrag = () => {
    dragging = undefined;
    dropTarget = undefined;
  };

  const canDropOn = (path?: string, targetWritable = false) =>
    !!dragging &&
    !!path &&
    targetWritable &&
    writable &&
    path !== folderPath &&
    dragging.folderPaths.every((source) => !isSameOrInsidePath(source, path));

  const dropOn = async (path: string) => {
    const selection = dragging;
    endDrag();
    if (selection) {
      await handleMoveSelectionTo(selection, path, handleFolderChange);
    }
  };

  const handleAssetPointerDown = (event: PointerEvent) => {
    const element = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-asset]');
    if (element && writable) {
      element.draggable = true;
    }
  };

  const handleAssetDragStart = (event: DragEvent) => {
    const asset = findAsset(event.target);
    if (!asset || !writable) {
      return;
    }
    startDrag(getSelectionFor('asset', asset.id), event);
  };

  const getSingleSelected = () => {
    if (selectionCount() !== 1) {
      return;
    }
    if (selectedFolders.size === 1) {
      const path = [...selectedFolders][0];
      return { card: cards.find((card) => card.path === path) };
    }
    const id = assetMultiSelectManager.assets[0].id;
    return { asset: pathAssets?.find((asset) => asset.id === id) };
  };

  const isBlocked = () => !!menu || isModalOpen() || assetViewerManager.isViewing;

  const isOnControl = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    return !!target?.closest('button, a, [role="menuitem"], input, textarea, select');
  };

  type FolderShortcut = { shortcut: Shortcut; when: (event: KeyboardEvent) => boolean; run: () => unknown };

  const renameSelected = () => {
    const single = getSingleSelected();
    if (single?.card) {
      return handleRenameFolder(single.card.path, handleFolderChange);
    }
    if (single?.asset) {
      return handleRenameFile(single.asset, handleFolderChange);
    }
  };

  const openSelected = () => {
    const single = getSingleSelected();
    if (single?.card) {
      return openCard(single.card);
    }
    if (single?.asset) {
      return navigateToAsset(single.asset);
    }
  };

  const selectAll = () => {
    for (const card of cards) {
      if (isSelectableCard(card)) {
        selectedFolders.add(card.path);
      }
    }
    if (pathAssets) {
      assetMultiSelectManager.selectAssets(pathAssets.map((asset) => toTimelineAsset(asset)));
    }
  };

  const canDelete = () => writable && selectionCount() > 0;
  const deleteSelected = () => handleDeleteSelection(getSelection(), handleFolderChange);

  const folderShortcuts: FolderShortcut[] = [
    { shortcut: { key: 'F2' }, when: () => writable && !!getSingleSelected(), run: renameSelected },
    { shortcut: { key: 'Enter' }, when: (event) => !isOnControl(event) && !!getSingleSelected(), run: openSelected },
    { shortcut: { key: 'Delete' }, when: canDelete, run: deleteSelected },
    { shortcut: { key: 'Backspace' }, when: canDelete, run: deleteSelected },
    { shortcut: { key: 'a', ctrl: true }, when: () => true, run: selectAll },
    { shortcut: { key: 'a', meta: true }, when: () => true, run: selectAll },
    { shortcut: { key: 'Escape' }, when: () => selectionCount() > 0 || selectingFolders, run: clearAll },
  ];

  const handleKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || shouldIgnoreEvent(event) || isBlocked()) {
      return;
    }

    const match = folderShortcuts.find(({ shortcut }) => matchesShortcut(event, shortcut));
    if (match?.when(event)) {
      event.preventDefault();
      event.stopPropagation();
      void match.run();
    }
  };

  const handleSort = async (next: FolderSort) => {
    const previous = authManager.preferences;
    const folders = { ...previous.folders, ...getFolderSortUpdate(previous.folders, sortKey, next) };
    authManager.setPreferences({ ...previous, folders });
    try {
      authManager.setPreferences(await updateMyPreferences({ userPreferencesUpdateDto: { folders } }));
    } catch (error) {
      authManager.setPreferences(previous);
      handleError(error, $t('errors.unable_to_update_settings'));
    }
  };

  const headerActions = $derived.by((): HeaderButtonActionItem[] => {
    if (!writable || !folderPath) {
      return [];
    }

    const { UploadFolder } = getFolderActions($t, folderPath, handleFolderChange, summary?.libraryId);
    return [
      UploadFolder,
      {
        title: selectingFolders ? $t('cancel') : $t('select_folders'),
        icon: selectingFolders ? mdiClose : mdiCheckboxMultipleMarkedOutline,
        onAction: () => (selectingFolders ? clearFolderSelection() : (selectingFolders = true)),
      },
    ];
  });

  const selectionActions = $derived(getFolderSelectionActions($t, getSelection, folderPath ?? '/', handleFolderChange));
  const singleSelectedAsset = $derived(
    assetMultiSelectManager.assets.length === 1
      ? pathAssets?.find((asset) => asset.id === assetMultiSelectManager.assets[0].id)
      : undefined,
  );

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
    menu = undefined;

    if (isAssetViewerRoute(from) && folderScrollContainer) {
      folderScrollContainer.scrollTop = savedScrollTop;
    }
  });

  const triggerAssetUpdate = async () => {
    assetMultiSelectManager.clear();
    if (folderPath) {
      await queryClient.invalidateQueries({ queryKey: getAssetsByOriginalPathQuery(folderPath).queryKey });
      await queryClient.invalidateQueries({ queryKey: getFolderSummaryQuery(folderPath).queryKey });
    }
    await refreshAll();
  };

  const handleSetVisibility = () => {
    void triggerAssetUpdate();
  };

  const handleSelectAllAssets = () => {
    if (!pathAssets) {
      return;
    }

    assetMultiSelectManager.selectAssets(pathAssets.map((asset) => toTimelineAsset(asset)));
  };
</script>

<svelte:window onkeydowncapture={handleKeydown} />

<UserPageLayout
  title={data.meta.title}
  description={summary && summary.directAssetCount > 0
    ? $t('items_count', { values: { count: summary.directAssetCount } })
    : undefined}
  actions={headerActions}
>
  {#snippet buttons()}
    <div class="ms-auto flex items-center gap-1">
      {#if folderPath}
        <span title={writable ? undefined : $t('read_only_library')}>
          <Button
            variant="ghost"
            size="small"
            color="secondary"
            leadingIcon={mdiFolderPlusOutline}
            disabled={!writable}
            aria-label={writable ? $t('new_folder') : `${$t('new_folder')} (${$t('read_only_library')})`}
            data-testid="new-folder-button"
            onclick={() => folderPath && handleCreateFolder(folderPath, handleFolderChange)}
          >
            <span class="hidden md:inline">{$t('new_folder')}</span>
          </Button>
        </span>
      {/if}
      <FolderSortMenu {sort} onSelect={handleSort} />
    </div>
  {/snippet}

  <OnEvents onAssetsDelete={refreshAll} onAssetsArchive={triggerAssetUpdate} onAssetsUnarchive={triggerAssetUpdate} />

  <FolderBreadcrumbs
    {crumbs}
    homeHref={Route.folders()}
    icon={mdiFolderHome}
    title={$t('folders')}
    canDrop={(crumb) => canDropOn(crumb.path, crumb.writable)}
    onDrop={(crumb) => crumb.path && dropOn(crumb.path)}
  />

  {#if folderPath && !writable}
    <p class="mx-4 mt-1 text-xs text-gray-500 dark:text-gray-400" data-testid="read-only-hint">
      {$t('read_only_library')}
    </p>
  {/if}

  <section class="mt-2 h-[calc(100%-(--spacing(25)))] immich-scrollbar overflow-auto" bind:this={folderScrollContainer}>
    <FolderCards
      items={cards}
      icon={mdiFolder}
      selectable={selectingFolders}
      selected={selectedFolders}
      {dropTarget}
      onClick={handleCardClick}
      onToggle={toggleCard}
      onMenu={openCardMenu}
      canDrag={(card) => writable && card.kind === 'folder'}
      onDragStart={(card, event) => startDrag(getSelectionFor('folder', card.path), event)}
      onDragEnd={endDrag}
      canDrop={(card) => card.kind === 'folder' && canDropOn(card.path, card.writable)}
      onDragOver={(card) => (dropTarget = card?.path)}
      onDrop={(card) => dropOn(card.path)}
    />

    {#if pathAssets && pathAssets.length > 0}
      <div
        bind:clientHeight={viewport.height}
        bind:clientWidth={viewport.width}
        class="mt-2"
        data-testid="folder-assets"
        role="presentation"
        oncontextmenu={handleAssetContextMenu}
        onclickcapture={handleAssetClickCapture}
        onpointerdowncapture={handleAssetPointerDown}
        ondragstart={handleAssetDragStart}
        ondragend={endDrag}
        {@attach longPress(handleAssetLongPress)}
      >
        <GalleryViewer
          assets={pathAssets}
          assetInteraction={assetMultiSelectManager}
          {viewport}
          showAssetName={true}
          pageHeaderOffset={54}
          allowDeletion={!writable}
          onReload={triggerAssetUpdate}
        />
      </div>
    {/if}
  </section>
</UserPageLayout>

{#if menu}
  <FolderContextMenu {...menu} onClose={() => (menu = undefined)} />
{/if}

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
