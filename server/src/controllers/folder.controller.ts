import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  AssetFileRenameDto,
  FolderAssetResponseDto,
  FolderBrowseQueryDto,
  FolderBrowseResponseDto,
  FolderCreateDto,
  FolderDeleteDto,
  FolderDeleteResponseDto,
  FolderMoveDto,
  FolderMoveResponseDto,
  FolderRenameDto,
  FolderResponseDto,
} from 'src/dtos/folder.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { FolderService } from 'src/services/folder.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Folders)
@Controller('folders')
export class FolderController {
  constructor(private service: FolderService) {}

  @Get('browse')
  @Authenticated({ permission: Permission.FolderRead })
  @Endpoint({
    summary: 'Browse writable folders',
    description:
      'List the child folders of a folder inside a writable external library, or the writable library folders when no path is given.',
    history: new HistoryBuilder().added('v3'),
  })
  browseFolders(@Auth() auth: AuthDto, @Query() dto: FolderBrowseQueryDto): Promise<FolderBrowseResponseDto> {
    return this.service.browse(auth, dto);
  }

  @Post()
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Create a folder',
    description: 'Create a new empty folder on disk inside a writable external library.',
    history: new HistoryBuilder().added('v3'),
  })
  createFolder(@Auth() auth: AuthDto, @Body() dto: FolderCreateDto): Promise<FolderResponseDto> {
    return this.service.create(auth, dto);
  }

  @Put('rename')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Rename a folder',
    description: 'Rename a folder on disk inside a writable external library and update the paths of its assets.',
    history: new HistoryBuilder().added('v3'),
  })
  renameFolder(@Auth() auth: AuthDto, @Body() dto: FolderRenameDto): Promise<FolderResponseDto> {
    return this.service.rename(auth, dto);
  }

  @Put('assets/:id/rename')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Rename a file',
    description:
      'Rename the original file of an asset of a writable external library. The extension must stay the same.',
    history: new HistoryBuilder().added('v3'),
  })
  renameFolderAsset(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetFileRenameDto,
  ): Promise<FolderAssetResponseDto> {
    return this.service.renameAsset(auth, id, dto);
  }

  @Put('move')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Move folders and files',
    description: 'Move folders and asset files into another folder of the same writable external library.',
    history: new HistoryBuilder().added('v3'),
  })
  moveFolderItems(@Auth() auth: AuthDto, @Body() dto: FolderMoveDto): Promise<FolderMoveResponseDto> {
    return this.service.move(auth, dto);
  }

  @Delete()
  @Authenticated({ permission: Permission.AssetDelete })
  @Endpoint({
    summary: 'Delete folders and files',
    description:
      'Move the assets of folders and files of a writable external library to the trash, or delete them permanently with force. Empty folders are removed from disk.',
    history: new HistoryBuilder().added('v3'),
  })
  deleteFolderItems(@Auth() auth: AuthDto, @Body() dto: FolderDeleteDto): Promise<FolderDeleteResponseDto> {
    return this.service.delete(auth, dto);
  }
}
