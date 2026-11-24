import { Route } from '#lib/route.ts';
import { test } from '#test/unit/fixtures.ts';
import { expect } from 'vitest';
import { page } from 'vitest/browser';
import Page from './+page.svelte';
import { load } from './+page.ts';

const rateLimitSwitch = () => page.getByRole('switch', { name: 'admin.password_rate_limit_enable' });
const numberField = (index: number) => page.getByRole('spinbutton').nth(index);
const accountField = () => numberField(0);
const ipField = () => numberField(1);

test.beforeEach(async ({ router, render, app }) => {
  await router.goto(Route.systemSettings());
  await render(Page, load);
  await app.admin.settings.open('admin.authentication_settings');
  await app.admin.settings.open('admin.password_settings');
  await expect.element(rateLimitSwitch()).toBeVisible();
});

test('shows the login rate limit settings', async () => {
  await expect.element(rateLimitSwitch()).toBeChecked();
  await expect.element(accountField()).toHaveValue(5);
  await expect.element(ipField()).toHaveValue(30);
  await expect.element(numberField(2)).toHaveValue(15);
  await expect.element(numberField(3)).toHaveValue(1);
  await expect.element(numberField(4)).toHaveValue(60);
  await expect.element(page.getByText('admin.password_rate_limit_account_max_failures_description')).toBeVisible();
});

test('hides the limits when rate limiting is turned off', async () => {
  await rateLimitSwitch().click();

  await expect.element(rateLimitSwitch()).not.toBeChecked();
  await expect.element(page.getByRole('spinbutton')).not.toBeInTheDocument();
});

test('saves the changed limits', async ({ api, settle }) => {
  await accountField().fill('8');
  await ipField().fill('0');
  await page.getByRole('button', { name: 'save', exact: true }).click();
  await settle();

  expect(api.updateAdminConfig).toHaveBeenCalledWith({
    body: expect.objectContaining({
      passwordLogin: {
        enabled: true,
        rateLimit: {
          enabled: true,
          accountMaxFailures: 8,
          ipMaxFailures: 0,
          windowMinutes: 15,
          lockoutMinutes: 1,
          maxLockoutMinutes: 60,
        },
      },
    }),
  });
});
