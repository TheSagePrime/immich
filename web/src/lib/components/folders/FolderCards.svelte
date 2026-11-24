<script lang="ts">
  import { longPress } from '#lib/actions/long-press.ts';
  import { getAssetMediaUrl } from '#lib/utils.ts';
  import type { FolderCard } from '#lib/utils/folder-cards.ts';
  import { AssetMediaSize } from '@immich/sdk';
  import { Checkbox, Icon } from '@immich/ui';
  import { mdiDotsVertical } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Point = { x: number; y: number };

  interface Props {
    items: FolderCard[];
    icon: string;
    selectable?: boolean;
    selected?: Set<string>;
    dropTarget?: string;
    onClick: (item: FolderCard, event: MouseEvent) => void;
    onToggle?: (item: FolderCard) => void;
    onMenu?: (item: FolderCard, point: Point) => void;
    canDrag?: (item: FolderCard) => boolean;
    onDragStart?: (item: FolderCard, event: DragEvent) => void;
    onDragEnd?: () => void;
    canDrop?: (item: FolderCard) => boolean;
    onDragOver?: (item: FolderCard | undefined) => void;
    onDrop?: (item: FolderCard) => void;
  }

  const {
    items,
    icon,
    selectable = false,
    selected,
    dropTarget,
    onClick,
    onToggle,
    onMenu,
    canDrag,
    onDragStart,
    onDragEnd,
    canDrop,
    onDragOver,
    onDrop,
  }: Props = $props();

  const openMenuAt = (item: FolderCard, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    onMenu?.(item, { x: rect.left, y: rect.bottom });
  };
</script>

{#if items.length > 0}
  <div class="grid grid-auto-fill-56 gap-y-4" data-testid="folder-cards">
    {#each items as item (item.path)}
      {const isSelected = $derived(selected?.has(item.path) ?? false)}
      {const isDropTarget = $derived(dropTarget === item.path)}
      <div
        class="group relative rounded-2xl border p-5 hover:border-gray-200 hover:bg-gray-100 dark:hover:border-gray-800 dark:hover:bg-gray-900 {isDropTarget
          ? 'border-primary bg-primary/20 ring-2 ring-primary'
          : isSelected
            ? 'border-primary bg-primary/10'
            : 'border-transparent'}"
        role="group"
        aria-label={item.label}
        data-testid="folder-card"
        data-folder-path={item.path}
        data-selected={isSelected || undefined}
        data-drop-target={isDropTarget || undefined}
        draggable={canDrag?.(item) ?? false}
        ondragstart={(event) => onDragStart?.(item, event)}
        ondragend={() => onDragEnd?.()}
        ondragover={(event) => {
          if (canDrop?.(item)) {
            event.preventDefault();
            if (event.dataTransfer) {
              event.dataTransfer.dropEffect = 'move';
            }
            onDragOver?.(item);
          }
        }}
        ondragleave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            onDragOver?.(undefined);
          }
        }}
        ondrop={(event) => {
          if (canDrop?.(item)) {
            event.preventDefault();
            onDrop?.(item);
          }
        }}
        oncontextmenu={(event) => {
          if (onMenu) {
            event.preventDefault();
            onMenu(item, { x: event.clientX, y: event.clientY });
          }
        }}
        {@attach longPress((point) => onMenu?.(item, point))}
      >
        <button
          class="flex w-full flex-col text-start"
          onclick={(event) => (selectable && onToggle ? onToggle(item) : onClick(item, event))}
          title={item.label}
          type="button"
          data-testid="folder-card-button"
        >
          <div
            class="flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl bg-gray-100 transition-all duration-300 group-hover:shadow-lg dark:bg-gray-800"
          >
            {#if item.coverAssetId}
              <img
                src={getAssetMediaUrl({ id: item.coverAssetId, size: AssetMediaSize.Thumbnail })}
                alt={item.label}
                loading="lazy"
                draggable="false"
                class="size-full object-cover"
                data-testid="folder-cover"
              />
            {:else}
              <Icon {icon} class="text-primary" size="64" />
            {/if}
          </div>
          <p
            class="mt-4 line-clamp-2 w-full text-lg/6 font-semibold wrap-break-word text-black group-hover:text-primary dark:text-white"
            data-testid="folder-card-label"
          >
            {item.label}
          </p>
          {#if item.assetCount !== undefined}
            <p class="text-sm dark:text-immich-dark-fg" data-testid="folder-count">
              {$t('items_count', { values: { count: item.assetCount } })}
            </p>
          {/if}
        </button>

        {#if selectable && onToggle}
          <div class="absolute inset-s-7 top-7">
            <Checkbox
              checked={isSelected}
              aria-label={$t('select_folder', { values: { name: item.label } })}
              onCheckedChange={() => onToggle(item)}
            />
          </div>
        {/if}

        {#if onMenu}
          <div
            class="absolute inset-e-6 top-6 opacity-100 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
          >
            <button
              type="button"
              class="flex size-9 items-center justify-center rounded-full bg-light-100/80 text-dark shadow-sm hover:bg-light-200 focus-visible:ring-2 focus-visible:ring-primary"
              title={$t('folder_actions', { values: { name: item.label } })}
              aria-label={$t('folder_actions', { values: { name: item.label } })}
              aria-haspopup="menu"
              onclick={(event) => openMenuAt(item, event.currentTarget)}
            >
              <Icon icon={mdiDotsVertical} size="1.25rem" />
            </button>
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}
