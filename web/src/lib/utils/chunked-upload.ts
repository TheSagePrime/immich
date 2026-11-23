import { getBaseUrl, isHttpError, type UploadSessionResponseDto } from '@immich/sdk';

export const UPLOAD_CHUNK_CONTENT_TYPE = 'application/offset+octet-stream';
export const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;
export const MAX_RETRY_ATTEMPTS = 8;
export const MAX_RETRY_DELAY_MS = 30_000;

export type FolderUploadEntry = { file: File; relativePath: string };

export class ChunkUploadError extends Error {
  override name = 'ChunkUploadError';

  constructor(
    readonly status: number,
    readonly body?: { message?: string; offset?: number },
  ) {
    super(body?.message ?? (status === 0 ? 'Network error' : `HTTP ${status}`));
  }
}

export class UploadAbortedError extends Error {
  override name = 'UploadAbortedError';
}

const trimSlashes = (value: string) => value.replaceAll(/^\/+|\/+$/g, '');

export const joinUploadPath = (...parts: string[]) =>
  parts
    .map((part) => trimSlashes(part))
    .filter((part) => part !== '')
    .join('/');

export const getEntryRelativePath = (file: File, fullPath?: string) => {
  const path = fullPath || file.webkitRelativePath || file.name;
  return trimSlashes(path);
};

export const toFolderUploadEntries = (files: File[]): FolderUploadEntry[] =>
  files.map((file) => ({ file, relativePath: getEntryRelativePath(file) }));

export const isValidFolderName = (name: string) =>
  name.trim() !== '' &&
  name === name.trim() &&
  !name.startsWith('.') &&
  !/[/\\]/.test(name) &&
  [...name].every((character) => (character.codePointAt(0) ?? 0) >= 0x20) &&
  new TextEncoder().encode(name).length <= 255;

export const getResumeKey = (libraryId: string, relativePath: string, file: Pick<File, 'size' | 'lastModified'>) =>
  `${libraryId}|${relativePath}|${file.size}|${file.lastModified}`;

export const getChunkRange = (offset: number, size: number, chunkSize: number) => ({
  start: offset,
  end: Math.min(offset + Math.max(1, chunkSize), size),
});

export const getRetryDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, MAX_RETRY_DELAY_MS);

export const getErrorStatus = (error: unknown) => {
  if (error instanceof ChunkUploadError) {
    return error.status;
  }

  if (isHttpError(error)) {
    return error.status;
  }

  return 0;
};

export const getConflictOffset = (error: unknown): number | undefined => {
  const status = getErrorStatus(error);
  if (status !== 409) {
    return;
  }

  const body = error instanceof ChunkUploadError ? error.body : (error as { data?: { offset?: unknown } }).data;
  return typeof body?.offset === 'number' ? body.offset : undefined;
};

export const isRetryableError = (error: unknown) => {
  if (error instanceof UploadAbortedError) {
    return false;
  }

  const status = getErrorStatus(error);
  return status === 0 || status === 408 || status === 429 || status >= 500;
};

export const getErrorMessage = (error: unknown) => {
  if (isHttpError(error)) {
    return error.data?.message ?? error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

type PatchChunkOptions = {
  sessionId: string;
  offset: number;
  chunk: Blob;
  signal?: AbortSignal;
  onProgress?: (loaded: number) => void;
};

export const patchChunk = ({ sessionId, offset, chunk, signal, onProgress }: PatchChunkOptions) =>
  new Promise<UploadSessionResponseDto>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadAbortedError());
      return;
    }

    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => signal?.removeEventListener('abort', onAbort);

    xhr.addEventListener('load', () => {
      cleanup();
      const body = xhr.response as (UploadSessionResponseDto & { message?: string; offset?: number }) | null;
      if (xhr.status >= 200 && xhr.status < 300 && body) {
        resolve(body);
      } else {
        reject(new ChunkUploadError(xhr.status, body ?? undefined));
      }
    });
    xhr.addEventListener('error', () => {
      cleanup();
      reject(new ChunkUploadError(0));
    });
    xhr.addEventListener('timeout', () => {
      cleanup();
      reject(new ChunkUploadError(0));
    });
    xhr.addEventListener('abort', () => {
      cleanup();
      reject(new UploadAbortedError());
    });

    if (onProgress) {
      xhr.upload.addEventListener('progress', (event) => onProgress(event.loaded));
    }

    xhr.open('PATCH', `${getBaseUrl()}/upload-sessions/${encodeURIComponent(sessionId)}`);
    xhr.responseType = 'json';
    xhr.setRequestHeader('Content-Type', UPLOAD_CHUNK_CONTENT_TYPE);
    xhr.setRequestHeader('Upload-Offset', String(offset));
    xhr.send(chunk);
  });

