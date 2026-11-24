import { BadRequestException } from '@nestjs/common';
import { extname } from 'node:path';
import { parseRelativePath } from 'src/utils/safe-path.js';

const MAX_SEGMENT_BYTES = 255;
const isControlCharacter = (character: string) => {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
};

export const numberedName = (name: string, n: number) => {
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  return `${stem} (${n})${extension}`;
};

export const validatePathSegments = (segments: string[]) => {
  for (const segment of segments) {
    if (Buffer.byteLength(segment, 'utf8') > MAX_SEGMENT_BYTES) {
      throw new BadRequestException(`Path segment is longer than ${MAX_SEGMENT_BYTES} bytes`);
    }

    if ([...segment].some((character) => isControlCharacter(character))) {
      throw new BadRequestException('Path must not contain control characters');
    }

    if (segment.startsWith('.')) {
      throw new BadRequestException('Path must not contain hidden files or folders');
    }
  }

  return segments;
};

export const parseUploadPath = (input: string) => {
  const segments = validatePathSegments(parseRelativePath(input));
  if (segments.length === 0) {
    throw new BadRequestException('Path must not be empty');
  }

  return segments;
};

export const parseUploadDirectory = (input: string) => validatePathSegments(parseRelativePath(input));

export const parseUploadOffset = (value: string | string[] | undefined) => {
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) {
    throw new BadRequestException('Upload-Offset header must be a non-negative integer');
  }

  return Number(value);
};

export const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = Array.from<R>({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
};

export const isErrorCode = (error: unknown, ...codes: string[]) =>
  codes.includes((error as NodeJS.ErrnoException)?.code ?? '');
