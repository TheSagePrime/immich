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
  <div class="grid grid-auto-fill-56 gap-y-4" data-testid="folder-cards">
    {#each items as item (item.path)}
      {const isSelected = selected?.has(item.path) ?? false}
      <div
        class="group relative rounded-2xl border p-5 hover:border-gray-200 hover:bg-gray-100 dark:hover:border-gray-800 dark:hover:bg-gray-900 {isSelected
          ? 'border-primary bg-primary/10'
          : 'border-transparent'}"
        data-testid="folder-card"
      >
        <button
          class="flex w-full flex-col text-start"
          onclick={() => (selectable && onToggle ? onToggle(item) : onClick(item))}
          title={item.path}
          type="button"
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

        {#if getActions}
          {const actions = getActions(item)}
          {#if actions.length > 0}
            <div
              class="absolute inset-e-6 top-6 opacity-100 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
            >
              <ContextMenuButton
                aria-label={$t('folder_actions', { values: { name: item.label } })}
                variant="filled"
                class="icon-white-drop-shadow"
                items={actions}
              />
            </div>
          {/if}
        {/if}
      </div>
    {/each}
  </div>
{/if}
