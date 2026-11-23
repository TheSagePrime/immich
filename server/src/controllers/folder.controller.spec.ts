import request from 'supertest';
import { FolderController } from 'src/controllers/folder.controller.js';
import { FolderService } from 'src/services/folder.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(FolderController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(FolderService);

  beforeAll(async () => {
    ctx = await controllerSetup(FolderController, [{ provide: FolderService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /folders/browse', () => {
    it('should allow listing the roots without a path', async () => {
      service.browse.mockResolvedValue({ path: null, parentPath: null, entries: [] });

      const { status } = await request(ctx.getHttpServer()).get('/folders/browse');

      expect(status).toBe(200);
      expect(service.browse).toHaveBeenCalledWith(undefined, {});
    });

    it('should reject relative paths', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/folders/browse').query({ path: 'photos' });

      expect(status).toBe(400);
      expect(service.browse).not.toHaveBeenCalled();
    });
  });

  describe('POST /folders', () => {
    it.each([
      { parentPath: '/photos/../etc', name: 'new' },
      { parentPath: '/photos', name: '..' },
      { parentPath: '/photos', name: 'a/b' },
      { parentPath: '/photos', name: String.raw`a\b` },
      { parentPath: '/photos', name: ' '.repeat(3) },
      { parentPath: '/photos', name: 'x'.repeat(256) },
      { parentPath: String.raw`\photos`, name: 'new' },
      { parentPath: '/photos\0', name: 'new' },
    ])('should reject %j', async (body) => {
      const { status } = await request(ctx.getHttpServer()).post('/folders').send(body);

      expect(status).toBe(400);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('should create a folder', async () => {
      service.create.mockResolvedValue({ path: '/photos/new' });

      const { status, body } = await request(ctx.getHttpServer())
        .post('/folders')
        .send({ parentPath: '/photos', name: 'new' });

      expect(status).toBe(201);
      expect(body).toEqual({ path: '/photos/new' });
    });
  });

  describe('PUT /folders/assets/:id/rename', () => {
    it('should require a valid id', async () => {
      const { status } = await request(ctx.getHttpServer()).put('/folders/assets/123/rename').send({ name: 'a.jpg' });

      expect(status).toBe(400);
      expect(service.renameAsset).not.toHaveBeenCalled();
    });
  });

  describe('PUT /folders/move', () => {
    it('should require at least one source', async () => {
      const { status } = await request(ctx.getHttpServer()).put('/folders/move').send({ destination: '/photos' });

      expect(status).toBe(400);
      expect(service.move).not.toHaveBeenCalled();
    });

    it('should limit the number of items', async () => {
      const assetIds = Array.from({ length: 1001 }, () => factory.uuid());

      const { status } = await request(ctx.getHttpServer())
        .put('/folders/move')
        .send({ assetIds, destination: '/photos' });

      expect(status).toBe(400);
      expect(service.move).not.toHaveBeenCalled();
    });

    it('should move items', async () => {
      service.move.mockResolvedValue({ moved: 1, failed: [] });
      const assetId = factory.uuid();

      const { status } = await request(ctx.getHttpServer())
        .put('/folders/move')
        .send({ assetIds: [assetId], destination: '/photos' });

      expect(status).toBe(200);
      expect(service.move).toHaveBeenCalledWith(undefined, { assetIds: [assetId], destination: '/photos' });
    });
  });

  describe('DELETE /folders', () => {
    it('should require at least one source', async () => {
      const { status } = await request(ctx.getHttpServer()).delete('/folders').send({ force: true });

      expect(status).toBe(400);
      expect(service.delete).not.toHaveBeenCalled();
    });
  });
});
