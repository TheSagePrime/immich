import { Injectable } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { BaseService } from 'src/services/base.service.js';

@Injectable()
export class VideoLibraryService extends BaseService {
  getVideoFolders(auth: AuthDto): Promise<string[]> {
    return this.assetRepository.getVideoFolders(auth.user.id);
  }
}
