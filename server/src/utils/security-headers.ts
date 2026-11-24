import type { NextFunction, Request, Response } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  API_CONTENT_SECURITY_POLICY,
  DOCS_CONTENT_SECURITY_POLICY,
  buildWebContentSecurityPolicy,
  type CspManifest,
} from 'src/utils/content-security-policy.js';

export {
  API_CONTENT_SECURITY_POLICY,
  buildWebContentSecurityPolicy,
  DOCS_CONTENT_SECURITY_POLICY,
  getMapCspSources,
  type CspManifest,
} from 'src/utils/content-security-policy.js';

export const readCspManifest = (manifestFile: string): CspManifest | undefined => {
  if (!existsSync(manifestFile)) {
    return undefined;
  }

  const manifest = JSON.parse(readFileSync(manifestFile).toString()) as unknown;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Invalid CSP manifest: ${manifestFile}`);
  }

  const result: CspManifest = {};
  for (const [directive, sources] of Object.entries(manifest)) {
    if (
      !Array.isArray(sources) ||
      sources.some((source) => typeof source !== 'string' || !/^'sha256-[\w+/=]+'$/.test(source))
    ) {
      throw new Error(`Invalid CSP manifest entry "${directive}": ${manifestFile}`);
    }
    result[directive] = sources as string[];
  }

  return result;
};

export type SecurityHeadersOptions = {
  manifest?: CspManifest;
  webPolicy: boolean;
  getMapSources?: () => string[];
};

export const createSecurityHeadersMiddleware = ({ manifest, webPolicy, getMapSources }: SecurityHeadersOptions) => {
  let cachedSources = '';
  let cachedPolicy = '';

  const getWebPolicy = () => {
    if (!manifest) {
      return;
    }
    const mapSources = getMapSources?.() ?? [];
    const key = mapSources.join(' ');
    if (!cachedPolicy || key !== cachedSources) {
      cachedSources = key;
      cachedPolicy = buildWebContentSecurityPolicy({ manifest, mapSources });
    }
    return cachedPolicy;
  };

  return (request: Request, response: Response, next: NextFunction) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');

    const path = request.path;
    if (path === '/api' || path.startsWith('/api/')) {
      response.setHeader('Content-Security-Policy', API_CONTENT_SECURITY_POLICY);
    } else if (path === '/doc' || path.startsWith('/doc/') || path.startsWith('/doc-')) {
      response.setHeader('Content-Security-Policy', DOCS_CONTENT_SECURITY_POLICY);
    } else if (webPolicy) {
      const policy = getWebPolicy();
      if (policy) {
        response.setHeader('Content-Security-Policy', policy);
      }
    }

    next();
  };
};

type SecurityHeadersEnv = {
  helmetPolicy: boolean;
  contentSecurityPolicy: boolean;
  webRoot: string;
};

export const createSecurityHeaders = (
  { helmetPolicy, contentSecurityPolicy, webRoot }: SecurityHeadersEnv,
  getMapSources?: () => string[],
) => {
  const messages: string[] = [];
  const webPolicy = contentSecurityPolicy && !helmetPolicy;
  const manifest = webPolicy ? readCspManifest(join(webRoot, '.csp.json')) : undefined;

  if (helmetPolicy) {
    messages.push('Using the Content-Security-Policy of IMMICH_HELMET_FILE for the web app');
  } else if (!contentSecurityPolicy) {
    messages.push('IMMICH_CONTENT_SECURITY_POLICY=false, the web app is served without a Content-Security-Policy');
  } else if (!manifest && existsSync(join(webRoot, 'index.html'))) {
    messages.push(
      'The web build has no CSP manifest (.csp.json), the web app is served without a Content-Security-Policy',
    );
  }

  return { messages, middleware: createSecurityHeadersMiddleware({ manifest, webPolicy, getMapSources }) };
};
