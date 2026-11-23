<script lang="ts">
  import { getAssetMediaUrl } from '#lib/utils.ts';
  import type { FolderCard } from '#lib/utils/folder-cards.ts';
  import { AssetMediaSize } from '@immich/sdk';
  import { Checkbox, ContextMenuButton, Icon, type ActionItem } from '@immich/ui';
  import { t } from 'svelte-i18n';

  interface Props {
    items: FolderCard[];
    icon: string;
    selectable?: boolean;
    selected?: Set<string>;
    getActions?: (item: FolderCard) => ActionItem[];
    onClick: (item: FolderCard) => void;
    onToggle?: (item: FolderCard) => void;
  }

  const { items, icon, selectable = false, selected, getActions, onClick, onToggle }: Props = $props();
</script>

{#if items.length > 0}
  <div
    class="grid w-full grid-cols-2 gap-2 rounded-2xl border border-gray-100 bg-gray-50 p-2 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8 dark:border-gray-900 dark:bg-immich-dark-gray/50"
    data-testid="folder-cards"
  >
    {#each items as item (item.path)}
      {const isSelected = selected?.has(item.path) ?? false}
      <div
        class="group relative flex flex-col rounded-xl hover:bg-immich-primary/10 dark:hover:bg-immich-primary/40 {isSelected
          ? 'bg-immich-primary/20 dark:bg-immich-primary/50'
          : ''}"
        data-testid="folder-card"
      >
        <button
          class="flex flex-col place-items-center gap-2 p-2"
          onclick={() => (selectable && onToggle ? onToggle(item) : onClick(item))}
          title={item.path}
          type="button"
        >
          <div class="flex aspect-square w-full items-center justify-center overflow-hidden rounded-lg">
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
          <p class="w-full truncate text-center text-sm dark:text-gray-200">{item.label}</p>
          {#if item.assetCount !== undefined}
            <p class="text-xs text-gray-500 dark:text-gray-400" data-testid="folder-count">
              {$t('items_count', { values: { count: item.assetCount } })}
            </p>
          {/if}
        </button>

        {#if selectable && onToggle}
          <div class="absolute inset-s-2 top-2">
            <Checkbox
              checked={isSelected}
              aria-label={$t('select_folder', { values: { name: item.label } })}
              onCheckedChange={() => onToggle(item)}
            />
          </div>
        {/if}

        {#if getActions}
          {const actions = getActions(item)}
          {#if actions.length > 0}
            <div
              class="absolute inset-e-1 top-1 opacity-100 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
            >
              <ContextMenuButton aria-label={$t('folder_actions', { values: { name: item.label } })} items={actions} />
            </div>
          {/if}
        {/if}
      </div>
    {/each}
  </div>
{/if}
