import { BadRequestException } from '@nestjs/common';
import { hash } from 'bcrypt';
import { Kysely } from 'kysely';
import { AuthType, SystemMetadataKey } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ClusterGroupRepository } from 'src/repositories/cluster-group.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { LoginAttemptRepository } from 'src/repositories/login-attempt.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TelemetryRepository } from 'src/repositories/telemetry.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AuthService } from 'src/services/auth.service.js';
import { TooManyRequestsException } from 'src/utils/rate-limit.js';
import { mediumFactory, newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

// eslint-disable-next-line unicorn/no-unnecessary-parameters
const setup = (db?: Kysely<DB>) => {
  return newMediumService(AuthService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      ClusterGroupRepository,
      ConfigRepository,
      CryptoRepository,
      DatabaseRepository,
      LoginAttemptRepository,
      SessionRepository,
      SystemMetadataRepository,
      UserRepository,
    ],
    mock: [LoggingRepository, StorageRepository, EventRepository, TelemetryRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AuthService.name, () => {
  describe('adminSignUp', () => {
    it(`should sign up the admin`, async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const dto = { name: 'Admin', email: 'admin@immich.cloud', password: 'password' };

      await expect(sut.adminSignUp(dto)).resolves.toEqual(
        expect.objectContaining({
          id: expect.any(String),
          email: dto.email,
          name: dto.name,
          isAdmin: true,
        }),
      );
    });
  });

  describe('login', () => {
    it('should reject an incorrect password', async () => {
      const { sut, ctx } = setup();
      const password = 'password';
      const passwordHashed = await hash(password, 10);
      const { user } = await ctx.newUser({ password: passwordHashed });
      const dto = { email: user.email, password: 'wrong-password' };

      await expect(sut.login(dto, mediumFactory.loginDetails())).rejects.toThrow('Incorrect email or password');
    });

    it('should accept a correct password and return a login response', async () => {
      const { sut, ctx } = setup();
      const password = 'password';
      const passwordHashed = await hash(password, 10);
      const { user } = await ctx.newUser({ password: passwordHashed });
      const dto = { email: user.email, password };

      await expect(sut.login(dto, mediumFactory.loginDetails())).resolves.toEqual({
        accessToken: expect.any(String),
        isAdmin: user.isAdmin,
        isOnboarded: false,
        name: user.name,
        profileImagePath: user.profileImagePath,
        userId: user.id,
        userEmail: user.email,
        shouldChangePassword: user.shouldChangePassword,
      });
    });
  });

  describe('login rate limiting', () => {
    const details = (clientIp: string) => ({ ...mediumFactory.loginDetails(), clientIp });

    const createUser = async (ctx: ReturnType<typeof setup>['ctx'], password: string) => {
      const { user } = await ctx.newUser({ password: await hash(password, 4) });
      return user;
    };

    const fail = (sut: AuthService, email: string, clientIp: string) =>
      sut.login({ email, password: 'wrong-password' }, details(clientIp)).catch((error) => error);

    it('should lock an account after 5 failures, even for the correct password', async () => {
      const { sut, ctx } = setup();
      const user = await createUser(ctx, 'password');

      for (let i = 0; i < 4; i++) {
        await expect(fail(sut, user.email, '198.51.100.1')).resolves.toHaveProperty('status', 401);
      }

      const error = await fail(sut, user.email, '198.51.100.1');
      expect(error).toBeInstanceOf(TooManyRequestsException);
      expect(error.retryAfterSeconds).toBeGreaterThan(55);
      expect(error.retryAfterSeconds).toBeLessThanOrEqual(60);

      await expect(
        sut.login({ email: user.email, password: 'password' }, details('198.51.100.2')),
      ).rejects.toBeInstanceOf(TooManyRequestsException);
    });

    it('should handle an unknown email exactly like an existing account', async () => {
      const { sut } = setup();
      const email = 'nobody-rate-limit@immich.cloud';

      const results = [];
      for (let i = 0; i < 6; i++) {
        const error = await fail(sut, email, '198.51.100.3');
        results.push(error.status);
      }

      expect(results).toEqual([401, 401, 401, 401, 429, 429]);
    });

    it('should reset the account counter after a successful login', async () => {
      const { sut, ctx } = setup();
      const user = await createUser(ctx, 'password');

      for (let i = 0; i < 4; i++) {
        await fail(sut, user.email, '198.51.100.4');
      }
      await expect(
        sut.login({ email: user.email, password: 'password' }, details('198.51.100.4')),
      ).resolves.toBeDefined();

      for (let i = 0; i < 4; i++) {
        await expect(fail(sut, user.email, '198.51.100.4')).resolves.toHaveProperty('status', 401);
      }
    });

    it('should double the lockout when failures continue after it expired', async () => {
      const { sut, ctx } = setup();
      const user = await createUser(ctx, 'password');
      const db = ctx.database;

      for (let i = 0; i < 5; i++) {
        await fail(sut, user.email, '198.51.100.5');
      }

      await db
        .updateTable('login_attempt')
        .set({ lockedUntil: new Date(Date.now() - 1000), lastFailureAt: new Date(Date.now() - 61_000) })
        .execute();

      const error = await fail(sut, user.email, '198.51.100.5');
      expect(error).toBeInstanceOf(TooManyRequestsException);
      expect(error.retryAfterSeconds).toBeGreaterThan(115);
      expect(error.retryAfterSeconds).toBeLessThanOrEqual(120);
    });

    it('should start over once the window has passed', async () => {
      const { sut, ctx } = setup();
      const user = await createUser(ctx, 'password');
      const repository = ctx.get(LoginAttemptRepository);

      for (let i = 0; i < 4; i++) {
        await fail(sut, user.email, '198.51.100.6');
      }

      await ctx.database
        .updateTable('login_attempt')
        .set({ lastFailureAt: new Date(Date.now() - 16 * 60 * 1000) })
        .execute();

      await expect(fail(sut, user.email, '198.51.100.6')).resolves.toHaveProperty('status', 401);
      await expect(repository.cleanup(new Date(Date.now() - 15 * 60 * 1000))).resolves.toBeGreaterThanOrEqual(0);
    });

    it('should lock an ip address that tries many accounts and allow other ip addresses', async () => {
      const { sut, ctx } = setup();
      const systemMetadata = ctx.get(SystemMetadataRepository);
      await systemMetadata.set(SystemMetadataKey.SystemConfig, {
        passwordLogin: {
          enabled: true,
          rateLimit: {
            enabled: true,
            accountMaxFailures: 5,
            ipMaxFailures: 3,
            windowMinutes: 15,
            lockoutMinutes: 1,
            maxLockoutMinutes: 60,
          },
        },
      });

      try {
        const user = await createUser(ctx, 'password');
        await expect(fail(sut, 'spray-1@immich.cloud', '203.0.113.7')).resolves.toHaveProperty('status', 401);
        await expect(fail(sut, 'spray-2@immich.cloud', '203.0.113.7')).resolves.toHaveProperty('status', 401);
        await expect(fail(sut, 'spray-3@immich.cloud', '203.0.113.7')).resolves.toHaveProperty('status', 429);

        await expect(
          sut.login({ email: user.email, password: 'password' }, details('203.0.113.7')),
        ).rejects.toBeInstanceOf(TooManyRequestsException);
        await expect(
          sut.login({ email: user.email, password: 'password' }, details('203.0.113.8')),
        ).resolves.toBeDefined();
      } finally {
        await systemMetadata.set(SystemMetadataKey.SystemConfig, {});
      }
    });

    it('should not limit anything when disabled', async () => {
      const { sut, ctx } = setup();
      const systemMetadata = ctx.get(SystemMetadataRepository);
      await systemMetadata.set(SystemMetadataKey.SystemConfig, {
        passwordLogin: { enabled: true, rateLimit: { enabled: false } },
      } as never);

      try {
        const email = 'disabled-rate-limit@immich.cloud';
        for (let i = 0; i < 8; i++) {
          await expect(fail(sut, email, '198.51.100.9')).resolves.toHaveProperty('status', 401);
        }
      } finally {
        await systemMetadata.set(SystemMetadataKey.SystemConfig, {});
      }
    });
  });

  describe('logout', () => {
    it('should logout', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      await expect(sut.logout(auth, AuthType.Password)).resolves.toEqual({
        successful: true,
        redirectUri: '/auth/login?autoLaunch=0',
      });
    });

    it('should cleanup the session', async () => {
      const { sut, ctx } = setup();
      const sessionRepo = ctx.get(SessionRepository);
      const eventRepo = ctx.getMock(EventRepository);
      const { user } = await ctx.newUser();
      const { session } = await ctx.newSession({ userId: user.id });
      const auth = factory.auth({ session, user });
      eventRepo.emit.mockResolvedValue();

      await expect(sessionRepo.get(session.id)).resolves.toEqual(expect.objectContaining({ id: session.id }));
      await expect(sut.logout(auth, AuthType.Password)).resolves.toEqual({
        successful: true,
        redirectUri: '/auth/login?autoLaunch=0',
      });
      await expect(sessionRepo.get(session.id)).resolves.toBeUndefined();
    });
  });

  describe('changePassword', () => {
    it('should change the password and login with it', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      const dto = { password: 'password', newPassword: 'new-password' };
      const passwordHashed = await hash(dto.password, 10);
      const { user } = await ctx.newUser({ password: passwordHashed });
      const auth = factory.auth({ user });

      const response = await sut.changePassword(auth, dto);
      expect(response).toEqual(
        expect.objectContaining({
          id: user.id,
          email: user.email,
        }),
      );
      expect((response as any).password).not.toBeDefined();

      await expect(
        sut.login({ email: user.email, password: dto.newPassword }, mediumFactory.loginDetails()),
      ).resolves.toBeDefined();
    });

    it('should validate the current password', async () => {
      const { sut, ctx } = setup();
      const dto = { password: 'wrong-password', newPassword: 'new-password' };
      const passwordHashed = await hash('password', 10);
      const { user } = await ctx.newUser({ password: passwordHashed });
      const auth = factory.auth({ user });

      const response = sut.changePassword(auth, dto);
      await expect(response).rejects.toThrow(BadRequestException);
      await expect(response).rejects.toThrow('Wrong password');
    });
  });
});
