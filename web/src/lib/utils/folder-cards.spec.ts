import { getFolderCards } from '#lib/utils/folder-cards.ts';
import { TreeNode } from '#lib/utils/tree-utils.ts';
import type { FolderSummaryResponseDto } from '@immich/sdk';

const summary = (overrides: Partial<FolderSummaryResponseDto> = {}): FolderSummaryResponseDto => ({
  path: '/',
  directAssetCount: 0,
  children: [],
  writable: false,
  isLibraryRoot: false,
  ...overrides,
});

describe('getFolderCards', () => {
  it('should keep collapsed tree labels and look up counts by their first segment', () => {
    const tree = TreeNode.fromPaths(['/mnt/photos/2020', '/mnt/photos/2021', '/srv/other']);
    tree.collapse();
    const root = tree.get('/')!;

    const cards = getFolderCards(
      summary({
        children: [
          { name: 'mnt', path: '/mnt', assetCount: 5, coverAssetId: 'cover-mnt' },
          { name: 'srv', path: '/srv', assetCount: 1, coverAssetId: 'cover-srv' },
          { name: 'writable', path: '/writable', assetCount: 0, coverAssetId: null },
        ],
      }),
      root,
    );

    expect(cards).toEqual([
      { label: 'mnt/photos', path: '/mnt/photos', assetCount: 5, coverAssetId: 'cover-mnt' },
      { label: 'srv/other', path: '/srv/other', assetCount: 1, coverAssetId: 'cover-srv' },
      { label: 'writable', path: '/writable', assetCount: 0, coverAssetId: null },
    ]);
  });

  it('should use the summary children inside writable libraries', () => {
    const tree = TreeNode.fromPaths(['/library/a/b']);
    tree.collapse();

    const cards = getFolderCards(
      summary({
        path: '/library',
        writable: true,
        children: [
          { name: 'a', path: '/library/a', assetCount: 1, coverAssetId: 'cover-a' },
          { name: 'empty', path: '/library/empty', assetCount: 0, coverAssetId: null },
        ],
      }),
      tree,
    );

    expect(cards.map(({ label }) => label)).toEqual(['a', 'empty']);
  });

  it('should use the summary children when the folder is not in the tree', () => {
    const cards = getFolderCards(
      summary({ path: '/new', children: [{ name: 'x', path: '/new/x', assetCount: 0, coverAssetId: null }] }),
      undefined,
    );

    expect(cards).toEqual([{ label: 'x', path: '/new/x', assetCount: 0, coverAssetId: null }]);
  });
});
