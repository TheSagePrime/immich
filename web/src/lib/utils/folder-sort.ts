import type { FolderCard } from '#lib/utils/folder-cards.ts';
import {
  AssetOrder,
  FolderSortBy,
  type AssetResponseDto,
  type FolderSortOverride,
  type FoldersResponse,
  type FoldersUpdate,
} from '@immich/sdk';

export type FolderSort = { sortBy: FolderSortBy; sortOrder: AssetOrder };

export const FOLDER_SORT_OVERRIDES_MAX = 500;

export const defaultFolderSort: FolderSort = { sortBy: FolderSortBy.Name, sortOrder: AssetOrder.Asc };

export const folderSortOptions: FolderSort[] = [
  { sortBy: FolderSortBy.Name, sortOrder: AssetOrder.Asc },
  { sortBy: FolderSortBy.Name, sortOrder: AssetOrder.Desc },
  { sortBy: FolderSortBy.DateTaken, sortOrder: AssetOrder.Desc },
  { sortBy: FolderSortBy.DateTaken, sortOrder: AssetOrder.Asc },
  { sortBy: FolderSortBy.DateAdded, sortOrder: AssetOrder.Desc },
  { sortBy: FolderSortBy.DateAdded, sortOrder: AssetOrder.Asc },
  { sortBy: FolderSortBy.FileSize, sortOrder: AssetOrder.Desc },
  { sortBy: FolderSortBy.FileSize, sortOrder: AssetOrder.Asc },
];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const compareNatural = (a: string, b: string) => {
  const result = collator.compare(a, b);
  if (result !== 0 || a === b) {
    return result;
  }

  return a < b ? -1 : 1;
};

const isFolderSort = (sort: Partial<FolderSort>): sort is FolderSort =>
  folderSortOptions.some((option) => option.sortBy === sort.sortBy && option.sortOrder === sort.sortOrder);

export const getFolderSort = (folders: FoldersResponse | undefined, path: string): FolderSort => {
  const override = folders?.sortOverrides?.find((item) => item.path === path);
  if (override && isFolderSort(override)) {
    return { sortBy: override.sortBy, sortOrder: override.sortOrder };
  }

  const sort = { sortBy: folders?.sortBy, sortOrder: folders?.sortOrder };
  return isFolderSort(sort) ? sort : defaultFolderSort;
};

export const getFolderSortUpdate = (
  folders: FoldersResponse | undefined,
  path: string,
  sort: FolderSort,
): Required<Pick<FoldersUpdate, 'sortBy' | 'sortOrder' | 'sortOverrides'>> => {
  const others = (folders?.sortOverrides ?? []).filter((item) => item.path !== path);
  const sortOverrides: FolderSortOverride[] = [{ path, ...sort }, ...others].slice(0, FOLDER_SORT_OVERRIDES_MAX);
  return { sortBy: sort.sortBy, sortOrder: sort.sortOrder, sortOverrides };
};

type SortKey = { name: string; value?: number };

const toTime = (value?: string | null) => {
  if (!value) {
    return;
  }

  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
};

const sortByKey = <T>(items: T[], getKey: (item: T) => SortKey, { sortBy, sortOrder }: FolderSort): T[] => {
  const direction = sortOrder === AssetOrder.Asc ? 1 : -1;
  const keyed = items.map((item) => ({ item, key: getKey(item) }));

  keyed.sort((a, b) => {
    if (sortBy === FolderSortBy.Name) {
      return direction * compareNatural(a.key.name, b.key.name);
    }

    const aValue = a.key.value;
    const bValue = b.key.value;
    if (aValue === undefined || bValue === undefined) {
      if (aValue !== bValue) {
        return aValue === undefined ? 1 : -1;
      }
    } else if (aValue !== bValue) {
      return direction * (aValue - bValue);
    }

    return compareNatural(a.key.name, b.key.name);
  });

  return keyed.map(({ item }) => item);
};

const getCardKey = (card: FolderCard, { sortBy, sortOrder }: FolderSort): SortKey => {
  const newest = sortOrder === AssetOrder.Desc;
  switch (sortBy) {
    case FolderSortBy.DateTaken: {
      return { name: card.label, value: toTime(newest ? card.newestTakenAt : card.oldestTakenAt) };
    }
    case FolderSortBy.DateAdded: {
      return { name: card.label, value: toTime(newest ? card.newestAddedAt : card.oldestAddedAt) };
    }
    case FolderSortBy.FileSize: {
      return { name: card.label, value: card.assetCount ? (card.totalSize ?? undefined) : undefined };
    }
    default: {
      return { name: card.label };
    }
  }
};

const getAssetKey = (asset: AssetResponseDto, { sortBy }: FolderSort): SortKey => {
  switch (sortBy) {
    case FolderSortBy.DateTaken: {
      return { name: asset.originalFileName, value: toTime(asset.fileCreatedAt) };
    }
    case FolderSortBy.DateAdded: {
      return { name: asset.originalFileName, value: toTime(asset.createdAt) };
    }
    case FolderSortBy.FileSize: {
      return { name: asset.originalFileName, value: asset.exifInfo?.fileSizeInByte ?? undefined };
    }
    default: {
      return { name: asset.originalFileName };
    }
  }
};

export const sortFolderCards = (cards: FolderCard[], sort: FolderSort) =>
  sortByKey(cards, (card) => getCardKey(card, sort), sort);

export const sortFolderAssets = (assets: AssetResponseDto[], sort: FolderSort) =>
  sortByKey(assets, (asset) => getAssetKey(asset, sort), sort);
