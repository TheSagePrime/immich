export type CspManifest = Record<string, string[]>;

type MapConfig = { enabled: boolean; lightStyle: string; darkStyle: string };

const OFFICIAL_TILES_ORIGIN = 'https://tiles.immich.cloud';
const OFFICIAL_TILES_ASSETS_ORIGIN = 'https://static.immich.cloud';
const LICENSE_ACTIVATION_ORIGIN = 'https://pay.futo.org';

export const API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox";

export const DOCS_CONTENT_SECURITY_POLICY = "frame-ancestors 'none'; object-src 'none'; base-uri 'self'";

const toOrigin = (url: string): string | undefined => {
  if (!URL.canParse(url)) {
    return;
  }

  const { protocol, origin } = new URL(url);
  if (protocol === 'https:' || protocol === 'http:') {
    return origin;
  }
};

export const getMapCspSources = (map: MapConfig): string[] => {
  if (!map.enabled) {
    return [];
  }

  const sources = new Set<string>();
  for (const style of [map.lightStyle, map.darkStyle]) {
    const origin = toOrigin(style);
    if (!origin) {
      continue;
    }
    sources.add(origin);
    if (origin === OFFICIAL_TILES_ORIGIN) {
      sources.add(OFFICIAL_TILES_ASSETS_ORIGIN);
    }
  }

  return [...sources];
};

export const buildWebContentSecurityPolicy = ({
  manifest,
  mapSources = [],
}: {
  manifest: CspManifest;
  mapSources?: string[];
}): string => {
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", "'wasm-unsafe-eval'", ...(manifest['script-src'] ?? [])]],
    ['script-src-attr', ["'none'"]],
    ['style-src', ["'self'", ...(manifest['style-src'] ?? [])]],
    ['style-src-attr', ["'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:', ...mapSources]],
    ['media-src', ["'self'", 'data:', 'blob:']],
    ['font-src', ["'self'", 'data:']],
    ['connect-src', ["'self'", 'blob:', LICENSE_ACTIVATION_ORIGIN, ...mapSources]],
    ['worker-src', ["'self'", 'blob:']],
    ['manifest-src', ["'self'"]],
    ['frame-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ];

  return directives.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
};
