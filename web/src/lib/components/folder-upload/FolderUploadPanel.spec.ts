import FolderUploadPanel from '#lib/components/folder-upload/FolderUploadPanel.svelte';
import {
  FolderUploadManager,
  FolderUploadState,
  type FolderUploadDependencies,
} from '#lib/managers/folder-upload-manager.svelte.ts';
import { ChunkUploadError, resumeStore } from '#lib/utils/chunked-upload.ts';
import { renderWithTooltips } from '#test/unit/helpers.ts';
import { UploadDuplicatePolicy, UploadOutcome, UploadSessionStatus, type UploadSessionResponseDto } from '@immich/sdk';
import { page } from 'vitest/browser';

const session = (
  relativePath: string,
  overrides: Partial<UploadSessionResponseDto> = {},
): UploadSessionResponseDto => ({
  id: `session-${relativePath}`,
  libraryId: 'library-1',
  relativePath,
  size: 1,
  offset: 0,
  chunkSize: 8,
  maxChunkSize: 32,
  status: UploadSessionStatus.Active,
  duplicatePolicy: UploadDuplicatePolicy.KeepBoth,
  expiresAt: new Date().toISOString(),
  ...overrides,
});

const outcomes: Record<string, UploadOutcome> = {
  'new.jpg': UploadOutcome.Created,
  'renamed.jpg': UploadOutcome.Renamed,
  'skipped.jpg': UploadOutcome.Skipped,
};

const makeManager = () => {
  const deps: Partial<FolderUploadDependencies> = {
    hashFile: () => Promise.resolve('a'.repeat(40)),
    createSession: (({ createUploadSessionDto }: { createUploadSessionDto: { relativePath: string } }) => {
      if (createUploadSessionDto.relativePath === 'broken.jpg') {
        return Promise.reject(new ChunkUploadError(400, { message: 'Path is excluded' }));
      }
      return Promise.resolve(session(createUploadSessionDto.relativePath));
    }) as unknown as FolderUploadDependencies['createSession'],
    getSession: (() => Promise.reject(new Error('unused'))) as unknown as FolderUploadDependencies['getSession'],
    sendChunk: (({ sessionId }: { sessionId: string }) =>
      Promise.resolve(session(sessionId, { offset: 1 }))) as unknown as FolderUploadDependencies['sendChunk'],
    completeSession: (({ id }: { id: string }) => {
      const relativePath = id.replace('session-', '');
      const outcome = outcomes[relativePath];
      return Promise.resolve(
        session(relativePath, {
          status: UploadSessionStatus.Completed,
          result: {
            outcome,
            relativePath: outcome === UploadOutcome.Renamed ? 'renamed (1).jpg' : relativePath,
          },
        }),
      );
    }) as unknown as FolderUploadDependencies['completeSession'],
    cancelSession: (() => Promise.resolve()) as unknown as FolderUploadDependencies['cancelSession'],
  };
  return new FolderUploadManager(deps);
};

describe('FolderUploadPanel', () => {
  let manager: FolderUploadManager;

  beforeEach(() => {
    resumeStore.clear();
    manager = makeManager();
  });

  afterEach(async () => {
    await manager.reset();
  });

  const upload = async () => {
    manager.start({
      libraryId: 'library-1',
      destination: '',
      duplicatePolicy: UploadDuplicatePolicy.KeepBoth,
      entries: ['new.jpg', 'renamed.jpg', 'skipped.jpg', 'broken.jpg'].map((name) => ({
        file: new File(['x'], name),
        relativePath: name,
      })),
    });
    await vi.waitFor(() => expect(manager.isActive).toBe(false));
    manager.flush();
  };

  it('stays hidden while nothing is uploading', async () => {
    const { baseElement } = await renderWithTooltips(FolderUploadPanel, { manager });
    expect(baseElement.querySelector('[data-testid="folder-upload-panel"]')).toBeNull();
  });

  it('shows the outcome of every file', async () => {
    await upload();
    const { baseElement } = await renderWithTooltips(FolderUploadPanel, { manager });

    await expect.element(page.getByTestId('folder-upload-files')).toBeVisible();
    expect(baseElement.querySelector('[data-testid="folder-upload-files"]')?.textContent).toContain(
      'upload_files_progress',
    );

    await page.getByRole('tab', { name: 'upload_filter_done' }).click();
    await expect.element(page.getByText('renamed (1).jpg')).toBeVisible();
    await expect.element(page.getByText('upload_outcome_renamed')).toBeVisible();
    await expect.element(page.getByText('upload_outcome_skipped')).toBeVisible();
    await expect.element(page.getByText('upload_outcome_created')).toBeVisible();

    await page.getByRole('tab', { name: 'upload_filter_failed' }).click();
    await expect.element(page.getByText('upload_outcome_failed: Path is excluded')).toBeVisible();
  });

  it('retries all failed uploads', async () => {
    await upload();
    const retryAllFailed = vi.spyOn(manager, 'retryAllFailed');
    await renderWithTooltips(FolderUploadPanel, { manager });

    await page.getByRole('button', { name: 'upload_retry_all_failed' }).click();
    expect(retryAllFailed).toHaveBeenCalledOnce();
  });

  it('retries a single failed upload', async () => {
    await upload();
    const retry = vi.spyOn(manager, 'retry');
    await renderWithTooltips(FolderUploadPanel, { manager });

    await page.getByRole('tab', { name: 'upload_filter_failed' }).click();
    await page.getByRole('button', { name: 'upload_retry', exact: true }).click();
    const failed = manager.items.values().find((item) => item.relativePath === 'broken.jpg')!;
    expect(retry).toHaveBeenCalledWith(failed.key);
  });

  it('cancels all running uploads', async () => {
    const pending = new FolderUploadManager({ hashFile: () => new Promise(() => {}) });
    pending.start({
      libraryId: 'library-1',
      destination: '',
      duplicatePolicy: UploadDuplicatePolicy.Skip,
      entries: [{ file: new File(['x'], 'a.jpg'), relativePath: 'a.jpg' }],
    });
    await renderWithTooltips(FolderUploadPanel, { manager: pending });

    await page.getByRole('button', { name: 'upload_cancel_all' }).click();
    await vi.waitFor(() => expect([...pending.items.values()][0].state).toBe(FolderUploadState.Cancelled));
    await pending.reset();
  });

  it('only renders the first rows of a large batch', async () => {
    const pending = new FolderUploadManager({ hashFile: () => new Promise(() => {}) });
    pending.start({
      libraryId: 'library-1',
      destination: '',
      duplicatePolicy: UploadDuplicatePolicy.Skip,
      entries: Array.from({ length: 30 }, (_, index) => ({
        file: new File(['x'], `${index}.jpg`),
        relativePath: `${index}.jpg`,
      })),
    });
    const { baseElement } = await renderWithTooltips(FolderUploadPanel, { manager: pending, rowLimit: 10 });

    await expect.element(page.getByText('upload_more_items')).toBeVisible();
    expect(baseElement.querySelectorAll('[data-testid="folder-upload-row"]')).toHaveLength(10);
    await pending.reset();
  });
});
