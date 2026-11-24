import request from 'supertest';
import { UserController } from 'src/controllers/user.controller.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UserService } from 'src/services/user.service.js';
import { errorDto } from 'test/medium/responses.js';
import { ControllerContext, automock, controllerSetup, mockBaseService } from 'test/utils.js';

describe(UserController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(UserService);

  beforeAll(async () => {
    ctx = await controllerSetup(UserController, [
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
      { provide: UserService, useValue: service },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('PUT /users/me', () => {
    for (const [key, message] of [
      ['email', 'Invalid input: expected email, received object'],
      ['name', 'Invalid input: expected string, received null'],
    ] as const) {
      it(`should not allow null ${key}`, async () => {
        const { status, body } = await request(ctx.getHttpServer())
          .put(`/users/me`)
          .set('Authorization', `Bearer token`)
          .send({ [key]: null });
        expect(status).toBe(400);
        expect(body).toEqual(errorDto.validationError([{ path: [key], message }]));
      });
    }

    it('should allow an empty avatarColor', async () => {
      await request(ctx.getHttpServer())
        .put(`/users/me`)
        .set('Authorization', `Bearer token`)
        .send({ avatarColor: null });
      expect(service.updateMe).toHaveBeenCalledWith(undefined, expect.objectContaining({ avatarColor: null }));
    });
  });

  describe('PUT /users/me/preferences', () => {
    it('should require an integer for download archive size', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/users/me/preferences`)
        .set('Authorization', `Bearer token`)
        .send({ download: { archiveSize: 1_234_567.89 } });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['download', 'archiveSize'], message: 'Invalid input: expected int, received number' },
        ]),
      );
    });

    it('should require a boolean for download include embedded videos', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/users/me/preferences`)
        .set('Authorization', `Bearer token`)
        .send({ download: { includeEmbeddedVideos: 1_234_567.89 } });
      expect(status).toBe(400);
      expect(body).toEqual(
        errorDto.validationError([
          { path: ['download', 'includeEmbeddedVideos'], message: 'Invalid input: expected boolean, received number' },
        ]),
      );
    });

    it('should accept a folder sort', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put(`/users/me/preferences`)
        .set('Authorization', `Bearer token`)
        .send({
          folders: {
            sortBy: 'fileSize',
            sortOrder: 'desc',
            sortOverrides: [{ path: '/photos/trip', sortBy: 'dateTaken', sortOrder: 'asc' }],
          },
        });
      expect(status).toBe(200);
      expect(service.updateMyPreferences).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ folders: expect.objectContaining({ sortBy: 'fileSize', sortOrder: 'desc' }) }),
      );
    });

    it('should reject an unknown folder sort', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .put(`/users/me/preferences`)
        .set('Authorization', `Bearer token`)
        .send({ folders: { sortBy: 'color' } });
      expect(status).toBe(400);
      expect(body).toEqual(expect.objectContaining({ message: expect.anything() }));
      expect(service.updateMyPreferences).not.toHaveBeenCalled();
    });

    it('should limit the number of folder sort overrides', async () => {
      const sortOverrides = Array.from({ length: 501 }, (_, index) => ({
        path: `/folder-${index}`,
        sortBy: 'name',
        sortOrder: 'asc',
      }));
      const { status } = await request(ctx.getHttpServer())
        .put(`/users/me/preferences`)
        .set('Authorization', `Bearer token`)
        .send({ folders: { sortOverrides } });
      expect(status).toBe(400);
    });

    it('should reject a folder sort override without a path', async () => {
      const { status } = await request(ctx.getHttpServer())
        .put(`/users/me/preferences`)
        .set('Authorization', `Bearer token`)
        .send({ folders: { sortOverrides: [{ path: '', sortBy: 'name', sortOrder: 'asc' }] } });
      expect(status).toBe(400);
    });
  });
});
