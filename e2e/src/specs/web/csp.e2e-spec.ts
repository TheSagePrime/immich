import { LoginResponseDto, SharedLinkType } from '@immich/sdk';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { testAssetDir, utils } from 'src/utils.js';

const collectViolations = (page: Page) => {
  const violations: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to (load|execute|apply|connect|frame|create)/i.test(text)) {
      violations.push(text);
    }
  });
  return violations;
};

test.describe('Content-Security-Policy', () => {
  let admin: LoginResponseDto;
  let assetId: string;
  let sharedLinkKey: string;

  test.beforeAll(async () => {
    utils.initSdk();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    const asset = await utils.createAsset(admin.accessToken, {
      assetData: {
        filename: 'el_torcal_rocks.jpg',
        bytes: readFileSync(`${testAssetDir}/formats/jpg/el_torcal_rocks.jpg`),
      },
    });
    assetId = asset.id;
    await utils.waitForQueueFinish(admin.accessToken, 'thumbnailGeneration');
    const link = await utils.createSharedLink(admin.accessToken, {
      type: SharedLinkType.Individual,
      assetIds: [assetId],
    });
    sharedLinkKey = link.key;
  });

  test('the web app loads under the strict policy', async ({ context, page }) => {
    const violations = collectViolations(page);
    await utils.setAuthCookies(context, admin.accessToken);

    const response = await page.goto('/photos');
    expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
    await expect(page.locator(`[data-thumbnail-focus-container]`).first()).toBeVisible();

    for (const path of [
      '/albums',
      '/sharing',
      '/shared-links',
      '/explore',
      '/folders',
      '/user-settings',
      '/admin/system-settings',
    ]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
    }

    await page.goto(`/photos/${assetId}`);
    await expect(page.locator('#immich-asset-viewer img').first()).toBeVisible();
    await page.waitForLoadState('networkidle');

    expect(violations).toEqual([]);
  });

  test('a shared link loads under the strict policy', async ({ page }) => {
    const violations = collectViolations(page);
    await page.goto(`/share/${sharedLinkKey}`);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('img').first()).toBeVisible();
    expect(violations).toEqual([]);
  });

  test('the login page loads under the strict policy', async ({ page }) => {
    const violations = collectViolations(page);
    await page.goto('/auth/login');
    await expect(page.getByRole('button', { name: 'Login', exact: true })).toBeVisible();
    expect(violations).toEqual([]);
  });
});
