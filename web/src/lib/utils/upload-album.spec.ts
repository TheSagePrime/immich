import { getUploadAlbumId } from '#lib/utils/upload-album.ts';

describe('getUploadAlbumId', () => {
  it('should return nothing outside an album', () => {
    expect(getUploadAlbumId(undefined, undefined)).toBeUndefined();
  });

  it('should add uploads to a hand-made album', () => {
    expect(getUploadAlbumId('album-1', { id: 'album-1', isFolderAlbum: false })).toBe('album-1');
  });

  it('should add uploads to the album while its details are not loaded yet', () => {
    expect(getUploadAlbumId('album-1', undefined)).toBe('album-1');
  });

  it('should not add uploads to a folder album', () => {
    expect(getUploadAlbumId('album-1', { id: 'album-1', isFolderAlbum: true })).toBeUndefined();
  });

  it('should ignore details of another album', () => {
    expect(getUploadAlbumId('album-1', { id: 'album-2', isFolderAlbum: true })).toBe('album-1');
  });
});
