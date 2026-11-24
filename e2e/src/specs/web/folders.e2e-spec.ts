import { LoginResponseDto, StartPage } from '@immich/sdk';
import { expect, Page, test } from '@playwright/test';
import { utils } from 'src/utils.js';

const expectMainSidebar = async (page: Page) => {
  const sidebar = page.getByTestId('sidebar-parent');
  await expect(sidebar.getByRole('link', { name: 'Photos', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Albums', exact: true })).toBeVisible();
  await expect(sidebar.getByRole('link', { name: 'Folders', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('Explorer', { exact: true })).toHaveCount(0);
};

test.describe('Folders', () => {
  let admin: LoginResponseDto;
  let originalPath: string;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    const asset = await utils.createAsset(admin.accessToken);
    const info = await utils.getAssetInfo(admin.accessToken, asset.id);
    originalPath = info.originalPath;
  });

  for (const startPage of [StartPage.Timeline, StartPage.Folders]) {
    test(`keeps the main layout from the sidebar link (start page: ${startPage})`, async ({ context, page }) => {
      await utils.updateMyPreferences(admin.accessToken, {
        folders: { enabled: true, sidebarWeb: true },
        navigation: { startPage },
      });
      await utils.setAuthCookies(context, admin.accessToken);

      const openedPages: string[] = [];
      context.on('page', (newPage) => {
        openedPages.push(newPage.url());
      });

      await page.goto('/photos');
      const link = page.getByTestId('sidebar-parent').getByRole('link', { name: 'Folders', exact: true });
      await expect(link).toBeVisible();
      await expect(link).not.toHaveAttribute('target');

      await link.click();
      await expect(page).toHaveURL(/\/folders$/);
      await expectMainSidebar(page);

      const cards = page.getByTestId('folder-card');
      await expect(cards.first()).toBeVisible();
      await cards.first().getByRole('button').first().click();

      await expect(page).toHaveURL(/\/folders\?path=/);
      await expectMainSidebar(page);
      const folderName = originalPath.split('/').at(-2)!;
      await expect(page.getByRole('main').getByRole('link', { name: 'Folders', exact: true })).toBeVisible();
      await expect(page.getByRole('main').getByText(folderName, { exact: true })).toBeVisible();

      expect(openedPages).toEqual([]);
      expect(context.pages()).toHaveLength(1);
    });
  }
});
