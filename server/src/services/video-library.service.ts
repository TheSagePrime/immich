import { Injectable, NotFoundException } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  PlaybackPositionResponseDto,
  PlaybackPositionUpdateDto,
  SubtitleResponseDto,
} from 'src/dtos/video-library.dto.js';
import { Permission } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { findSidecarSubtitles, readSidecarSubtitle } from 'src/utils/subtitle.js';

type PlaybackPositionRow = {
  assetId: string;
  position: number;
  duration: number | null;
  updatedAt: Date | string;
};

const mapPlaybackPosition = ({ assetId, position, duration, updatedAt }: PlaybackPositionRow) => ({
  assetId,
  position,
  duration,
  updatedAt: new Date(updatedAt),
});

@Injectable()
export class VideoLibraryService extends BaseService {
  async getPlaybackPosition(auth: AuthDto, id: string): Promise<PlaybackPositionResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [id] });

    const row = await this.assetPlaybackRepository.get(auth.user.id, id);
    if (!row) {
      return { assetId: id, position: 0, duration: null, updatedAt: null };
    }

    return mapPlaybackPosition(row);
  }

  async updatePlaybackPosition(
    auth: AuthDto,
    id: string,
    dto: PlaybackPositionUpdateDto,
  ): Promise<PlaybackPositionResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [id] });
    await this.requireVideo(id);

    const duration = dto.duration ?? null;
    const position = duration === null ? dto.position : Math.min(dto.position, duration);

    const row = await this.assetPlaybackRepository.upsert({ userId: auth.user.id, assetId: id, position, duration });
    return mapPlaybackPosition(row);
  }

  async deletePlaybackPosition(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [id] });
    await this.assetPlaybackRepository.delete(auth.user.id, id);
  }

  async getSubtitles(auth: AuthDto, id: string): Promise<SubtitleResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [id] });
    const { originalPath } = await this.requireVideo(id);
    return findSidecarSubtitles(originalPath);
  }

  async getSubtitle(auth: AuthDto, id: string, name: string): Promise<string> {
    await this.requireAccess({ auth, permission: Permission.AssetView, ids: [id] });
    const { originalPath } = await this.requireVideo(id);
    return readSidecarSubtitle(originalPath, name);
  }

  getVideoFolders(auth: AuthDto): Promise<string[]> {
    return this.assetPlaybackRepository.getVideoFolders(auth.user.id);
  }

  private async requireVideo(id: string) {
    const asset = await this.assetRepository.getForVideo(id);
    if (!asset) {
      throw new NotFoundException('Asset not found or asset is not a video');
    }
    return asset;
  }
}
