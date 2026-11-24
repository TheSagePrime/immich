import { eventManager } from '#lib/managers/event-manager.svelte.ts';
import {
  MAX_RETRY_ATTEMPTS,
  UploadAbortedError,
  getChunkRange,
  getConflictOffset,
  getErrorMessage,
  getErrorStatus,
  getResumeKey,
  getRetryDelay,
  hashFileInWorker,
  isRetryableError,
  joinUploadPath,
  patchChunk,
  resumeStore,
  toIsoDate,
  waitFor,
  type FolderUploadEntry,
} from '#lib/utils/chunked-upload.ts';
import { ExecutorQueue } from '#lib/utils/executor-queue.ts';
import {
  UploadDuplicatePolicy,
  UploadOutcome,
  UploadSessionStatus,
  cancelUploadSession,
  completeUploadSession,
  createUploadSession,
  getUploadSession,
  type UploadSessionResponseDto,
} from '@immich/sdk';
import { SvelteMap } from 'svelte/reactivity';

export enum FolderUploadState {
  Queued = 'queued',
  Hashing = 'hashing',
  Uploading = 'uploading',
  Completing = 'completing',
  Done = 'done',
  Renamed = 'renamed',
  Skipped = 'skipped',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export type FolderUploadItem = {
  key: string;
  file: File;
  libraryId: string;
  batchId: string;
  duplicatePolicy: UploadDuplicatePolicy;
  relativePath: string;
  targetLabel?: string;
  finalRelativePath?: string;
  size: number;
  bytesSent: number;
  state: FolderUploadState;
  message?: string;
  sessionId?: string;
  assetId?: string;
};

export type FolderUploadFilter = 'active' | 'failed' | 'done';

export type FolderUploadOptions = {
  libraryId: string;
  destination: string;
  duplicatePolicy: UploadDuplicatePolicy;
  entries: FolderUploadEntry[];
  targetLabel?: string;
};

export type FolderUploadDependencies = {
  hashFile: (file: File) => Promise<string>;
  createSession: typeof createUploadSession;
  getSession: typeof getUploadSession;
  completeSession: typeof completeUploadSession;
  cancelSession: typeof cancelUploadSession;
  sendChunk: typeof patchChunk;
  wait: typeof waitFor;
  now: () => number;
};

const activeStates = new Set([
  FolderUploadState.Queued,
  FolderUploadState.Hashing,
  FolderUploadState.Uploading,
  FolderUploadState.Completing,
]);
const doneStates = new Set([FolderUploadState.Done, FolderUploadState.Renamed, FolderUploadState.Skipped]);
const failedStates = new Set([FolderUploadState.Failed, FolderUploadState.Cancelled]);

export const isActiveState = (state: FolderUploadState) => activeStates.has(state);
export const isDoneState = (state: FolderUploadState) => doneStates.has(state);
export const isFailedState = (state: FolderUploadState) => failedStates.has(state);

const outcomeStates: Record<UploadOutcome, FolderUploadState> = {
  [UploadOutcome.Created]: FolderUploadState.Done,
  [UploadOutcome.Renamed]: FolderUploadState.Renamed,
  [UploadOutcome.Skipped]: FolderUploadState.Skipped,
  [UploadOutcome.Failed]: FolderUploadState.Failed,
};

const resumableStatuses = new Set<UploadSessionStatus>([UploadSessionStatus.Completing, UploadSessionStatus.Completed]);

const SPEED_WINDOW_MS = 5000;
const MAX_COMPLETE_ATTEMPTS = 3;
export const FOLDER_UPLOAD_CONCURRENCY = 3;
export const FOLDER_UPLOAD_RENDER_INTERVAL_MS = 250;

export class SpeedTracker {
  speed = 0;
  private lastBytes?: number;
  private lastTime?: number;

  update(bytes: number, time: number) {
    if (this.lastBytes === undefined || this.lastTime === undefined || bytes < this.lastBytes) {
      this.lastBytes = bytes;
      this.lastTime = time;
      return this.speed;
    }

    const elapsed = time - this.lastTime;
    if (elapsed <= 0) {
      return this.speed;
    }

    const instant = ((bytes - this.lastBytes) / elapsed) * 1000;
    const weight = 1 - Math.exp(-elapsed / SPEED_WINDOW_MS);
    this.speed = this.speed === 0 ? instant : this.speed + weight * (instant - this.speed);
    this.lastBytes = bytes;
    this.lastTime = time;
    return this.speed;
  }

