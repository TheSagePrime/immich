import { Route } from '#lib/route.ts';
import { factory } from '#test/common/factories.ts';
import { expect, test } from '#test/medium/fixtures.ts';

test.describe('library administration', () => {
  test('enables and disables writing files for a library', async ({ page, data, api, app }) => {
    const { form } = app.admin.libraries;
    const library = factory.library({ name: 'Family Photos' });
    data.addLibraries(library);

    await page.goto(Route.editLibrary(library));
    await expect(form.writableSwitch).not.toBeChecked();
    await expect(app.admin.libraries.writableBadge).toBeHidden();
    await form.writableSwitch.click();
    await expect(form.writableSwitch).toBeChecked();
    await form.saveButton.click();
    await expect(page).toHaveURL(Route.viewLibrary(library));
    await expect(app.admin.libraries.writableBadge).toBeVisible();
    expect(api.updateLibrary).toHaveBeenCalledWith({
      params: { id: library.id },
      body: { name: 'Family Photos', writable: true },
    });

    await page.goto(Route.editLibrary(library));
    await expect(form.writableSwitch).toBeChecked();
    await form.writableSwitch.click();
    await expect(form.writableSwitch).not.toBeChecked();
    await form.saveButton.click();
    await expect(page).toHaveURL(Route.viewLibrary(library));
    await expect(app.admin.libraries.writableBadge).toBeHidden();
    expect(api.updateLibrary).toHaveBeenCalledWith({
      params: { id: library.id },
      body: { name: 'Family Photos', writable: false },
    });
  });

  test('renaming a library does not send the writable flag', async ({ page, data, api, app }) => {
    const { form } = app.admin.libraries;
    const library = factory.library({ name: 'Old Name', writable: true });
    data.addLibraries(library);

    await page.goto(Route.editLibrary(library));
    await expect(form.writableSwitch).toBeChecked();
    await form.nameInput.fill('New Name');
    await form.saveButton.click();
    await expect(page).toHaveURL(Route.viewLibrary(library));
    expect(api.updateLibrary).toHaveBeenCalledWith({
      params: { id: library.id },
      body: { name: 'New Name' },
    });
  });
});
