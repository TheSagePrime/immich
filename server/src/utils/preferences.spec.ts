import { StartPage, UserMetadataKey } from 'src/enum.js';
import { getPreferences, getPreferencesPartial, mergePreferences } from 'src/utils/preferences.js';

describe('preferences', () => {
  it('should show folders and start on the timeline by default', () => {
    const preferences = getPreferences([]);

    expect(preferences.folders).toEqual({ enabled: true, sidebarWeb: true });
    expect(preferences.navigation).toEqual({ startPage: StartPage.Timeline });
  });

  it('should keep a saved choice to hide folders', () => {
    const preferences = getPreferences([
      { key: UserMetadataKey.Preferences, value: { folders: { enabled: false, sidebarWeb: false } } },
    ]);

    expect(preferences.folders).toEqual({ enabled: false, sidebarWeb: false });
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
});
