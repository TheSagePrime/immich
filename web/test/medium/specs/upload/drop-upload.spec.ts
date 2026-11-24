import { Route } from '#lib/route.ts';
import type { MockData } from '#test/common/data.ts';
import { factory } from '#test/common/factories.ts';
import { expect, test } from '#test/medium/fixtures.ts';
import { UploadDuplicatePolicy } from '@immich/sdk';
import type { BrowserContext, Locator, Page } from '@playwright/test';

type DropFile = { path: string; content: string };

const chunkPattern = /\/api\/upload-sessions\/[^/?]+$/;

const routeChunks = async (context: BrowserContext, data: MockData) => {
  await context.route(chunkPattern, async (route, request) => {
    if (request.method() !== 'PATCH') {
      await route.fallback();
      return;
    }

    const id = new URL(request.url()).pathname.split('/').at(-1)!;
    const offset = Number(await request.headerValue('upload-offset'));
    const length = request.postDataBuffer()?.length ?? 0;
    const response = data.uploads.writeChunk(id, offset, length);
    await route.fulfill({ status: response.status ?? 200, json: response.json });
  });
};

const setup = (data: MockData) => {
  data.setPreferences(factory.preferences({ folders: { enabled: true, sidebarWeb: true } }));
  const library = factory.library({ name: 'Uploads', writable: true });
  data.addLibraries(library);
  data.folders.addWritableRoot('/library', library.id).setRootName('/library', 'Uploads');
  return library;
};

const dragFilesOver = (target: Locator, files: DropFile[]) =>
  target.evaluate((element, items: DropFile[]) => {
    type Node = Map<string, Node> | File;
    const tree = new Map<string, Node>();
    const dataTransfer = new DataTransfer();
    for (const { path, content } of items) {
      const parts = path.split('/');
      let folder = tree;
      for (const part of parts.slice(0, -1)) {
        if (!folder.has(part)) {
          folder.set(part, new Map());
        }
        folder = folder.get(part) as Map<string, Node>;
      }
      const file = new File([content], parts.at(-1)!, { type: 'image/jpeg', lastModified: 1_700_000_000_000 });
      folder.set(parts.at(-1)!, file);
      dataTransfer.items.add(file);
    }

    const toEntry = (name: string, node: Node, parent: string): object => {
      const fullPath = `${parent}/${name}`;
      if (node instanceof File) {
        return {
          name,
          fullPath,
          isFile: true,
          isDirectory: false,
          file: (resolve: (file: File) => void) => resolve(node),
        };
      }

      let done = false;
      return {
        name,
        fullPath,
        isFile: false,
        isDirectory: true,
        createReader: () => ({
          readEntries: (resolve: (entries: object[]) => void) => {
            resolve(done ? [] : [...node].map(([child, value]) => toEntry(child, value, fullPath)));
            done = true;
          },
        }),
      };
    };

    const entries = [...tree].map(([name, node]) => toEntry(name, node, ''));
    Object.defineProperty(dataTransfer, 'items', {
      value: entries.map((entry) => ({ kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => null })),
    });

    Object.defineProperty(element, 'dropData', { value: dataTransfer, configurable: true });
    element.dispatchEvent(new DragEvent('dragenter', { dataTransfer, bubbles: true, cancelable: true }));
    element.dispatchEvent(new DragEvent('dragover', { dataTransfer, bubbles: true, cancelable: true }));
  }, files);

const dropOn = (target: Locator) =>
  target.evaluate((element) => {
    const { dropData: dataTransfer } = element as Element & { dropData: DataTransfer };
    element.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }));
  });

const overlayMessage = (page: Page) => page.getByTestId('drop-overlay-message');
const panel = (page: Page) => page.getByTestId('folder-upload-panel');

const expectUploaded = async (page: Page, target: string, count: number) => {
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByTestId('folder-upload-target')).toHaveAttribute('data-target', target);
  await panel(page).getByRole('tab', { name: 'upload_filter_done' }).click();
  await expect(panel(page).getByText('upload_outcome_created')).toHaveCount(count);
  await expect(page.getByRole('dialog')).toHaveCount(0);
};

const tripFolder: DropFile[] = [
  { path: 'Trip/a.jpg', content: 'abcdefghij' },
  { path: 'Trip/Day 2/b.jpg', content: '0123456789' },
];

