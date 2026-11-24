import { Body, Controller, Delete, Get, Header, HttpCode, HttpStatus, Param, Put } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  PlaybackPositionResponseDto,
  PlaybackPositionUpdateDto,
  SubtitleParamDto,
  SubtitleResponseDto,
} from 'src/dtos/video-library.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { VideoLibraryService } from 'src/services/video-library.service.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.4.2').alpha('v3.4.2');

@ApiTags(ApiTag.VideoLibrary)
@Controller()
export class VideoLibraryController {
  constructor(private service: VideoLibraryService) {}

  @Get('assets/:id/playback-position')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Get playback position',
    description: 'Get the saved playback position of a video for the current user.',
    history: history(),
  })
  getPlaybackPosition(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PlaybackPositionResponseDto> {
    return this.service.getPlaybackPosition(auth, id);
  }

  @Put('assets/:id/playback-position')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Save playback position',
    description: 'Save the playback position of a video for the current user, so playback can resume there.',
    history: history(),
  })
  updatePlaybackPosition(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PlaybackPositionUpdateDto,
  ): Promise<PlaybackPositionResponseDto> {
    return this.service.updatePlaybackPosition(auth, id, dto);
  }

  @Delete('assets/:id/playback-position')
  @Authenticated({ permission: Permission.AssetRead })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Clear playback position',
    description: 'Forget the saved playback position of a video for the current user.',
    history: history(),
  })
  deletePlaybackPosition(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.deletePlaybackPosition(auth, id);
  }

  @Get('assets/:id/subtitles')
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Endpoint({
    summary: 'List sidecar subtitles',
    description:
      'List the .srt and .vtt files stored next to the original video file that share its base name, for example movie.en.srt.',
    history: history(),
  })
  getSubtitles(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<SubtitleResponseDto[]> {
    return this.service.getSubtitles(auth, id);
  }

  @Get('assets/:id/subtitles/:name')
  @Authenticated({ permission: Permission.AssetView, sharedLink: true })
  @Header('Content-Type', 'text/vtt; charset=utf-8')
  @Header('Cache-Control', 'private, no-cache')
  @ApiOkResponse({ content: { 'text/vtt': { schema: { type: 'string' } } } })
  @Endpoint({
    summary: 'Get sidecar subtitle',
    description: 'Get a sidecar subtitle of a video as WebVTT. SubRip (.srt) files are converted on the fly.',
    history: history(),
  })
  getSubtitle(@Auth() auth: AuthDto, @Param() { id, name }: SubtitleParamDto): Promise<string> {
    return this.service.getSubtitle(auth, id, name);
  }

  @Get('video-library/folders')
  @Authenticated({ permission: Permission.FolderRead })
  @Endpoint({
    summary: 'List video folders',
    description: 'List the folders that contain at least one video of the current user.',
    history: history(),
  })
  getVideoFolders(@Auth() auth: AuthDto): Promise<string[]> {
    return this.service.getVideoFolders(auth);
  }
}