  reset() {
    this.speed = 0;
    this.lastBytes = undefined;
    this.lastTime = undefined;
  }
}

export const getRemainingSeconds = (remainingBytes: number, speed: number) =>
  speed > 0 && remainingBytes > 0 ? Math.ceil(remainingBytes / speed) : undefined;

const defaultDependencies: FolderUploadDependencies = {
  hashFile: hashFileInWorker,
  createSession: createUploadSession,
  getSession: getUploadSession,
  completeSession: completeUploadSession,
  cancelSession: cancelUploadSession,
  sendChunk: patchChunk,
  wait: waitFor,
  now: () => Date.now(),
};

export class FolderUploadManager {
  readonly items = new SvelteMap<string, FolderUploadItem>();
  totalFiles = $state(0);
  finishedFiles = $state(0);
  failedFiles = $state(0);
  totalBytes = $state(0);
  sentBytes = $state(0);
  speed = $state(0);
  unfinishedResumeCount = $state(0);
  isPanelOpen = $state(false);
  targetLabels = $state<string[]>([]);

  readonly remainingSeconds = $derived(getRemainingSeconds(this.totalBytes - this.sentBytes, this.speed));
  readonly isActive = $derived(this.finishedFiles < this.totalFiles);

  private readonly queue = new ExecutorQueue({ concurrency: FOLDER_UPLOAD_CONCURRENCY });
  private readonly controllers = new SvelteMap<string, AbortController>();
  private readonly pendingProgress = new SvelteMap<string, number>();
  private readonly speedTracker = new SpeedTracker();
  private flushTimer?: ReturnType<typeof setInterval>;
  private deps: FolderUploadDependencies;

  constructor(deps: Partial<FolderUploadDependencies> = {}, { resetOnLogout = false } = {}) {
    this.deps = { ...defaultDependencies, ...deps };
    this.unfinishedResumeCount = resumeStore.count();
    if (resetOnLogout) {
      eventManager.on({ AuthLogout: () => void this.reset() });
    }
  }

  start({ libraryId, destination, duplicatePolicy, entries, targetLabel }: FolderUploadOptions) {
    const batchId = crypto.randomUUID();
    let added = 0;
    for (const { file, relativePath } of entries) {
      const fullPath = joinUploadPath(destination, relativePath);
      const key = getResumeKey(libraryId, fullPath, file);
      const existing = this.items.get(key);
      if (existing && isActiveState(existing.state)) {
        continue;
      }

      if (existing) {
        this.forget(existing);
      }

      this.items.set(key, {
        key,
        file,
        libraryId,
        batchId,
        duplicatePolicy,
        relativePath: fullPath,
        targetLabel,
        size: file.size,
        bytesSent: 0,
        state: FolderUploadState.Queued,
      });
      this.totalFiles++;
      this.totalBytes += file.size;
      this.enqueue(key);
      added++;
    }

    if (added > 0) {
      this.isPanelOpen = true;
      this.updateTargetLabels();
      this.startTicker();
    }

    this.unfinishedResumeCount = resumeStore.count();
    return added;
  }

  getItems(filter: FolderUploadFilter, limit: number) {
    const matches = filter === 'active' ? isActiveState : filter === 'failed' ? isFailedState : isDoneState;
    const result: FolderUploadItem[] = [];
    let total = 0;
    for (const item of this.items.values()) {
      if (!matches(item.state)) {
        continue;
      }
      total++;
      if (result.length < limit) {
        result.push(item);
      }
    }
    return { items: result, total };
  }

  async cancel(key: string) {
    const item = this.items.get(key);
    if (!item || !isActiveState(item.state)) {
      return;
    }

    this.controllers.get(key)?.abort();
    this.setState(key, { state: FolderUploadState.Cancelled });
    resumeStore.remove(key);
    if (item.sessionId) {
      await this.deps.cancelSession({ id: item.sessionId }).catch(() => {});
    }
  }

  async cancelAll() {
    const keys = [...this.items.values()].filter((item) => isActiveState(item.state)).map((item) => item.key);
    await Promise.all(keys.map((key) => this.cancel(key)));
  }

  retry(key: string) {
    const item = this.items.get(key);
    if (!item || !isFailedState(item.state)) {
      return;
    }

    this.finishedFiles--;
    this.failedFiles--;
    this.sentBytes -= item.bytesSent;
    this.items.set(key, { ...item, state: FolderUploadState.Queued, bytesSent: 0, message: undefined });
    this.enqueue(key);
    this.startTicker();
  }

  retryAllFailed() {
    for (const item of this.items.values()) {
      if (item.state === FolderUploadState.Failed) {
        this.retry(item.key);
      }
    }
  }

  clearFinished() {
    for (const item of this.items.values()) {
      if (!isActiveState(item.state)) {
        this.forget(item);
      }
    }
    this.updateTargetLabels();
  }

