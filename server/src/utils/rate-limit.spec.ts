import { defaults } from 'src/dtos/config.dto.js';
import { getLockoutMinutes, getRetryAfterSeconds, normalizeClientIp } from 'src/utils/rate-limit.js';
import { describe, expect, it } from 'vitest';

describe('getLockoutMinutes', () => {
  const config = { ...defaults.passwordLogin.rateLimit, lockoutMinutes: 2, maxLockoutMinutes: 30 };

  it.each([
    [0, 0],
    [4, 0],
    [5, 2],
    [6, 4],
    [7, 8],
    [8, 16],
    [9, 30],
    [500, 30],
  ])('should lock %i failures for %i minutes', (failures, minutes) => {
    expect(getLockoutMinutes(failures, 5, config)).toBe(minutes);
  });
});

describe('getRetryAfterSeconds', () => {
  it('should round up and never return less than one second', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(getRetryAfterSeconds(new Date('2026-01-01T00:00:10.200Z'), now)).toBe(11);
    expect(getRetryAfterSeconds(new Date('2025-12-31T23:59:59.000Z'), now)).toBe(1);
  });
});

describe('normalizeClientIp', () => {
  it.each([
    ['192.0.2.10', '192.0.2.10'],
    [' 192.0.2.10 ', '192.0.2.10'],
    ['::ffff:192.0.2.10', '192.0.2.10'],
    ['2001:DB8:aa:bb:cc:dd:ee:ff', '2001:db8:aa:bb::/64'],
    ['2001:db8:aa:bb::1', '2001:db8:aa:bb::/64'],
    ['::1', '0:0:0:0::/64'],
    ['', undefined],
    ['not-an-ip', undefined],
  ])('should normalize %s to %s', (input, expected) => {
    expect(normalizeClientIp(input)).toBe(expected);
  });
});
