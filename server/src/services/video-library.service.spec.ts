import { VideoLibraryService } from 'src/services/video-library.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(VideoLibraryService.name, () => {
  let sut: VideoLibraryService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(VideoLibraryService));
  });

  describe('getVideoFolders', () => {
    it('should return the folders of the current user', async () => {
      mocks.asset.getVideoFolders.mockResolvedValue(['/videos', '/videos/holiday']);

      await expect(sut.getVideoFolders(authStub.admin)).resolves.toEqual(['/videos', '/videos/holiday']);
      expect(mocks.asset.getVideoFolders).toHaveBeenCalledWith(authStub.admin.user.id);
    });
  });
});
