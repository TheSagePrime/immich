import { Route } from '#lib/route.ts';
import type { MockData } from '#test/common/data.ts';
import { factory } from '#test/common/factories.ts';
import { expect, test } from '#test/medium/fixtures.ts';
import { AssetOrder, FolderSortBy } from '@immich/sdk';

const enableFolders = (data: MockData) =>
  data.setPreferences(factory.preferences({ folders: { enabled: true, sidebarWeb: true } }));

const writableLibrary = (data: MockData) => {
  const library = factory.library({ name: 'Family', writable: true });
  data.addLibraries(library);
  data.folders.addWritableRoot('/library', library.id).setRootName('/library', 'Family');
  return library;
};

const cardLabels = (page: import('@playwright/test').Page) =>
  page.getByTestId('folder-card').getByTestId('folder-card-label').allTextContents();

test.describe('folder roots and names', () => {
  test('shows friendly roots without internal paths', async ({ page, data }) => {
    enableFolders(data);
    const media = factory.asset({ originalPath: '/mnt/media/Trips/Goa/a.jpg' });
    const upload = factory.asset({ originalPath: '/data/library/admin/2026/b.jpg' });
    data.addAssets([media, upload]);
    data.folders.addFolder('/mnt/media/Trips/Goa', [media]).setRootName('/mnt', 'Media');
    data.folders.setUploadsPath('/data/library/admin').addFolder('/data/library/admin/2026', [upload]);

    await page.goto(Route.folders());
    await expect(page.getByTestId('folder-card')).toHaveCount(2);
    await expect(page.getByTestId('folder-card-label')).toHaveText(['Media', 'phone_uploads']);
    const labels = await cardLabels(page);
    expect(labels.some((label) => label.includes('/'))).toBe(false);

    await page.getByTestId('folder-card').first().getByTestId('folder-card-button').click();
    await expect(page).toHaveURL(Route.folders({ root: 'library-mnt' }));
    await expect(page.getByTestId('folder-card-label')).toHaveText(['media']);

    await page.goto(Route.folders({ root: 'library-mnt', path: 'media/Trips' }));
    await expect(page.getByTestId('folder-card-label')).toHaveText(['Goa']);
    const crumbs = page.getByTestId('folder-breadcrumbs');
    await expect(crumbs).toContainText('Media');
    await expect(crumbs).toContainText('Trips');
    await expect(crumbs).not.toContainText('/mnt');
  });

  test('redirects old ?path= links to the root and relative path', async ({ page, data }) => {
    enableFolders(data);
    const asset = factory.asset({ originalPath: '/library/2024/summer/a.jpg' });
    data.addAssets(asset);
    data.folders.addFolder('/library/2024/summer', [asset]);

    await page.goto(Route.folders({ path: '/library/2024' }));
    await expect(page).toHaveURL(Route.folders({ root: 'library-library', path: '2024' }));
    await expect(page.getByTestId('folder-card')).toHaveCount(1);
  });
});

test.describe('folder context menu', () => {
  test('opens on right-click with every item enabled in a writable library', async ({ page, data }) => {
    enableFolders(data);
    writableLibrary(data);
    data.folders.addFolder('/library/a');

    await page.goto(Route.folders({ path: '/library' }));
    await page.getByTestId('folder-card').first().click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    for (const id of ['open', 'new-folder', 'rename', 'move', 'delete', 'upload', 'download']) {
      await expect(menu.getByTestId(`folder-menu-${id}`)).toBeEnabled();
    }
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });

  test('disables the write items in a read-only library', async ({ page, data }) => {
    enableFolders(data);
    const asset = factory.asset({ originalPath: '/media/trip/photo.jpg' });
    data.addAssets(asset);
    data.folders.addFolder('/media/trip', [asset]);

    await page.goto(Route.folders({ path: '/media' }));
    await page.getByRole('button', { name: 'folder_actions' }).first().click();
    const menu = page.getByRole('menu');
    for (const id of ['new-folder', 'rename', 'move', 'delete', 'upload']) {
      await expect(menu.getByTestId(`folder-menu-${id}`)).toBeDisabled();
      await expect(menu.getByTestId(`folder-menu-${id}`)).toHaveAttribute('title', 'read_only_library');
    }
    await expect(menu.getByTestId('folder-menu-open')).toBeEnabled();
    await expect(menu.getByTestId('folder-menu-download')).toBeEnabled();
    await expect(page.getByTestId('new-folder-button')).toBeDisabled();

    await page.keyboard.press('Escape');
    await page.getByTestId('folder-card').first().getByTestId('folder-card-button').click();
    await page.locator(`[data-asset="${asset.id}"]`).click({ button: 'right' });
    await expect(page.getByRole('menu').getByTestId('folder-menu-rename')).toBeDisabled();
    await expect(page.getByRole('menu').getByTestId('folder-menu-download')).toBeEnabled();
  });
});

