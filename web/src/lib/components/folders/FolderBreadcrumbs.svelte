<script lang="ts">
  import { getFolderCrumbs, getFolderParentPath } from '#lib/utils/folder-utils.ts';
  import { Breadcrumbs, ControlBar, ControlBarHeader, IconButton } from '@immich/ui';
  import { mdiArrowUpLeft } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    path: string;
    getLink: (path: string) => string;
    title: string;
    icon: string;
  };

  const { path, getLink, title, icon }: Props = $props();

  const crumbs = $derived(getFolderCrumbs(path));
  const items = $derived([
    { icon, title, href: getLink('') },
    ...crumbs.map((crumb, index) =>
      index === crumbs.length - 1 ? { title: crumb.name } : { title: crumb.name, href: getLink(crumb.path) },
    ),
  ]);
  const parentLink = $derived.by(() => {
    if (crumbs.length === 0) {
      return;
    }

    const parent = getFolderParentPath(path);
    return getLink(parent === '/' ? '' : parent);
  });
</script>

<ControlBar>
  <ControlBarHeader class="flex-row gap-4 overflow-x-auto">
    <IconButton
      shape="round"
      color="secondary"
      variant="ghost"
      icon={mdiArrowUpLeft}
      aria-label={$t('to_parent')}
      href={parentLink}
      disabled={!parentLink}
    />
    <Breadcrumbs {items} class="min-w-0 flex-wrap [&_a]:text-primary" />
  </ControlBarHeader>
</ControlBar>
