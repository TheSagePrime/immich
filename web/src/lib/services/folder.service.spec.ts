import { getFolderAssetMenuItems, getFolderCardMenuItems } from '#lib/services/folder.service.ts';
import type { FolderCard } from '#lib/utils/folder-cards.ts';
import { factory } from '#test/common/factories.ts';
import type { MessageFormatter } from 'svelte-i18n';

const $t = ((key: string) => key) as MessageFormatter;

const folder = (overrides: Partial<FolderCard> = {}): FolderCard => ({
  label: 'Goa',
  path: '/library/Trips/Goa',
  href: '/folders?root=library&path=Trips%2FGoa',
  kind: 'folder',
  writable: true,
  folderPath: '/library/Trips/Goa',
  ...overrides,
});

const context = (writable: boolean) => ({
  writable,
  onOpen: vi.fn(),
  selection: { folderPaths: ['/library/Trips/Goa'], assetIds: [] },
});

const summarize = (items: { id: string; disabled?: boolean; hint?: string }[]) =>
  items.map(({ id, disabled, hint }) => ({ id, disabled: !!disabled, hint }));

describe('getFolderCardMenuItems', () => {
  it('enables every item in a writable library', () => {
    expect(summarize(getFolderCardMenuItems($t, folder(), context(true)))).toEqual([
      { id: 'open', disabled: false, hint: undefined },
      { id: 'new-folder', disabled: false, hint: undefined },
      { id: 'rename', disabled: false, hint: undefined },
      { id: 'move', disabled: false, hint: undefined },
      { id: 'delete', disabled: false, hint: undefined },
      { id: 'upload', disabled: false, hint: undefined },
      { id: 'download', disabled: false, hint: undefined },
    ]);
  });

  it('disables the write items in a read-only library and keeps open and download', () => {
    const items = getFolderCardMenuItems($t, folder({ writable: false }), context(false));

    expect(summarize(items)).toEqual([
      { id: 'open', disabled: false, hint: undefined },
      { id: 'new-folder', disabled: true, hint: 'read_only_library' },
      { id: 'rename', disabled: true, hint: 'read_only_library' },
      { id: 'move', disabled: true, hint: 'read_only_library' },
      { id: 'delete', disabled: true, hint: 'read_only_library' },
      { id: 'upload', disabled: true, hint: 'read_only_library' },
      { id: 'download', disabled: false, hint: undefined },
    ]);
  });

  it('offers no rename, move or delete for a library root', () => {
    const root = folder({ kind: 'root', path: 'root:media', folderPath: '/mnt/media', writable: false });
    expect(getFolderCardMenuItems($t, root, context(false)).map(({ id }) => id)).toEqual([
      'open',
      'new-folder',
      'upload',
      'download',
    ]);
  });

  it('runs the open action', async () => {
    const ctx = context(false);
    const [open] = getFolderCardMenuItems($t, folder(), ctx);
    await open.onAction();
    expect(ctx.onOpen).toHaveBeenCalled();
  });
});

describe('getFolderAssetMenuItems', () => {
  const asset = factory.asset({ originalFileName: 'IMG_1.jpg' });

  it('lists the photo items and disables writing outside writable libraries', () => {
    expect(summarize(getFolderAssetMenuItems($t, asset, { ...context(false), currentPath: '/mnt/media' }))).toEqual([
      { id: 'open', disabled: false, hint: undefined },
      { id: 'new-folder', disabled: true, hint: 'read_only_library' },
      { id: 'rename', disabled: true, hint: 'read_only_library' },
      { id: 'move', disabled: true, hint: 'read_only_library' },
      { id: 'delete', disabled: true, hint: 'read_only_library' },
      { id: 'upload', disabled: true, hint: 'read_only_library' },
      { id: 'download', disabled: false, hint: undefined },
    ]);
    expect(
      getFolderAssetMenuItems($t, asset, { ...context(true), currentPath: '/library' }).some(
        ({ disabled }) => disabled,
      ),
    ).toBe(false);
  });
});
