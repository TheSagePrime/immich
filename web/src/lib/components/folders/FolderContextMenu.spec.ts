import FolderContextMenu from '#lib/components/folders/FolderContextMenu.svelte';
import { mdiDownload, mdiFolderOpenOutline, mdiRename } from '@mdi/js';
import { expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page, userEvent } from 'vitest/browser';

const setup = async () => {
  const onOpen = vi.fn();
  const onRename = vi.fn();
  const onDownload = vi.fn();
  const onClose = vi.fn();
  await render(FolderContextMenu, {
    x: 10,
    y: 10,
    label: 'Actions for Goa',
    onClose,
    items: [
      { id: 'open', title: 'Open', icon: mdiFolderOpenOutline, onAction: onOpen },
      { id: 'rename', title: 'Rename', icon: mdiRename, disabled: true, hint: 'Read-only library', onAction: onRename },
      { id: 'download', title: 'Download', icon: mdiDownload, onAction: onDownload },
    ],
  });
  return { onOpen, onRename, onDownload, onClose };
};

describe('FolderContextMenu', () => {
  it('renders an accessible menu with disabled items and their hint', async () => {
    await setup();

    await expect.element(page.getByRole('menu', { name: 'Actions for Goa' })).toBeVisible();
    const rename = page.getByRole('menuitem', { name: /Rename/ });
    await expect.element(rename).toBeDisabled();
    await expect.element(rename).toHaveAttribute('title', 'Read-only library');
    await expect.element(page.getByText('Read-only library')).toBeVisible();
    await expect.element(page.getByRole('menuitem', { name: 'Open' })).toHaveFocus();
  });

  it('moves the focus with the arrow keys, skips disabled items and runs the item on Enter', async () => {
    const { onDownload, onClose } = await setup();

    await userEvent.keyboard('{ArrowDown}');
    await expect.element(page.getByRole('menuitem', { name: 'Download' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');

    expect(onClose).toHaveBeenCalled();
    expect(onDownload).toHaveBeenCalled();
  });

  it('closes on Escape without running an item', async () => {
    const { onOpen, onClose } = await setup();

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });
});
