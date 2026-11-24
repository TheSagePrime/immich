import { HttpException, HttpStatus } from '@nestjs/common';
import { isIP } from 'node:net';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { parseIpv6 } from 'src/utils/safe-fetch.js';

export type LoginRateLimitConfig = SystemConfig['passwordLogin']['rateLimit'];

export class TooManyRequestsException extends HttpException {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number,
  ) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

export const getLockoutMinutes = (failures: number, maxFailures: number, config: LoginRateLimitConfig) => {
  if (failures < maxFailures) {
    return 0;
  }

  const exponent = Math.min(failures - maxFailures, 30);
  return Math.min(config.lockoutMinutes * 2 ** exponent, config.maxLockoutMinutes);
};

export const getRetryAfterSeconds = (lockedUntil: Date, now: Date) =>
  Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000));

export const normalizeClientIp = (ip: string): string | undefined => {
  const address = ip.trim().toLowerCase();
  if (isIP(address) === 4) {
    return address;
  }

  const groups = parseIpv6(address);
  if (!groups) {
    return;
  }

  const isMapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xff_ff;
  if (isMapped) {
    return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  }

  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
};
