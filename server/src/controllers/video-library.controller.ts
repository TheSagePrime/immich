import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { VideoLibraryService } from 'src/services/video-library.service.js';

@ApiTags(ApiTag.VideoLibrary)
@Controller()
export class VideoLibraryController {
  constructor(private service: VideoLibraryService) {}

  @Get('video-library/folders')
  @Authenticated({ permission: Permission.FolderRead })
  @Endpoint({
    summary: 'List video folders',
    description: 'List the folders that contain at least one video of the current user.',
    history: new HistoryBuilder().added('v3.4.2').alpha('v3.4.2'),
  })
  getVideoFolders(@Auth() auth: AuthDto): Promise<string[]> {
    return this.service.getVideoFolders(auth);
  }
}
