import FolderAlbumChildren from '#lib/components/album-page/FolderAlbumChildren.svelte';
import { Route } from '#lib/route.ts';
import { factory } from '#test/unit/factories.ts';
import { test } from '#test/unit/fixtures.ts';
import { expect } from 'vitest';
import { render } from 'vitest-browser-svelte';

describe('FolderAlbumChildren', () => {
  it('renders a card with cover and item count for every child album', async () => {
    const albums = [
      factory.album({
        albumName: 'day 1',
        assetCount: 4,
        albumThumbnailAssetId: '00000000-0000-4000-a000-000000000001',
        isFolderAlbum: true,
      }),
      factory.album({ albumName: 'day 2', assetCount: 0, albumThumbnailAssetId: null, isFolderAlbum: true }),
    ];
    const { baseElement } = await render(FolderAlbumChildren, { albums });

    expect(baseElement.textContent).toContain('albums_in_folder');
    const cards = baseElement.querySelectorAll('[data-testid="folder-card"]');
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain('day 1');
    expect(cards[0].querySelector('[data-testid="folder-cover"]')?.getAttribute('src')).toContain(
      '/assets/00000000-0000-4000-a000-000000000001/thumbnail',
    );
    expect(cards[0].querySelector('[data-testid="folder-count"]')?.textContent?.trim()).toBe('items_count');
    expect(cards[1].querySelector('[data-testid="folder-cover"]')).toBeNull();
  });

  it('renders nothing without child albums', async () => {
    const { baseElement } = await render(FolderAlbumChildren, { albums: [] });

    expect(baseElement.querySelector('[data-testid="folder-album-children"]')).toBeNull();
  });
});

test('opens a child album on click', async ({ router }) => {
  const album = factory.album({ albumName: 'day 1', isFolderAlbum: true });
  const { baseElement } = await render(FolderAlbumChildren, { albums: [album] });

  baseElement.querySelector<HTMLButtonElement>(':scope [data-testid="folder-card"] button')!.click();

  await expect.poll(() => router.url.pathname).toBe(Route.viewAlbum(album));
});
