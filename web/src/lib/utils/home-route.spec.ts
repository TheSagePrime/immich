import { getHomeRoute } from '#lib/utils/home-route.ts';
import { StartPage } from '@immich/sdk';

describe('getHomeRoute', () => {
  it('should default to the timeline', () => {
    expect(getHomeRoute()).toBe('/photos');
    expect(getHomeRoute({ folders: { enabled: true, sidebarWeb: true } })).toBe('/photos');
  });

  it('should open the folders when chosen as start page', () => {
    expect(
      getHomeRoute({ folders: { enabled: true, sidebarWeb: true }, navigation: { startPage: StartPage.Folders } }),
    ).toBe('/folders');
  });

  it('should fall back to the timeline when folders are disabled', () => {
    expect(
      getHomeRoute({ folders: { enabled: false, sidebarWeb: false }, navigation: { startPage: StartPage.Folders } }),
    ).toBe('/photos');
  });

  it('should open the timeline when chosen as start page', () => {
    expect(
      getHomeRoute({ folders: { enabled: true, sidebarWeb: true }, navigation: { startPage: StartPage.Timeline } }),
    ).toBe('/photos');
  });
});
