import {
  FolderUploadManager,
  FolderUploadState,
  SpeedTracker,
  getRemainingSeconds,
  type FolderUploadDependencies,
} from '#lib/managers/folder-upload-manager.svelte.ts';
import { ChunkUploadError, resumeStore } from '#lib/utils/chunked-upload.ts';
import { UploadDuplicatePolicy, UploadOutcome, UploadSessionStatus, type UploadSessionResponseDto } from '@immich/sdk';
import type { Mock } from 'vitest';

const CHUNK_SIZE = 4;

const makeSession = (overrides: Partial<UploadSessionResponseDto> = {}): UploadSessionResponseDto => ({
  id: 'session-1',
  libraryId: 'library-1',
  relativePath: 'Dest/Trip/a.jpg',
  size: 10,
  offset: 0,
  chunkSize: CHUNK_SIZE,
  maxChunkSize: 32,
  status: UploadSessionStatus.Active,
  duplicatePolicy: UploadDuplicatePolicy.Skip,
  expiresAt: new Date().toISOString(),
  ...overrides,
});

const makeFile = (name: string, content: string) => new File([content], name, { lastModified: 1234 });

const completed = (outcome: UploadOutcome, overrides: Partial<UploadSessionResponseDto> = {}) =>
  makeSession({
    status: outcome === UploadOutcome.Failed ? UploadSessionStatus.Failed : UploadSessionStatus.Completed,
    result: { outcome, relativePath: 'Dest/Trip/a.jpg', assetId: 'asset-1' },
    ...overrides,
  });

