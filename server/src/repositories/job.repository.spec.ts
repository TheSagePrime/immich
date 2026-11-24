import { FOLDER_ALBUM_SYNC_DELAY_MS } from 'src/constants.js';
import { JobName, QueueName } from 'src/enum.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { describe, expect, it, vi } from 'vitest';

const setup = () => {
  const queue = { add: vi.fn().mockResolvedValue(void 0), addBulk: vi.fn().mockResolvedValue(void 0) };
  const moduleRef = { get: vi.fn().mockReturnValue(queue) };
  const logger = { setContext: vi.fn() };
  const sut = new JobRepository(moduleRef as any, {} as any, {} as any, logger as any);
  (sut as any).handlers = {
    [JobName.FolderAlbumSync]: { queueName: QueueName.BackgroundTask },
  };
  return { sut, queue };
};

describe(JobRepository.name, () => {
  describe('queue', () => {
    it('should throttle debounced folder album syncs per user', async () => {
      const { sut, queue } = setup();

      await sut.queue({ name: JobName.FolderAlbumSync, data: { userId: 'user-1', debounce: true } });

      expect(queue.add).toHaveBeenCalledWith(
        JobName.FolderAlbumSync,
        { userId: 'user-1', debounce: true },
        {
          delay: FOLDER_ALBUM_SYNC_DELAY_MS,
          deduplication: { id: 'FolderAlbumSync/user-1', ttl: FOLDER_ALBUM_SYNC_DELAY_MS },
        },
      );
      expect(queue.addBulk).not.toHaveBeenCalled();
    });

    it('should queue a full folder album sync immediately', async () => {
      const { sut, queue } = setup();

      await sut.queue({ name: JobName.FolderAlbumSync, data: { userId: 'user-1', full: true } });

      expect(queue.add).not.toHaveBeenCalled();
      expect(queue.addBulk).toHaveBeenCalledWith([
        { name: JobName.FolderAlbumSync, data: { userId: 'user-1', full: true }, options: undefined },
      ]);
    });
  });
});
