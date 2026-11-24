import { Route } from '#lib/route.ts';
import { factory } from '#test/common/factories.ts';
import { expect, test } from '#test/medium/fixtures.ts';
import { AssetTypeEnum, SubtitleFormat } from '@immich/sdk';

test.describe('video library', () => {
  test('adds sidecar subtitles as tracks of the video', async ({ page, data, app }) => {
    const video = factory.asset({ type: AssetTypeEnum.Video, originalPath: '/media/movies/movie.mp4' });
    data.addAssets(video);
    data.videoLibrary
      .addSubtitle(video.id, {
        name: 'movie.en.srt',
        format: SubtitleFormat.Srt,
        language: 'en',
        label: null,
        forced: false,
        hearingImpaired: false,
      })
      .addSubtitle(video.id, {
        name: 'movie.de.sdh.vtt',
        format: SubtitleFormat.Vtt,
        language: 'de',
        label: null,
        forced: false,
        hearingImpaired: true,
      });

    await page.goto(Route.viewAsset({ id: video.id }));
    await app.viewer.waitForAsset(video);

    const tracks = page.locator('track');
    await expect(tracks).toHaveCount(2);
    await expect(tracks.nth(0)).toHaveAttribute(
      'src',
      new RegExp(String.raw`/assets/${video.id}/subtitles/movie\.en\.srt`),
    );
    await expect(tracks.nth(0)).toHaveAttribute('kind', 'subtitles');
    await expect(tracks.nth(0)).toHaveAttribute('srclang', 'en');
    await expect(tracks.nth(1)).toHaveAttribute('kind', 'captions');
  });

  test('adds no tracks without sidecar subtitles', async ({ page, data, app }) => {
    const video = factory.asset({ type: AssetTypeEnum.Video, originalPath: '/media/movies/movie.mp4' });
    data.addAssets(video);

    await page.goto(Route.viewAsset({ id: video.id }));
    await app.viewer.waitForAsset(video);

    await expect(page.locator('track')).toHaveCount(0);
  });

  test('opens the videos page from the sidebar', async ({ page, data }) => {
    data.addAssets(factory.asset({ type: AssetTypeEnum.Video, originalPath: '/media/movies/movie.mp4' }));

    await page.goto(Route.photos());
    await page.getByRole('link', { name: 'videos', exact: true }).click();

    await expect(page).toHaveURL(Route.videos());
    await expect(page.getByTestId('video-folder-tree').getByRole('link', { name: 'movies' })).toBeVisible();
  });
});
