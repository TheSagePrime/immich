import FolderPickerModal from '#lib/modals/FolderPickerModal.svelte';
import { test } from '#test/unit/fixtures.ts';
import { expect } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';

test('lists the writable roots and disables confirming there', async ({ data }) => {
  data.folders.addWritableRoot('/library');
  const onClose = vi.fn();

  await render(FolderPickerModal, { onClose });

  await expect.element(page.getByTestId('folder-picker-path')).toHaveTextContent('writable_library_folders');
  await expect.element(page.getByRole('button', { name: 'move_here' })).toBeDisabled();
  await page.getByRole('listitem').getByRole('button', { name: '/library' }).click();
  await expect.element(page.getByTestId('folder-picker-path')).toHaveTextContent('/library');
  await expect.element(page.getByRole('button', { name: 'move_here' })).toBeEnabled();
});

test('disables the moved folder and its descendants', async ({ data }) => {
  data.folders.addWritableRoot('/library').addFolder('/library/a/inner').addFolder('/library/b');
  const onClose = vi.fn();

  await render(FolderPickerModal, { onClose, folderPaths: ['/library/a'], initialPath: '/library' });

  await expect.element(page.getByRole('listitem').filter({ hasText: 'a' }).getByRole('button')).toBeDisabled();
  await page.getByRole('listitem').filter({ hasText: 'b' }).getByRole('button').click();
  await expect.element(page.getByTestId('folder-picker-path')).toHaveTextContent('/library/b');
  await page.getByRole('button', { name: 'move_here' }).click();

  expect(onClose).toHaveBeenCalledWith('/library/b');
});
