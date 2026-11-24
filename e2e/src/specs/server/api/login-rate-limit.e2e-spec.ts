import { LoginResponseDto, getAdminConfig, updateAdminConfig } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const login = (email: string, password: string) => request(app).post('/auth/login').send({ email, password });

describe('password login rate limiting', () => {
  let admin: LoginResponseDto;

  const setRateLimit = async (rateLimit: Record<string, unknown>) => {
    const config = await getAdminConfig({ headers: asBearerAuth(admin.accessToken) });
    config.passwordLogin.rateLimit = { ...config.passwordLogin.rateLimit, ...rateLimit };
    await updateAdminConfig({ adminConfigDto: config }, { headers: asBearerAuth(admin.accessToken) });
  };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
  });

  beforeEach(async () => {
    await utils.resetDatabase(['login_attempt']);
    await setRateLimit({
      enabled: true,
      accountMaxFailures: 5,
      ipMaxFailures: 30,
      windowMinutes: 15,
      lockoutMinutes: 1,
      maxLockoutMinutes: 60,
    });
  });

  it('should lock an account after 5 failed logins and answer 429 with Retry-After', async () => {
    const user = await utils.userSetup(admin.accessToken, createUserDto.create('rate-limit-1'));
    const password = createUserDto.create('rate-limit-1').password;

    for (let i = 0; i < 4; i++) {
      const { status, body } = await login(user.userEmail, 'wrong-password');
      expect(status).toBe(401);
      expect(body).toEqual(expect.objectContaining({ message: 'Incorrect email or password' }));
    }

    const locked = await login(user.userEmail, 'wrong-password');
    expect(locked.status).toBe(429);
    expect(locked.body).toEqual(
      expect.objectContaining({ message: 'Too many failed login attempts, try again later' }),
    );
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(50);
    expect(Number(locked.headers['retry-after'])).toBeLessThanOrEqual(60);

    const correct = await login(user.userEmail, password);
    expect(correct.status).toBe(429);
    expect(correct.headers['retry-after']).toBeDefined();
  });

  it('should answer the same way for an email that does not exist', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const { status } = await login('does-not-exist@immich.cloud', 'wrong-password');
      statuses.push(status);
    }

    expect(statuses).toEqual([401, 401, 401, 401, 429, 429]);
  });

  it('should keep other accounts usable and reset the count after a successful login', async () => {
    const [user, other] = await Promise.all([
      utils.userSetup(admin.accessToken, createUserDto.create('rate-limit-2')),
      utils.userSetup(admin.accessToken, createUserDto.create('rate-limit-3')),
    ]);

    for (let i = 0; i < 4; i++) {
      await login(user.userEmail, 'wrong-password');
    }
    expect((await login(other.userEmail, createUserDto.create('rate-limit-3').password)).status).toBe(201);
    expect((await login(user.userEmail, createUserDto.create('rate-limit-2').password)).status).toBe(201);

    for (let i = 0; i < 4; i++) {
      expect((await login(user.userEmail, 'wrong-password')).status).toBe(401);
    }
  });

  it('should lock a client address that tries many accounts', async () => {
    await setRateLimit({ ipMaxFailures: 3 });
    const user = await utils.userSetup(admin.accessToken, createUserDto.create('rate-limit-4'));

    expect((await login('spray-1@immich.cloud', 'wrong-password')).status).toBe(401);
    expect((await login('spray-2@immich.cloud', 'wrong-password')).status).toBe(401);
    expect((await login('spray-3@immich.cloud', 'wrong-password')).status).toBe(429);
    expect((await login(user.userEmail, createUserDto.create('rate-limit-4').password)).status).toBe(429);
  });

  it('should not limit logins when an admin turns it off', async () => {
    const user = await utils.userSetup(admin.accessToken, createUserDto.create('rate-limit-5'));
    for (let i = 0; i < 5; i++) {
      await login(user.userEmail, 'wrong-password');
    }
    const password = createUserDto.create('rate-limit-5').password;
    expect((await login(user.userEmail, password)).status).toBe(429);

    await setRateLimit({ enabled: false });

    for (let i = 0; i < 8; i++) {
      expect((await login(user.userEmail, 'wrong-password')).status).toBe(401);
    }
    expect((await login(user.userEmail, password)).status).toBe(201);
  });
});
