import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  HostResolver,
  OutboundAllowlist,
  OutboundRequestBlockedError,
  ResponseTooLargeError,
  createSafeFetch,
  isPrivateAddress,
  resolveAllowedAddress,
} from 'src/utils/safe-fetch.js';

const resolverFor =
  (records: Record<string, string[]>): HostResolver =>
  (hostname) => {
    const addresses = records[hostname];
    if (!addresses) {
      return Promise.reject(new Error(`ENOTFOUND ${hostname}`));
    }
    return Promise.resolve(addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  };

const allowLoopback = (resolver?: HostResolver) => createSafeFetch({ allowedHosts: ['127.0.0.1'], resolver });

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1',
    '100.127.255.255',
    '169.254.169.254',
    '169.254.1.1',
    '0.0.0.0',
    '0.1.2.3',
    '224.0.0.1',
    '239.255.255.250',
    '255.255.255.255',
    '198.18.0.1',
    '192.0.0.170',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '::127.0.0.1',
    '64:ff9b::a00:1',
    '64:ff9b::192.168.0.1',
    '2002:c0a8:101::1',
    'fc00::1',
    'fd00:ec2::254',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%eth0',
    'fec0::1',
    'ff02::1',
    '2001:db8::1',
    '2001::1',
  ])('should treat %s as private', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '93.184.216.34',
    '172.32.0.1',
    '100.128.0.1',
    '192.169.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80b::200e',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
  ])('should treat %s as public', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it('should treat garbage as private', () => {
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('OutboundAllowlist', () => {
  it('should match hosts, wildcard suffixes and networks', () => {
    const allowlist = new OutboundAllowlist(['Auth.Internal', '*.lan', '10.1.0.0/16', '192.168.1.5', 'fd00:1::/32']);

    expect(allowlist.hasHost('auth.internal')).toBe(true);
    expect(allowlist.hasHost('auth.internal.')).toBe(true);
    expect(allowlist.hasHost('idp.lan')).toBe(true);
    expect(allowlist.hasHost('lan')).toBe(false);
    expect(allowlist.hasHost('evil-lan')).toBe(false);
    expect(allowlist.hasHost('other.internal')).toBe(false);
    expect(allowlist.hasAddress('10.1.2.3')).toBe(true);
    expect(allowlist.hasAddress('10.2.0.1')).toBe(false);
    expect(allowlist.hasAddress('192.168.1.5')).toBe(true);
    expect(allowlist.hasAddress('192.168.1.6')).toBe(false);
    expect(allowlist.hasAddress('fd00:1:2::3')).toBe(true);
  });

  it.each(['10.0.0.0/33', 'https://example.com', 'exa mple.com', 'example.com/8'])('should reject %s', (entry) => {
    expect(() => new OutboundAllowlist([entry])).toThrow('Invalid outbound allowlist entry');
  });
});

describe('resolveAllowedAddress', () => {
  const empty = new OutboundAllowlist();

  it('should return the first resolved public address', async () => {
    const resolver = resolverFor({ 'example.com': ['93.184.216.34', '2606:2800:220:1::1'] });
    await expect(resolveAllowedAddress('example.com', empty, resolver)).resolves.toEqual({
      address: '93.184.216.34',
      family: 4,
    });
  });

  it('should block a host that resolves to loopback', async () => {
    const resolver = resolverFor({ 'localtest.me': ['127.0.0.1'] });
    await expect(resolveAllowedAddress('localtest.me', empty, resolver)).rejects.toBeInstanceOf(
      OutboundRequestBlockedError,
    );
  });

  it('should block a host when any of its addresses is private', async () => {
    const resolver = resolverFor({ 'mixed.example': ['93.184.216.34', '10.0.0.5'] });
    await expect(resolveAllowedAddress('mixed.example', empty, resolver)).rejects.toThrow(
      'IMMICH_OUTBOUND_ALLOWED_HOSTS',
    );
  });

  it.each(['127.0.0.1', '[::1]', '169.254.169.254', '[fd00:ec2::254]', '[::ffff:10.0.0.1]'])(
    'should block the literal address %s without resolving it',
    async (hostname) => {
      const resolver = vi.fn<HostResolver>();
      await expect(resolveAllowedAddress(hostname, empty, resolver)).rejects.toBeInstanceOf(
        OutboundRequestBlockedError,
      );
      expect(resolver).not.toHaveBeenCalled();
    },
  );

  it('should allow a private address for an allowlisted host', async () => {
    const resolver = resolverFor({ 'auth.internal': ['192.168.1.10'] });
    const allowlist = new OutboundAllowlist(['auth.internal']);
    await expect(resolveAllowedAddress('auth.internal', allowlist, resolver)).resolves.toEqual({
      address: '192.168.1.10',
      family: 4,
    });
  });

  it('should allow a private address inside an allowlisted network', async () => {
    const resolver = resolverFor({ 'idp.example': ['10.20.0.4'] });
    const allowlist = new OutboundAllowlist(['10.20.0.0/16']);
    await expect(resolveAllowedAddress('idp.example', allowlist, resolver)).resolves.toMatchObject({
      address: '10.20.0.4',
    });
  });

  it.each(['169.254.169.254', 'fd00:ec2::254', '0.0.0.0', '::', '224.0.0.1', 'ff02::1'])(
    'should always block %s, even for an allowlisted host',
    async (address) => {
      const resolver = resolverFor({ 'auth.internal': [address] });
      const allowlist = new OutboundAllowlist(['auth.internal', '0.0.0.0/0', '::/0']);
      await expect(resolveAllowedAddress('auth.internal', allowlist, resolver)).rejects.toBeInstanceOf(
        OutboundRequestBlockedError,
      );
    },
  );

  it('should fail when the host does not resolve', async () => {
    await expect(resolveAllowedAddress('missing.example', empty, resolverFor({}))).rejects.toThrow(
      'Failed to resolve missing.example',
    );
  });
});

describe('createSafeFetch', () => {
  let server: Server;
  let port: number;
  const requests: IncomingMessage[] = [];
  const bodies: string[] = [];

  const handler = (request: IncomingMessage, response: ServerResponse) => {
    requests.push(request);
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      bodies.push(body);
      const url = new URL(request.url ?? '/', 'http://localhost');
      switch (url.pathname) {
        case '/ok': {
          response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] });
          response.end(JSON.stringify({ ok: true, host: request.headers.host }));
          return;
        }
        case '/gzip': {
          response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
          response.end(gzipSync('compressed hello'));
          return;
        }
        case '/redirect': {
          response.writeHead(302, { location: url.searchParams.get('to') ?? '/ok' });
          response.end();
          return;
        }
        case '/see-other': {
          response.writeHead(303, { location: '/ok' });
          response.end();
          return;
        }
        case '/loop': {
          response.writeHead(307, { location: '/loop' });
          response.end();
          return;
        }
        case '/large': {
          response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '2048' });
          response.end(Buffer.alloc(2048));
          return;
        }
        case '/chunked': {
          response.writeHead(200, { 'content-type': 'application/octet-stream' });
          response.write(Buffer.alloc(1024));
          response.end(Buffer.alloc(1024));
          return;
        }
        case '/bomb': {
          response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
          response.end(gzipSync(Buffer.alloc(64 * 1024)));
          return;
        }
        case '/empty': {
          response.writeHead(204);
          response.end();
          return;
        }
        default: {
          response.writeHead(404);
          response.end('not found');
        }
      }
    });
  };

  beforeAll(async () => {
    server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('should block loopback by default', async () => {
    const safeFetch = createSafeFetch();
    await expect(safeFetch(`http://127.0.0.1:${port}/ok`)).rejects.toBeInstanceOf(OutboundRequestBlockedError);
    await expect(safeFetch(`http://[::1]:${port}/ok`)).rejects.toBeInstanceOf(OutboundRequestBlockedError);
  });

  it('should block a host name that resolves to loopback', async () => {
    const safeFetch = createSafeFetch({ resolver: resolverFor({ 'evil.example': ['127.0.0.1'] }) });
    await expect(safeFetch(`http://evil.example:${port}/ok`)).rejects.toBeInstanceOf(OutboundRequestBlockedError);
    expect(requests.length).toBe(0);
  });

  it('should reject other protocols and credentials in the URL', async () => {
    const safeFetch = createSafeFetch();
    await expect(safeFetch('file:///etc/passwd')).rejects.toBeInstanceOf(OutboundRequestBlockedError);
    await expect(safeFetch('ftp://example.com/file')).rejects.toBeInstanceOf(OutboundRequestBlockedError);
    await expect(safeFetch('https://user:pass@example.com/')).rejects.toBeInstanceOf(OutboundRequestBlockedError);
  });

  it('should fetch an allowed address and return a regular response', async () => {
    const response = await allowLoopback()(`http://127.0.0.1:${port}/ok`);

    expect(response.status).toBe(200);
    expect(response.ok).toBe(true);
    expect(response.url).toBe(`http://127.0.0.1:${port}/ok`);
    expect(response.headers.get('set-cookie')).toBe('a=1, b=2');
    await expect(response.json()).resolves.toEqual({ ok: true, host: `127.0.0.1:${port}` });
    expect(requests.at(-1)?.headers['user-agent']).toMatch(/^immich-server\//);
  });

  it('should connect to the address it validated instead of resolving the host again', async () => {
    const resolver = vi.fn(resolverFor({ 'pinned.example': ['127.0.0.1'] }));
    const safeFetch = createSafeFetch({ allowedHosts: ['127.0.0.0/8'], resolver });

    const response = await safeFetch(`http://pinned.example:${port}/ok`);

    await expect(response.json()).resolves.toEqual({ ok: true, host: `pinned.example:${port}` });
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('should send a POST body', async () => {
    const response = await allowLoopback()(`http://127.0.0.1:${port}/ok`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code: 'abc' }),
    });

    expect(response.status).toBe(200);
    expect(bodies.at(-1)).toBe('grant_type=authorization_code&code=abc');
    expect(requests.at(-1)?.headers['content-type']).toBe('application/x-www-form-urlencoded;charset=UTF-8');
  });

  it('should reject a response with a declared length above the limit', async () => {
    const safeFetch = createSafeFetch({ allowedHosts: ['127.0.0.1'], maxResponseSize: 1024 });

    await expect(safeFetch(`http://127.0.0.1:${port}/large`)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('should stop reading a streamed response once it exceeds the limit', async () => {
    const safeFetch = createSafeFetch({ allowedHosts: ['127.0.0.1'], maxResponseSize: 1500 });

    const response = await safeFetch(`http://127.0.0.1:${port}/chunked`);
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  it('should apply the limit to the decompressed body', async () => {
    const safeFetch = createSafeFetch({ allowedHosts: ['127.0.0.1'], maxResponseSize: 4096 });

    const response = await safeFetch(`http://127.0.0.1:${port}/bomb`);
    await expect(response.text()).rejects.toThrow();
  });

  it('should read a response within the limit', async () => {
    const safeFetch = createSafeFetch({ allowedHosts: ['127.0.0.1'], maxResponseSize: 2048 });

    const response = await safeFetch(`http://127.0.0.1:${port}/chunked`);
    await expect(response.arrayBuffer()).resolves.toHaveProperty('byteLength', 2048);
  });

  it('should check every hop against the url filter', async () => {
    const safeFetch = createSafeFetch({
      allowedHosts: ['127.0.0.1', 'localhost'],
      isUrlAllowed: (url) => url.hostname === '127.0.0.1',
    });

    await expect(safeFetch(`http://127.0.0.1:${port}/redirect?to=/ok`)).resolves.toHaveProperty('status', 200);
    const count = requests.length;
    await expect(
      safeFetch(`http://127.0.0.1:${port}/redirect?to=${encodeURIComponent(`http://localhost:${port}/ok`)}`),
    ).rejects.toBeInstanceOf(OutboundRequestBlockedError);
    expect(requests.length).toBe(count + 1);
    await expect(safeFetch(`http://localhost:${port}/ok`)).rejects.toBeInstanceOf(OutboundRequestBlockedError);
  });

  it('should decompress gzip responses', async () => {
    const response = await allowLoopback()(`http://127.0.0.1:${port}/gzip`);

    expect(response.headers.get('content-encoding')).toBeNull();
    await expect(response.text()).resolves.toBe('compressed hello');
  });

  it('should return a response without a body for 204', async () => {
    const response = await allowLoopback()(`http://127.0.0.1:${port}/empty`);

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it('should follow redirects to allowed addresses', async () => {
    const response = await allowLoopback()(`http://127.0.0.1:${port}/redirect`);

    expect(response.status).toBe(200);
    expect(response.redirected).toBe(true);
    expect(response.url).toBe(`http://127.0.0.1:${port}/ok`);
  });

  it('should validate every redirect hop', async () => {
    const safeFetch = allowLoopback();
    const to = encodeURIComponent('http://169.254.169.254/latest/meta-data/');

    await expect(safeFetch(`http://127.0.0.1:${port}/redirect?to=${to}`)).rejects.toBeInstanceOf(
      OutboundRequestBlockedError,
    );
  });

  it('should validate the resolved address of a redirect target', async () => {
    const safeFetch = allowLoopback(resolverFor({ 'internal.example': ['10.0.0.8'] }));
    const to = encodeURIComponent('http://internal.example/admin');

    await expect(safeFetch(`http://127.0.0.1:${port}/redirect?to=${to}`)).rejects.toBeInstanceOf(
      OutboundRequestBlockedError,
    );
  });

  it('should not follow redirects to other protocols', async () => {
    const to = encodeURIComponent('file:///etc/passwd');

    await expect(allowLoopback()(`http://127.0.0.1:${port}/redirect?to=${to}`)).rejects.toBeInstanceOf(
      OutboundRequestBlockedError,
    );
  });

  it('should strip credentials on a cross-origin redirect', async () => {
    const safeFetch = createSafeFetch({
      allowedHosts: ['127.0.0.1', 'other.example'],
      resolver: resolverFor({ 'other.example': ['127.0.0.1'] }),
    });
    const to = encodeURIComponent(`http://other.example:${port}/ok`);

    const response = await safeFetch(`http://127.0.0.1:${port}/redirect?to=${to}`, {
      headers: { authorization: 'Bearer secret', 'x-custom': 'kept' },
    });

    expect(response.status).toBe(200);
    expect(requests.at(-2)?.headers.authorization).toBe('Bearer secret');
    expect(requests.at(-1)?.headers.authorization).toBeUndefined();
    expect(requests.at(-1)?.headers['x-custom']).toBe('kept');
  });

  it('should switch to GET after a 303', async () => {
    const response = await allowLoopback()(`http://127.0.0.1:${port}/see-other`, { method: 'POST', body: 'data' });

    expect(response.status).toBe(200);
    expect(requests.at(-1)?.method).toBe('GET');
    expect(bodies.at(-1)).toBe('');
  });

  it('should return the redirect response when redirect is manual', async () => {
    const response = await allowLoopback()(`http://127.0.0.1:${port}/redirect`, { redirect: 'manual' });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/ok');
  });

  it('should reject redirects when redirect is error', async () => {
    await expect(allowLoopback()(`http://127.0.0.1:${port}/redirect`, { redirect: 'error' })).rejects.toThrow(
      'Unexpected redirect',
    );
  });

  it('should stop after too many redirects', async () => {
    const safeFetch = createSafeFetch({ allowedHosts: ['127.0.0.1'], maxRedirects: 3 });

    await expect(safeFetch(`http://127.0.0.1:${port}/loop`)).rejects.toThrow('Too many redirects');
  });

  it('should accept a Request object', async () => {
    const response = await allowLoopback()(new Request(`http://127.0.0.1:${port}/ok`, { method: 'POST', body: 'x' }));

    expect(response.status).toBe(200);
    expect(bodies.at(-1)).toBe('x');
  });

  it('should abort when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(allowLoopback()(`http://127.0.0.1:${port}/ok`, { signal: controller.signal })).rejects.toThrow();
  });
});
