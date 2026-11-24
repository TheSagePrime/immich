import { Route } from '#lib/route.ts';
import { factory } from '#test/unit/factories.ts';
import { test } from '#test/unit/fixtures.ts';
import { AssetTypeEnum, AssetVisibility } from '@immich/sdk';
import { expect } from 'vitest';
import { page } from 'vitest/browser';
import Page from './+page.svelte';
import { load } from './+page.ts';

const video = (originalPath: string) =>
  factory.asset({ type: AssetTypeEnum.Video, originalPath, duration: 120_000 as never });

test('requests only videos from the timeline', async ({ data, router, render, settle, api }) => {
  data.addAssets([video('/media/movies/a.mp4'), factory.asset({ originalPath: '/media/photos/b.jpg' })]);
  await router.goto(Route.videos());
  await render(Page, load);
  await settle();

  const calls = api.getTimeBuckets.calls.map((call) => call.params);
  expect(calls).toContainEqual(
    expect.objectContaining({ assetType: AssetTypeEnum.Video, visibility: AssetVisibility.Timeline }),
  );
  expect(calls.every((params) => params?.folder === undefined)).toBe(true);
});

test('lists the folders that contain videos', async ({ data, router, render, settle }) => {
  data.addAssets([
    video('/media/movies/a.mp4'),
    video('/media/series/b.mp4'),
    factory.asset({ originalPath: '/media/photos/c.jpg' }),
  ]);
  await router.goto(Route.videos({ path: '/media' }));
  await render(Page, load);
  await settle();

  const tree = page.getByTestId('video-folder-tree');
  await expect.element(tree.getByRole('link', { name: '/media' })).toBeVisible();
  await expect.element(tree.getByRole('link', { name: 'movies' })).toBeVisible();
  await expect.element(tree.getByRole('link', { name: 'series' })).toBeVisible();
  await expect.element(tree.getByRole('link', { name: 'photos' })).not.toBeInTheDocument();
});

test('filters the timeline by the selected folder', async ({ data, router, render, settle, api }) => {
  data.addAssets([video('/media/movies/a.mp4'), video('/media/series/b.mp4')]);
  await router.goto(Route.videos({ path: '/media/movies' }));
  await render(Page, load);
  await settle();

  expect(api.getTimeBuckets.calls.map((call) => call.params)).toContainEqual(
    expect.objectContaining({ assetType: AssetTypeEnum.Video, folder: '/media/movies' }),
  );
});

test('shows sub folders of the selected folder', async ({ data, router, render, settle }) => {
  data.addAssets([video('/media/movies/a.mp4'), video('/media/movies/2024/b.mp4'), video('/media/series/c.mp4')]);
  await router.goto(Route.videos({ path: '/media/movies' }));
  await render(Page, load);
  await settle();

  await expect.element(page.getByTestId('video-subfolders').getByRole('link', { name: '2024' })).toBeVisible();
});

test('shows a placeholder without videos', async ({ data, router, render, settle }) => {
  data.addAssets(factory.asset({ originalPath: '/media/photos/c.jpg' }));
  await router.goto(Route.videos());
  await render(Page, load);
  await settle();

  await expect.element(page.getByText('no_videos_message')).toBeVisible();
});
