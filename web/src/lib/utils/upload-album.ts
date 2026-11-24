import type { AlbumResponseDto } from '@immich/sdk';

export const getUploadAlbumId = (
  albumId: string | undefined,
  album: Pick<AlbumResponseDto, 'id' | 'isFolderAlbum'> | undefined,
) => {
  if (!albumId) {
    return;
  }

  if (album?.id === albumId && album.isFolderAlbum) {
    return;
  }

  return albumId;
};
