import type { UserConfigDto, UserPreferencesResponseDto } from '@immich/sdk';

export type SidebarVisibility = {
  explore: boolean;
  map: boolean;
  memories: boolean;
  people: boolean;
  sharedLinks: boolean;
  tags: boolean;
  recentlyAdded: boolean;
  folders: boolean;
  utilities: boolean;
  lockedFolder: boolean;
  trash: boolean;
};

type SidebarConfig = Pick<UserConfigDto, 'map' | 'trash'> & { server: Pick<UserConfigDto['server'], 'simpleMode'> };

type SidebarPreferences = Pick<
  UserPreferencesResponseDto,
  'memories' | 'people' | 'sharedLinks' | 'tags' | 'recentlyAdded' | 'folders'
>;

export const isSimpleMode = (config: SidebarConfig) => config.server.simpleMode;

export const getSidebarVisibility = (config: SidebarConfig, preferences: SidebarPreferences): SidebarVisibility => {
  const full = !isSimpleMode(config);

  return {
    explore: full,
    map: full && config.map.enabled,
    memories: full && preferences.memories.enabled && preferences.memories.sidebarWeb,
    people: preferences.people.enabled && preferences.people.sidebarWeb,
    sharedLinks: preferences.sharedLinks.enabled && preferences.sharedLinks.sidebarWeb,
    tags: full && preferences.tags.enabled && preferences.tags.sidebarWeb,
    recentlyAdded: preferences.recentlyAdded.sidebarWeb,
    folders: preferences.folders.enabled && preferences.folders.sidebarWeb,
    utilities: full,
    lockedFolder: full,
    trash: config.trash.enabled,
  };
};
