import { Route } from '#lib/route.ts';
import type { MockData } from '#test/common/data.ts';
import { expect, test } from '#test/medium/fixtures.ts';
import type { Page } from '@playwright/test';

const hiddenInSimpleMode = ['explore', 'map', 'utilities', 'locked_folder'];
const alwaysShown = ['photos', 'sharing', 'favorites', 'albums', 'archive', 'trash'];

const setSimpleMode = (data: MockData, simpleMode: boolean) => {
  data.userConfig.server.simpleMode = simpleMode;
  data.adminConfig = { ...data.adminConfig, server: { ...data.adminConfig.server, simpleMode } };
};

const sidebarLink = (page: Page, name: string) =>
  page.locator('#sidebar').getByRole('link', { name, exact: true });

test.describe('simple mode', () => {
  test('hides rarely used items from the sidebar', async ({ page, data }) => {
    setSimpleMode(data, true);

    await page.goto(Route.photos());
    for (const name of alwaysShown) {
      await expect(sidebarLink(page, name)).toBeVisible();
    }
    for (const name of hiddenInSimpleMode) {
      await expect(sidebarLink(page, name)).toHaveCount(0);
    }
  });

  test('shows every item when simple mode is off', async ({ page, data }) => {
    setSimpleMode(data, false);

    await page.goto(Route.photos());
    for (const name of [...alwaysShown, ...hiddenInSimpleMode]) {
      await expect(sidebarLink(page, name)).toBeVisible();
    }
  });

  test('keeps hidden pages reachable by their address', async ({ page, data }) => {
    setSimpleMode(data, true);

    await page.goto(Route.utilities());
    await expect(page).toHaveURL(Route.utilities());
    await expect(sidebarLink(page, 'utilities')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'review_duplicates' }).first()).toBeVisible();
  });

  test('turns simple mode off from the server settings', async ({ page, data, api }) => {
    setSimpleMode(data, true);

    await page.goto(Route.systemSettings());
    await page.getByRole('button', { name: /admin\.server_settings/ }).click();
    const toggle = page.getByRole('switch', { name: 'admin.server_simple_mode' });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await page.getByRole('button', { name: 'save', exact: true }).click();

    await expect.poll(() => api.updateAdminConfig.calls.length).toBeGreaterThan(0);
    expect(api.updateAdminConfig).toHaveBeenCalledWith({
      body: expect.objectContaining({ server: expect.objectContaining({ simpleMode: false }) }),
    });
  });
});
