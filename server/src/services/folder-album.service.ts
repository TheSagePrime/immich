import { Injectable } from '@nestjs/common';
import { FOLDER_ALBUM_SYNC_DELAY_MS, FOLDER_ALBUM_SYNC_OVERLAP_MS } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { DatabaseLock, ImmichWorker, JobName, JobStatus, QueueName} from 'src/enum.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { BaseService } from 'src/services/base.service.js';
import type { JobOf } from 'src/types.js';
import {
  FOLDER_ALBUM_DEFAULT_ROOT_NAME,
  buildDesiredFolderAlbums,
  buildFolderAlbumRoots,
  diffFolderAlbums,
  getFolderAlbumRootsKey,
  getPrunableFolderAlbumIds,
} from 'src/utils/folder-album.js';
import { getPreferences } from 'src/utils/preferences.js';

const LOCAL_THROTTLE_MS = Math.floor(FOLDER_ALBUM_SYNC_DELAY_MS / 2);

@Injectable()
export class FolderAlbumService extends BaseService {
  private recentlyQueued = new Map<string, number>();

  async queueSync(userIds: Iterable<string | null | undefined>, options: { full?: boolean } = {}) {
    const now = Date.now();
    const items = [];
    for (const userId of new Set(userIds)) {
      if (!userId) {
        continue;
      }

      if (options.full) {
        items.push({ name: JobName.FolderAlbumSync as const, data: { userId, full: true } });
        continue;
      }

      const last = this.recentlyQueued.get(userId);
      if (last !== undefined && now - last < LOCAL_THROTTLE_MS) {
        continue;
      }

      this.recentlyQueued.set(userId, now);
      items.push({ name: JobName.FolderAlbumSync as const, data: { userId, debounce: true } });
    }

    if (this.recentlyQueued.size > 1000) {
      for (const [userId, time] of this.recentlyQueued) {
        if (now - time >= LOCAL_THROTTLE_MS) {
          this.recentlyQueued.delete(userId);
        }
      }
    }

    await this.jobRepository.queueAll(items);
  }

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  async onBootstrap() {
    await this.jobRepository.queue({ name: JobName.FolderAlbumSyncQueueAll, data: { full: false } });
  }

  @OnEvent({ name: 'AssetCreate' })
  onAssetCreate({ asset }: ArgOf<'AssetCreate'>) {
    return this.queueSync([asset.ownerId]);
  }

  @OnEvent({ name: 'AssetTrash' })
  onAssetTrash({ userId }: ArgOf<'AssetTrash'>) {
    return this.queueSync([userId]);
  }

  @OnEvent({ name: 'AssetDelete' })
  onAssetDelete({ userId }: ArgOf<'AssetDelete'>) {
    return this.queueSync([userId]);
  }

  @OnEvent({ name: 'AssetHide' })
  onAssetHide({ userId }: ArgOf<'AssetHide'>) {
    return this.queueSync([userId]);
  }

  @OnEvent({ name: 'AssetShow' })
  onAssetShow({ userId }: ArgOf<'AssetShow'>) {
    return this.queueSync([userId]);
  }

  @OnEvent({ name: 'AssetMetadataExtracted' })
  onAssetMetadataExtracted({ userId }: ArgOf<'AssetMetadataExtracted'>) {
    return this.queueSync([userId]);
  }

  @OnEvent({ name: 'AssetTrashAll' })
  onAssetTrashAll({ userId }: ArgOf<'AssetTrashAll'>) {
    return this.queueSync([userId]);
  }

  @OnEvent({ name: 'AssetDeleteAll' })
  onAssetDeleteAll({ userId }: ArgOf<'AssetDeleteAll'>) {
    return this.queueSync([userId]);
  }

  @OnEvent({ name: 'AssetRestoreAll' })
  onAssetRestoreAll({ userId }: ArgOf<'AssetRestoreAll'>) {
    return this.queueSync([userId]);
  }

