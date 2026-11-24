import type { MockData } from '#test/common/data.ts';
import type { Handlers } from '#test/common/types.ts';
import { AssetTypeEnum, type PlaybackPositionResponseDto, type SubtitleResponseDto } from '@immich/sdk';

const notFound = { status: 404, json: { message: 'Not found', statusCode: 404 } };

export const getFolder = (originalPath: string) => originalPath.slice(0, Math.max(0, originalPath.lastIndexOf('/')));

export const isInFolder = (originalPath: string, folder: string) => {
  const prefix = folder.endsWith('/') ? folder : `${folder}/`;
  return originalPath.startsWith(prefix);
};

export class VideoLibraryData {
  private readonly positions = new Map<string, PlaybackPositionResponseDto>();
  private readonly subtitles = new Map<string, SubtitleResponseDto[]>();
  private readonly subtitleContents = new Map<string, string>();

  constructor(private readonly data: MockData) {}

  setPlaybackPosition(assetId: string, position: number, duration: number | null = null) {
    this.positions.set(assetId, { assetId, position, duration, updatedAt: new Date().toISOString() });
    return this;
  }

  getPlaybackPosition(assetId: string): PlaybackPositionResponseDto {
    return this.positions.get(assetId) ?? { assetId, position: 0, duration: null, updatedAt: null };
  }

  deletePlaybackPosition(assetId: string) {
    this.positions.delete(assetId);
  }

  addSubtitle(assetId: string, subtitle: SubtitleResponseDto, content = 'WEBVTT\n') {
    this.subtitles.set(assetId, [...(this.subtitles.get(assetId) ?? []), subtitle]);
    this.subtitleContents.set(`${assetId}/${subtitle.name}`, content);
    return this;
  }

  getSubtitles(assetId: string) {
    return this.subtitles.get(assetId) ?? [];
  }

  getSubtitle(assetId: string, name: string) {
    return this.subtitleContents.get(`${assetId}/${name}`);
  }

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
  getPlaybackPosition: ({ params }) =>
    data.getAsset(params.id) ? { json: data.videoLibrary.getPlaybackPosition(params.id) } : notFound,
  updatePlaybackPosition: ({ params, body }) => {
    data.videoLibrary.setPlaybackPosition(params.id, body.position, body.duration ?? null);
    return { json: data.videoLibrary.getPlaybackPosition(params.id) };
  },
  deletePlaybackPosition: ({ params }) => {
    data.videoLibrary.deletePlaybackPosition(params.id);
    return { status: 204 };
  },
  getSubtitles: ({ params }) => ({ json: data.videoLibrary.getSubtitles(params.id) }),
  getSubtitle: ({ params }) => {
    const content = data.videoLibrary.getSubtitle(params.id, params.name);
    return content === undefined ? notFound : { body: content, contentType: 'text/vtt' };
  },
});
