import { JobStatus } from 'src/enum.js';
import { SessionService } from 'src/services/session.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { SessionFactory } from 'test/factories/session.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe('SessionService', () => {
  let sut: SessionService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(SessionService));
  });

  it('should be defined', () => {
    expect(sut).toBeDefined();
  });

  describe('handleCleanup', () => {
    it('should clean sessions', async () => {
      mocks.session.cleanup.mockResolvedValue([]);
      mocks.loginAttempt.cleanup.mockResolvedValue(0);
      await expect(sut.handleCleanup()).resolves.toEqual(JobStatus.Success);
    });

    it('should clean failed login records older than the rate limit window', async () => {
      mocks.session.cleanup.mockResolvedValue([]);
      mocks.loginAttempt.cleanup.mockResolvedValue(3);

      const before = Date.now();
      await expect(sut.handleCleanup()).resolves.toEqual(JobStatus.Success);

      const olderThan = mocks.loginAttempt.cleanup.mock.calls[0][0];
      expect(before - olderThan.getTime()).toBeGreaterThanOrEqual(15 * 60 * 1000 - 1000);
      expect(before - olderThan.getTime()).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);
    });
  });

  describe('getAll', () => {
    it('should get the devices', async () => {
      const currentSession = SessionFactory.create();
      const otherSession = SessionFactory.create();
      const auth = AuthFactory.from().session(currentSession).build();

      mocks.session.getByUserId.mockResolvedValue([currentSession, otherSession]);

      await expect(sut.getAll(auth)).resolves.toEqual([
        expect.objectContaining({ current: true, id: currentSession.id }),
        expect.objectContaining({ current: false, id: otherSession.id }),
      ]);

      expect(mocks.session.getByUserId).toHaveBeenCalledWith(auth.user.id);
    });
  });

  describe('logoutDevices', () => {
    it('should logout all devices', async () => {
      const currentSession = SessionFactory.create();
      const auth = AuthFactory.from().session(currentSession).build();

      mocks.session.invalidateAll.mockResolvedValue();

      await sut.deleteAll(auth);

      expect(mocks.session.invalidateAll).toHaveBeenCalledWith({
        userId: auth.user.id,
        excludeId: currentSession.id,
      });
    });
  });

  describe('logoutDevice', () => {
    it('should logout the device', async () => {
      mocks.access.authDevice.checkOwnerAccess.mockResolvedValue(new Set(['token-1']));
      mocks.session.delete.mockResolvedValue();

      await sut.delete(authStub.user1, 'token-1');

      expect(mocks.access.authDevice.checkOwnerAccess).toHaveBeenCalledWith(
        authStub.user1.user.id,
        new Set(['token-1']),
      );
      expect(mocks.session.delete).toHaveBeenCalledWith('token-1');
    });
  });
});