  async discardUnfinished() {
    const entries = Object.values(resumeStore.load());
    resumeStore.clear();
    this.unfinishedResumeCount = 0;
    await Promise.all(entries.map(({ sessionId }) => this.deps.cancelSession({ id: sessionId }).catch(() => {})));
  }

  close() {
    if (!this.isActive) {
      this.clearFinished();
      this.isPanelOpen = false;
    }
  }

  async reset() {
    await this.cancelAll();
    this.items.clear();
    this.totalFiles = 0;
    this.finishedFiles = 0;
    this.failedFiles = 0;
    this.totalBytes = 0;
    this.sentBytes = 0;
    this.speed = 0;
    this.speedTracker.reset();
    this.isPanelOpen = false;
    this.targetLabels = [];
    this.stopTicker();
  }

  flush() {
    for (const [key, bytes] of this.pendingProgress) {
      const item = this.items.get(key);
      if (!item || !isActiveState(item.state)) {
        continue;
      }
      const clamped = Math.min(Math.max(bytes, 0), item.size);
      this.sentBytes += clamped - item.bytesSent;
      this.items.set(key, { ...item, bytesSent: clamped });
    }
    this.pendingProgress.clear();
    this.speed = this.isActive ? this.speedTracker.update(this.sentBytes, this.deps.now()) : 0;
    if (!this.isActive) {
      this.stopTicker();
    }
  }

  private updateTargetLabels() {
    const labels: string[] = [];
    for (const { targetLabel } of this.items.values()) {
      if (targetLabel && !labels.includes(targetLabel)) {
        labels.push(targetLabel);
      }
    }
    this.targetLabels = labels;
  }

  private forget(item: FolderUploadItem) {
    this.items.delete(item.key);
    this.totalFiles--;
    this.totalBytes -= item.size;
    this.sentBytes -= item.bytesSent;
    if (!isActiveState(item.state)) {
      this.finishedFiles--;
    }
    if (isFailedState(item.state)) {
      this.failedFiles--;
    }
  }

  private enqueue(key: string) {
    void this.queue.addTask(() => this.run(key));
  }

  private startTicker() {
    if (this.flushTimer || typeof setInterval === 'undefined') {
      return;
    }
    this.speedTracker.reset();
    this.flushTimer = setInterval(() => this.flush(), FOLDER_UPLOAD_RENDER_INTERVAL_MS);
  }

  private stopTicker() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private setState(key: string, patch: Partial<FolderUploadItem>) {
    const item = this.items.get(key);
    if (!item) {
      return;
    }

    const next = { ...item, ...patch };
    const wasActive = isActiveState(item.state);
    const isActive = isActiveState(next.state);
    if (wasActive && !isActive) {
      this.finishedFiles++;
      this.pendingProgress.delete(key);
      if (isDoneState(next.state)) {
        next.bytesSent = next.size;
      }
    }
    if (!isFailedState(item.state) && isFailedState(next.state)) {
      this.failedFiles++;
    }
    this.sentBytes += next.bytesSent - item.bytesSent;
    this.items.set(key, next);
  }

  private reportProgress(key: string, bytes: number) {
    this.pendingProgress.set(key, bytes);
  }

  private isCurrent(key: string, state: FolderUploadState) {
    return this.items.get(key)?.state === state;
  }

  private async run(key: string) {
    const item = this.items.get(key);
    if (!item || item.state !== FolderUploadState.Queued) {
      return;
    }

    const controller = new AbortController();
    this.controllers.set(key, controller);
    try {
      let session = await this.openSession(item, controller.signal);
      if (session.status === UploadSessionStatus.Completing) {
        session = await this.resumeCompleting(session.id, controller.signal);
      }

      for (let attempt = 0; session.status === UploadSessionStatus.Active; attempt++) {
        await this.sendChunks(key, item.file, session, controller.signal);
        this.setState(key, { state: FolderUploadState.Completing });
        try {
          session = await this.deps.completeSession({ id: session.id });
        } catch (error) {
          if (attempt >= MAX_COMPLETE_ATTEMPTS) {
            throw error;
          }

          const offset = getConflictOffset(error);
          if (offset !== undefined) {
            this.setState(key, { state: FolderUploadState.Uploading });
            session = { ...session, offset };
            continue;
          }

          if (!isRetryableError(error) && getErrorStatus(error) !== 409) {
            throw error;
          }

          session = await this.waitForCompletion(session.id, controller.signal, error);
          if (session.status === UploadSessionStatus.Active) {
            this.setState(key, { state: FolderUploadState.Uploading });
          }
        }
      }

      this.finish(key, session);
    } catch (error) {
      if (error instanceof UploadAbortedError || controller.signal.aborted) {
        return;
      }

      const current = this.items.get(key);
      if (current && isActiveState(current.state)) {
        this.setState(key, { state: FolderUploadState.Failed, message: getErrorMessage(error) });
      }
    } finally {
      this.controllers.delete(key);
    }
  }

