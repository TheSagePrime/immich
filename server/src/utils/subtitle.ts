import { BadRequestException, NotFoundException } from '@nestjs/common';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import { SubtitleFormat, SubtitleResponseDto } from 'src/dtos/video-library.dto.js';
import { parseSafeName, resolveSafePath } from 'src/utils/safe-path.js';

export const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;
export const MAX_SUBTITLES_PER_VIDEO = 50;

const SUBTITLE_EXTENSIONS: Record<string, SubtitleFormat> = {
  '.srt': SubtitleFormat.Srt,
  '.vtt': SubtitleFormat.Vtt,
};

const FORCED_FLAGS = new Set(['forced', 'foreign']);
const HEARING_IMPAIRED_FLAGS = new Set(['sdh', 'cc']);
const AMBIGUOUS_HEARING_IMPAIRED_FLAG = 'hi';
const IGNORED_FLAGS = new Set(['default']);
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i;
const languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });

type SubtitleCandidate = { name: string; format: SubtitleFormat; suffix: string };

const getSubtitleFormat = (fileName: string) => SUBTITLE_EXTENSIONS[extname(fileName).toLowerCase()];

const toLanguageTag = (token: string): string | null => {
  if (!LANGUAGE_PATTERN.test(token)) {
    return null;
  }

  try {
    const [canonical] = Intl.getCanonicalLocales(token.replaceAll('_', '-'));
    return canonical && languageNames.of(canonical) ? canonical : null;
  } catch {
    return null;
  }
};

const getVideoBase = (videoPath: string) => basename(videoPath, extname(videoPath));

export const hideSubtitleBaseName = (videoPath: string, name: string): string => {
  const videoBase = getVideoBase(videoPath);
  return name.startsWith(videoBase) ? name.slice(videoBase.length) : name;
};

const restoreSubtitleBaseName = (videoPath: string, name: string): string =>
  name.startsWith('.') ? `${getVideoBase(videoPath)}${name}` : name;

export const matchSubtitleFileName = (videoPath: string, fileName: string): SubtitleCandidate | null => {
  const format = getSubtitleFormat(fileName);
  if (!format) {
    return null;
  }

  const videoBase = getVideoBase(videoPath);
  const subtitleBase = fileName.slice(0, -extname(fileName).length);
  if (subtitleBase === videoBase) {
    return { name: fileName, format, suffix: '' };
  }

  if (!subtitleBase.startsWith(`${videoBase}.`)) {
    return null;
  }

  return { name: fileName, format, suffix: subtitleBase.slice(videoBase.length + 1) };
};

export const describeSubtitle = ({ name, format, suffix }: SubtitleCandidate): SubtitleResponseDto => {
  let language: string | null = null;
  let forced = false;
  let hearingImpaired = false;
  const labelTokens: string[] = [];

  for (const token of suffix.split('.')) {
    if (!token) {
      continue;
    }

    const normalized = token.toLowerCase();
    if (FORCED_FLAGS.has(normalized)) {
      forced = true;
      continue;
    }

    if (HEARING_IMPAIRED_FLAGS.has(normalized) || (normalized === AMBIGUOUS_HEARING_IMPAIRED_FLAG && language)) {
      hearingImpaired = true;
      continue;
    }

    if (IGNORED_FLAGS.has(normalized)) {
      continue;
    }

    const tag: string | null = language ? null : toLanguageTag(token);
    if (tag) {
      language = tag;
      continue;
    }

    labelTokens.push(token);
  }

  return {
    name,
    format,
    language,
    label: labelTokens.length > 0 ? labelTokens.join(' ') : null,
    forced,
    hearingImpaired,
  };
};

const compareSubtitles = (a: SubtitleResponseDto, b: SubtitleResponseDto) =>
  (a.language ?? '').localeCompare(b.language ?? '') || a.name.localeCompare(b.name);

const resolveSubtitleFile = async (directory: string, name: string) => {
  const path = await resolveSafePath(directory, parseSafeName(name));
  const stats = await stat(path);
  if (!stats.isFile() || stats.size > MAX_SUBTITLE_BYTES) {
    throw new BadRequestException('Subtitle file is not readable');
  }
  return path;
};

