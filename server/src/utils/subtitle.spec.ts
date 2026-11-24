import { NotFoundException } from '@nestjs/common';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubtitleFormat } from 'src/dtos/video-library.dto.js';
import {
  MAX_SUBTITLE_BYTES,
  decodeSubtitle,
  describeSubtitle,
  findSidecarSubtitles,
  matchSubtitleFileName,
  readSidecarSubtitle,
  sanitizeVtt,
  srtToVtt,
} from 'src/utils/subtitle.js';

const describeSuffix = (suffix: string) => describeSubtitle({ name: 'x', format: SubtitleFormat.Srt, suffix });

const SRT =
  '1\r\n00:00:01,000 --> 00:00:02,500\r\nHello <i>world</i>\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nBye\r\n';

describe('subtitle utils', () => {
  describe('matchSubtitleFileName', () => {
    it.each([
      ['movie.srt', ''],
      ['movie.vtt', ''],
      ['movie.en.srt', 'en'],
      ['movie.en.forced.SRT', 'en.forced'],
      ['movie.pt-BR.sdh.vtt', 'pt-BR.sdh'],
    ])('should match %s', (fileName, suffix) => {
      expect(matchSubtitleFileName('/videos/movie.mp4', fileName)).toEqual(expect.objectContaining({ suffix }));
    });

    it.each(['movie.mp4', 'movie.ass', 'movies.srt', 'other.en.srt', 'movie-en.srt', 'movie.en.srt.bak'])(
      'should not match %s',
      (fileName) => {
        expect(matchSubtitleFileName('/videos/movie.mp4', fileName)).toBeNull();
      },
    );

    it('should support base names containing dots', () => {
      expect(matchSubtitleFileName('/videos/my.movie.2024.mkv', 'my.movie.2024.de.srt')).toEqual(
        expect.objectContaining({ suffix: 'de' }),
      );
    });
  });

  describe('describeSubtitle', () => {
    it('should return nulls without a suffix', () => {
      expect(describeSuffix('')).toEqual(
        expect.objectContaining({ language: null, label: null, forced: false, hearingImpaired: false }),
      );
    });

    it.each([
      ['en', 'en'],
      ['eng', 'en'],
      ['pt_BR', 'pt-BR'],
      ['ger', 'de'],
      ['zh-Hans', 'zh-Hans'],
    ])('should parse %s as %s', (suffix, language) => {
      expect(describeSuffix(suffix).language).toBe(language);
    });

    it('should parse flags', () => {
      expect(describeSuffix('en.forced')).toEqual(expect.objectContaining({ language: 'en', forced: true }));
      expect(describeSuffix('en.sdh')).toEqual(expect.objectContaining({ language: 'en', hearingImpaired: true }));
      expect(describeSuffix('en.hi')).toEqual(expect.objectContaining({ language: 'en', hearingImpaired: true }));
      expect(describeSuffix('hi')).toEqual(expect.objectContaining({ language: 'hi', hearingImpaired: false }));
    });

    it('should keep unknown words as a label', () => {
      expect(describeSuffix('en.Director Commentary')).toEqual(
        expect.objectContaining({ language: 'en', label: 'Director Commentary' }),
      );
      expect(describeSuffix('mkv')).toEqual(expect.objectContaining({ language: null, label: 'mkv' }));
    });
  });

  describe('srtToVtt', () => {
    it('should convert cues', () => {
      expect(srtToVtt(SRT)).toBe(
        'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello <i>world</i>\n\n00:00:03.000 --> 00:00:04.000\nBye\n',
      );
    });

    it('should handle a byte order mark, short timestamps and positions', () => {
      expect(srtToVtt('\u{FEFF}1\n0:00:01,5 --> 0:00:02,25 X1:10 X2:20 Y1:1 Y2:2\nHi\n')).toBe(
        'WEBVTT\n\n00:00:01.500 --> 00:00:02.250\nHi\n',
      );
    });

    it('should drop styling the browser does not understand', () => {
      expect(srtToVtt('1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<font color="#fff">Top</font> --> x\n')).toBe(
        'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nTop -> x\n',
      );
    });

    it('should skip broken cues', () => {
      expect(srtToVtt('garbage\n\n1\nnot a timing --> line\ntext\n\n2\n00:00:01,000 --> 00:00:02,000\nok\n')).toBe(
        'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nok\n',
      );
    });

    it('should return an empty WebVTT file for empty input', () => {
      expect(srtToVtt('')).toBe('WEBVTT\n');
    });
  });

  describe('sanitizeVtt', () => {
    it('should keep cues and remove style blocks', () => {
      const input =
        'WEBVTT\r\n\r\nSTYLE\r\n::cue { background: url(https://example.com/x) }\r\n\r\n00:01.000 --> 00:02.000\r\nHi\r\n';
      expect(sanitizeVtt(input)).toBe('WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n');
    });

    it('should convert files that are SubRip in disguise', () => {
      expect(sanitizeVtt(SRT)).toBe(srtToVtt(SRT));
    });
  });

  describe('decodeSubtitle', () => {
    it('should decode utf-8', () => {
      expect(decodeSubtitle(Buffer.from('Grüße', 'utf8'))).toBe('Grüße');
    });

    it('should decode utf-16 with a byte order mark', () => {
      const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Grüße', 'utf16le')]);
      expect(decodeSubtitle(le)).toBe('Grüße');
    });

    it('should fall back to windows-1252', () => {
      expect(decodeSubtitle(Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65]))).toBe('Grüße');
    });
  });

  describe('file system', () => {
    let root: string;
    let videos: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'immich-subtitle-'));
      videos = join(root, 'videos');
      await mkdir(videos);
      await writeFile(join(videos, 'movie.mp4'), '');
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    const video = () => join(videos, 'movie.mp4');

    it('should list matching subtitles sorted by language', async () => {
      await writeFile(join(videos, 'movie.srt'), SRT);
      await writeFile(join(videos, 'movie.fr.vtt'), 'WEBVTT\n');
      await writeFile(join(videos, 'movie.de.srt'), SRT);
      await writeFile(join(videos, 'other.en.srt'), SRT);
      await mkdir(join(videos, 'movie.en.srt'));

      const subtitles = await findSidecarSubtitles(video());

      expect(subtitles.map(({ name }) => name)).toEqual(['movie.srt', 'movie.de.srt', 'movie.fr.vtt']);
      expect(subtitles[2]).toEqual({
        name: 'movie.fr.vtt',
        format: 'vtt',
        language: 'fr',
        label: null,
        forced: false,
        hearingImpaired: false,
      });
    });

    it('should return an empty list when the folder is missing', async () => {
      await expect(findSidecarSubtitles(join(root, 'missing', 'movie.mp4'))).resolves.toEqual([]);
    });

    it('should ignore symbolic links that leave the folder', async () => {
      await writeFile(join(root, 'secret.txt'), 'secret');
      await symlink(join(root, 'secret.txt'), join(videos, 'movie.en.srt'));
      await writeFile(join(videos, 'target.srt'), SRT);
      await symlink(join(videos, 'target.srt'), join(videos, 'movie.de.srt'));

      await expect(findSidecarSubtitles(video())).resolves.toEqual([expect.objectContaining({ name: 'movie.de.srt' })]);
      await expect(readSidecarSubtitle(video(), 'movie.en.srt')).rejects.toBeInstanceOf(NotFoundException);
      await expect(readSidecarSubtitle(video(), 'movie.de.srt')).resolves.toBe(srtToVtt(SRT));
    });

    it('should ignore files that are too large', async () => {
      await writeFile(join(videos, 'movie.en.srt'), Buffer.alloc(MAX_SUBTITLE_BYTES + 1));

      await expect(findSidecarSubtitles(video())).resolves.toEqual([]);
      await expect(readSidecarSubtitle(video(), 'movie.en.srt')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should serve converted subtitles', async () => {
      await writeFile(join(videos, 'movie.en.srt'), SRT);
      await writeFile(join(videos, 'movie.vtt'), 'WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n');

      await expect(readSidecarSubtitle(video(), 'movie.en.srt')).resolves.toBe(srtToVtt(SRT));
      await expect(readSidecarSubtitle(video(), 'movie.vtt')).resolves.toBe('WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n');
    });

    it.each(['other.srt', '../movie.srt', 'videos/movie.srt', 'movie.en.srt\0', 'movie.missing.srt', 'movie.mp4'])(
      'should refuse %s',
      async (name) => {
        await writeFile(join(root, 'movie.srt'), SRT);
        await writeFile(join(videos, 'other.srt'), SRT);
        await expect(readSidecarSubtitle(video(), name)).rejects.toBeInstanceOf(NotFoundException);
      },
    );
  });
});
