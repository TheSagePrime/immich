import request from 'supertest';
import { UploadSessionController } from 'src/controllers/upload-session.controller.js';
import { UploadDuplicatePolicy, UploadSessionStatus } from 'src/enum.js';
import { UploadSessionService } from 'src/services/upload-session.service.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(UploadSessionController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(UploadSessionService);

  beforeAll(async () => {
    ctx = await controllerSetup(UploadSessionController, [{ provide: UploadSessionService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  const id = factory.uuid();
  const sessionResponse = {
    id,
    libraryId: factory.uuid(),
    relativePath: 'a/b.jpg',
    size: 10,
    offset: 4,
    chunkSize: 8,
    maxChunkSize: 32,
    status: UploadSessionStatus.Active,
    duplicatePolicy: UploadDuplicatePolicy.Skip,
    expiresAt: new Date(),
  };

  const validCreate = {
    libraryId: factory.uuid(),
    relativePath: 'a/b.jpg',
    size: 10,
    checksum: 'a'.repeat(40),
    duplicatePolicy: UploadDuplicatePolicy.Skip,
  };

  describe('GET /upload-sessions/libraries', () => {
    it('should be an authenticated route', async () => {
      service.getLibraries.mockResolvedValue([]);
      await request(ctx.getHttpServer()).get('/upload-sessions/libraries');
      expect(ctx.authenticate).toHaveBeenCalled();
    });
  });

  describe('POST /upload-sessions', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).post('/upload-sessions').send(validCreate);
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('should require a valid checksum', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/upload-sessions')
        .send({ ...validCreate, checksum: 'not-a-checksum' });
      expect(status).toBe(400);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('should require a known duplicate policy', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/upload-sessions')
        .send({ ...validCreate, duplicatePolicy: 'overwrite' });
      expect(status).toBe(400);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('should refuse a negative size', async () => {
      const { status } = await request(ctx.getHttpServer())
        .post('/upload-sessions')
        .send({ ...validCreate, size: -1 });
      expect(status).toBe(400);
      expect(service.create).not.toHaveBeenCalled();
    });

    it('should accept a valid request', async () => {
      service.create.mockResolvedValue(sessionResponse);
      const { status } = await request(ctx.getHttpServer()).post('/upload-sessions').send(validCreate);
      expect(status).toBe(201);
      expect(service.create).toHaveBeenCalledWith(undefined, expect.objectContaining(validCreate));
    });
  });

  describe('POST /upload-sessions/check', () => {
    it('should refuse more than 1000 items', async () => {
      const items = Array.from({ length: 1001 }, (_, index) => ({ id: String(index), relativePath: `${index}.jpg` }));
      const { status } = await request(ctx.getHttpServer())
        .post('/upload-sessions/check')
        .send({ libraryId: factory.uuid(), items });
      expect(status).toBe(400);
      expect(service.check).not.toHaveBeenCalled();
    });
  });

  describe('GET /upload-sessions/:id', () => {
    it('should require a uuid', async () => {
      const { status } = await request(ctx.getHttpServer()).get('/upload-sessions/123');
      expect(status).toBe(400);
    });

    it('should return the offset headers', async () => {
      service.get.mockResolvedValue(sessionResponse);
      const { status, headers } = await request(ctx.getHttpServer()).get(`/upload-sessions/${id}`);
      expect(status).toBe(200);
      expect(headers['upload-offset']).toBe('4');
      expect(headers['upload-length']).toBe('10');
      expect(headers['cache-control']).toBe('no-store');
    });
  });

  describe('HEAD /upload-sessions/:id', () => {
    it('should return the offset headers', async () => {
      service.get.mockResolvedValue(sessionResponse);
      const { status, headers } = await request(ctx.getHttpServer()).head(`/upload-sessions/${id}`);
      expect(status).toBe(200);
      expect(headers['upload-offset']).toBe('4');
    });
  });

  describe('PATCH /upload-sessions/:id', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer())
        .patch(`/upload-sessions/${id}`)
        .set('Content-Type', 'application/offset+octet-stream')
        .set('Upload-Offset', '0')
        .send(Buffer.from('abc'));
      expect(ctx.authenticate).toHaveBeenCalled();
    });

    it('should require the chunk content type', async () => {
      const { status } = await request(ctx.getHttpServer())
        .patch(`/upload-sessions/${id}`)
        .set('Content-Type', 'application/octet-stream')
        .set('Upload-Offset', '0')
        .send(Buffer.from('abc'));
      expect(status).toBe(415);
      expect(service.writeChunk).not.toHaveBeenCalled();
    });

    it('should require an Upload-Offset header', async () => {
      const { status } = await request(ctx.getHttpServer())
        .patch(`/upload-sessions/${id}`)
        .set('Content-Type', 'application/offset+octet-stream')
        .send(Buffer.from('abc'));
      expect(status).toBe(400);
      expect(service.writeChunk).not.toHaveBeenCalled();
    });

    it('should refuse a negative Upload-Offset', async () => {
      const { status } = await request(ctx.getHttpServer())
        .patch(`/upload-sessions/${id}`)
        .set('Content-Type', 'application/offset+octet-stream')
        .set('Upload-Offset', '-1')
        .send(Buffer.from('abc'));
      expect(status).toBe(400);
      expect(service.writeChunk).not.toHaveBeenCalled();
    });

    it('should pass the offset and length to the service', async () => {
      service.writeChunk.mockImplementation(async (_auth, _id, _chunk, body) => {
        for await (const _ of body) {
          void _;
        }
        return { ...sessionResponse, offset: 7 };
      });

      const { status, headers } = await request(ctx.getHttpServer())
        .patch(`/upload-sessions/${id}`)
        .set('Content-Type', 'application/offset+octet-stream')
        .set('Upload-Offset', '4')
        .send(Buffer.from('abc'));

      expect(status).toBe(200);
      expect(headers['upload-offset']).toBe('7');
      expect(service.writeChunk).toHaveBeenCalledWith(
        undefined,
        id,
        { offset: 4, contentLength: 3 },
        expect.anything(),
      );
    });
  });

  describe('POST /upload-sessions/:id/complete', () => {
    it('should be an authenticated route', async () => {
      await request(ctx.getHttpServer()).post(`/upload-sessions/${id}/complete`);
      expect(ctx.authenticate).toHaveBeenCalled();
    });
  });

  describe('DELETE /upload-sessions/:id', () => {
    it('should return 204', async () => {
      service.cancel.mockResolvedValue();
      const { status } = await request(ctx.getHttpServer()).delete(`/upload-sessions/${id}`);
      expect(status).toBe(204);
    });
  });
});
