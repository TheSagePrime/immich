import { Route } from '#lib/route.ts';
import type { MockData } from '#test/common/data.ts';
import { factory } from '#test/common/factories.ts';
import { expect, test } from '#test/medium/fixtures.ts';
import { StartPage } from '@immich/sdk';

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
