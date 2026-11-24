import {
  ChunkUploadError,
  UploadAbortedError,
  chunkArray,
  filterUploadableEntries,
  getChunkRange,
  getConflictOffset,
  getEntryRelativePath,
  getResumeKey,
  getRetryDelay,
  isRetryableError,
  isValidFolderName,
  joinUploadPath,
  resumeStore,
  toFolderUploadEntries,
  waitFor,
} from '#lib/utils/chunked-upload.ts';

const makeFile = (name: string, content = 'data', relativePath?: string) => {
  const file = new File([content], name, { lastModified: 1000 });
  if (relativePath) {
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  }
  return file;
};

describe('chunked upload helpers', () => {
  describe('paths', () => {
    it('joins upload paths without empty or duplicate slashes', () => {
      expect(joinUploadPath('', 'Trip/a.jpg')).toBe('Trip/a.jpg');
      expect(joinUploadPath('Photos/2024/', '/Trip/a.jpg')).toBe('Photos/2024/Trip/a.jpg');
      expect(joinUploadPath('', '')).toBe('');
    });

    it('keeps the folder structure from webkitRelativePath and FileSystemEntry.fullPath', () => {
      expect(getEntryRelativePath(makeFile('a.jpg', 'x', 'Trip/Day 1/a.jpg'))).toBe('Trip/Day 1/a.jpg');
      expect(getEntryRelativePath(makeFile('b.jpg'), '/Dropped/Sub/b.jpg')).toBe('Dropped/Sub/b.jpg');
      expect(getEntryRelativePath(makeFile('c.jpg'))).toBe('c.jpg');
    });

    it('builds entries for picked files', () => {
      const file = makeFile('a.jpg', 'x', 'Trip/a.jpg');
      expect(toFolderUploadEntries([file])).toEqual([{ file, relativePath: 'Trip/a.jpg' }]);
    });

    it('validates new folder names', () => {
      expect(isValidFolderName('Holidays 2024')).toBe(true);
      expect(isValidFolderName('')).toBe(false);
      expect(isValidFolderName(' padded ')).toBe(false);
      expect(isValidFolderName('.hidden')).toBe(false);
      expect(isValidFolderName('a/b')).toBe(false);
      expect(isValidFolderName(String.raw`a\b`)).toBe(false);
      expect(isValidFolderName('x'.repeat(256))).toBe(false);
    });

    it('builds a stable resume key', () => {
      expect(getResumeKey('library', 'Trip/a.jpg', { size: 10, lastModified: 5 })).toBe('library|Trip/a.jpg|10|5');
    });
  });

  describe('filterUploadableEntries', () => {
    it('leaves out unsupported and hidden files', () => {
      const photo = { file: makeFile('a.JPG'), relativePath: 'Trip/a.JPG' };
      const text = { file: makeFile('notes.txt'), relativePath: 'Trip/notes.txt' };
      const hidden = { file: makeFile('b.jpg'), relativePath: 'Trip/.thumbs/b.jpg' };
      const dsStore = { file: makeFile('.DS_Store'), relativePath: 'Trip/.DS_Store' };

      expect(filterUploadableEntries([photo, text, hidden, dsStore], ['.jpg', '.heic'])).toEqual({
        accepted: [photo],
        ignored: [text, hidden, dsStore],
      });
    });

    it('accepts every visible file while the supported types are unknown', () => {
      const text = { file: makeFile('notes.txt'), relativePath: 'notes.txt' };
      expect(filterUploadableEntries([text], []).accepted).toEqual([text]);
    });
  });

  describe('chunk planning', () => {
    it('plans chunks up to the end of the file', () => {
      expect(getChunkRange(0, 20, 8)).toEqual({ start: 0, end: 8 });
      expect(getChunkRange(16, 20, 8)).toEqual({ start: 16, end: 20 });
      expect(getChunkRange(0, 0, 8)).toEqual({ start: 0, end: 0 });
    });

    it('splits arrays into batches', () => {
      expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
      expect(chunkArray([], 2)).toEqual([]);
    });
  });

  describe('retries', () => {
    it('backs off exponentially up to 30 seconds', () => {
      expect([0, 1, 2, 3, 4, 5, 6].map((attempt) => getRetryDelay(attempt))).toEqual([
        1000, 2000, 4000, 8000, 16_000, 30_000, 30_000,
      ]);
    });

    it('adopts the offset of a 409 response', () => {
      expect(getConflictOffset(new ChunkUploadError(409, { offset: 42 }))).toBe(42);
      expect(getConflictOffset(new ChunkUploadError(409, {}))).toBeUndefined();
      expect(getConflictOffset(new ChunkUploadError(500, { offset: 42 }))).toBeUndefined();
    });

    it('retries network errors and server errors only', () => {
      expect(isRetryableError(new ChunkUploadError(0))).toBe(true);
      expect(isRetryableError(new ChunkUploadError(502))).toBe(true);
      expect(isRetryableError(new ChunkUploadError(429))).toBe(true);
      expect(isRetryableError(new ChunkUploadError(400))).toBe(false);
      expect(isRetryableError(new ChunkUploadError(403))).toBe(false);
      expect(isRetryableError(new UploadAbortedError())).toBe(false);
    });

    it('stops waiting when aborted', async () => {
      const controller = new AbortController();
      const promise = waitFor(10_000, controller.signal);
      controller.abort();
      await expect(promise).rejects.toBeInstanceOf(UploadAbortedError);
    });
  });

  describe('resumeStore', () => {
    beforeEach(() => resumeStore.clear());

    it('remembers and forgets sessions', () => {
      resumeStore.set('a', { sessionId: 's1', relativePath: 'a.jpg', libraryId: 'l' });
      resumeStore.set('b', { sessionId: 's2', relativePath: 'b.jpg', libraryId: 'l' });
      expect(resumeStore.get('a')?.sessionId).toBe('s1');
      expect(resumeStore.count()).toBe(2);

      resumeStore.remove('a');
      expect(resumeStore.get('a')).toBeUndefined();
      expect(resumeStore.count()).toBe(1);
    });

    it('survives broken stored data', () => {
      localStorage.setItem('immich-folder-upload-sessions', '{not json');
      expect(resumeStore.load()).toEqual({});
    });
  });
});