  @OnJob({ name: JobName.FolderAlbumSyncQueueAll, queue: QueueName.BackgroundTask })
  async handleQueueAll(job: JobOf<JobName.FolderAlbumSyncQueueAll> = {}): Promise<JobStatus> {
    const users = await this.userRepository.getList({ withDeleted: false });
    await this.jobRepository.queueAll(
      users.map((user) => ({ name: JobName.FolderAlbumSync, data: { userId: user.id, full: job.full } })),
    );
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.FolderAlbumSync, queue: QueueName.BackgroundTask })
  handleSync(job: JobOf<JobName.FolderAlbumSync>): Promise<JobStatus> {
    return this.databaseRepository.withLock(DatabaseLock.FolderAlbumSync, () => this.sync(job));
  }

  private async sync({ userId, full }: JobOf<JobName.FolderAlbumSync>): Promise<JobStatus> {
    const started = Date.now();
    const user = await this.folderAlbumRepository.getUser(userId);
    if (!user || user.deletedAt) {
      return JobStatus.Skipped;
    }

    const preferences = getPreferences(await this.userRepository.getMetadata(userId));
    if (!preferences.folderAlbums.enabled) {
      await this.folderAlbumRepository.deleteAll(userId);
      await this.folderAlbumRepository.deleteState(userId);
      return JobStatus.Success;
    }

    const libraries = await this.folderAlbumRepository.getLibraries(userId);
    const roots = buildFolderAlbumRoots(libraries, {
      path: StorageCore.getLibraryFolder(user),
      name: user.storageLabel || FOLDER_ALBUM_DEFAULT_ROOT_NAME,
    });
    const rootsKey = getFolderAlbumRootsKey(roots);
    const state = await this.folderAlbumRepository.getState(userId);
    const isFull = !!full || !state?.checkpointAt || state.rootsKey !== rootsKey;
    const since = isFull ? undefined : new Date(state.checkpointAt!.getTime() - FOLDER_ALBUM_SYNC_OVERLAP_MS);
    const checkpointAt = await this.folderAlbumRepository.getDatabaseTime();

    const existing = await this.folderAlbumRepository.getFolderAlbums(userId);
    const directories = await this.folderAlbumRepository.getDirectories(userId, since);
    const desired = buildDesiredFolderAlbums(
      [
        ...directories,
        ...(isFull ? [] : existing.map((album) => ({ directory: album.folderPath, libraryId: undefined }))),
      ],
      roots,
    );

    const diff = diffFolderAlbums(desired, existing, {
      deleteUndesired: isFull,
      newId: () => this.cryptoRepository.randomUUID(),
    });

    await this.folderAlbumRepository.deleteFolderAlbums(diff.delete);
    await this.folderAlbumRepository.createFolderAlbums(diff.create, userId, preferences.albums.defaultAssetOrder);
    await this.folderAlbumRepository.updateFolderAlbums(diff.update);

    const removed = await this.folderAlbumRepository.removeStaleMembers(userId, since);
    const added = await this.folderAlbumRepository.addMembers(userId, since);

    const albums = await this.folderAlbumRepository.getFolderAlbums(userId);
    const nonEmpty = await this.folderAlbumRepository.getNonEmptyFolderAlbumIds(userId);
    const pruned = getPrunableFolderAlbumIds(albums, nonEmpty);
    await this.folderAlbumRepository.deleteFolderAlbums(pruned);

    if (added > 0 || removed > 0) {
      await this.albumRepository.updateThumbnails();
    }

    await this.folderAlbumRepository.saveState({
      userId,
      checkpointAt,
      rootsKey,
      fullSyncAt: isFull ? checkpointAt : undefined,
    });

    const changes = diff.create.length + diff.update.length + diff.delete.length + pruned.length + added + removed;
    const message =
      `Folder album ${isFull ? 'full' : 'incremental'} sync for user ${userId}: ` +
      `${diff.create.length} created, ${diff.update.length} updated, ${diff.delete.length + pruned.length} deleted, ` +
      `${added} asset(s) added, ${removed} removed in ${Date.now() - started}ms`;
    if (changes > 0 || isFull) {
      this.logger.log(message);
    } else {
      this.logger.debug(message);
    }

    return JobStatus.Success;
  }
}
