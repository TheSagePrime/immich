import type { FolderCard } from '#lib/utils/folder-cards.ts';
import {
  FOLDER_SORT_OVERRIDES_MAX,
  compareNatural,
  defaultFolderSort,
  getFolderSort,
  getFolderSortUpdate,
  sortFolderAssets,
  sortFolderCards,
} from '#lib/utils/folder-sort.ts';
import { factory } from '#test/common/factories.ts';
import { AssetOrder, FolderSortBy } from '@immich/sdk';

const card = (label: string, overrides: Partial<FolderCard> = {}): FolderCard => ({
  label,
  path: `/photos/${label}`,
  href: `/folders?path=/photos/${label}`,
  kind: 'folder',
  writable: false,
  assetCount: 1,
  coverAssetId: null,
  ...overrides,
});

const cards = [
  card('Day 10', {
    newestTakenAt: '2024-01-10T00:00:00.000Z',
    oldestTakenAt: '2024-01-01T00:00:00.000Z',
    newestAddedAt: '2024-03-01T00:00:00.000Z',
    oldestAddedAt: '2024-02-01T00:00:00.000Z',
    totalSize: 500,
  }),
  card('day 2', {
    newestTakenAt: '2024-01-05T00:00:00.000Z',
    oldestTakenAt: '2024-01-04T00:00:00.000Z',
    newestAddedAt: '2024-04-01T00:00:00.000Z',
    oldestAddedAt: '2024-01-15T00:00:00.000Z',
    totalSize: 2000,
  }),
  card('Day 1', {
    newestTakenAt: '2024-01-08T00:00:00.000Z',
    oldestTakenAt: '2024-01-02T00:00:00.000Z',
    newestAddedAt: '2024-02-15T00:00:00.000Z',
    oldestAddedAt: '2024-02-10T00:00:00.000Z',
    totalSize: 1000,
  }),
  card('empty', { assetCount: 0 }),
];

const labels = (sortBy: FolderSortBy, sortOrder: AssetOrder) =>
  sortFolderCards(cards, { sortBy, sortOrder }).map(({ label }) => label);

describe('compareNatural', () => {
  it('sorts numbers by value and ignores case', () => {
    expect(['Day 10', 'day 2', 'Day 1', 'apple'].toSorted(compareNatural)).toEqual([
      'apple',
      'Day 1',
      'day 2',
      'Day 10',
    ]);
  });
});

describe('sortFolderCards', () => {
  it('sorts by name in natural order', () => {
    expect(labels(FolderSortBy.Name, AssetOrder.Asc)).toEqual(['Day 1', 'day 2', 'Day 10', 'empty']);
    expect(labels(FolderSortBy.Name, AssetOrder.Desc)).toEqual(['empty', 'Day 10', 'day 2', 'Day 1']);
  });

  it('sorts by the newest or oldest date taken inside the folder', () => {
    expect(labels(FolderSortBy.DateTaken, AssetOrder.Desc)).toEqual(['Day 10', 'Day 1', 'day 2', 'empty']);
    expect(labels(FolderSortBy.DateTaken, AssetOrder.Asc)).toEqual(['Day 10', 'Day 1', 'day 2', 'empty']);
  });

  it('uses the oldest date taken when sorting oldest first', () => {
    const sorted = sortFolderCards(
      [
        card('a', { newestTakenAt: '2024-05-01T00:00:00.000Z', oldestTakenAt: '2020-01-01T00:00:00.000Z' }),
        card('b', { newestTakenAt: '2024-01-01T00:00:00.000Z', oldestTakenAt: '2023-01-01T00:00:00.000Z' }),
      ],
      { sortBy: FolderSortBy.DateTaken, sortOrder: AssetOrder.Asc },
    );
    expect(sorted.map(({ label }) => label)).toEqual(['a', 'b']);
  });

  it('sorts by the newest or oldest date added inside the folder', () => {
    expect(labels(FolderSortBy.DateAdded, AssetOrder.Desc)).toEqual(['day 2', 'Day 10', 'Day 1', 'empty']);
    expect(labels(FolderSortBy.DateAdded, AssetOrder.Asc)).toEqual(['day 2', 'Day 10', 'Day 1', 'empty']);
  });

  it('sorts by the total size of the folder and keeps empty folders last', () => {
    expect(labels(FolderSortBy.FileSize, AssetOrder.Desc)).toEqual(['day 2', 'Day 1', 'Day 10', 'empty']);
    expect(labels(FolderSortBy.FileSize, AssetOrder.Asc)).toEqual(['Day 10', 'Day 1', 'day 2', 'empty']);
  });

  it('breaks ties by name', () => {
    const sorted = sortFolderCards([card('b 10', { totalSize: 5 }), card('B 9', { totalSize: 5 })], {
      sortBy: FolderSortBy.FileSize,
      sortOrder: AssetOrder.Desc,
    });
    expect(sorted.map(({ label }) => label)).toEqual(['B 9', 'b 10']);
  });
});

