import AlbumCard from '#lib/components/album-page/AlbumCard.svelte';
import { factory } from '#test/unit/factories.ts';
import { expect } from 'vitest';
import { render } from 'vitest-browser-svelte';

describe('AlbumCard', () => {
  it('marks a folder album and shows its number of child albums', async () => {
    const album = factory.album({ albumName: 'photos', isFolderAlbum: true, childAlbumCount: 3 });
    const { baseElement } = await render(AlbumCard, { album });

    const badge = baseElement.querySelector('[data-testid="folder-album-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('folder_album');
    expect(badge?.textContent).toContain('albums_count');
  });

  it('does not show the child count of a folder album without children', async () => {
    const album = factory.album({ albumName: 'leaf', isFolderAlbum: true, childAlbumCount: 0 });
    const { baseElement } = await render(AlbumCard, { album });

    const badge = baseElement.querySelector('[data-testid="folder-album-badge"]');
    expect(badge?.textContent).toContain('folder_album');
    expect(badge?.textContent).not.toContain('albums_count');
  });

  it('does not mark a hand-made album', async () => {
    const album = factory.album({ albumName: 'Holiday' });
    const { baseElement } = await render(AlbumCard, { album });

    expect(baseElement.querySelector('[data-testid="folder-album-badge"]')).toBeNull();
  });
});