export const waitFor = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadAbortedError());
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new UploadAbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const RESUME_STORAGE_KEY = 'immich-folder-upload-sessions';
const MAX_RESUME_ENTRIES = 5000;

export type ResumeEntry = { sessionId: string; relativePath: string; libraryId: string };

class ResumeStore {
  load(): Record<string, ResumeEntry> {
    try {
      const raw = localStorage.getItem(RESUME_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, ResumeEntry>) : {};
    } catch {
      return {};
    }
  }

  save(entries: Record<string, ResumeEntry>) {
    try {
      const keys = Object.keys(entries);
      const kept = keys.length > MAX_RESUME_ENTRIES ? keys.slice(keys.length - MAX_RESUME_ENTRIES) : keys;
      localStorage.setItem(
        RESUME_STORAGE_KEY,
        JSON.stringify(Object.fromEntries(kept.map((key) => [key, entries[key]]))),
      );
    } catch {
      return;
    }
  }

  get(key: string): ResumeEntry | undefined {
    return this.load()[key];
  }

  set(key: string, entry: ResumeEntry) {
    const entries = this.load();
    delete entries[key];
    entries[key] = entry;
    this.save(entries);
  }

  remove(key: string) {
    const entries = this.load();
    if (Object.hasOwn(entries, key)) {
      delete entries[key];
      this.save(entries);
    }
  }

  count() {
    return Object.keys(this.load()).length;
  }

  clear() {
    this.save({});
  }
}

export const resumeStore = new ResumeStore();

export const toIsoDate = (milliseconds: number) => new Date(milliseconds).toISOString();

export const hashFileInWorker = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/hash-file.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', ({ data }: MessageEvent<{ result?: string; error?: string }>) => {
      worker.terminate();
      if (data.error) {
        reject(new Error(data.error));
      } else {
        resolve(data.result!);
      }
    });
    worker.addEventListener('error', (event) => {
      worker.terminate();
      reject(new Error(event.message));
    });
    worker.postMessage(file);
  });

export const openFolderPicker = () =>
  new Promise<File[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.webkitdirectory = true;
    input.hidden = true;
    input.dataset.testid = 'folder-upload-input';
    input.addEventListener(
      'change',
      () => {
        const files = Array.from(input.files ?? []);
        input.remove();
        resolve(files);
      },
      { passive: true },
    );
    input.addEventListener(
      'cancel',
      () => {
        input.remove();
        resolve([]);
      },
      { passive: true },
    );
    document.body.append(input);
    input.click();
  });

const isHiddenPath = (relativePath: string) => relativePath.split('/').some((segment) => segment.startsWith('.'));

export const filterUploadableEntries = (entries: FolderUploadEntry[], extensions: string[]) => {
  const lowerExtensions = extensions.map((extension) => extension.toLowerCase());
  const accepted: FolderUploadEntry[] = [];
  const ignored: FolderUploadEntry[] = [];
  for (const entry of entries) {
    const name = entry.file.name.toLowerCase();
    const supported = lowerExtensions.length === 0 || lowerExtensions.some((extension) => name.endsWith(extension));
    if (supported && entry.relativePath !== '' && !isHiddenPath(entry.relativePath)) {
      accepted.push(entry);
    } else {
      ignored.push(entry);
    }
  }
  return { accepted, ignored };
};

export const UPLOAD_CHECK_BATCH_SIZE = 1000;

export const chunkArray = <T>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};