const isServable = (directory: string, name: string) =>
  resolveSubtitleFile(directory, name)
    .then(() => true)
    .catch(() => false);

export const findSidecarSubtitles = async (videoPath: string): Promise<SubtitleResponseDto[]> => {
  const directory = dirname(videoPath);

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => matchSubtitleFileName(videoPath, entry.name))
    .filter((candidate): candidate is SubtitleCandidate => candidate !== null)
    .slice(0, MAX_SUBTITLES_PER_VIDEO);

  const servable = await Promise.all(candidates.map((candidate) => isServable(directory, candidate.name)));

  return candidates
    .filter((_, index) => servable[index])
    .map((candidate) => describeSubtitle(candidate))
    .sort(compareSubtitles);
};

const UTF16_LE_BOM = [0xff, 0xfe];
const UTF16_BE_BOM = [0xfe, 0xff];

const startsWithBytes = (buffer: Buffer, bytes: number[]) => bytes.every((byte, index) => buffer[index] === byte);

export const decodeSubtitle = (buffer: Buffer): string => {
  if (startsWithBytes(buffer, UTF16_LE_BOM)) {
    return new TextDecoder('utf-16le').decode(buffer);
  }

  if (startsWithBytes(buffer, UTF16_BE_BOM)) {
    return new TextDecoder('utf-16be').decode(buffer);
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
};

const TIMESTAMP_PATTERN = /(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?/;
const TIMING_PATTERN = new RegExp(String.raw`^\s*(${TIMESTAMP_PATTERN.source})\s*-->\s*(${TIMESTAMP_PATTERN.source})`);

const padTwo = (part: string) => part.padStart(2, '0');

const formatTimestamp = (value: string) => {
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const [, hours = '0', minutes, seconds, fraction = '0'] = match;
  return `${padTwo(hours)}:${padTwo(minutes)}:${padTwo(seconds)}.${fraction.padEnd(3, '0')}`;
};

const convertTimingLine = (line: string): string | null => {
  const match = TIMING_PATTERN.exec(line);
  if (!match) {
    return null;
  }
  const start = formatTimestamp(match[1]);
  const end = formatTimestamp(match[6]);
  return start && end ? `${start} --> ${end}` : null;
};

const cleanCueText = (line: string) =>
  line
    .replaceAll(/\{\\[^}]*\}/g, '')
    .replaceAll(/<\/?font[^>]*>/gi, '')
    .replaceAll('-->', '->');

const normalizeNewlines = (text: string) => text.replace(/^\u{FEFF}/u, '').replaceAll(/\r\n?/g, '\n');

export const srtToVtt = (input: string): string => {
  const cues: string[] = [];

  for (const block of normalizeNewlines(input).split(/\n\s*\n/)) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1) {
      continue;
    }

    const timing = convertTimingLine(lines[timingIndex]);
    if (!timing) {
      continue;
    }

    const text = lines
      .slice(timingIndex + 1)
      .map((line) => cleanCueText(line))
      .filter((line) => line.trim() !== '');
    cues.push([timing, ...text].join('\n'));
  }

  return ['WEBVTT', ...cues].join('\n\n') + '\n';
};

export const sanitizeVtt = (input: string): string => {
  const blocks = normalizeNewlines(input).split(/\n\s*\n/);
  const [header, ...rest] = blocks;
  const body = rest.filter((block) => !/^\s*STYLE\b/.test(block));

  if (!header?.startsWith('WEBVTT')) {
    return srtToVtt(input);
  }

  return [header, ...body].join('\n\n').trimEnd() + '\n';
};

export const readSidecarSubtitle = async (videoPath: string, name: string): Promise<string> => {
  const candidate = matchSubtitleFileName(videoPath, restoreSubtitleBaseName(videoPath, name));
  if (!candidate) {
    throw new NotFoundException('Subtitle not found');
  }

  let content: Buffer;
  try {
    const path = await resolveSubtitleFile(dirname(videoPath), candidate.name);
    content = await readFile(path);
  } catch {
    throw new NotFoundException('Subtitle not found');
  }

  const text = decodeSubtitle(content);
  return candidate.format === SubtitleFormat.Srt ? srtToVtt(text) : sanitizeVtt(text);
};