test.describe('folder selection and keyboard', () => {
  test('selects with Ctrl and Shift, renames with F2 and deletes with Delete', async ({ page, data, api }) => {
    enableFolders(data);
    writableLibrary(data);
    data.folders.addFolder('/library/a').addFolder('/library/b').addFolder('/library/c').addFolder('/library/d');

    await page.goto(Route.folders({ path: '/library' }));
    const cards = page.getByTestId('folder-card');
    await expect(cards).toHaveCount(4);

    await cards
      .nth(0)
      .getByTestId('folder-card-button')
      .click({ modifiers: ['ControlOrMeta'] });
    await expect(cards.nth(0)).toHaveAttribute('data-selected');
    await cards
      .nth(2)
      .getByTestId('folder-card-button')
      .click({ modifiers: ['Shift'] });
    for (const index of [0, 1, 2]) {
      await expect(cards.nth(index)).toHaveAttribute('data-selected');
    }
    await expect(cards.nth(3)).not.toHaveAttribute('data-selected');

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="folder-card"][data-selected]')).toHaveCount(0);

    await cards
      .nth(1)
      .getByTestId('folder-card-button')
      .click({ modifiers: ['ControlOrMeta'] });
    await page.locator('body').press('F2');
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('name').fill('renamed');
    await dialog.getByRole('button', { name: 'rename' }).click();
    expect(api.renameFolder).toHaveBeenCalledWith({ body: { path: '/library/b', name: 'renamed' } });

    await cards
      .nth(0)
      .getByTestId('folder-card-button')
      .click({ modifiers: ['ControlOrMeta'] });
    await page.locator('body').press('Delete');
    await page.getByRole('dialog').getByRole('button', { name: 'delete', exact: true }).click();
    expect(api.deleteFolderItems).toHaveBeenCalledWith({ body: { force: false, folderPaths: ['/library/a'] } });
  });

  test('selects every folder and photo with Ctrl+A', async ({ page, data }) => {
    enableFolders(data);
    writableLibrary(data);
    const asset = factory.asset({ originalPath: '/library/photo.jpg' });
    data.addAssets(asset);
    data.folders.addFolder('/library', [asset]).addFolder('/library/a').addFolder('/library/b');

    await page.goto(Route.folders({ path: '/library' }));
    await expect(page.getByTestId('folder-card')).toHaveCount(2);
    await page.locator('body').press('ControlOrMeta+a');
    await expect(page.locator('[data-testid="folder-card"][data-selected]')).toHaveCount(2);
    await expect(page.locator(`[data-asset="${asset.id}"][data-selected]`)).toHaveCount(1);
  });

  test('moves a dragged folder onto another folder card', async ({ page, data, api }) => {
    enableFolders(data);
    writableLibrary(data);
    data.folders.addFolder('/library/a').addFolder('/library/b');

    await page.goto(Route.folders({ path: '/library' }));
    const cards = page.getByTestId('folder-card');
    await cards.nth(0).dragTo(cards.nth(1));

    await expect.poll(() => api.moveFolderItems.calls.length).toBe(1);
    expect(api.moveFolderItems).toHaveBeenCalledWith({
      body: { destination: '/library/b', folderPaths: ['/library/a'] },
    });
  });
});

test.describe('folder sort', () => {
  test('keeps folders before photos and remembers the sort per folder', async ({ page, data, api }) => {
    enableFolders(data);
    const assets = [
      factory.asset({
        originalPath: '/media/photo 10.jpg',
        originalFileName: 'photo 10.jpg',
        exifInfo: { fileSizeInByte: 300 },
      }),
      factory.asset({
        originalPath: '/media/photo 2.jpg',
        originalFileName: 'photo 2.jpg',
        exifInfo: { fileSizeInByte: 100 },
      }),
    ];
    data.addAssets(assets);
    data.folders.addFolder('/media', assets).addFolder('/media/Day 10/x').addFolder('/media/Day 2/y');

    await page.goto(Route.folders({ path: '/media' }));
    await expect(page.getByTestId('folder-card-label')).toHaveText(['Day 2', 'Day 10']);
    const thumbnails = page.locator('[data-testid="folder-assets"] [data-asset]');
    await expect(thumbnails).toHaveCount(2);
    await expect(thumbnails.first()).toHaveAttribute('data-asset', assets[1].id);

    const cardsBox = await page.getByTestId('folder-cards').boundingBox();
    const assetsBox = await page.getByTestId('folder-assets').boundingBox();
    expect(cardsBox!.y).toBeLessThan(assetsBox!.y);

    await page.getByTestId('folder-sort').getByRole('button').first().click();
    await page.getByRole('button', { name: 'sort_name_descending' }).click();
    await expect(page.getByTestId('folder-card-label')).toHaveText(['Day 10', 'Day 2']);
    await expect(thumbnails.first()).toHaveAttribute('data-asset', assets[0].id);

    await expect.poll(() => api.updateMyPreferences.calls.length).toBe(1);
    expect(api.updateMyPreferences).toHaveBeenCalledWith({
      body: {
        folders: expect.objectContaining({
          sortBy: FolderSortBy.Name,
          sortOrder: AssetOrder.Desc,
          sortOverrides: [{ path: '/media', sortBy: FolderSortBy.Name, sortOrder: AssetOrder.Desc }],
        }),
      },
    });

    await page.reload();
    await expect(page.getByTestId('folder-card-label')).toHaveText(['Day 10', 'Day 2']);
  });
});
