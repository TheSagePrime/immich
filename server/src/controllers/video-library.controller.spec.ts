import request from 'supertest';
import { VideoLibraryController } from 'src/controllers/video-library.controller.js';
import { Permission } from 'src/enum.js';
import { VideoLibraryService } from 'src/services/video-library.service.js';
import { ControllerContext, controllerSetup, mockBaseService } from 'test/utils.js';

describe(VideoLibraryController.name, () => {
  let ctx: ControllerContext;
  const service = mockBaseService(VideoLibraryService);

  beforeAll(async () => {
    ctx = await controllerSetup(VideoLibraryController, [{ provide: VideoLibraryService, useValue: service }]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    ctx.reset();
  });

  const expectPermission = (permission: Permission, sharedLinkRoute: boolean) =>
    expect(ctx.authenticate).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ permission, sharedLinkRoute }) }),
    );

  describe('GET /video-library/folders', () => {
    it('should require folder.read', async () => {
      await request(ctx.getHttpServer()).get('/video-library/folders');
      expectPermission(Permission.FolderRead, false);
    });
  });
});
