import { getSubtitleKind, getSubtitleLabel } from '#lib/utils/subtitles.ts';
import { SubtitleFormat, type SubtitleResponseDto } from '@immich/sdk';

const subtitle = (overrides: Partial<SubtitleResponseDto> = {}): SubtitleResponseDto => ({
  name: 'movie.srt',
  format: SubtitleFormat.Srt,
  language: null,
  label: null,
  forced: false,
  hearingImpaired: false,
  ...overrides,
});

const translations = { forced: 'Forced', hearingImpaired: 'SDH', fallback: 'Subtitles' };

describe('getSubtitleLabel', () => {
  it('should fall back when nothing is known', () => {
    expect(getSubtitleLabel(subtitle(), 'en', translations)).toBe('Subtitles');
  });

  it('should show the language name in the given locale', () => {
    expect(getSubtitleLabel(subtitle({ language: 'de' }), 'en', translations)).toBe('German');
    expect(getSubtitleLabel(subtitle({ language: 'de' }), 'de', translations)).toBe('Deutsch');
  });

  it('should add the label and flags', () => {
    expect(
      getSubtitleLabel(
        subtitle({ language: 'en', label: 'Commentary', forced: true, hearingImpaired: true }),
        'en',
        translations,
      ),
    ).toBe('English · Commentary · Forced · SDH');
  });

  it('should keep unknown language tags', () => {
    expect(getSubtitleLabel(subtitle({ language: 'qaa' }), 'en', translations)).toBe('qaa');
  });
});

describe('getSubtitleKind', () => {
  it('should use captions for hearing impaired subtitles', () => {
    expect(getSubtitleKind(subtitle({ hearingImpaired: true }))).toBe('captions');
    expect(getSubtitleKind(subtitle())).toBe('subtitles');
  });
});