describe('sortFolderAssets', () => {
  const assets = [
    factory.asset({
      originalFileName: 'IMG 10.jpg',
      fileCreatedAt: '2024-01-03T00:00:00.000Z',
      createdAt: '2024-02-01T00:00:00.000Z',
      exifInfo: { fileSizeInByte: 300 },
    }),
    factory.asset({
      originalFileName: 'img 2.jpg',
      fileCreatedAt: '2024-01-01T00:00:00.000Z',
      createdAt: '2024-02-03T00:00:00.000Z',
      exifInfo: { fileSizeInByte: 100 },
    }),
    factory.asset({
      originalFileName: 'IMG 1.jpg',
      fileCreatedAt: '2024-01-02T00:00:00.000Z',
      createdAt: '2024-02-02T00:00:00.000Z',
      exifInfo: { fileSizeInByte: 200 },
    }),
  ];

  const names = (sortBy: FolderSortBy, sortOrder: AssetOrder) =>
    sortFolderAssets(assets, { sortBy, sortOrder }).map(({ originalFileName }) => originalFileName);

  it('sorts every asset of the folder', () => {
    expect(names(FolderSortBy.Name, AssetOrder.Asc)).toEqual(['IMG 1.jpg', 'img 2.jpg', 'IMG 10.jpg']);
    expect(names(FolderSortBy.Name, AssetOrder.Desc)).toEqual(['IMG 10.jpg', 'img 2.jpg', 'IMG 1.jpg']);
    expect(names(FolderSortBy.DateTaken, AssetOrder.Desc)).toEqual(['IMG 10.jpg', 'IMG 1.jpg', 'img 2.jpg']);
    expect(names(FolderSortBy.DateTaken, AssetOrder.Asc)).toEqual(['img 2.jpg', 'IMG 1.jpg', 'IMG 10.jpg']);
    expect(names(FolderSortBy.DateAdded, AssetOrder.Desc)).toEqual(['img 2.jpg', 'IMG 1.jpg', 'IMG 10.jpg']);
    expect(names(FolderSortBy.DateAdded, AssetOrder.Asc)).toEqual(['IMG 10.jpg', 'IMG 1.jpg', 'img 2.jpg']);
    expect(names(FolderSortBy.FileSize, AssetOrder.Desc)).toEqual(['IMG 10.jpg', 'IMG 1.jpg', 'img 2.jpg']);
    expect(names(FolderSortBy.FileSize, AssetOrder.Asc)).toEqual(['img 2.jpg', 'IMG 1.jpg', 'IMG 10.jpg']);
  });

  it('does not change the input', () => {
    const before = assets.map(({ id }) => id);
    sortFolderAssets(assets, { sortBy: FolderSortBy.FileSize, sortOrder: AssetOrder.Asc });
    expect(assets.map(({ id }) => id)).toEqual(before);
  });
});

describe('getFolderSort', () => {
  it('defaults to name A-Z', () => {
    expect(getFolderSort(undefined, '/photos')).toEqual(defaultFolderSort);
    expect(getFolderSort({ enabled: true, sidebarWeb: true }, '/photos')).toEqual({
      sortBy: FolderSortBy.Name,
      sortOrder: AssetOrder.Asc,
    });
  });

  it('prefers the sort saved for the folder over the default', () => {
    const folders = {
      enabled: true,
      sidebarWeb: true,
      sortBy: FolderSortBy.DateAdded,
      sortOrder: AssetOrder.Desc,
      sortOverrides: [{ path: '/photos/trip', sortBy: FolderSortBy.FileSize, sortOrder: AssetOrder.Asc }],
    };

    expect(getFolderSort(folders, '/photos/trip')).toEqual({
      sortBy: FolderSortBy.FileSize,
      sortOrder: AssetOrder.Asc,
    });
    expect(getFolderSort(folders, '/photos')).toEqual({ sortBy: FolderSortBy.DateAdded, sortOrder: AssetOrder.Desc });
  });
});

describe('getFolderSortUpdate', () => {
  it('saves the sort for the folder and as the new default', () => {
    const folders = {
      enabled: true,
      sidebarWeb: true,
      sortOverrides: [
        { path: '/a', sortBy: FolderSortBy.Name, sortOrder: AssetOrder.Desc },
        { path: '/b', sortBy: FolderSortBy.FileSize, sortOrder: AssetOrder.Desc },
      ],
    };

    expect(getFolderSortUpdate(folders, '/b', { sortBy: FolderSortBy.DateTaken, sortOrder: AssetOrder.Asc })).toEqual({
      sortBy: FolderSortBy.DateTaken,
      sortOrder: AssetOrder.Asc,
      sortOverrides: [
        { path: '/b', sortBy: FolderSortBy.DateTaken, sortOrder: AssetOrder.Asc },
        { path: '/a', sortBy: FolderSortBy.Name, sortOrder: AssetOrder.Desc },
      ],
    });
  });

  it('keeps at most the newest overrides', () => {
    const sortOverrides = Array.from({ length: FOLDER_SORT_OVERRIDES_MAX }, (_, index) => ({
      path: `/folder-${index}`,
      sortBy: FolderSortBy.Name,
      sortOrder: AssetOrder.Asc,
    }));

    const update = getFolderSortUpdate({ enabled: true, sidebarWeb: true, sortOverrides }, '/new', defaultFolderSort);
    expect(update.sortOverrides).toHaveLength(FOLDER_SORT_OVERRIDES_MAX);
    expect(update.sortOverrides[0].path).toBe('/new');
    expect(update.sortOverrides.at(-1)?.path).toBe(`/folder-${FOLDER_SORT_OVERRIDES_MAX - 2}`);
  });
});
