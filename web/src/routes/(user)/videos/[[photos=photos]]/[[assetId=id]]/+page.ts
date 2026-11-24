import { QueryParameter } from '#lib/constants.ts';
import { queryClient } from '#lib/queries/client.ts';
import { getVideoFoldersQuery } from '#lib/queries/video-library.query.ts';
import { authenticate } from '#lib/utils/auth.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const [, $t] = await Promise.all([queryClient.query(getVideoFoldersQuery()), getFormatter()]);

  return {
    path: url.searchParams.get(QueryParameter.PATH) ?? '',
    meta: {
      title: $t('videos'),
    },
  };
}) satisfies PageLoad;