  private async openSession(item: FolderUploadItem, signal: AbortSignal): Promise<UploadSessionResponseDto> {
    const resume = resumeStore.get(item.key);
    if (resume) {
      const session = await this.deps.getSession({ id: resume.sessionId }).catch(() => undefined);
      if (session && session.status === UploadSessionStatus.Active) {
        this.setState(item.key, { state: FolderUploadState.Uploading, sessionId: session.id });
        return session;
      }
      if (session && resumableStatuses.has(session.status)) {
        this.setState(item.key, { state: FolderUploadState.Completing, sessionId: session.id });
        return session;
      }
      resumeStore.remove(item.key);
    }

    this.setState(item.key, { state: FolderUploadState.Hashing });
    const checksum = await this.deps.hashFile(item.file);
    if (signal.aborted || !this.isCurrent(item.key, FolderUploadState.Hashing)) {
      throw new UploadAbortedError();
    }

    const session = await this.deps.createSession({
      createUploadSessionDto: {
        libraryId: item.libraryId,
        relativePath: item.relativePath,
        size: item.file.size,
        checksum,
        duplicatePolicy: item.duplicatePolicy,
        fileModifiedAt: toIsoDate(item.file.lastModified),
        batchId: item.batchId,
      },
    });

    if (session.status === UploadSessionStatus.Active) {
      resumeStore.set(item.key, { sessionId: session.id, relativePath: item.relativePath, libraryId: item.libraryId });
    }
    this.setState(item.key, { state: FolderUploadState.Uploading, sessionId: session.id });
    return session;
  }

  private async sendChunks(key: string, file: File, session: UploadSessionResponseDto, signal: AbortSignal) {
    let offset = session.offset;
    let attempt = 0;
    this.reportProgress(key, offset);

    while (offset < file.size) {
      const { start, end } = getChunkRange(offset, file.size, session.chunkSize);
      try {
        const response = await this.deps.sendChunk({
          sessionId: session.id,
          offset: start,
          chunk: file.slice(start, end),
          signal,
          onProgress: (loaded) => this.reportProgress(key, start + loaded),
        });
        offset = response.offset;
        attempt = 0;
        this.reportProgress(key, offset);
      } catch (error) {
        if (error instanceof UploadAbortedError || signal.aborted) {
          throw new UploadAbortedError();
        }

        const conflictOffset = getConflictOffset(error);
        if (conflictOffset !== undefined) {
          offset = conflictOffset;
          this.reportProgress(key, offset);
          continue;
        }

        if ((!isRetryableError(error) && getErrorStatus(error) !== 409) || attempt >= MAX_RETRY_ATTEMPTS) {
          throw error;
        }

        await this.deps.wait(getRetryDelay(attempt), signal);
        attempt++;
        const fresh = await this.deps.getSession({ id: session.id }).catch(() => undefined);
        if (fresh) {
          if (fresh.status !== UploadSessionStatus.Active) {
            throw new Error(fresh.result?.message ?? `Upload session is ${fresh.status}`, { cause: error });
          }
          offset = fresh.offset;
          this.reportProgress(key, offset);
        }
      }
    }
  }

  private async resumeCompleting(id: string, signal: AbortSignal) {
    try {
      return await this.deps.completeSession({ id });
    } catch (error) {
      if (!isRetryableError(error) && getErrorStatus(error) !== 409) {
        throw error;
      }
      return this.waitForCompletion(id, signal, error);
    }
  }

  private async waitForCompletion(id: string, signal: AbortSignal, cause?: unknown) {
    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      await this.deps.wait(getRetryDelay(attempt), signal);
      const session = await this.deps.getSession({ id }).catch(() => undefined);
      if (session && session.status !== UploadSessionStatus.Completing) {
        return session;
      }
    }

    throw cause ?? new Error(`Upload session ${id} is still completing`);
  }

  private finish(key: string, session: UploadSessionResponseDto) {
    resumeStore.remove(key);
    this.unfinishedResumeCount = resumeStore.count();
    const outcome = session.result?.outcome ?? UploadOutcome.Failed;
    this.setState(key, {
      state: outcomeStates[outcome],
      finalRelativePath: session.result?.relativePath,
      assetId: session.result?.assetId,
      message: session.result?.message,
      sessionId: session.id,
    });
  }
}

export const folderUploadManager = new FolderUploadManager({}, { resetOnLogout: true });
