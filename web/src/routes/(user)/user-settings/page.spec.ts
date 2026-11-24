import { OpenQueryParam } from '#lib/constants.ts';
import { Route } from '#lib/route.ts';
import { test } from '#test/unit/fixtures.ts';
import { expect } from 'vitest';
import { page } from 'vitest/browser';
import Page from './+page.svelte';
import { load } from './+page.ts';

test('links to the OAuth account management page', async ({ data, router, render, app }) => {
  data.user.oauthId = 'oauth-user';
  data.userConfig.oauth.enabled = true;
  data.userConfig.oauth.accountManagementUrl = 'https://idp.example/account';
  await router.goto(Route.userSettings({ isOpen: OpenQueryParam.OAUTH }));

  await render(Page, load);

  await expect.element(app.settings.manageOauthAccountLink).toHaveAttribute('href', 'https://idp.example/account');
});

test('turns folder albums off in the feature settings', async ({ router, render, settle, api }) => {
  await router.goto('/user-settings?isOpen=feature+albums');

  await render(Page, load);
  await settle();

  await page.getByRole('switch', { name: 'folder_albums' }).click();
  await page.getByRole('button', { name: 'save', exact: true }).click();
  await settle();

  expect(api.updateMyPreferences).toHaveBeenCalledWith({
    body: expect.objectContaining({ folderAlbums: { enabled: false } }),
  });
});
