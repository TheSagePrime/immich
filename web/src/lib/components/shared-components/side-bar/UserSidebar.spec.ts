import UserSidebar from '#lib/components/shared-components/side-bar/UserSidebar.svelte';
import { authManager } from '#lib/managers/auth-manager.svelte.ts';
import { queryClient } from '#lib/queries/client.ts';
import { factory } from '#test/common/factories.ts';
import { payload } from '#test/common/payloads.ts';
import { cleanup, render } from 'vitest-browser-svelte';

vi.mock('#lib/components/shared-components/side-bar/BottomInfo.svelte', async () => ({
  default: (await import('#test/unit/mocks/Empty.svelte')).default,
}));

vi.mock('#lib/components/shared-components/side-bar/RecentAlbums.svelte', async () => ({
  default: (await import('#test/unit/mocks/Empty.svelte')).default,
}));

const setSimpleMode = (simpleMode: boolean) => {
  const config = payload.userConfig();
  queryClient.setQueryData(['config', 'user'], {
    ...config,
    map: { ...config.map, enabled: true },
    trash: { ...config.trash, enabled: true },
    server: { ...config.server, simpleMode },
  });
};

const linkNames = (element: HTMLElement) =>
  [...element.querySelectorAll('a')].map((link) => link.textContent?.trim()).filter(Boolean);

describe('UserSidebar', () => {
  beforeEach(() => {
    authManager.setPreferences(
      factory.preferences({
        folders: { enabled: true, sidebarWeb: true },
        memories: { enabled: true, duration: 5, sidebarWeb: true },
        people: { ...factory.preferences().people, enabled: true, sidebarWeb: true },
        sharedLinks: { enabled: true, sidebarWeb: true },
        tags: { enabled: true, sidebarWeb: true },
      }),
    );
  });

  afterEach(async () => {
    await cleanup();
    queryClient.clear();
    authManager.reset();
  });

  it('shows every item when simple mode is off', async () => {
    setSimpleMode(false);
    const { baseElement } = await render(UserSidebar);

    expect(linkNames(baseElement)).toEqual([
      'photos',
      'explore',
      'map',
      'memories',
      'people',
      'shared_links',
      'sharing',
      'favorites',
      'albums',
      'tags',
      'folders',
      'utilities',
      'archive',
      'locked_folder',
      'trash',
    ]);
  });

  it('hides the rarely used items in simple mode', async () => {
    setSimpleMode(true);
    const { baseElement } = await render(UserSidebar);

    expect(linkNames(baseElement)).toEqual([
      'photos',
      'people',
      'shared_links',
      'sharing',
      'favorites',
      'albums',
      'folders',
      'archive',
      'trash',
    ]);
  });
});