describe('FolderUploadManager', () => {
  let deps: { [K in keyof FolderUploadDependencies]: Mock<FolderUploadDependencies[K]> };
  let sut: FolderUploadManager;
  let stored: number;

  const sendOk = ({ offset, chunk }: { offset: number; chunk: Blob }) => {
    stored = offset + chunk.size;
    return Promise.resolve(makeSession({ offset: stored }));
  };

  beforeEach(() => {
    resumeStore.clear();
    stored = 0;
    deps = {
      hashFile: vi.fn<FolderUploadDependencies['hashFile']>().mockResolvedValue('a'.repeat(40)),
      createSession: vi.fn<FolderUploadDependencies['createSession']>().mockResolvedValue(makeSession()),
      getSession: vi
        .fn<FolderUploadDependencies['getSession']>()
        .mockImplementation(() => Promise.resolve(makeSession({ offset: stored }))),
      completeSession: vi
        .fn<FolderUploadDependencies['completeSession']>()
        .mockResolvedValue(completed(UploadOutcome.Created)),
      cancelSession: vi.fn<FolderUploadDependencies['cancelSession']>().mockResolvedValue(undefined as never),
      sendChunk: vi.fn<FolderUploadDependencies['sendChunk']>().mockImplementation(sendOk),
      wait: vi.fn<FolderUploadDependencies['wait']>().mockResolvedValue(),
      now: vi.fn<FolderUploadDependencies['now']>().mockReturnValue(0),
    };
    sut = new FolderUploadManager(deps);
  });

  afterEach(async () => {
    await sut.reset();
  });

  const startOne = (content = '0123456789', policy = UploadDuplicatePolicy.Skip) =>
    sut.start({
      libraryId: 'library-1',
      destination: 'Dest',
      duplicatePolicy: policy,
      entries: [{ file: makeFile('a.jpg', content), relativePath: 'Trip/a.jpg' }],
    });

  const settled = () => vi.waitFor(() => expect(sut.isActive).toBe(false));

  it('hashes, uploads in chunks and completes a file', async () => {
    startOne();
    await settled();

    expect(deps.createSession).toHaveBeenCalledWith({
      createUploadSessionDto: expect.objectContaining({
        libraryId: 'library-1',
        relativePath: 'Dest/Trip/a.jpg',
        size: 10,
        checksum: 'a'.repeat(40),
        duplicatePolicy: UploadDuplicatePolicy.Skip,
        fileModifiedAt: new Date(1234).toISOString(),
      }),
    });
    expect(deps.sendChunk.mock.calls.map(([{ offset, chunk }]) => [offset, chunk.size])).toEqual([
      [0, 4],
      [4, 4],
      [8, 2],
    ]);
    expect(deps.completeSession).toHaveBeenCalledWith({ id: 'session-1' });

    const [item] = sut.items.values();
    expect(item).toMatchObject({ state: FolderUploadState.Done, bytesSent: 10, assetId: 'asset-1' });
    expect(sut.finishedFiles).toBe(1);
    expect(sut.sentBytes).toBe(10);
    expect(resumeStore.count()).toBe(0);
  });

  it('reports the outcome chosen by the server', async () => {
    deps.completeSession.mockResolvedValue(
      completed(UploadOutcome.Renamed, {
        result: { outcome: UploadOutcome.Renamed, relativePath: 'Dest/Trip/a (1).jpg' },
      }),
    );
    startOne('x', UploadDuplicatePolicy.KeepBoth);
    await settled();

    const [item] = sut.items.values();
    expect(item).toMatchObject({ state: FolderUploadState.Renamed, finalRelativePath: 'Dest/Trip/a (1).jpg' });
  });

  it('does not send data when the server skips the file right away', async () => {
    deps.createSession.mockResolvedValue(
      completed(UploadOutcome.Skipped, { result: { outcome: UploadOutcome.Skipped, relativePath: 'Dest/Trip/a.jpg' } }),
    );
    startOne();
    await settled();

    expect(deps.sendChunk).not.toHaveBeenCalled();
    expect(deps.completeSession).not.toHaveBeenCalled();
    expect([...sut.items.values()][0].state).toBe(FolderUploadState.Skipped);
    expect(sut.failedFiles).toBe(0);
  });

  it('waits for the server instead of failing when completing times out', async () => {
    deps.completeSession.mockRejectedValueOnce(new ChunkUploadError(504));
    deps.getSession
      .mockResolvedValueOnce(makeSession({ status: UploadSessionStatus.Completing, offset: 10 }))
      .mockResolvedValueOnce(completed(UploadOutcome.Created));
    startOne();
    await settled();

    expect(deps.completeSession).toHaveBeenCalledTimes(1);
    expect(deps.createSession).toHaveBeenCalledTimes(1);
    expect([...sut.items.values()][0]).toMatchObject({ state: FolderUploadState.Done, assetId: 'asset-1' });
  });

  it('reuses a session that was completed before the page was reloaded', async () => {
    const file = makeFile('a.jpg', '0123456789');
    resumeStore.set(`library-1|Dest/Trip/a.jpg|10|1234`, {
      sessionId: 'session-1',
      relativePath: 'Dest/Trip/a.jpg',
      libraryId: 'library-1',
    });
    deps.getSession.mockResolvedValue(completed(UploadOutcome.Created));
    sut.start({
      libraryId: 'library-1',
      destination: 'Dest',
      duplicatePolicy: UploadDuplicatePolicy.KeepBoth,
      entries: [{ file, relativePath: 'Trip/a.jpg' }],
    });
    await settled();

    expect(deps.createSession).not.toHaveBeenCalled();
    expect(deps.sendChunk).not.toHaveBeenCalled();
    expect([...sut.items.values()][0].state).toBe(FolderUploadState.Done);
    expect(resumeStore.count()).toBe(0);
  });

  it('retries a chunk while the server is still writing the previous one', async () => {
    deps.sendChunk.mockRejectedValueOnce(new ChunkUploadError(409, { message: 'busy' }));
    startOne();
    await settled();

    expect(deps.wait).toHaveBeenCalled();
    expect([...sut.items.values()][0].state).toBe(FolderUploadState.Done);
  });

  it('adopts the server offset after a 409', async () => {
    deps.sendChunk.mockRejectedValueOnce(new ChunkUploadError(409, { offset: 8 }));
    startOne();
    await settled();

    expect(deps.sendChunk.mock.calls.map(([{ offset }]) => offset)).toEqual([0, 8]);
    expect([...sut.items.values()][0].state).toBe(FolderUploadState.Done);
  });

  it('waits, asks for the offset and resumes after a dropped connection', async () => {
    deps.sendChunk.mockImplementationOnce(sendOk).mockImplementationOnce(() => {
      stored = 6;
      return Promise.reject(new ChunkUploadError(0));
    });
    startOne();
    await settled();

    expect(deps.wait).toHaveBeenCalledWith(1000, expect.any(AbortSignal));
    expect(deps.getSession).toHaveBeenCalledWith({ id: 'session-1' });
    expect(deps.sendChunk.mock.calls.map(([{ offset }]) => offset)).toEqual([0, 4, 6]);
    expect([...sut.items.values()][0].state).toBe(FolderUploadState.Done);
  });

  it('gives up after repeated failures and can retry', async () => {
    deps.sendChunk.mockRejectedValue(new ChunkUploadError(503, { message: 'Service unavailable' }));
    startOne();
    await settled();

    expect(deps.wait).toHaveBeenCalledTimes(8);
    const [failed] = sut.items.values();
    expect(failed).toMatchObject({ state: FolderUploadState.Failed, message: 'Service unavailable' });
    expect(sut.failedFiles).toBe(1);
    expect(resumeStore.count()).toBe(1);

    deps.sendChunk.mockImplementation(sendOk);
    sut.retryAllFailed();
    await settled();

    expect(deps.createSession).toHaveBeenCalledTimes(1);
    expect([...sut.items.values()][0].state).toBe(FolderUploadState.Done);
    expect(sut.failedFiles).toBe(0);
    expect(sut.finishedFiles).toBe(1);
  });

  it('does not retry client errors', async () => {
    deps.createSession.mockRejectedValue(new ChunkUploadError(400, { message: 'Path is excluded' }));
    startOne();
    await settled();

    expect(deps.wait).not.toHaveBeenCalled();
    expect([...sut.items.values()][0]).toMatchObject({ state: FolderUploadState.Failed, message: 'Path is excluded' });
  });

  it('cancels a running upload and deletes the session', async () => {
    let release!: () => void;
    deps.sendChunk.mockImplementation(
      ({ signal }) =>
        new Promise<UploadSessionResponseDto>((_resolve, reject) => {
          release = () => reject(new ChunkUploadError(0));
          signal?.addEventListener('abort', () => reject(new ChunkUploadError(0)));
        }),
    );
    startOne();
    await vi.waitFor(() => expect(deps.sendChunk).toHaveBeenCalled());

    const [item] = sut.items.values();
    await sut.cancel(item.key);
    release();
    await settled();

    expect(deps.cancelSession).toHaveBeenCalledWith({ id: 'session-1' });
    expect([...sut.items.values()][0].state).toBe(FolderUploadState.Cancelled);
    expect(resumeStore.count()).toBe(0);
  });

  it('resumes a session remembered from an earlier page load without hashing again', async () => {
    resumeStore.set('library-1|Dest/Trip/a.jpg|10|1234', {
      sessionId: 'session-1',
      relativePath: 'Dest/Trip/a.jpg',
      libraryId: 'library-1',
    });
    stored = 8;
    const resumed = new FolderUploadManager(deps);
    expect(resumed.unfinishedResumeCount).toBe(1);

    resumed.start({
      libraryId: 'library-1',
      destination: 'Dest',
      duplicatePolicy: UploadDuplicatePolicy.Skip,
      entries: [{ file: makeFile('a.jpg', '0123456789'), relativePath: 'Trip/a.jpg' }],
    });
    await vi.waitFor(() => expect(resumed.isActive).toBe(false));

    expect(deps.hashFile).not.toHaveBeenCalled();
    expect(deps.createSession).not.toHaveBeenCalled();
    expect(deps.sendChunk.mock.calls.map(([{ offset }]) => offset)).toEqual([8]);
    expect(resumed.unfinishedResumeCount).toBe(0);
    await resumed.reset();
  });

  it('keeps aggregate counters for many files', async () => {
    sut.start({
      libraryId: 'library-1',
      destination: '',
      duplicatePolicy: UploadDuplicatePolicy.Fail,
      entries: [
        { file: makeFile('a.jpg', '0123456789'), relativePath: 'a.jpg' },
        { file: makeFile('b.jpg', '01234'), relativePath: 'b.jpg' },
        { file: makeFile('c.jpg', '012'), relativePath: 'c.jpg' },
      ],
    });
    deps.completeSession
      .mockResolvedValueOnce(completed(UploadOutcome.Created))
      .mockResolvedValueOnce(
        completed(UploadOutcome.Failed, {
          result: { outcome: UploadOutcome.Failed, relativePath: 'b.jpg', message: 'exists' },
        }),
      )
      .mockResolvedValueOnce(completed(UploadOutcome.Created));

    expect(sut.totalFiles).toBe(3);
    expect(sut.totalBytes).toBe(18);
    await settled();

    expect(sut.finishedFiles).toBe(3);
    expect(sut.failedFiles).toBe(1);
    expect(sut.getItems('failed', 10).total).toBe(1);
    expect(sut.getItems('done', 10).total).toBe(2);
    expect(sut.getItems('done', 1)).toMatchObject({ total: 2, items: [expect.anything()] });

    sut.clearFinished();
    expect(sut.totalFiles).toBe(0);
    expect(sut.totalBytes).toBe(0);
    expect(sut.sentBytes).toBe(0);
  });

  it('does not queue a file twice while it is still uploading', () => {
    deps.hashFile.mockReturnValue(new Promise(() => {}));
    expect(startOne()).toBe(1);
    expect(startOne()).toBe(0);
    expect(sut.totalFiles).toBe(1);
  });
});

describe('SpeedTracker', () => {
  it('computes a smoothed speed', () => {
    const tracker = new SpeedTracker();
    tracker.update(0, 0);
    expect(tracker.update(1000, 1000)).toBe(1000);
    const next = tracker.update(5000, 2000);
    expect(next).toBeGreaterThan(1000);
    expect(next).toBeLessThan(4000);
  });

  it('starts over when the byte count goes down', () => {
    const tracker = new SpeedTracker();
    tracker.update(0, 0);
    tracker.update(1000, 1000);
    tracker.update(10, 2000);
    expect(tracker.update(1010, 3000)).toBeGreaterThan(0);
  });
});

describe('getRemainingSeconds', () => {
  it('estimates the time remaining', () => {
    expect(getRemainingSeconds(1000, 100)).toBe(10);
    expect(getRemainingSeconds(1000, 0)).toBeUndefined();
    expect(getRemainingSeconds(0, 100)).toBeUndefined();
  });
});
