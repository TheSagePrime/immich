import { LoginResponseDto, getConfig, updateConfig } from '@immich/sdk';
import { createHash } from 'node:crypto';
import { app, asBearerAuth, baseUrl, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const directive = (policy: string, name: string) =>
  policy
    .split(';')
    .map((item) => item.trim().split(' '))
    .find(([key]) => key === name)
    ?.slice(1);

const inlineHashes = (html: string, tag: 'script' | 'style') =>
  html
    .matchAll(new RegExp(String.raw`<${tag}(?![^>]*\ssrc=)[^>]*>([\s\S]*?)</${tag}>`, 'g'))
    .map(([, content]) => `'sha256-${createHash('sha256').update(content).digest('base64')}'`)
    .toArray();

describe('security headers', () => {
  let admin: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  it('should serve the web app with a strict content security policy', async () => {
    const { status, headers, text } = await request(baseUrl).get('/photos').set('Accept', 'text/html');
    expect(status).toBe(200);
    expect(headers['x-content-type-options']).toBe('nosniff');

    const policy = headers['content-security-policy'];
    expect(policy).toBeDefined();
    expect(directive(policy, 'default-src')).toEqual([`'self'`]);
    expect(directive(policy, 'object-src')).toEqual([`'none'`]);
    expect(directive(policy, 'base-uri')).toEqual([`'self'`]);
    expect(directive(policy, 'frame-ancestors')).toEqual([`'none'`]);

    const scriptSources = directive(policy, 'script-src')!;
    expect(scriptSources).not.toContain(`'unsafe-inline'`);
    expect(scriptSources).not.toContain(`'unsafe-eval'`);

    const scripts = inlineHashes(text, 'script');
    expect(scripts.length).toBeGreaterThan(0);
    for (const hash of scripts) {
      expect(scriptSources).toContain(hash);
    }
    for (const hash of inlineHashes(text, 'style')) {
      expect(directive(policy, 'style-src')).toContain(hash);
    }
  });

  it('should serve the index file directly with the same policy', async () => {
    const page = await request(baseUrl).get('/photos').set('Accept', 'text/html');
    const index = await request(baseUrl).get('/index.html');
    expect(index.headers['content-security-policy']).toBe(page.headers['content-security-policy']);
  });

  it('should not allow third-party hosts by default', async () => {
    const { headers } = await request(baseUrl).get('/').set('Accept', 'text/html');
    const policy = headers['content-security-policy'];
    expect(policy).not.toContain('tiles.immich.cloud');
    expect(policy).not.toContain('gstatic');
  });

  it('should sandbox api responses', async () => {
    const { headers } = await request(app).get('/server/ping');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(directive(headers['content-security-policy'], 'sandbox')).toEqual([]);
    expect(directive(headers['content-security-policy'], 'default-src')).toEqual([`'none'`]);
  });

  it('should sandbox asset originals and thumbnails', async () => {
    const asset = await utils.createAsset(admin.accessToken);

    const original = await request(app)
      .get(`/assets/${asset.id}/original`)
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(original.status).toBe(200);

    for (const path of [`/assets/${asset.id}/original`, `/assets/${asset.id}/thumbnail`]) {
      const { headers } = await request(app).get(path).set('Authorization', `Bearer ${admin.accessToken}`);
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(directive(headers['content-security-policy'], 'sandbox')).toEqual([]);
      expect(directive(headers['content-security-policy'], 'frame-ancestors')).toEqual([`'none'`]);
    }
  });

  it('should disable third-party features by default', async () => {
    const config = await getConfig({ headers: asBearerAuth(admin.accessToken) });
    expect(config.map.enabled).toBe(false);
    expect(config.newVersionCheck.enabled).toBe(false);
    expect(config.sharedLink.defaultExpiryDays).toBe(30);

    const { body } = await request(app).get('/server/features');
    expect(body.map).toBe(false);
  });

  it('should allow the map tile hosts once the map is enabled', async () => {
    const config = await getConfig({ headers: asBearerAuth(admin.accessToken) });
    await updateConfig(
      { adminConfigDto: { ...config, map: { ...config.map, enabled: true } } },
      { headers: asBearerAuth(admin.accessToken) },
    );

    try {
      const { headers } = await request(baseUrl).get('/map').set('Accept', 'text/html');
      const connectSources = directive(headers['content-security-policy'], 'connect-src');
      expect(connectSources).toContain('https://tiles.immich.cloud');
      expect(connectSources).toContain('https://static.immich.cloud');
    } finally {
      await updateConfig({ adminConfigDto: config }, { headers: asBearerAuth(admin.accessToken) });
    }

    const { headers } = await request(baseUrl).get('/map').set('Accept', 'text/html');
    expect(headers['content-security-policy']).not.toContain('tiles.immich.cloud');
  });
});
