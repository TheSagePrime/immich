import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { FolderRootKindSchema } from 'src/enum.js';

export const FOLDER_BULK_MAX_ITEMS = 1000;

const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith('/'), 'Path must be absolute')
  .refine((value) => !value.includes('\0'), 'Path must not contain NUL bytes')
  .refine((value) => !value.includes('\\'), 'Path must use forward slashes')
  .refine((value) => !value.split('/').includes('..'), 'Path must not contain ".." segments');

const entryName = z
  .string()
  .trim()
  .min(1)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 255, 'Name must be at most 255 bytes')
  .refine((value) => !/[/\\\0]/.test(value), String.raw`Name must not contain "/", "\" or NUL bytes`)
  .refine((value) => value !== '.' && value !== '..', 'Name must not be "." or ".."');

const FolderSummaryQuerySchema = z
  .object({
    path: z
      .string()
      .max(4096)
      .refine((value) => !value.includes('\0'), 'Path must not contain NUL bytes')
      .default('/')
      .describe('Folder path, "/" for the root'),
  })
  .meta({ id: 'FolderSummaryQueryDto' });

const FolderSummaryItemSchema = z
  .object({
    name: z.string().describe('Child folder name'),
    path: z.string().describe('Absolute child folder path'),
    assetCount: z.int().min(0).describe('Number of assets in the child folder and its subfolders'),
    coverAssetId: z.uuidv4().nullable().describe('Newest asset in the child folder, used as its cover'),
    newestTakenAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .optional()
      .describe('Newest date taken (fileCreatedAt) of the assets in the child folder'),
    oldestTakenAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .optional()
      .describe('Oldest date taken (fileCreatedAt) of the assets in the child folder'),
    newestAddedAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .optional()
      .describe('Newest date added (createdAt) of the assets in the child folder'),
    oldestAddedAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .optional()
      .describe('Oldest date added (createdAt) of the assets in the child folder'),
    totalSize: z.int().min(0).optional().describe('Total file size in bytes of the assets in the child folder'),
  })
  .meta({ id: 'FolderSummaryItemDto' });

const FolderSummaryResponseSchema = z
  .object({
    path: z.string().describe('Normalized folder path'),
    directAssetCount: z.int().min(0).describe('Number of assets directly inside the folder'),
    children: z.array(FolderSummaryItemSchema).describe('Child folders'),
    writable: z.boolean().describe('Whether the folder can be managed (inside a writable library)'),
    libraryId: z.uuidv4().optional().describe('Writable library that contains the folder'),
    isLibraryRoot: z.boolean().describe('Whether the folder is the root of a writable library'),
  })
  .meta({ id: 'FolderSummaryResponseDto' });

export const FOLDER_ROOT_UPLOADS_ID = 'uploads';

const FolderRootFolderSchema = z
  .object({
    name: z.string().describe('Display name of the folder inside the root'),
    path: z.string().describe('Absolute folder path, as returned by the other folder endpoints'),
    writable: z.boolean().describe('Whether the folder can be managed (inside a writable library)'),
  })
  .meta({ id: 'FolderRootFolderDto' });

const FolderRootSchema = z
  .object({
    id: z.string().describe('Library ID, or "uploads" for the assets uploaded to Immich'),
    kind: FolderRootKindSchema,
    name: z.string().describe('Library name, or "Uploads"'),
    writable: z.boolean().describe('Whether any folder of the root can be managed'),
    assetCount: z.int().min(0).describe('Number of assets in the root'),
    coverAssetId: z.uuidv4().nullable().describe('Newest asset in the root, used as its cover'),
    folders: z.array(FolderRootFolderSchema).describe('Top level folders of the root'),
  })
  .meta({ id: 'FolderRootDto' });

const FolderBrowseQuerySchema = z
  .object({
    path: absolutePath.optional().describe('Folder to list, omit to list the writable library roots'),
  })
  .meta({ id: 'FolderBrowseQueryDto' });

const FolderBrowseEntrySchema = z
  .object({
    name: z.string().describe('Folder name'),
    path: z.string().describe('Absolute folder path'),
  })
  .meta({ id: 'FolderBrowseEntryDto' });

const FolderBrowseResponseSchema = z
  .object({
    path: z.string().nullable().describe('Listed folder, null for the list of library roots'),
    parentPath: z.string().nullable().describe('Parent folder inside the library, null at a library root'),
    entries: z.array(FolderBrowseEntrySchema).describe('Child folders'),
  })
  .meta({ id: 'FolderBrowseResponseDto' });

