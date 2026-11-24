<script lang="ts">
  import FolderCards from '#lib/components/folders/FolderCards.svelte';
  import { Route } from '#lib/route.ts';
  import type { FolderCard } from '#lib/utils/folder-cards.ts';
  import type { AlbumResponseDto } from '@immich/sdk';
  import { mdiFolderOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { goto } from '$app/navigation';

  type Props = {
    albums: AlbumResponseDto[];
  };

  const { albums }: Props = $props();

  const items = $derived<FolderCard[]>(
    albums.map((album) => ({
      path: album.id,
      label: album.albumName,
      coverAssetId: album.albumThumbnailAssetId,
      assetCount: album.assetCount,
    })),
  );
</script>

{#if items.length > 0}
  <section class="my-4" data-testid="folder-album-children">
    <h2 class="mb-2 text-sm font-medium text-gray-500 uppercase dark:text-gray-300">{$t('albums_in_folder')}</h2>
    <FolderCards {items} icon={mdiFolderOutline} onClick={(item) => goto(Route.viewAlbum({ id: item.path }))} />
  </section>
{/if}
