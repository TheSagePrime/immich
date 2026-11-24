import { QueryParameter } from '#lib/constants.ts';
import { queryClient } from '#lib/queries/client.ts';
import { getAssetsByOriginalPathQuery, getFolderRootsQuery, getFolderSummaryQuery } from '#lib/queries/view.query.ts';
import { authenticate } from '#lib/utils/auth.ts';
import { locateFolderPath, resolveFolderLocation, type FolderView } from '#lib/utils/folder-roots.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import { normalizeTreePath } from '#lib/utils/tree-utils.ts';
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const [roots, $t] = await Promise.all([queryClient.query(getFolderRootsQuery()), getFormatter()]);

  const rootId = url.searchParams.get(QueryParameter.ROOT);
  const path = url.searchParams.get(QueryParameter.PATH);

  if (rootId === null && path === null) {
    queryClient.removeQueries({ queryKey: ['view', 'folder', 'assets'] });
  }

  if (rootId === null && path !== null) {
    const located = locateFolderPath(roots, normalizeTreePath(path));
    if (located) {
      const query = new URLSearchParams({ [QueryParameter.ROOT]: located.rootId });
      if (located.relativePath) {
        query.set(QueryParameter.PATH, located.relativePath);
      }
      redirect(307, `${url.pathname}?${query.toString()}`);
    }
  }

  let view: FolderView = { mode: 'roots' };
  if (rootId !== null) {
    const location = resolveFolderLocation(roots, rootId, path);
    if (!location) {
      redirect(307, '/folders');
    }
    view = location.absolutePath
      ? { mode: 'folder', location, folderPath: location.absolutePath }
      : { mode: 'folders', location };
  } else if (path !== null) {
    view = { mode: 'folder', folderPath: normalizeTreePath(path) || '/' };
  }

  const folderPath = view.mode === 'folder' ? view.folderPath : undefined;
  const summary = folderPath ? await queryClient.query(getFolderSummaryQuery(folderPath)) : undefined;
  const pathAssets =
    folderPath && summary && summary.directAssetCount > 0
      ? await queryClient.query(getAssetsByOriginalPathQuery(folderPath))
      : null;

  return {
    roots,
    view,
    folderPath,
    summary,
    pathAssets,
    meta: {
      title: $t('folders'),
    },
  };
}) satisfies PageLoad;
