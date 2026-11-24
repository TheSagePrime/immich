import type { SubtitleResponseDto } from '@immich/sdk';

type Translations = { forced: string; hearingImpaired: string; fallback: string };

const getLanguageName = (language: string, locale: string | undefined) => {
  try {
    return new Intl.DisplayNames(locale ? [locale, 'en'] : ['en'], { type: 'language', fallback: 'none' }).of(language);
  } catch {
    return undefined;
  }
};

export const getSubtitleLabel = (
  subtitle: SubtitleResponseDto,
  locale: string | undefined,
  translations: Translations,
): string => {
  const parts = [
    subtitle.language ? (getLanguageName(subtitle.language, locale) ?? subtitle.language) : undefined,
    subtitle.label ?? undefined,
    subtitle.forced ? translations.forced : undefined,
    subtitle.hearingImpaired ? translations.hearingImpaired : undefined,
  ].filter((part): part is string => !!part);

  return parts.length > 0 ? parts.join(' · ') : translations.fallback;
};

export const getSubtitleKind = (subtitle: SubtitleResponseDto) => (subtitle.hearingImpaired ? 'captions' : 'subtitles');
