import { getSidebarVisibility, isSimpleMode } from '#lib/utils/sidebar-visibility.ts';
import { factory } from '#test/common/factories.ts';
import { payload } from '#test/common/payloads.ts';

const configWith = (simpleMode: boolean, overrides: { map?: boolean; trash?: boolean } = {}) => {
  const config = payload.userConfig();
  return {
    ...config,
    map: { ...config.map, enabled: overrides.map ?? true },
    trash: { ...config.trash, enabled: overrides.trash ?? true },
    server: { ...config.server, simpleMode },
  };
};

const allEnabled = factory.preferences({
  folders: { enabled: true, sidebarWeb: true },
  memories: { enabled: true, duration: 5, sidebarWeb: true },
  people: { ...factory.preferences().people, enabled: true, sidebarWeb: true },
  sharedLinks: { enabled: true, sidebarWeb: true },
  tags: { enabled: true, sidebarWeb: true },
  recentlyAdded: { sidebarWeb: true },
});

describe('getSidebarVisibility', () => {
  it('shows every enabled item when simple mode is off', () => {
    expect(getSidebarVisibility(configWith(false), allEnabled)).toEqual({
      explore: true,
      map: true,
      memories: true,
      people: true,
      sharedLinks: true,
      tags: true,
      recentlyAdded: true,
      folders: true,
      utilities: true,
      lockedFolder: true,
      trash: true,
    });
  });

  it('hides the rarely used items in simple mode and keeps the core ones', () => {
    expect(getSidebarVisibility(configWith(true), allEnabled)).toEqual({
      explore: false,
      map: false,
      memories: false,
      people: true,
      sharedLinks: true,
      tags: false,
      recentlyAdded: true,
      folders: true,
      utilities: false,
      lockedFolder: false,
      trash: true,
    });
  });

  it('still respects the user preferences in simple mode', () => {
    const preferences = factory.preferences({
      folders: { enabled: true, sidebarWeb: false },
      people: { ...factory.preferences().people, enabled: false, sidebarWeb: true },
      sharedLinks: { enabled: true, sidebarWeb: false },
    });

    const visible = getSidebarVisibility(configWith(true), preferences);
    expect(visible.folders).toBe(false);
    expect(visible.people).toBe(false);
    expect(visible.sharedLinks).toBe(false);
    expect(visible.recentlyAdded).toBe(false);
  });

  it('still respects the server features when simple mode is off', () => {
    const visible = getSidebarVisibility(configWith(false, { map: false, trash: false }), allEnabled);
    expect(visible.map).toBe(false);
    expect(visible.trash).toBe(false);
  });

  it('keeps the trash hidden when it is disabled in simple mode', () => {
    expect(getSidebarVisibility(configWith(true, { trash: false }), allEnabled).trash).toBe(false);
  });
});

describe('isSimpleMode', () => {
  it('reads the server setting', () => {
    expect(isSimpleMode(configWith(true))).toBe(true);
    expect(isSimpleMode(configWith(false))).toBe(false);
  });

  it('treats a missing value from an older server as off', () => {
    const config = configWith(false);
    expect(isSimpleMode({ ...config, server: {} as typeof config.server })).toBe(false);
  });
});
