import { AssetOrder, FolderSortBy, StartPage, UserMetadataKey } from 'src/enum.js';
import { getPreferences, getPreferencesPartial, mergePreferences } from 'src/utils/preferences.js';

describe('preferences', () => {
  it('should show folders and start on the timeline by default', () => {
    const preferences = getPreferences([]);

    expect(preferences.folders).toEqual({
      enabled: true,
      sidebarWeb: true,
      sortBy: FolderSortBy.Name,
      sortOrder: AssetOrder.Asc,
      sortOverrides: [],
    });
    expect(preferences.navigation).toEqual({ startPage: StartPage.Timeline });
  });

  it('should keep a saved choice to hide folders', () => {
    const preferences = getPreferences([
      { key: UserMetadataKey.Preferences, value: { folders: { enabled: false, sidebarWeb: false } } },
    ]);

    expect(preferences.folders).toMatchObject({ enabled: false, sidebarWeb: false });
  });

  it('should store the start page only when it differs from the default', () => {
    const preferences = mergePreferences(getPreferences([]), { navigation: { startPage: StartPage.Folders } });

    expect(preferences.navigation.startPage).toBe(StartPage.Folders);
    expect(getPreferencesPartial(preferences)).toEqual({ navigation: { startPage: StartPage.Folders } });

    const reset = mergePreferences(preferences, { navigation: { startPage: StartPage.Timeline } });
    expect(getPreferencesPartial(reset)).toEqual({});
  });

  it('should store hidden folders now that they are shown by default', () => {
    const preferences = mergePreferences(getPreferences([]), { folders: { enabled: false } });

    expect(getPreferencesPartial(preferences)).toEqual({ folders: { enabled: false } });
  });

  it('should store the folder sort and the per-folder overrides', () => {
    const sortOverrides = [{ path: '/photos/trip', sortBy: FolderSortBy.FileSize, sortOrder: AssetOrder.Desc }];
    const preferences = mergePreferences(getPreferences([]), {
      folders: { sortBy: FolderSortBy.DateTaken, sortOrder: AssetOrder.Desc, sortOverrides },
    });

    const partial = getPreferencesPartial(preferences);
    expect(partial).toEqual({
      folders: { sortBy: FolderSortBy.DateTaken, sortOrder: AssetOrder.Desc, sortOverrides },
    });

    const restored = getPreferences([{ key: UserMetadataKey.Preferences, value: partial }]);
    expect(restored.folders).toEqual({
      enabled: true,
      sidebarWeb: true,
      sortBy: FolderSortBy.DateTaken,
      sortOrder: AssetOrder.Desc,
      sortOverrides,
    });
  });

  it('should keep the folder sort when other folder settings are saved', () => {
    const sortOverrides = [{ path: '/a', sortBy: FolderSortBy.Name, sortOrder: AssetOrder.Desc }];
    const saved = mergePreferences(getPreferences([]), { folders: { sortBy: FolderSortBy.DateAdded, sortOverrides } });
    const preferences = mergePreferences(saved, { folders: { enabled: false, sidebarWeb: true } });

    expect(preferences.folders).toMatchObject({ enabled: false, sortBy: FolderSortBy.DateAdded, sortOverrides });
  });

  it('should drop the overrides once the list is emptied', () => {
    const saved = mergePreferences(getPreferences([]), {
      folders: { sortOverrides: [{ path: '/a', sortBy: FolderSortBy.Name, sortOrder: AssetOrder.Desc }] },
    });
    const cleared = mergePreferences(saved, { folders: { sortOverrides: [] } });

    expect(getPreferencesPartial(cleared)).toEqual({});
  });
});
