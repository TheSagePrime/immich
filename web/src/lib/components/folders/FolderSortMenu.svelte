<script lang="ts">
  import Dropdown from '#lib/elements/Dropdown.svelte';
  import { folderSortOptions, type FolderSort } from '#lib/utils/folder-sort.ts';
  import { AssetOrder, FolderSortBy } from '@immich/sdk';
  import { mdiArrowDownThin, mdiArrowUpThin } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    sort: FolderSort;
    onSelect: (sort: FolderSort) => void;
  }

  const { sort, onSelect }: Props = $props();

  const names = $derived<Record<FolderSortBy, Record<AssetOrder, string>>>({
    [FolderSortBy.Name]: {
      [AssetOrder.Asc]: $t('sort_name_ascending'),
      [AssetOrder.Desc]: $t('sort_name_descending'),
    },
    [FolderSortBy.DateTaken]: {
      [AssetOrder.Desc]: $t('sort_date_taken_newest'),
      [AssetOrder.Asc]: $t('sort_date_taken_oldest'),
    },
    [FolderSortBy.DateAdded]: {
      [AssetOrder.Desc]: $t('sort_date_added_newest'),
      [AssetOrder.Asc]: $t('sort_date_added_oldest'),
    },
    [FolderSortBy.FileSize]: {
      [AssetOrder.Desc]: $t('sort_file_size_largest'),
      [AssetOrder.Asc]: $t('sort_file_size_smallest'),
    },
  });
</script>

<div class="ms-auto" data-testid="folder-sort">
  <Dropdown
    title={$t('sort_folders_by')}
    position="bottom-right"
    options={folderSortOptions}
    selectedOption={sort}
    {onSelect}
    render={(option: FolderSort) => ({
      title: names[option.sortBy][option.sortOrder],
      icon: option.sortOrder === AssetOrder.Desc ? mdiArrowDownThin : mdiArrowUpThin,
    })}
  />
</div>
