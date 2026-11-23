import request from 'supertest';
import { ViewController } from 'src/controllers/view.controller.js';
import { ViewService } from 'src/services/view.service.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(ViewController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(ViewService);

  beforeAll(async () => {
    ctx = await controllerSetup(ViewController, [{ provide: ViewService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  describe('GET /view/folder/summary', () => {
    it('should default to the root folder', async () => {
      service.getFolderSummary.mockResolvedValue({
        path: '/',
        directAssetCount: 0,
        children: [],
        writable: false,
        isLibraryRoot: false,
      });

      const { status } = await request(ctx.getHttpServer()).get('/view/folder/summary');

      expect(status).toBe(200);
      expect(service.getFolderSummary).toHaveBeenCalledWith(undefined, { path: '/' });
    });

    it('should pass the path', async () => {
      service.getFolderSummary.mockResolvedValue({
        path: '/photos',
        directAssetCount: 1,
        children: [],
        writable: false,
        isLibraryRoot: false,
      });

      const { status, body } = await request(ctx.getHttpServer())
        .get('/view/folder/summary')
        .query({ path: '/photos' });

      expect(status).toBe(200);
      expect(body).toMatchObject({ path: '/photos', directAssetCount: 1 });
      expect(service.getFolderSummary).toHaveBeenCalledWith(undefined, { path: '/photos' });
    });
  });

  describe('GET /view/folder/unique-paths', () => {
    it('should keep returning a list of strings', async () => {
      service.getUniqueOriginalPaths.mockResolvedValue(['/photos']);

      const { status, body } = await request(ctx.getHttpServer()).get('/view/folder/unique-paths');

      expect(status).toBe(200);
      expect(body).toEqual(['/photos']);
    });
  });
});
