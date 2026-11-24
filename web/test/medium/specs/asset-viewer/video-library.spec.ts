import { Route } from '#lib/route.ts';
import { factory } from '#test/common/factories.ts';
import { expect, test } from '#test/medium/fixtures.ts';
import { AssetTypeEnum } from '@immich/sdk';

test.describe('video library', () => {
  test('opens the videos page from the sidebar', async ({ page, data }) => {
    data.addAssets(factory.asset({ type: AssetTypeEnum.Video, originalPath: '/media/movies/movie.mp4' }));

    await page.goto(Route.photos());
    await page.getByRole('link', { name: 'videos', exact: true }).click();

    await expect(page).toHaveURL(Route.videos());
    await expect(page.getByTestId('video-folder-tree').getByRole('link', { name: 'movies' })).toBeVisible();
  });
});
