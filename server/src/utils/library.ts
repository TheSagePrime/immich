import { Insertable } from 'kysely';
import { Stats } from 'node:fs';
import { normalize, parse } from 'node:path';
import { AssetType, ChecksumAlgorithm } from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { mimeTypes } from 'src/utils/mime-types.js';

export const toExternalAssetInsert = ({
  ownerId,
  libraryId,
  path,
  stat,
  hashSha1,
}: {
  ownerId: string;
  libraryId: string;
  path: string;
  stat: Pick<Stats, 'mtime'>;
  hashSha1: (value: string) => Buffer;
}): Insertable<AssetTable> => {
  const assetPath = normalize(path);
  return {
    ownerId,
    libraryId,
    checksum: hashSha1(`path:${assetPath}`),
    checksumAlgorithm: ChecksumAlgorithm.sha1Path,
    originalPath: assetPath,

    fileCreatedAt: stat.mtime,
    fileModifiedAt: stat.mtime,
    localDateTime: stat.mtime,
    type: mimeTypes.isVideo(assetPath) ? AssetType.Video : AssetType.Image,
    originalFileName: parse(assetPath).base,
    isExternal: true,
    livePhotoVideoId: null,
  };
};