test.describe('drag and drop upload', () => {
  test('uploads a dropped folder into the open folder without asking', async ({ page, context, data, api }) => {
    const library = setup(data);
    data.folders.addFolder('/library/Goa');
    await routeChunks(context, data);

    await page.goto(Route.folders({ path: '/library/Goa' }));
    await expect(page.getByTestId('folder-breadcrumbs')).toContainText('Goa');

    const body = page.locator('body');
    await dragFilesOver(body, tripFolder);
    await expect(page.getByTestId('drop-overlay')).toBeVisible();
    await expect(overlayMessage(page)).toContainText('drop_to_upload_to');
    await expect(overlayMessage(page)).toHaveAttribute('data-target', 'Goa');
    await dropOn(body);

    await expectUploaded(page, 'Goa', 2);
    expect(api.createUploadSession).toHaveBeenCalledWith({
      body: expect.objectContaining({
        libraryId: library.id,
        relativePath: 'Goa/Trip/a.jpg',
        duplicatePolicy: UploadDuplicatePolicy.Skip,
      }),
    });
    expect(api.createUploadSession).toHaveBeenCalledWith({
      body: expect.objectContaining({ libraryId: library.id, relativePath: 'Goa/Trip/Day 2/b.jpg' }),
    });
    expect(api.completeUploadSession).toHaveBeenCalled();
    expect(data.uploads.hasFile(library.id, 'Goa/Trip/Day 2/b.jpg')).toBe(true);
  });

  test('uploads into a folder card and highlights it while dragging', async ({ page, context, data, api }) => {
    const library = setup(data);
    data.folders.addFolder('/library/Goa').addFolder('/library/Kerala');
    await routeChunks(context, data);

    await page.goto(Route.folders({ path: '/library' }));
    const card = page.getByTestId('folder-card').filter({ hasText: 'Goa' });
    await expect(card).toBeVisible();

    await dragFilesOver(card, tripFolder);
    await expect(card).toHaveAttribute('data-drop-target', 'true');
    await expect(page.getByTestId('folder-card').filter({ hasText: 'Kerala' })).not.toHaveAttribute('data-drop-target');
    await expect(overlayMessage(page)).toHaveAttribute('data-target', 'Goa');
    await dropOn(card);

    await expectUploaded(page, 'Goa', 2);
    await expect(card).not.toHaveAttribute('data-drop-target');
    expect(api.createUploadSession).toHaveBeenCalledWith({
      body: expect.objectContaining({ libraryId: library.id, relativePath: 'Goa/Trip/a.jpg' }),
    });
    expect(api.createUploadSession).toHaveBeenCalledWith({
      body: expect.objectContaining({ libraryId: library.id, relativePath: 'Goa/Trip/Day 2/b.jpg' }),
    });
    expect(api.completeUploadSession).toHaveBeenCalled();
  });

  test('uploads into the writable library root from the photos timeline', async ({ page, context, data, api }) => {
    const library = setup(data);
    await routeChunks(context, data);

    await page.goto(Route.photos());
    await expect(
      page.getByRole('button', { name: 'upload_folder', exact: true }).filter({ visible: true }),
    ).toBeVisible();

    const body = page.locator('body');
    await dragFilesOver(body, [{ path: 'loose.jpg', content: 'abc' }, ...tripFolder]);
    await expect(overlayMessage(page)).toHaveAttribute('data-target', 'Uploads');
    await dropOn(body);

    await expectUploaded(page, 'Uploads', 3);
    expect(api.createUploadSession).toHaveBeenCalledWith({
      body: expect.objectContaining({ libraryId: library.id, relativePath: 'loose.jpg' }),
    });
    expect(api.createUploadSession).toHaveBeenCalledWith({
      body: expect.objectContaining({ libraryId: library.id, relativePath: 'Trip/a.jpg' }),
    });
    expect(api.createUploadSession).toHaveBeenCalledWith({
      body: expect.objectContaining({ libraryId: library.id, relativePath: 'Trip/Day 2/b.jpg' }),
    });
    expect(api.completeUploadSession).toHaveBeenCalled();
  });

  test('uploads into the writable library root from the folders home', async ({ page, context, data, api }) => {
    const library = setup(data);
    await routeChunks(context, data);

    await page.goto(Route.folders());
    await expect(page.getByTestId('folder-card')).toHaveCount(1);

    const body = page.locator('body');
    await dragFilesOver(body, tripFolder);
    await expect(overlayMessage(page)).toHaveAttribute('data-target', 'Uploads');
    await dropOn(body);

    await expectUploaded(page, 'Uploads', 2);
    expect(api.createUploadSession).toHaveBeenCalledWith({
      body: expect.objectContaining({ libraryId: library.id, relativePath: 'Trip/a.jpg' }),
    });
    expect(api.createUploadSession).toHaveBeenCalledWith({
      body: expect.objectContaining({ libraryId: library.id, relativePath: 'Trip/Day 2/b.jpg' }),
    });
    expect(api.completeUploadSession).toHaveBeenCalled();
  });

  test('refuses a drop onto a read-only folder without a dialog', async ({ page, data, api }) => {
    setup(data);
    const asset = factory.asset({ originalPath: '/media/Trips/photo.jpg' });
    data.addAssets(asset);
    data.folders.addFolder('/media/Trips', [asset]);

    await page.goto(Route.folders({ path: '/media/Trips' }));
    await expect(page.getByTestId('read-only-hint')).toBeVisible();

    const body = page.locator('body');
    await dragFilesOver(body, tripFolder);
    await expect(page.getByTestId('drop-overlay')).toHaveAttribute('data-read-only', 'true');
    await expect(overlayMessage(page)).toContainText('upload_target_read_only');
    await expect(overlayMessage(page)).toHaveAttribute('data-target', 'Trips');
    await dropOn(body);

    await expect(page.getByTestId('drop-overlay')).toHaveCount(0);
    await expect(page.getByText('upload_target_read_only')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
    expect(api.createUploadSession).not.toHaveBeenCalled();
  });
});
