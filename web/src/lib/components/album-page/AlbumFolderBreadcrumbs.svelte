<script lang="ts">
  import { Route } from '#lib/route.ts';
  import type { AlbumFolderAncestorDto } from '@immich/sdk';
  import { Breadcrumbs, IconButton } from '@immich/ui';
  import { mdiArrowUpLeft, mdiImageAlbum } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    albumName: string;
    ancestors: AlbumFolderAncestorDto[];
  };

  const { albumName, ancestors }: Props = $props();

  const items = $derived([
    { icon: mdiImageAlbum, title: $t('albums'), href: Route.albums() },
    ...ancestors.map((ancestor) => ({ title: ancestor.albumName, href: Route.viewAlbum(ancestor) })),
    { title: albumName },
  ]);
  const parent = $derived(ancestors.at(-1));
</script>

<nav class="flex flex-row items-center gap-4 overflow-x-auto" data-testid="album-folder-breadcrumbs">
  <IconButton
    shape="round"
    color="secondary"
    variant="ghost"
    icon={mdiArrowUpLeft}
    aria-label={$t('to_parent')}
    href={parent ? Route.viewAlbum(parent) : Route.albums()}
  />
  <Breadcrumbs {items} class="min-w-0 flex-wrap [&_a]:text-primary" />
</nav>
