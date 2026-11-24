import { Route } from '#lib/route.ts';
import { StartPage, type UserPreferencesResponseDto } from '@immich/sdk';

type HomePreferences = Pick<UserPreferencesResponseDto, 'folders' | 'navigation'>;

export const getHomeRoute = (preferences?: HomePreferences) => {
  if (preferences?.navigation?.startPage === StartPage.Folders && preferences.folders.enabled) {
    return Route.folders();
  }

  return Route.photos();
};
