import { Route } from '#lib/route.ts';
import type { MockData } from '#test/common/data.ts';
import { factory } from '#test/common/factories.ts';
import { expect, test } from '#test/medium/fixtures.ts';
import { UploadDuplicatePolicy } from '@immich/sdk';
import type { BrowserContext, Page, Route as PlaywrightRoute } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const chunkPattern = /\/api\/upload-sessions\/[^/?]+$/;

const routeChunks = async (context: BrowserContext, data: MockData, options: { hold?: PlaywrightRoute[] } = {}) => {
  await context.route(chunkPattern, async (route, request) => {
    if (request.method() !== 'PATCH') {
      await route.fallback();
      return;
    }

    if (options.hold) {
      options.hold.push(route);
      return;
    }

    const id = new URL(request.url()).pathname.split('/').at(-1)!;
    const offset = Number(await request.headerValue('upload-offset'));
    const length = request.postDataBuffer()?.length ?? 0;
    const response = data.uploads.writeChunk(id, offset, length);
    await route.fulfill({ status: response.status ?? 200, json: response.json });
  });
};

const createFolder = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), 'immich-folder-upload-'));
  const folder = join(root, 'Trip');
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(folder, name, '..'), { recursive: true });
    await writeFile(join(folder, name), content);
  }
  return { root, folder };
};

