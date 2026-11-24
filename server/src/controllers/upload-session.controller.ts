import {
  Body,
  Controller,
  Delete,
  Get,
  Head,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { type Request, type Response } from 'express';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { type AuthDto } from 'src/dtos/auth.dto.js';
import {
  CreateUploadSessionDto,
  UploadDirectoryQueryDto,
  UploadDirectoryResponseDto,
  UploadLibraryResponseDto,
  UploadSessionCheckDto,
  UploadSessionCheckResponseDto,
  UploadSessionResponseDto,
  UploadSessionSearchDto,
} from 'src/dtos/upload-session.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { UploadSessionService } from 'src/services/upload-session.service.js';
import { parseUploadOffset } from 'src/utils/upload.js';
import { UUIDParamDto } from 'src/validation.js';

export const UPLOAD_CHUNK_CONTENT_TYPE = 'application/offset+octet-stream';

const history = () => new HistoryBuilder().added('v3.4.2').alpha('v3.4.2');

const setOffsetHeaders = (res: Response, session: UploadSessionResponseDto) => {
  res.setHeader('Upload-Offset', String(session.offset));
  res.setHeader('Upload-Length', String(session.size));
  res.setHeader('Cache-Control', 'no-store');
};

@ApiTags(ApiTag.UploadSessions)
@Controller('upload-sessions')
export class UploadSessionController {
  constructor(private service: UploadSessionService) {}

  @Get('libraries')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'List upload destinations',
    description: 'List the writable external libraries of the current user that files can be uploaded into.',
    history: history(),
  })
  getUploadLibraries(@Auth() auth: AuthDto): Promise<UploadLibraryResponseDto[]> {
    return this.service.getLibraries(auth);
  }

  @Get('libraries/:id/directories')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'List upload folders',
    description: 'List the sub-folders of a folder inside a writable library, to choose an upload destination.',
    history: history(),
  })
  getUploadDirectories(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: UploadDirectoryQueryDto,
  ): Promise<UploadDirectoryResponseDto> {
    return this.service.getDirectories(auth, id, dto);
  }

  @Post('check')
  @Authenticated({ permission: Permission.AssetUpload })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Check upload paths',
    description: 'Check which of the given paths already exist in a writable library, before uploading.',
    history: history(),
  })
  checkUploadSessions(
    @Auth() auth: AuthDto,
    @Body() dto: UploadSessionCheckDto,
  ): Promise<UploadSessionCheckResponseDto> {
    return this.service.check(auth, dto);
  }

  @Post()
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Create an upload session',
    description:
      'Start a resumable upload of one file into a writable library. When the file already exists and the duplicate policy is "skip" or "fail", the session is finished right away and carries the result.',
    history: history(),
  })
  createUploadSession(@Auth() auth: AuthDto, @Body() dto: CreateUploadSessionDto): Promise<UploadSessionResponseDto> {
    return this.service.create(auth, dto);
  }

  @Get()
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'List upload sessions',
    description: 'List the upload sessions of the current user, for example to resume them after a page reload.',
    history: history(),
  })
  getUploadSessions(@Auth() auth: AuthDto, @Query() dto: UploadSessionSearchDto): Promise<UploadSessionResponseDto[]> {
    return this.service.search(auth, dto);
  }

  @Head(':id')
  @ApiExcludeEndpoint()
  @Authenticated({ permission: Permission.AssetUpload })
  async getUploadSessionOffset(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const session = await this.service.get(auth, id);
    setOffsetHeaders(res, session);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Retrieve an upload session',
    description: 'Retrieve an upload session, including the number of bytes the server has stored so far.',
    history: history(),
  })
  async getUploadSession(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UploadSessionResponseDto> {
    const session = await this.service.get(auth, id);
    setOffsetHeaders(res, session);
    return session;
  }

  @Patch(':id')
  @ApiExcludeEndpoint()
  @Authenticated({ permission: Permission.AssetUpload })
  @HttpCode(HttpStatus.OK)
  async uploadSessionChunk(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<UploadSessionResponseDto> {
    const contentType = (req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== UPLOAD_CHUNK_CONTENT_TYPE) {
      throw new UnsupportedMediaTypeException(`Content-Type must be ${UPLOAD_CHUNK_CONTENT_TYPE}`);
    }

    const contentLengthHeader = req.headers['content-length'];
    if (!contentLengthHeader || !/^\d{1,16}$/.test(contentLengthHeader)) {
      throw new HttpException('Content-Length header is required', HttpStatus.LENGTH_REQUIRED);
    }

    const offset = parseUploadOffset(req.headers['upload-offset']);
    const session = await this.service.writeChunk(
      auth,
      id,
      { offset, contentLength: Number(contentLengthHeader) },
      req,
    );
    setOffsetHeaders(res, session);
    return session;
  }

  @Post(':id/complete')
  @Authenticated({ permission: Permission.AssetUpload })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Complete an upload session',
    description:
      'Verify the size and checksum of an uploaded file, move it to its final path following the duplicate policy and import it as a library asset. Calling it again returns the stored result.',
    history: history(),
  })
  completeUploadSession(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<UploadSessionResponseDto> {
    return this.service.complete(auth, id);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.AssetUpload })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Cancel an upload session',
    description: 'Cancel an unfinished upload and delete the partial data.',
    history: history(),
  })
  cancelUploadSession(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.cancel(auth, id);
  }
}
