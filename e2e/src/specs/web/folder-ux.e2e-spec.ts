import { LoginResponseDto } from '@immich/sdk';
import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { testAssetDir, testAssetDirInternal, utils } from 'src/utils.js';

const hostRoot = `${testAssetDir}/temp/folder-ux-web`;
const root = `${testAssetDirInternal}/temp/folder-ux-web`;
const readOnlyHostRoot = `${testAssetDir}/temp/folder-ux-web-readonly`;
const readOnlyRoot = `${testAssetDirInternal}/temp/folder-ux-web-readonly`;

test.describe.configure({ mode: 'serial' });

test.describe('Folders file manager', () => {
  let admin: LoginResponseDto;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();

    utils.resetTempFolder();
    utils.createImageFile(`${hostRoot}/Day 10/a.png`);
    utils.createImageFile(`${hostRoot}/Day 2/b.png`);
    utils.createImageFile(`${hostRoot}/Day 1/c.png`);
    utils.createImageFile(`${readOnlyHostRoot}/Trips/d.png`);

    const writable = await utils.createLibrary(admin.accessToken, {
      ownerId: admin.userId,
      name: 'Family',
      importPaths: [root],
      writable: true,
    });
    await utils.scan(admin.accessToken, writable.id);
    const readOnly = await utils.createLibrary(admin.accessToken, {
      ownerId: admin.userId,
      name: 'Media',
      importPaths: [readOnlyRoot],
    });
    await utils.scan(admin.accessToken, readOnly.id);

    await utils.updateMyPreferences(admin.accessToken, { folders: { enabled: true, sidebarWeb: true } });
  });

  test.afterAll(() => {
    utils.resetTempFolder();
  });

  test.beforeEach(async ({ context }) => {
    await utils.setAuthCookies(context, admin.accessToken);
  });

  test('shows library names at the top level without paths', async ({ page }) => {
    await page.goto('/folders');
    const labels = page.getByTestId('folder-card-label');
    await expect(labels).toHaveText(['Family', 'Media']);
    for (const label of await labels.allTextContents()) {
      expect(label).not.toContain('/');
    }
  });

  test('opens the context menu on right-click and renames with F2', async ({ page }) => {
    await page.goto('/folders');
    await page.getByTestId('folder-card').filter({ hasText: 'Family' }).getByTestId('folder-card-button').click();
    await expect(page.getByTestId('folder-card-label')).toHaveText(['Day 1', 'Day 2', 'Day 10']);

    const card = page.getByTestId('folder-card').filter({ hasText: 'Day 1' }).first();
    await card.click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    await card.getByTestId('folder-card-button').click({ modifiers: ['ControlOrMeta'] });
    await page.locator('body').press('F2');
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox').fill('Day 1 renamed');
    await dialog.getByRole('button', { name: 'Rename' }).click();

    await expect(page.getByTestId('folder-card-label')).toContainText(['Day 1 renamed']);
    await expect.poll(() => existsSync(`${hostRoot}/Day 1 renamed/c.png`)).toBe(true);
  });

  test('disables the write items in a read-only library', async ({ page }) => {
    await page.goto('/folders');
    await page.getByTestId('folder-card').filter({ hasText: 'Media' }).getByTestId('folder-card-button').click();
    await expect(page.getByTestId('new-folder-button')).toBeDisabled();

    await page.getByTestId('folder-card').filter({ hasText: 'Trips' }).click({ button: 'right' });
    const menu = page.getByRole('menu');
    for (const id of ['new-folder', 'rename', 'move', 'delete', 'upload']) {
      await expect(menu.getByTestId(`folder-menu-${id}`)).toBeDisabled();
      await expect(menu.getByTestId(`folder-menu-${id}`)).toHaveAttribute('title', 'Read-only library');
    }
    await expect(menu.getByTestId('folder-menu-open')).toBeEnabled();
    await expect(menu.getByTestId('folder-menu-download')).toBeEnabled();
  });

  test('reorders the cards when a sort is chosen', async ({ page }) => {
    await page.goto('/folders');
    await page.getByTestId('folder-card').filter({ hasText: 'Family' }).getByTestId('folder-card-button').click();
    const labels = page.getByTestId('folder-card-label');
    await expect(labels).toHaveText(['Day 1 renamed', 'Day 2', 'Day 10']);

    await page.getByTestId('folder-sort').getByRole('button').first().click();
    await page.getByRole('button', { name: 'Name (Z-A)' }).click();
    await expect(labels).toHaveText(['Day 10', 'Day 2', 'Day 1 renamed']);

    await page.reload();
    await expect(labels).toHaveText(['Day 10', 'Day 2', 'Day 1 renamed']);
  });
});