const pickFolder = async (page: Page, folder: string) => {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'upload_folder', exact: true }).filter({ visible: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(folder);
};

const panel = (page: Page) => page.getByTestId('folder-upload-panel');

test.describe('folder upload', () => {
  const roots: string[] = [];

  test.afterAll(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  test('uploads a folder in chunks into a chosen destination and keeps both copies', async ({
    page,
    context,
    data,
    api,
  }) => {
    const library = factory.library({ name: 'Family', writable: true });
    data.addLibraries(library);
    data.uploads.chunkSize = 4;
    data.uploads.setDirectories(library.id, '', ['Albums', 'Other']);
    data.uploads.addExisting(library.id, 'Albums/Trip/a.jpg');
    await routeChunks(context, data);

    const { root, folder } = await createFolder({
      'a.jpg': 'abcdefghij',
      'Day 2/b.jpg': '0123456789',
      'notes.txt': 'not a photo',
    });
    roots.push(root);

    await page.goto(Route.photos());
    await pickFolder(page, folder);

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('folder-upload-summary')).toContainText('upload_folder_summary');
    await expect(dialog.getByText('upload_folder_ignored')).toBeVisible();
    await dialog.getByRole('button', { name: 'Albums' }).click();
    await expect(dialog.getByText('upload_already_exist_count')).toBeVisible();
    await dialog.getByLabel('upload_duplicate_keep_both').check();
    await dialog.getByRole('button', { name: 'upload_folder_start' }).click();

    await expect(panel(page)).toBeVisible();
    await panel(page).getByRole('tab', { name: 'upload_filter_done' }).click();
    await expect(panel(page).getByText('Albums/Trip/a (1).jpg')).toBeVisible();
    await expect(panel(page).getByText('Albums/Trip/Day 2/b.jpg')).toBeVisible();
    await expect(panel(page).getByText('upload_outcome_renamed')).toBeVisible();
    await expect(panel(page).getByText('upload_outcome_created')).toBeVisible();

    expect(api.createUploadSession).toHaveBeenCalledWith({
      body: expect.objectContaining({
        libraryId: library.id,
        relativePath: 'Albums/Trip/a.jpg',
        size: 10,
        duplicatePolicy: UploadDuplicatePolicy.KeepBoth,
        checksum: 'd68c19a0a345b7eab78d5e11e991c026ec60db63',
      }),
    });
    expect(api.createUploadSession).toHaveBeenCalledWith({
      body: expect.objectContaining({ relativePath: 'Albums/Trip/Day 2/b.jpg' }),
    });
    expect(api.completeUploadSession).toHaveBeenCalled();
    expect(data.uploads.hasFile(library.id, 'Albums/Trip/a (1).jpg')).toBe(true);
  });

  test('skips files that already exist', async ({ page, context, data, api }) => {
    const library = factory.library({ writable: true });
    data.addLibraries(library);
    data.uploads.addExisting(library.id, 'Trip/a.jpg');
    await routeChunks(context, data);
    const { root, folder } = await createFolder({ 'a.jpg': 'abc', 'b.jpg': 'def' });
    roots.push(root);

    await page.goto(Route.photos());
    await pickFolder(page, folder);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('upload_duplicate_skip')).toBeChecked();
    await dialog.getByRole('button', { name: 'upload_folder_start' }).click();

    await panel(page).getByRole('tab', { name: 'upload_filter_done' }).click();
    await expect(panel(page).getByText('upload_outcome_skipped')).toBeVisible();
    await expect(panel(page).getByText('upload_outcome_created')).toBeVisible();
    expect(api.createUploadSession).toHaveBeenCalled();
    expect(api.completeUploadSession).toHaveBeenCalled();
  });

  test('resumes after a failed chunk and retries failed uploads', async ({ page, context, data, api, logger }) => {
    const library = factory.library({ writable: true });
    data.addLibraries(library);
    data.uploads.chunkSize = 2;
    data.uploads.failNextChunks(503);
    await routeChunks(context, data);
    const { root, folder } = await createFolder({ 'a.jpg': 'abcdef' });
    roots.push(root);

    await page.goto(Route.photos());
    await pickFolder(page, folder);
    await page.getByRole('dialog').getByRole('button', { name: 'upload_folder_start' }).click();

    await panel(page).getByRole('tab', { name: 'upload_filter_done' }).click();
    await expect(panel(page).getByText('upload_outcome_created')).toBeVisible();
    expect(api.getUploadSession).toHaveBeenCalled();
    expect(api.createUploadSession).toHaveBeenCalled();
    expect(api.completeUploadSession).toHaveBeenCalled();

    const second = await createFolder({ 'c.jpg': 'ghijkl' });
    roots.push(second.root);
    data.uploads.failNextChunks(400);
    await pickFolder(page, second.folder);
    await page.getByRole('dialog').getByRole('button', { name: 'upload_folder_start' }).click();

    await panel(page).getByRole('tab', { name: 'upload_filter_failed' }).click();
    await expect(panel(page).getByText('upload_outcome_failed')).toBeVisible();
    await panel(page).getByRole('button', { name: 'upload_retry_all_failed' }).click();

    await panel(page).getByRole('tab', { name: 'upload_filter_done' }).click();
    await expect(panel(page).getByText('upload_outcome_created')).toHaveCount(2);
    expect(api.createUploadSession).toHaveBeenCalledWith({
      body: expect.objectContaining({ relativePath: 'Trip/c.jpg' }),
    });
    expect(api.completeUploadSession).toHaveBeenCalledWith({ params: { id: expect.any(String) } });
    expect(logger.error).toHaveBeenCalledWith(/status of 503/);
    expect(logger.error).toHaveBeenCalledWith(/status of 400/);
  });

  test('cancels running uploads', async ({ page, context, data, api }) => {
    const library = factory.library({ writable: true });
    data.addLibraries(library);
    const held: PlaywrightRoute[] = [];
    await routeChunks(context, data, { hold: held });
    const { root, folder } = await createFolder({ 'a.jpg': 'abcdef' });
    roots.push(root);

    await page.goto(Route.photos());
    await pickFolder(page, folder);
    await page.getByRole('dialog').getByRole('button', { name: 'upload_folder_start' }).click();
    await expect.poll(() => held.length).toBe(1);

    await panel(page).getByRole('button', { name: 'upload_cancel_all' }).click();
    await panel(page).getByRole('tab', { name: 'upload_filter_failed' }).click();
    await expect(panel(page).getByText('upload_outcome_cancelled')).toBeVisible();
    expect(api.createUploadSession).toHaveBeenCalled();
    expect(api.cancelUploadSession).toHaveBeenCalled();
  });

  test('hides the folder button without a writable library', async ({ page, data }) => {
    data.addLibraries(factory.library({ writable: false }));
    await page.goto(Route.photos());
    await expect(page.getByRole('button', { name: 'upload', exact: true }).filter({ visible: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'upload_folder', exact: true })).toHaveCount(0);
  });

  test('shows a full window drop overlay', async ({ page, data }) => {
    data.addLibraries(factory.library({ writable: true }));
    await page.goto(Route.photos());
    await expect(
      page.getByRole('button', { name: 'upload_folder', exact: true }).filter({ visible: true }),
    ).toBeVisible();

    await page.evaluate(() => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['x'], 'a.jpg'));
      document.body.dispatchEvent(new DragEvent('dragenter', { dataTransfer, bubbles: true }));
    });

    const overlay = page.getByTestId('drop-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('drop_to_upload_to');
    const box = await overlay.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).toMatchObject({ x: 0, y: 0, width: viewport.width, height: viewport.height });
  });

  test('keeps the album upload when dragging over an album', async ({ page, data }) => {
    data.addLibraries(factory.library({ writable: true }));
    const album = factory.album({ albumName: 'Holiday' });
    data.addAlbums(album);
    await page.goto(Route.viewAlbum(album));
    await expect(page).toHaveTitle(/Holiday/);

    await page.evaluate(() => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['x'], 'a.jpg'));
      document.body.dispatchEvent(new DragEvent('dragenter', { dataTransfer, bubbles: true }));
    });

    const overlay = page.getByTestId('drop-overlay');
    await expect(overlay).toBeVisible();
    await expect(overlay).toContainText('drop_files_to_upload');
    await expect(overlay).not.toContainText('drop_to_upload_to');
  });
});
