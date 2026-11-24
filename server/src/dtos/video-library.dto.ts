import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { isoDatetimeToDate } from 'src/validation.js';

export const MAX_PLAYBACK_SECONDS = 7 * 24 * 60 * 60;

const seconds = () => z.number().meta({ format: 'double' }).min(0).max(MAX_PLAYBACK_SECONDS);

const PlaybackPositionUpdateSchema = z
  .object({
    position: seconds().describe('Playback position in seconds'),
    duration: seconds().positive().optional().describe('Duration of the video in seconds, as seen by the player'),
  })
  .meta({ id: 'PlaybackPositionUpdateDto' });

const PlaybackPositionResponseSchema = z
  .object({
    assetId: z.uuidv4().describe('Asset ID'),
    position: z.number().meta({ format: 'double' }).describe('Saved playback position in seconds (0 when none saved)'),
    duration: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('Duration of the video in seconds when the position was saved'),
    updatedAt: isoDatetimeToDate.nullable().describe('When the position was saved (null when none saved)'),
  })
  .meta({ id: 'PlaybackPositionResponseDto' });

export enum SubtitleFormat {
  Srt = 'srt',
  Vtt = 'vtt',
}

const SubtitleFormatSchema = z.enum(SubtitleFormat).describe('Format of the subtitle file on disk').meta({
  id: 'SubtitleFormat',
});

const SubtitleResponseSchema = z
  .object({
    name: z.string().describe('File name of the subtitle, used to fetch it'),
    format: SubtitleFormatSchema,
    language: z.string().nullable().describe('BCP 47 language tag parsed from the file name, if any'),
    label: z.string().nullable().describe('Extra text from the file name besides the language, if any'),
    forced: z.boolean().describe('The file name marks the subtitle as forced'),
    hearingImpaired: z.boolean().describe('The file name marks the subtitle as SDH / hearing impaired'),
  })
  .meta({ id: 'SubtitleResponseDto' });

const SubtitleParamSchema = z.object({
  id: z.uuidv4(),
  name: z.string().min(1).max(255).describe('Subtitle file name'),
});

export class PlaybackPositionUpdateDto extends createZodDto(PlaybackPositionUpdateSchema) {}
export class PlaybackPositionResponseDto extends createZodDto(PlaybackPositionResponseSchema) {}
export class SubtitleResponseDto extends createZodDto(SubtitleResponseSchema) {}
export class SubtitleParamDto extends createZodDto(SubtitleParamSchema) {}
