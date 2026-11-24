import { lookup as dnsLookup } from 'node:dns/promises';
import http, { IncomingMessage } from 'node:http';
import https from 'node:https';
import { BlockList, LookupFunction, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { serverVersion } from 'src/constants.js';

export class OutboundRequestBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundRequestBlockedError';
  }
}

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type SafeFetchOptions = {
  allowedHosts?: string[];
  resolver?: HostResolver;
  maxRedirects?: number;
  timeout?: number;
};

export type SafeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type Subnet = [address: string, prefix: number];

const BLOCKED_IPV4: Subnet[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const BLOCKED_IPV6: Subnet[] = [
  ['::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];

const ALWAYS_BLOCKED_IPV4: Subnet[] = [
  ['0.0.0.0', 8],
  ['169.254.169.254', 32],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const ALWAYS_BLOCKED_IPV6: Subnet[] = [
  ['::', 128],
  ['fd00:ec2::254', 128],
  ['ff00::', 8],
];

const toBlockList = (ipv4: Subnet[], ipv6: Subnet[]) => {
  const list = new BlockList();
  for (const [address, prefix] of ipv4) {
    list.addSubnet(address, prefix, 'ipv4');
  }
  for (const [address, prefix] of ipv6) {
    list.addSubnet(address, prefix, 'ipv6');
  }
  return list;
};

const blocked = toBlockList(BLOCKED_IPV4, BLOCKED_IPV6);
const alwaysBlocked = toBlockList(ALWAYS_BLOCKED_IPV4, ALWAYS_BLOCKED_IPV6);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
const CROSS_ORIGIN_STRIPPED_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT = 30_000;

export const parseIpv6 = (address: string): number[] | undefined => {
  if (isIP(address) !== 6) {
    return;
  }

  let value = address.toLowerCase();
  const tail: number[] = [];
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const octets = value
      .slice(lastColon + 1)
      .split('.')
      .map(Number);
    tail.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    value = value.slice(0, lastColon + 1);
    if (!value.endsWith('::')) {
      value = value.slice(0, -1);
    }
  }

  const [head, rest] = value.includes('::') ? value.split('::') : [value, undefined];
  const parse = (part: string) => (part ? part.split(':').filter((group) => group !== '') : []);
  const headGroups = parse(head).map((group) => Number.parseInt(group, 16));
  const restGroups = rest === undefined ? [] : parse(rest).map((group) => Number.parseInt(group, 16));
  const total = 8 - tail.length;
  const zeros = rest === undefined ? 0 : total - headGroups.length - restGroups.length;
  const groups = [...headGroups, ...Array.from({ length: Math.max(zeros, 0) }, () => 0), ...restGroups, ...tail];

  return groups.length === 8 ? groups : undefined;
};

const groupsToIpv4 = (high: number, low: number) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

const getEmbeddedIpv4 = (address: string): string | undefined => {
  const groups = parseIpv6(address);
  if (!groups) {
    return;
  }

  const isMapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xff_ff;
  const isNat64 = groups[0] === 0x64 && groups[1] === 0xff_9b && groups.slice(2, 6).every((group) => group === 0);
  if (isMapped || isNat64) {
    return groupsToIpv4(groups[6], groups[7]);
  }

  if (groups[0] === 0x20_02) {
    return groupsToIpv4(groups[1], groups[2]);
  }
};

const stripBrackets = (hostname: string) =>
  hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

const checkList = (list: BlockList, address: string): boolean => {
  const family = isIP(address);
  if (family === 4) {
    return list.check(address, 'ipv4');
  }

  if (family === 6) {
    const embedded = getEmbeddedIpv4(address);
    return list.check(address, 'ipv6') || (embedded !== undefined && list.check(embedded, 'ipv4'));
  }

  return true;
};

export const isPrivateAddress = (address: string): boolean => {
  if (address.includes('%')) {
    return true;
  }
  return checkList(blocked, address);
};

const isAlwaysBlockedAddress = (address: string): boolean => address.includes('%') || checkList(alwaysBlocked, address);

export class OutboundAllowlist {
  private hosts = new Set<string>();
  private suffixes: string[] = [];
  private networks = new BlockList();

  constructor(entries: string[] = []) {
    for (const raw of entries) {
      const entry = raw.trim().toLowerCase();
      if (!entry) {
        continue;
      }

      const [address, prefix] = entry.split('/');
      const plain = stripBrackets(address);
      const family = isIP(plain);
      if (family) {
        const bits = prefix === undefined ? (family === 4 ? 32 : 128) : Number(prefix);
        const max = family === 4 ? 32 : 128;
        if (!Number.isInteger(bits) || bits < 0 || bits > max) {
          throw new Error(`Invalid outbound allowlist entry: ${raw}`);
        }
        this.networks.addSubnet(plain, bits, family === 4 ? 'ipv4' : 'ipv6');
        continue;
      }

      if (prefix !== undefined || !/^(\*\.)?[a-z0-9_-]+(\.[a-z0-9_-]+)*\.?$/.test(entry)) {
        throw new Error(`Invalid outbound allowlist entry: ${raw}`);
      }

      if (entry.startsWith('*.')) {
        this.suffixes.push(entry.slice(1).replace(/\.$/, ''));
      } else {
        this.hosts.add(entry.replace(/\.$/, ''));
      }
    }
  }

  hasHost(hostname: string): boolean {
    const host = stripBrackets(hostname.toLowerCase()).replace(/\.$/, '');
    return this.hosts.has(host) || this.suffixes.some((suffix) => host.endsWith(suffix));
  }

  hasAddress(address: string): boolean {
    const family = isIP(address);
    if (!family) {
      return false;
    }
    return this.networks.check(address, family === 4 ? 'ipv4' : 'ipv6');
  }
}

export const assertAddressAllowed = (hostname: string, address: string, allowlist: OutboundAllowlist) => {
  if (isAlwaysBlockedAddress(address)) {
    throw new OutboundRequestBlockedError(`Outbound request to ${hostname} (${address}) is not allowed`);
  }

  if (!isPrivateAddress(address) || allowlist.hasHost(hostname) || allowlist.hasAddress(address)) {
    return;
  }

  throw new OutboundRequestBlockedError(
    `Outbound request to ${hostname} (${address}) is blocked because it resolves to a private or reserved address. ` +
      'Add the host to IMMICH_OUTBOUND_ALLOWED_HOSTS to allow it.',
  );
};

const defaultResolver: HostResolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
};

export const resolveAllowedAddress = async (
  hostname: string,
  allowlist: OutboundAllowlist,
  resolver: HostResolver = defaultResolver,
): Promise<ResolvedAddress> => {
  const host = stripBrackets(hostname);
  const literal = isIP(host);
  if (literal) {
    assertAddressAllowed(host, host, allowlist);
    return { address: host, family: literal === 6 ? 6 : 4 };
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(host);
  } catch (error) {
    throw new Error(`Failed to resolve ${host}`, { cause: error });
  }

  if (addresses.length === 0) {
    throw new Error(`Failed to resolve ${host}`);
  }

  for (const { address } of addresses) {
    assertAddressAllowed(host, address, allowlist);
  }

  return addresses[0];
};

const pinnedLookup =
  ({ address, family }: ResolvedAddress): LookupFunction =>
  (hostname, options, callback) => {
    if (options?.all) {
      (callback as unknown as (error: null, addresses: ResolvedAddress[]) => void)(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };

const toBuffer = async (body: RequestInit['body'] | undefined, headers: Headers): Promise<Buffer | undefined> => {
  if (body === undefined || body === null) {
    return;
  }

  if (typeof body === 'string') {
    if (!headers.has('content-type')) {
      headers.set('content-type', 'text/plain;charset=UTF-8');
    }
    return Buffer.from(body);
  }

  if (body instanceof URLSearchParams) {
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    }
    return Buffer.from(body.toString());
  }

  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }

  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }

  if (body instanceof Blob) {
    if (!headers.has('content-type') && body.type) {
      headers.set('content-type', body.type);
    }
    return Buffer.from(await body.arrayBuffer());
  }

  throw new TypeError('Unsupported request body type');
};

const decode = (response: IncomingMessage): Readable => {
  const encoding = String(response.headers['content-encoding'] ?? '')
    .trim()
    .toLowerCase();
  switch (encoding) {
    case 'gzip':
    case 'x-gzip': {
      return response.pipe(createGunzip());
    }
    case 'deflate': {
      return response.pipe(createInflate());
    }
    case 'br': {
      return response.pipe(createBrotliDecompress());
    }
    default: {
      return response;
    }
  }
};

const toResponse = (message: IncomingMessage, url: URL, method: string, redirected: boolean): Response => {
  const status = message.statusCode ?? 0;
  if (status < 200 || status > 599) {
    message.destroy();
    throw new Error(`Unexpected response status ${status} from ${url.origin}`);
  }

  const headers = new Headers();
  for (let index = 0; index < message.rawHeaders.length; index += 2) {
    headers.append(message.rawHeaders[index], message.rawHeaders[index + 1]);
  }

  let body: ReadableStream | null = null;
  if (method === 'HEAD' || NULL_BODY_STATUSES.has(status)) {
    message.resume();
  } else {
    const stream = decode(message);
    if (stream !== message) {
      headers.delete('content-encoding');
      headers.delete('content-length');
      message.on('error', (error) => stream.destroy(error));
    }
    body = Readable.toWeb(stream) as ReadableStream;
  }

  const response = new Response(body, { status, statusText: message.statusMessage, headers });
  Object.defineProperty(response, 'url', { value: url.href });
  Object.defineProperty(response, 'redirected', { value: redirected });
  return response;
};

type Hop = { url: URL; method: string; headers: Headers; body?: Buffer; signal: AbortSignal };

const send = (hop: Hop, target: ResolvedAddress) =>
  new Promise<IncomingMessage>((resolve, reject) => {
    const transport = hop.url.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = {};
    for (const [key, value] of hop.headers) {
      headers[key] = value;
    }
    if (hop.body) {
      headers['content-length'] = String(hop.body.length);
    }

    const request = transport.request(hop.url, {
      method: hop.method,
      headers,
      agent: false,
      lookup: pinnedLookup(target),
      signal: hop.signal,
    });
    request.once('response', resolve);
    request.once('error', reject);
    request.end(hop.body);
  });

const normalizeInput = async (input: string | URL | Request, init: RequestInit = {}) => {
  if (input instanceof Request) {
    const headers = new Headers(input.headers);
    for (const [key, value] of new Headers(init.headers)) {
      headers.set(key, value);
    }
    const body = init.body ?? (input.body ? await input.arrayBuffer() : undefined);
    return {
      url: new URL(input.url),
      method: (init.method ?? input.method).toUpperCase(),
      headers,
      body,
      redirect: init.redirect ?? input.redirect,
      signal: init.signal ?? input.signal,
    };
  }

  return {
    url: new URL(input),
    method: (init.method ?? 'GET').toUpperCase(),
    headers: new Headers(init.headers),
    body: init.body,
    redirect: init.redirect ?? 'follow',
    signal: init.signal ?? undefined,
  };
};

export const createSafeFetch = (options: SafeFetchOptions = {}): SafeFetch => {
  const allowlist = new OutboundAllowlist(options.allowedHosts);
  const resolver = options.resolver ?? defaultResolver;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  return async (input, init) => {
    const request = await normalizeInput(input, init);
    const timeoutSignal = AbortSignal.timeout(timeout);
    const signal = request.signal ? AbortSignal.any([request.signal, timeoutSignal]) : timeoutSignal;

    const headers = request.headers;
    if (!headers.has('user-agent')) {
      headers.set('user-agent', `immich-server/${serverVersion}`);
    }
    if (!headers.has('accept-encoding')) {
      headers.set('accept-encoding', 'gzip, deflate, br');
    }

    let url = request.url;
    let method = request.method;
    let body = await toBuffer(request.body, headers);

    for (let redirects = 0; ; redirects++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new OutboundRequestBlockedError(`Outbound request with protocol ${url.protocol} is not allowed`);
      }

      if (url.username || url.password) {
        throw new OutboundRequestBlockedError('Outbound request URLs must not contain credentials');
      }

      signal.throwIfAborted();
      const target = await resolveAllowedAddress(url.hostname, allowlist, resolver);
      const message = await send({ url, method, headers, body, signal }, target);
      const status = message.statusCode ?? 0;
      const location = message.headers.location;

      if (!REDIRECT_STATUSES.has(status) || !location || request.redirect === 'manual') {
        return toResponse(message, url, method, redirects > 0);
      }

      message.resume();

      if (request.redirect === 'error') {
        throw new TypeError(`Unexpected redirect from ${url.origin}`);
      }

      if (redirects >= maxRedirects) {
        throw new Error(`Too many redirects (more than ${maxRedirects})`);
      }

      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) {
          headers.delete(name);
        }
      }

      if (status === 303 ? method !== 'HEAD' : (status === 301 || status === 302) && method === 'POST') {
        method = 'GET';
        body = undefined;
        headers.delete('content-type');
      }

      url = next;
    }
  };
};
