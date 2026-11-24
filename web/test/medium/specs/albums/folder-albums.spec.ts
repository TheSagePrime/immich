import { Route } from '#lib/route.ts';
import type { MockData } from '#test/common/data.ts';
import { adminUserId, factory } from '#test/common/factories.ts';
import { expect, test } from '#test/medium/fixtures.ts';
import { AlbumUserRole } from '@immich/sdk';

const addFolderTree = (data: MockData) => {
  const albumUsers = [{ role: AlbumUserRole.Owner, user: factory.user({ id: adminUserId }) }];
  const root = factory.album({ albumName: 'photos', isFolderAlbum: true, parentAlbumId: null, albumUsers });
  const year = factory.album({ albumName: '2024', isFolderAlbum: true, parentAlbumId: root.id, albumUsers });
  const trip = factory.album({ albumName: 'trip', isFolderAlbum: true, parentAlbumId: year.id, albumUsers });
  const manual = factory.album({ albumName: 'Hand made', albumUsers });
  const photo = factory.asset({ originalPath: '/mnt/photos/2024/trip/photo.jpg' });
  data.addAssets(photo);
  data.addAlbums([root, year, trip, manual]).addToAlbum(trip.id, [photo]);
  return { root, year, trip, manual, photo };
};

test.describe('folder albums', () => {
  test('the albums page shows hand-made albums and top-level folder albums only', async ({ page, data }) => {
    addFolderTree(data);

    await page.goto(Route.albums());

    const cards = page.getByTestId('album-card');
    await expect(cards.filter({ hasText: 'photos' })).toHaveCount(1);
    await expect(cards.filter({ hasText: 'Hand made' })).toHaveCount(1);
    await expect(cards.filter({ hasText: 'trip' })).toHaveCount(0);
    await expect(cards.filter({ hasText: '2024' })).toHaveCount(0);
    await expect(cards.filter({ hasText: 'photos' }).getByTestId('folder-album-badge')).toBeVisible();
    await expect(cards.filter({ hasText: 'Hand made' }).getByTestId('folder-album-badge')).toHaveCount(0);
  });

  test('opening a folder album shows its child albums with cover and count', async ({ page, data }) => {
    const { year, photo } = addFolderTree(data);

    await page.goto(Route.viewAlbum(year));

    const children = page.getByTestId('folder-album-children');
    const card = children.getByTestId('folder-card').filter({ hasText: 'trip' });
    await expect(card).toBeVisible();
    await expect(card.getByTestId('folder-cover')).toHaveAttribute('src', new RegExp(`/assets/${photo.id}/thumbnail`));
    await expect(card.getByTestId('folder-count')).toHaveText('items_count');
    await expect(page.getByTestId('folder-album-badge')).toBeVisible();
  });

  test('child cards and breadcrumbs navigate down and back up', async ({ page, data }) => {
    const { root, year, trip } = addFolderTree(data);

    await page.goto(Route.viewAlbum(root));
    await page.getByTestId('folder-album-children').getByTestId('folder-card').filter({ hasText: '2024' }).click();
    await expect(page).toHaveURL(Route.viewAlbum(year));

    await page.getByTestId('folder-album-children').getByTestId('folder-card').filter({ hasText: 'trip' }).click();
    await expect(page).toHaveURL(Route.viewAlbum(trip));

    const breadcrumbs = page.getByTestId('album-folder-breadcrumbs');
    await expect(breadcrumbs.getByRole('link', { name: 'photos' })).toBeVisible();
    await breadcrumbs.getByRole('link', { name: '2024' }).click();
    await expect(page).toHaveURL(Route.viewAlbum(year));

    await page.getByTestId('album-folder-breadcrumbs').getByRole('link', { name: 'to_parent' }).click();
    await expect(page).toHaveURL(Route.viewAlbum(root));

    await page.getByTestId('album-folder-breadcrumbs').getByRole('link', { name: 'albums' }).click();
    await expect(page).toHaveURL(Route.albums());
  });

  test('a folder album cannot be renamed or get photos added', async ({ page, data }) => {
    const { trip } = addFolderTree(data);

    await page.goto(Route.viewAlbum(trip));

    await expect(page.getByTestId('folder-album-info')).toBeVisible();
    await expect(page.getByRole('button', { name: 'add_photos' })).toHaveCount(0);
    await expect(page.getByTitle('edit_title')).toHaveCount(0);
  });
});
