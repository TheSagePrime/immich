import { Route } from '#lib/route.ts';
import type { MockData } from '#test/common/data.ts';
import { factory } from '#test/common/factories.ts';
import { expect, test } from '#test/medium/fixtures.ts';
import { StartPage } from '@immich/sdk';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const enableFolders = (data: MockData, startPage = StartPage.Timeline) =>
  data.setPreferences(factory.preferences({ folders: { enabled: true, sidebarWeb: true }, navigation: { startPage } }));

test.describe('folders', () => {
  test('opens the folders when they are the start page', async ({ page, data }) => {
    enableFolders(data, StartPage.Folders);
    const asset = factory.asset({ originalPath: '/library/trip/photo.jpg' });
    data.addAssets(asset);
    data.folders.addFolder('/library/trip', [asset]);

    await page.goto(Route.root());
    await expect(page).toHaveURL(Route.folders());
    await expect(page.getByTestId('folder-card')).toHaveCount(1);
  });

  test('shows the folders entry in the sidebar when enabled', async ({ page, data }) => {
    enableFolders(data);

    await page.goto(Route.photos());
    await expect(page.getByRole('link', { name: 'folders', exact: true })).toBeVisible();
  });

  test('keeps the main sidebar with folders active on every folder level', async ({ page, data, context }) => {
    enableFolders(data);
    const asset = factory.asset({ originalPath: '/library/2024/summer/a.jpg' });
    data.addAssets(asset);
    data.folders.addFolder('/library/2024/summer', [asset]);
    const openedPages: string[] = [];
    context.on('page', (newPage) => {
      openedPages.push(newPage.url());
    });

    await page.goto(Route.photos());
    const sidebarLink = page.getByTestId('sidebar-parent').getByRole('link', { name: 'folders', exact: true });
    await expect(sidebarLink).not.toHaveAttribute('target');
    await sidebarLink.click();
    await expect(page).toHaveURL(Route.folders());
    expect(openedPages).toEqual([]);

    for (const path of [undefined, '/library/2024', '/library/2024/summer']) {
      if (path) {
        await page.goto(Route.folders({ path }));
      }
      const sidebar = page.getByTestId('sidebar-parent');
      await expect(sidebar.getByRole('link', { name: 'photos', exact: true })).toBeVisible();
      await expect(sidebar.getByRole('link', { name: 'albums', exact: true })).toBeVisible();
      await expect(sidebar.getByRole('link', { name: 'folders', exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(page.getByText('explorer', { exact: true })).toHaveCount(0);
    }

    await page.goto(`/folders/photos/${asset.id}?path=/library/2024/summer`);
    await expect(page.getByTestId('sidebar-parent').locator('a[href="/folders"]')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('uploads a folder into the open folder of a writable library', async ({ page, data }) => {
    enableFolders(data);
    const library = factory.library({ name: 'Family', writable: true });
    data.addLibraries(library);
    data.folders.addWritableRoot('/library', library.id).addFolder('/library/trips/2024');

    const root = await mkdtemp(join(tmpdir(), 'immich-folders-upload-'));
    try {
      const folder = join(root, 'Day');
      await mkdir(folder);
      await writeFile(join(folder, 'a.jpg'), 'abc');

      await page.goto(Route.folders({ path: '/library/trips/2024' }));
      const chooserPromise = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'upload_folder_here' }).click();
      const chooser = await chooserPromise;
      await chooser.setFiles(folder);

      const dialog = page.getByRole('dialog');
      const destination = dialog.getByRole('navigation', { name: 'upload_folder_destination' });
      await expect(destination.getByRole('button', { name: 'trips' })).toBeVisible();
      await expect(destination.getByRole('button', { name: '2024' })).toBeVisible();
      await dialog.getByRole('button', { name: 'cancel' }).click();
      await expect(dialog).toHaveCount(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('shows covers and counts and navigates with breadcrumbs', async ({ page, data }) => {
    enableFolders(data);
    const first = factory.asset({ originalPath: '/library/2024/summer/a.jpg' });
    const second = factory.asset({ originalPath: '/library/2024/winter/b.jpg' });
    data.addAssets([first, second]);
    data.folders.addFolder('/library/2024/summer', [first]).addFolder('/library/2024/winter', [second]);

    await page.goto(Route.folders({ path: '/library/2024' }));
    const cards = page.getByTestId('folder-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.first().getByTestId('folder-cover')).toBeVisible();
    await expect(cards.first().getByTestId('folder-count')).toHaveText('items_count');

    await cards.first().getByRole('button').first().click();
    await expect(page).toHaveURL(Route.folders({ path: '/library/2024/summer' }));

    await page.getByRole('link', { name: '2024', exact: true }).click();
    await expect(page).toHaveURL(Route.folders({ path: '/library/2024' }));
  });

  test('hides management controls outside of writable libraries', async ({ page, data }) => {
    enableFolders(data);
    const asset = factory.asset({ originalPath: '/library/trip/photo.jpg' });
    data.addAssets(asset);
    data.folders.addFolder('/library/trip', [asset]);

    await page.goto(Route.folders({ path: '/library' }));
    await expect(page.getByTestId('folder-card')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'new_folder' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'select_folders' })).toHaveCount(0);
  });

  test('creates, renames, moves and deletes folders in a writable library', async ({ page, data, api }) => {
    enableFolders(data);
    data.folders.addWritableRoot('/library').addFolder('/library/a').addFolder('/library/b');

    await page.goto(Route.folders({ path: '/library' }));
    await expect(page.getByTestId('folder-card')).toHaveCount(2);

    await page.getByRole('button', { name: 'new_folder' }).first().click();
    await page.getByRole('dialog').getByLabel('name').fill('c');
    await page.getByRole('dialog').getByRole('button', { name: 'create' }).click();
    await expect(page.getByTestId('folder-card')).toHaveCount(3);
    expect(api.createFolder).toHaveBeenCalledWith({ body: { parentPath: '/library', name: 'c' } });

    await page.getByRole('button', { name: 'folder_actions' }).first().click();
    await page.getByRole('menuitem', { name: 'rename' }).click();
    await page.getByRole('dialog').getByLabel('name').fill('renamed');
    await page.getByRole('dialog').getByRole('button', { name: 'rename' }).click();
    await expect(page.getByTestId('folder-card').getByText('renamed', { exact: true })).toBeVisible();
    expect(api.renameFolder).toHaveBeenCalledWith({ body: { path: '/library/a', name: 'renamed' } });

    await page.getByRole('button', { name: 'select_folders' }).click();
    await page.getByRole('checkbox', { name: 'select_folder' }).first().click();
    await page.getByRole('button', { name: 'move_to_folder' }).click();
    const picker = page.getByRole('dialog');
    await expect(picker.getByTestId('folder-picker-path')).toHaveText('/library');
    await expect(picker.getByRole('listitem').getByRole('button', { name: 'b', exact: true })).toBeDisabled();
    await picker.getByRole('listitem').getByRole('button', { name: 'c', exact: true }).click();
    await expect(picker.getByTestId('folder-picker-path')).toHaveText('/library/c');
    await picker.getByRole('button', { name: 'move_here' }).click();
    expect(api.moveFolderItems).toHaveBeenCalledWith({
      body: { destination: '/library/c', folderPaths: ['/library/b'] },
    });

    await page.getByRole('button', { name: 'select_folders' }).click();
    await page.getByRole('checkbox', { name: 'select_folder' }).first().click();
    await page.getByRole('button', { name: 'delete_from_disk_folder' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'delete', exact: true }).click();
    expect(api.deleteFolderItems).toHaveBeenCalledWith({
      body: { force: false, folderPaths: ['/library/c'] },
    });
  });
});
