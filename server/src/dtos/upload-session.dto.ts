import type { Selectable } from 'kysely';
import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { UPLOAD_CHECK_MAX_ITEMS } from 'src/constants.js';
import { UploadDuplicatePolicySchema, UploadOutcomeSchema, UploadSessionStatusSchema } from 'src/enum.js';
import { UploadSessionTable } from 'src/schema/tables/upload-session.table.js';
import { isoDatetimeToDate } from 'src/validation.js';

const relativePathSchema = z.string().min(1).max(4096);

const checksumSchema = z
  .string()
  .regex(/^(?:[0-9a-fA-F]{40}|[A-Za-z0-9+/]{27}=)$/, { error: 'Checksum must be a hex or base64 encoded SHA-1 hash' });

const CreateUploadSessionSchema = z
  .object({
    libraryId: z.uuidv4().describe('Writable library ID'),
    relativePath: relativePathSchema.describe('File path relative to the first import path of the library'),
    size: z.int().min(0).max(Number.MAX_SAFE_INTEGER).describe('File size in bytes'),
    checksum: checksumSchema.describe('Base64 or hex encoded SHA-1 hash of the whole file'),
    duplicatePolicy: UploadDuplicatePolicySchema,
    fileModifiedAt: isoDatetimeToDate.optional().describe('Modification date to set on the stored file'),
    batchId: z.uuidv4().optional().describe('Client chosen ID grouping the files of one upload'),
  })
  .meta({ id: 'CreateUploadSessionDto' });

const UploadSessionCheckItemSchema = z
  .object({
    id: z.string().min(1).max(256).describe('Client chosen item ID echoed in the result'),
    relativePath: relativePathSchema.describe('File path relative to the first import path of the library'),
  })
  .meta({ id: 'UploadSessionCheckItem' });

const UploadSessionCheckSchema = z
  .object({
    libraryId: z.uuidv4().describe('Writable library ID'),
    items: z.array(UploadSessionCheckItemSchema).max(UPLOAD_CHECK_MAX_ITEMS).describe('Paths to check'),
  })
  .meta({ id: 'UploadSessionCheckDto' });

const UploadSessionSearchSchema = z
  .object({
    libraryId: z.uuidv4().optional().describe('Filter by library ID'),
    batchId: z.uuidv4().optional().describe('Filter by batch ID'),
    status: UploadSessionStatusSchema.optional(),
  })
  .meta({ id: 'UploadSessionSearchDto' });

const UploadDirectoryQuerySchema = z
  .object({
    path: z.string().max(4096).optional().describe('Folder path relative to the first import path of the library'),
  })
  .meta({ id: 'UploadDirectoryQueryDto' });

const UploadSessionResultSchema = z
  .object({
    outcome: UploadOutcomeSchema,
    assetId: z.uuidv4().optional().describe('ID of the imported or already existing asset'),
    relativePath: z.string().describe('Final path relative to the first import path of the library'),
    message: z.string().optional().describe('Reason for a failed or skipped upload'),
  })
  .meta({ id: 'UploadSessionResultDto' });

const UploadSessionResponseSchema = z
  .object({
    id: z.uuidv4().describe('Upload session ID'),
    libraryId: z.uuidv4().describe('Library ID'),
    batchId: z.uuidv4().optional().describe('Batch ID'),
    relativePath: z.string().describe('Requested path relative to the first import path of the library'),
    size: z.int().describe('File size in bytes'),
    offset: z.int().describe('Number of bytes stored so far'),
    chunkSize: z.int().describe('Suggested chunk size in bytes'),
    maxChunkSize: z.int().describe('Largest accepted chunk in bytes'),
    status: UploadSessionStatusSchema,
    duplicatePolicy: UploadDuplicatePolicySchema,
    expiresAt: isoDatetimeToDate.describe('When the session expires if no data is received'),
    result: UploadSessionResultSchema.optional(),
  })
  .meta({ id: 'UploadSessionResponseDto' });

const UploadSessionCheckResultSchema = z
  .object({
    id: z.string().describe('Item ID from the request'),
    exists: z.boolean().describe('Whether a file or folder already exists at the path'),
    assetId: z.uuidv4().optional().describe('ID of the asset at the path'),
    suggestedRelativePath: z.string().optional().describe('Next free numbered path for "keep both"'),
    error: z.string().optional().describe('Why the path cannot be used'),
  })
  .meta({ id: 'UploadSessionCheckResultDto' });

const UploadSessionCheckResponseSchema = z
  .object({
    results: z.array(UploadSessionCheckResultSchema),
  })
  .meta({ id: 'UploadSessionCheckResponseDto' });

const UploadDirectoryResponseSchema = z
  .object({
    path: z.string().describe('Normalized folder path'),
    directories: z.array(z.string()).describe('Names of the sub-folders'),
    truncated: z.boolean().describe('Whether the list was cut off'),
  })
  .meta({ id: 'UploadDirectoryResponseDto' });

const UploadLibraryResponseSchema = z
  .object({
    id: z.uuidv4().describe('Library ID'),
    name: z.string().describe('Library name'),
  })
  .meta({ id: 'UploadLibraryResponseDto' });

export class CreateUploadSessionDto extends createZodDto(CreateUploadSessionSchema) {}
export class UploadSessionCheckDto extends createZodDto(UploadSessionCheckSchema) {}
export class UploadSessionSearchDto extends createZodDto(UploadSessionSearchSchema) {}
export class UploadDirectoryQueryDto extends createZodDto(UploadDirectoryQuerySchema) {}
export class UploadSessionResultDto extends createZodDto(UploadSessionResultSchema) {}
export class UploadSessionResponseDto extends createZodDto(UploadSessionResponseSchema) {}
export class UploadSessionCheckResultDto extends createZodDto(UploadSessionCheckResultSchema) {}
export class UploadSessionCheckResponseDto extends createZodDto(UploadSessionCheckResponseSchema) {}
export class UploadDirectoryResponseDto extends createZodDto(UploadDirectoryResponseSchema) {}
export class UploadLibraryResponseDto extends createZodDto(UploadLibraryResponseSchema) {}

export type UploadSession = Selectable<UploadSessionTable>;

export interface UploadSessionChunk {
  offset: number;
  contentLength: number;
}

export const mapUploadSession = (
  session: UploadSession,
  { offset, chunkSize, maxChunkSize }: { offset: number; chunkSize: number; maxChunkSize: number },
): UploadSessionResponseDto => ({
  id: session.id,
  libraryId: session.libraryId,
  batchId: session.batchId ?? undefined,
  relativePath: session.relativePath,
  size: Number(session.size),
  offset,
  chunkSize,
  maxChunkSize,
  status: session.status,
  duplicatePolicy: session.duplicatePolicy,
  expiresAt: new Date(session.expiresAt),
  result: session.outcome
    ? {
        outcome: session.outcome,
        assetId: session.assetId ?? undefined,
        relativePath: session.finalRelativePath ?? session.relativePath,
        message: session.message ?? undefined,
      }
    : undefined,
});
