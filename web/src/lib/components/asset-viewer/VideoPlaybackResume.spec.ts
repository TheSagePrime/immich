import { authenticate } from '#lib/utils/auth.ts';
import { factory } from '#test/unit/factories.ts';
import { test } from '#test/unit/fixtures.ts';
import VideoPlaybackResumeHost from '#test/unit/mocks/VideoPlaybackResumeHost.svelte';
import { AssetTypeEnum } from '@immich/sdk';
import { expect } from 'vitest';
import { page } from 'vitest/browser';

class FakeVideo extends EventTarget {
  currentTime = 0;
  duration = 300;
}

const setup = (data: { addAssets: (asset: ReturnType<typeof factory.asset>) => unknown }) => {
  const asset = factory.asset({ type: AssetTypeEnum.Video });
  data.addAssets(asset);
  const video = new FakeVideo();
  const load = async ({ url }: { url: URL }) => {
    await authenticate(url);
    return { video: video as unknown as HTMLVideoElement, assetId: asset.id };
  };
  return { asset, video, load };
};

test('resumes from the saved position and offers to start over', async ({ data, render, settle, api }) => {
  const { asset, video, load } = setup(data);
  data.videoLibrary.setPlaybackPosition(asset.id, 90, 300);

  await render(VideoPlaybackResumeHost as never, load);
  await settle();

  expect(video.currentTime).toBe(90);
  const notice = page.getByTestId('video-resume-notice');
  await expect.element(notice).toBeVisible();

  await notice.getByRole('button', { name: 'video_start_over' }).click();
  await settle();

  expect(video.currentTime).toBe(0);
  await expect.element(notice).not.toBeInTheDocument();
  expect(api.deletePlaybackPosition).toHaveBeenCalledWith({ params: { id: asset.id } });
});

test('starts from the beginning without a saved position', async ({ data, render, settle }) => {
  const { video, load } = setup(data);

  await render(VideoPlaybackResumeHost as never, load);
  await settle();

  expect(video.currentTime).toBe(0);
  await expect.element(page.getByTestId('video-resume-notice')).not.toBeInTheDocument();
});

test('does not resume near the end of the video', async ({ data, render, settle }) => {
  const { asset, video, load } = setup(data);
  data.videoLibrary.setPlaybackPosition(asset.id, 295, 300);

  await render(VideoPlaybackResumeHost as never, load);
  await settle();

  expect(video.currentTime).toBe(0);
  await expect.element(page.getByTestId('video-resume-notice')).not.toBeInTheDocument();
});

test('saves the position when playback pauses', async ({ data, render, settle, api }) => {
  const { asset, video, load } = setup(data);

  await render(VideoPlaybackResumeHost as never, load);
  await settle();

  video.currentTime = 42;
  video.dispatchEvent(new Event('timeupdate'));
  video.dispatchEvent(new Event('pause'));
  await settle();

  expect(api.updatePlaybackPosition).toHaveBeenCalledWith({
    params: { id: asset.id },
    body: { position: 42, duration: 300 },
  });
});

test('forgets the position when the video ends', async ({ data, render, settle, api }) => {
  const { asset, video, load } = setup(data);
  data.videoLibrary.setPlaybackPosition(asset.id, 60, 300);

  await render(VideoPlaybackResumeHost as never, load);
  await settle();

  video.currentTime = 300;
  video.dispatchEvent(new Event('ended'));
  await settle();

  expect(api.deletePlaybackPosition).toHaveBeenCalledWith({ params: { id: asset.id } });
});
