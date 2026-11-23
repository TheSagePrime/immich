import { QueryParameter } from '#lib/constants.ts';
import { queryClient } from '#lib/queries/client.ts';
import { getAssetsByOriginalPathQuery, getFolderSummaryQuery, getFolderTreeQuery } from '#lib/queries/view.query.ts';
import { authenticate } from '#lib/utils/auth.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import { normalizeTreePath } from '#lib/utils/tree-utils.ts';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const [root, $t] = await Promise.all([queryClient.query(getFolderTreeQuery()), getFormatter()]);

  const path = url.searchParams.get(QueryParameter.PATH);
  if (path === null) {
    queryClient.removeQueries({ queryKey: ['view', 'folder', 'assets'] });
  }

  let tree = root;
  if (path) {
    tree = root.traverse(path);
  } else if (root.size === 1 && root.has('/')) {
    tree = root.get('/')!;
  }

  const folderPath = path ? normalizeTreePath(path) : tree.path || '/';
  const isTreeNode = normalizeTreePath(tree.path || '/') === folderPath;
  const summary = await queryClient.query(getFolderSummaryQuery(folderPath));

  const hasAssets = summary.directAssetCount > 0;
  const pathAssets = hasAssets ? await queryClient.query(getAssetsByOriginalPathQuery(folderPath)) : null;

  return {
    tree,
    isTreeNode,
    folderPath,
    pathAssets,
    meta: {
      title: $t('folders'),
    },
  };
}) satisfies PageLoad;
