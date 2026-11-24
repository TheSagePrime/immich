import type { MockData } from '#test/common/data.ts';
import type { Handlers } from '#test/common/types.ts';
import { AssetTypeEnum } from '@immich/sdk';

export const getFolder = (originalPath: string) => originalPath.slice(0, Math.max(0, originalPath.lastIndexOf('/')));

export const isInFolder = (originalPath: string, folder: string) => {
  const prefix = folder.endsWith('/') ? folder : `${folder}/`;
  return originalPath.startsWith(prefix);
};

export class VideoLibraryData {
  constructor(private readonly data: MockData) {}

  folders() {
    const folders = new Set(
      this.data
        .timelineAssets()
        .filter((asset) => asset.type === AssetTypeEnum.Video)
        .map((asset) => getFolder(asset.originalPath))
        .filter(Boolean),
    );
    return [...folders].sort();
  }
}

export const createVideoLibraryHandlers = (data: MockData): Handlers => ({
  getVideoFolders: () => ({ json: data.videoLibrary.folders() }),
});
