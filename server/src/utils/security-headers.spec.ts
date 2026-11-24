import type { NextFunction, Request, Response } from 'express';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  API_CONTENT_SECURITY_POLICY,
  buildWebContentSecurityPolicy,
  createSecurityHeaders,
  createSecurityHeadersMiddleware,
  getMapCspSources,
  readCspManifest,
} from 'src/utils/security-headers.js';

const manifest = {
  'script-src': [`'sha256-c2NyaXB0'`],
  'style-src': [`'sha256-c3R5bGU='`],
};

const run = (middleware: ReturnType<typeof createSecurityHeadersMiddleware>, path: string) => {
  const headers: Record<string, string> = {};
  const response = { setHeader: (name: string, value: string) => (headers[name.toLowerCase()] = value) };
  const next = vi.fn() as NextFunction;
  middleware({ path } as Request, response as unknown as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return headers;
};

const directive = (policy: string, name: string) =>
  policy
    .split('; ')
    .find((item) => item.split(' ', 1)[0] === name)
    ?.split(' ')
    .slice(1);

describe('getMapCspSources', () => {
  it('should allow nothing when the map is disabled', () => {
    expect(
      getMapCspSources({
        enabled: false,
        lightStyle: 'https://tiles.immich.cloud/v1/style/light.json',
        darkStyle: 'https://tiles.immich.cloud/v1/style/dark.json',
      }),
    ).toEqual([]);
  });

  it('should allow the official tile hosts', () => {
    expect(
      getMapCspSources({
        enabled: true,
        lightStyle: 'https://tiles.immich.cloud/v1/style/light.json',
        darkStyle: 'https://tiles.immich.cloud/v1/style/dark.json',
      }),
    ).toEqual(['https://tiles.immich.cloud', 'https://static.immich.cloud']);
  });

  it('should allow the origins of custom styles and ignore invalid ones', () => {
    expect(
      getMapCspSources({
        enabled: true,
        lightStyle: 'https://maps.example.com/styles/light.json',
        darkStyle: 'javascript:alert(1)',
      }),
    ).toEqual(['https://maps.example.com']);
  });
});

describe('buildWebContentSecurityPolicy', () => {
  it('should build a strict policy with the build hashes', () => {
    const policy = buildWebContentSecurityPolicy({ manifest });

    expect(directive(policy, 'default-src')).toEqual([`'self'`]);
    expect(directive(policy, 'script-src')).toEqual([`'self'`, `'wasm-unsafe-eval'`, `'sha256-c2NyaXB0'`]);
    expect(directive(policy, 'style-src')).toEqual([`'self'`, `'sha256-c3R5bGU='`]);
    expect(directive(policy, 'object-src')).toEqual([`'none'`]);
    expect(directive(policy, 'base-uri')).toEqual([`'self'`]);
    expect(directive(policy, 'frame-ancestors')).toEqual([`'none'`]);
    expect(directive(policy, 'connect-src')).toEqual([`'self'`, 'blob:', 'https://pay.futo.org']);
    expect(directive(policy, 'script-src')).not.toContain(`'unsafe-inline'`);
    expect(directive(policy, 'script-src')).not.toContain(`'unsafe-eval'`);
    expect(directive(policy, 'img-src')).toEqual([`'self'`, 'data:', 'blob:']);
  });

  it('should add the map sources', () => {
    const policy = buildWebContentSecurityPolicy({ manifest, mapSources: ['https://tiles.immich.cloud'] });
    expect(directive(policy, 'connect-src')).toEqual([
      `'self'`,
      'blob:',
      'https://pay.futo.org',
      'https://tiles.immich.cloud',
    ]);
    expect(directive(policy, 'img-src')).toContain('https://tiles.immich.cloud');
  });
});

describe('createSecurityHeadersMiddleware', () => {
  it('should sandbox api responses', () => {
    const middleware = createSecurityHeadersMiddleware({ manifest, webPolicy: true });
    for (const path of ['/api/assets/123/original', '/api/assets/123/thumbnail', '/api/server/config', '/api']) {
      expect(run(middleware, path)).toEqual({
        'x-content-type-options': 'nosniff',
        'content-security-policy': API_CONTENT_SECURITY_POLICY,
      });
    }
    expect(API_CONTENT_SECURITY_POLICY).toContain('sandbox');
    expect(API_CONTENT_SECURITY_POLICY).toContain(`default-src 'none'`);
  });

  it('should sandbox api responses regardless of the path case', () => {
    const middleware = createSecurityHeadersMiddleware({ manifest, webPolicy: true });
    for (const path of ['/API/assets/123/original', '/Api/assets/123/thumbnail', '/aPi']) {
      expect(run(middleware, path)['content-security-policy']).toBe(API_CONTENT_SECURITY_POLICY);
    }
    expect(run(middleware, '/DOC')['content-security-policy']).toBe(
      `frame-ancestors 'none'; object-src 'none'; base-uri 'self'`,
    );
  });

  it('should sandbox api responses even when the web policy is off', () => {
    const middleware = createSecurityHeadersMiddleware({ webPolicy: false });
    expect(run(middleware, '/api/assets/123/original')['content-security-policy']).toBe(API_CONTENT_SECURITY_POLICY);
    expect(run(middleware, '/photos')).toEqual({ 'x-content-type-options': 'nosniff' });
  });

  it('should set the web policy on web routes', () => {
    const middleware = createSecurityHeadersMiddleware({ manifest, webPolicy: true });
    const headers = run(middleware, '/photos');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-security-policy']).toBe(buildWebContentSecurityPolicy({ manifest }));
    expect(run(middleware, '/apiary')['content-security-policy']).toBe(buildWebContentSecurityPolicy({ manifest }));
  });

  it('should follow map changes', () => {
    let mapSources: string[] = [];
    const middleware = createSecurityHeadersMiddleware({ manifest, webPolicy: true, getMapSources: () => mapSources });
    expect(run(middleware, '/map')['content-security-policy']).not.toContain('tiles.immich.cloud');

    mapSources = ['https://tiles.immich.cloud'];
    expect(run(middleware, '/map')['content-security-policy']).toContain('https://tiles.immich.cloud');
  });

  it('should only protect against framing on the api documentation', () => {
    const middleware = createSecurityHeadersMiddleware({ manifest, webPolicy: true });
    expect(run(middleware, '/doc')['content-security-policy']).toBe(
      `frame-ancestors 'none'; object-src 'none'; base-uri 'self'`,
    );
  });
});

describe('readCspManifest', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'immich-csp-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should return undefined when the manifest does not exist', () => {
    expect(readCspManifest(join(tempDir, '.csp.json'))).toBeUndefined();
  });

  it('should read hashes', async () => {
    await writeFile(join(tempDir, '.csp.json'), JSON.stringify(manifest));
    expect(readCspManifest(join(tempDir, '.csp.json'))).toEqual(manifest);
  });

  it('should reject anything but hashes', async () => {
    await writeFile(join(tempDir, '.csp.json'), JSON.stringify({ 'script-src': [`'unsafe-inline'`] }));
    expect(() => readCspManifest(join(tempDir, '.csp.json'))).toThrow('Invalid CSP manifest entry');
  });

  it('should explain why the web policy is missing', async () => {
    await writeFile(join(tempDir, 'index.html'), '<html></html>');
    expect(
      createSecurityHeaders({ helmetPolicy: false, contentSecurityPolicy: true, webRoot: tempDir }).messages,
    ).toEqual([expect.stringContaining('no CSP manifest')]);
    expect(
      createSecurityHeaders({ helmetPolicy: false, contentSecurityPolicy: false, webRoot: tempDir }).messages,
    ).toEqual([expect.stringContaining('IMMICH_CONTENT_SECURITY_POLICY=false')]);
    expect(
      createSecurityHeaders({ helmetPolicy: true, contentSecurityPolicy: true, webRoot: tempDir }).messages,
    ).toEqual([expect.stringContaining('IMMICH_HELMET_FILE')]);
  });
});