const FolderCreateSchema = z
  .object({
    parentPath: absolutePath.describe('Folder in which to create the new folder'),
    name: entryName.describe('New folder name'),
  })
  .meta({ id: 'FolderCreateDto' });

const FolderRenameSchema = z
  .object({
    path: absolutePath.describe('Folder to rename'),
    name: entryName.describe('New folder name'),
  })
  .meta({ id: 'FolderRenameDto' });

const FolderResponseSchema = z
  .object({
    path: z.string().describe('Absolute folder path'),
  })
  .meta({ id: 'FolderResponseDto' });

const AssetFileRenameSchema = z
  .object({
    name: entryName.describe('New file name, the extension must stay the same'),
  })
  .meta({ id: 'AssetFileRenameDto' });

const FolderAssetResponseSchema = z
  .object({
    id: z.uuidv4().describe('Asset ID'),
    originalPath: z.string().describe('New original path'),
    originalFileName: z.string().describe('New original file name'),
  })
  .meta({ id: 'FolderAssetResponseDto' });

const sources = {
  folderPaths: z
    .array(absolutePath)
    .max(FOLDER_BULK_MAX_ITEMS)
    .optional()
    .describe(`Folders (max ${FOLDER_BULK_MAX_ITEMS})`),
  assetIds: z
    .array(z.uuidv4())
    .max(FOLDER_BULK_MAX_ITEMS)
    .optional()
    .describe(`Asset IDs (max ${FOLDER_BULK_MAX_ITEMS})`),
};

const hasSource = (value: { folderPaths?: string[]; assetIds?: string[] }) =>
  (value.folderPaths?.length ?? 0) + (value.assetIds?.length ?? 0) > 0;

const FolderMoveSchema = z
  .object({
    ...sources,
    destination: absolutePath.describe('Destination folder'),
  })
  .refine(hasSource, 'At least one folder or asset is required')
  .meta({ id: 'FolderMoveDto' });

const FolderDeleteSchema = z
  .object({
    ...sources,
    force: z.boolean().optional().describe('Delete permanently instead of moving the assets to the trash'),
  })
  .refine(hasSource, 'At least one folder or asset is required')
  .meta({ id: 'FolderDeleteDto' });

const FolderBulkFailureSchema = z
  .object({
    path: z.string().optional().describe('Folder that failed'),
    assetId: z.uuidv4().optional().describe('Asset that failed'),
    reason: z.string().describe('Failure reason'),
  })
  .meta({ id: 'FolderBulkFailureDto' });

const FolderMoveResponseSchema = z
  .object({
    moved: z.int().min(0).describe('Number of folders and files moved'),
    failed: z.array(FolderBulkFailureSchema).describe('Items that could not be moved'),
  })
  .meta({ id: 'FolderMoveResponseDto' });

const FolderDeleteResponseSchema = z
  .object({
    trashed: z.int().min(0).describe('Number of assets moved to the trash'),
    deleted: z.int().min(0).describe('Number of assets deleted permanently'),
    removedFolders: z.int().min(0).describe('Number of empty folders removed from disk'),
    failed: z.array(FolderBulkFailureSchema).describe('Items that could not be deleted'),
  })
  .meta({ id: 'FolderDeleteResponseDto' });

export class FolderSummaryQueryDto extends createZodDto(FolderSummaryQuerySchema) {}
export class FolderSummaryItemDto extends createZodDto(FolderSummaryItemSchema) {}
export class FolderSummaryResponseDto extends createZodDto(FolderSummaryResponseSchema) {}
export class FolderRootFolderDto extends createZodDto(FolderRootFolderSchema) {}
export class FolderRootDto extends createZodDto(FolderRootSchema) {}
export class FolderBrowseQueryDto extends createZodDto(FolderBrowseQuerySchema) {}
export class FolderBrowseResponseDto extends createZodDto(FolderBrowseResponseSchema) {}
export class FolderCreateDto extends createZodDto(FolderCreateSchema) {}
export class FolderRenameDto extends createZodDto(FolderRenameSchema) {}
export class FolderResponseDto extends createZodDto(FolderResponseSchema) {}
export class AssetFileRenameDto extends createZodDto(AssetFileRenameSchema) {}
export class FolderAssetResponseDto extends createZodDto(FolderAssetResponseSchema) {}
export class FolderMoveDto extends createZodDto(FolderMoveSchema) {}
export class FolderDeleteDto extends createZodDto(FolderDeleteSchema) {}
export class FolderMoveResponseDto extends createZodDto(FolderMoveResponseSchema) {}
export class FolderDeleteResponseDto extends createZodDto(FolderDeleteResponseSchema) {}
