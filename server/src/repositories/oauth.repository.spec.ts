import { Server, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaults } from 'src/dtos/config.dto.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { OAuthConfig, OAuthRepository } from 'src/repositories/oauth.repository.js';

const loggerMock = {
  setContext: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as LoggingRepository;

const configWith = (outboundAllowedHosts: string[]) =>
  ({ getEnv: () => ({ network: { outboundAllowedHosts } }) }) as unknown as ConfigRepository;

describe(OAuthRepository.name, () => {
  let server: Server;
  let issuer: string;
  let requests: string[];

  beforeAll(async () => {
    requests = [];
    server = createServer((request, response) => {
      requests.push(request.url ?? '');
      if (request.url === '/.well-known/openid-configuration') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            code_challenge_methods_supported: ['S256'],
          }),
        );
        return;
      }

      if (request.url === '/picture.png') {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(Buffer.from([1, 2, 3]));
        return;
      }

      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const getConfig = (): OAuthConfig => ({
    ...defaults.oauth,
    clientId: 'immich',
    issuerUrl: issuer,
    allowInsecureRequests: true,
  });

  it('should refuse OAuth discovery against a private issuer that is not allowlisted', async () => {
    const sut = new OAuthRepository(loggerMock, configWith([]));
    requests.length = 0;

    await expect(sut.authorize(getConfig(), 'http://immich/auth/login')).rejects.toThrow('Error in OAuth discovery');
    expect(requests).toEqual([]);
  });

  it('should allow OAuth discovery against an allowlisted private issuer', async () => {
    const sut = new OAuthRepository(loggerMock, configWith(['127.0.0.1']));

    const { url } = await sut.authorize(getConfig(), 'http://immich/auth/login', 'state', 'challenge');

    expect(url.startsWith(`${issuer}/authorize?`)).toBe(true);
    expect(requests).toContain('/.well-known/openid-configuration');
  });

  it('should refuse to download a profile picture from a private address', async () => {
    const sut = new OAuthRepository(loggerMock, configWith([]));
    requests.length = 0;

    await expect(sut.getProfilePicture(`${issuer}/picture.png`)).rejects.toThrow('private or reserved address');
    await expect(sut.getProfilePicture('http://169.254.169.254/latest/meta-data/')).rejects.toThrow('is not allowed');
    expect(requests).toEqual([]);
  });

  it('should download a profile picture from an allowed address', async () => {
    const sut = new OAuthRepository(loggerMock, configWith(['127.0.0.1']));

    const data = await sut.getProfilePicture(`${issuer}/picture.png`);

    expect(Buffer.from(data)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('should decode a profile picture embedded as a data URL', async () => {
    const sut = new OAuthRepository(loggerMock, configWith([]));

    const data = await sut.getProfilePicture(`data:image/png;base64,${Buffer.from([4, 5, 6]).toString('base64')}`);

    expect(Buffer.from(data)).toEqual(Buffer.from([4, 5, 6]));
  });
});
