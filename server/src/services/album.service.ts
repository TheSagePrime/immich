import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AddUsersDto,
  AlbumFolderResponseDto,
  AlbumResponseDto,
  AlbumStatisticsResponseDto,
  AlbumsAddAssetsDto,
  AlbumsAddAssetsResponseDto,
  CreateAlbumDto,
  GetAlbumsDto,
  MapAlbumDto,
  UpdateAlbumDto,
  UpdateAlbumUserDto,
  mapAlbum,
} from 'src/dtos/album.dto.js';
import { BulkIdErrorReason, BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { AuthDto, isMetadataHidden } from 'src/dtos/auth.dto.js';
import { MapMarkerResponseDto } from 'src/dtos/map.dto.js';
import { AlbumUserRole, Permission } from 'src/enum.js';
import { AlbumAssetCount } from 'src/repositories/album.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { addAssets, removeAssets } from 'src/utils/asset.util.js';
import { asDateTimeString } from 'src/utils/date.js';
import { findOrFail } from 'src/utils/misc.js';
import { getPreferences } from 'src/utils/preferences.js';

const mapAlbumMetadata = (metadata?: AlbumAssetCount) => ({
  startDate: asDateTimeString(metadata?.startDate ?? undefined),
  endDate: asDateTimeString(metadata?.endDate ?? undefined),
  assetCount: metadata?.assetCount ?? 0,
  // lastModifiedAssetTimestamp is only used in mobile app, please remove if not need
  lastModifiedAssetTimestamp: asDateTimeString(metadata?.lastModifiedAssetTimestamp ?? undefined),
});

@Injectable()
export class AlbumService extends BaseService {
  async getStatistics(auth: AuthDto): Promise<AlbumStatisticsResponseDto> {
    const [owned, shared, notShared] = await Promise.all([
      this.albumRepository.getAll(auth.user.id, { isOwned: true }),
      this.albumRepository.getAll(auth.user.id, { isShared: true }),
      this.albumRepository.getAll(auth.user.id, { isOwned: true, isShared: false }),
    ]);

    return {
      owned: owned.length,
      shared: shared.length,
      notShared: notShared.length,
    };
  }

  async getAll({ user: { id: ownerId } }: AuthDto, { assetId, ...rest }: GetAlbumsDto): Promise<AlbumResponseDto[]> {
    await this.albumRepository.updateThumbnails();

    const albums = assetId
      ? await this.albumRepository.getByAssetId(ownerId, assetId)
      : await this.albumRepository.getAll(ownerId, rest);

    return this.mapAlbumList(albums, ownerId);
  }

  async getFolder(auth: AuthDto, id: string): Promise<AlbumFolderResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    const album = await this.findOrFail(id, auth.user.id);
    if (!album.folderPath) {
      return { isFolderAlbum: false, ancestors: [], children: [] };
    }

    await this.albumRepository.updateThumbnails();

    const ancestors: AlbumFolderResponseDto['ancestors'] = [];
    for (const ancestor of await this.folderAlbumRepository.getAncestors(id, auth.user.id)) {
      if (!ancestor.accessible) {
        break;
      }
      ancestors.unshift({ id: ancestor.id, albumName: ancestor.albumName });
    }

    const childAlbums = await this.albumRepository.getAll(auth.user.id, { parentAlbumId: id });
    const children = (await this.mapAlbumList(childAlbums, auth.user.id)).toSorted((a, b) =>
      a.albumName.localeCompare(b.albumName, undefined, { numeric: true, sensitivity: 'base' }),
    );

    return {
      isFolderAlbum: true,
      path:
        album.folderOwnerId === auth.user.id
          ? [...ancestors.map(({ albumName }) => albumName), album.albumName].join('/')
          : undefined,
      ancestors,
      children,
    };
  }

  async get(auth: AuthDto, id: string): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    await this.albumRepository.updateThumbnails();
    const album = await this.findOrFail(id, auth.user.id);

    const hasSharedUsers = album.albumUsers && album.albumUsers.length > 1;
    const hasSharedLink = album.sharedLinks && album.sharedLinks.length > 0;
    const isShared = hasSharedUsers || hasSharedLink;

    return {
      ...(await this.mapWithMetadata(album, auth)),
      contributorCounts:
        isShared && !auth.sharedLink ? await this.albumRepository.getContributorCounts(album.id) : undefined,
    };
  }

  async getMapMarkers(auth: AuthDto, id: string): Promise<MapMarkerResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });

    if (isMetadataHidden(auth)) {
      return [];
    }

    return this.mapRepository.getAlbumMapMarkers(id);
  }

  async create(auth: AuthDto, dto: CreateAlbumDto): Promise<AlbumResponseDto> {
    const albumUsers = (dto.albumUsers || []).filter(({ userId }) => userId !== auth.user.id);

    for (const { userId } of albumUsers) {
      const exists = await this.userRepository.get(userId, {});
      if (!exists) {
        this.logger.debug('Album creation failed: user not found');
        throw new BadRequestException('Invalid user');
      }
    }

    const allowedAssetIdsSet = await this.checkAccess({
      auth,
      permission: Permission.AssetShare,
      ids: dto.assetIds || [],
    });
    const assetIds = [...allowedAssetIdsSet].map((id) => id);

    const userMetadata = await this.userRepository.getMetadata(auth.user.id);

    const album = await this.albumRepository.create(
      {
        albumName: dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: assetIds[0] || null,
        order: getPreferences(userMetadata).albums.defaultAssetOrder,
      },
      assetIds,
      [{ userId: auth.user.id, role: AlbumUserRole.Owner }, ...albumUsers],
      auth.user.id,
    );

    for (const { userId } of albumUsers) {
      await this.eventRepository.emit('AlbumInvite', { id: album.id, userId, senderName: auth.user.name });
    }

    return this.mapWithMetadata(album);
  }

  async update(auth: AuthDto, id: string, dto: UpdateAlbumDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id);

    if (album.folderPath && dto.albumName !== undefined && dto.albumName !== album.albumName) {
      throw new BadRequestException('Folder albums are named after their folder');
    }

    if (dto.albumThumbnailAssetId) {
      const results = await this.albumRepository.getAssetIds(id, [dto.albumThumbnailAssetId]);
      if (results.size === 0) {
        throw new BadRequestException('Invalid album thumbnail');
      }
    }
    const updatedAlbum = await this.albumRepository.update(
      album.id,
      {
        id: album.id,
        albumName: album.folderPath ? undefined : dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: dto.albumThumbnailAssetId,
        isActivityEnabled: dto.isActivityEnabled,
        order: dto.order,
      },
      auth.user.id,
    );

    return this.mapWithMetadata(updatedAlbum, auth);
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumDelete, ids: [id] });
    const album = await this.albumRepository.getById(id);
    if (album?.folderPath) {
      throw new BadRequestException('Folder albums are removed automatically when their folder is empty');
    }
    await this.albumRepository.delete(id);
  }

  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    const album = await this.findOrFail(id, auth.user.id);
    await this.requireAccess({ auth, permission: Permission.AlbumAssetCreate, ids: [id] });

    if (album.folderPath) {
      return this.folderAlbumReadOnly(dto.ids);
    }

    const results = await addAssets(
      auth,
      { access: this.accessRepository, bulk: this.albumRepository },
      { parentId: id, assetIds: dto.ids, permission: Permission.AssetShare },
    );

    const { id: firstNewAssetId } = results.find(({ success }) => success) || {};
    if (firstNewAssetId) {
      await this.albumRepository.update(
        id,
        {
          id,
          updatedAt: new Date(),
          albumThumbnailAssetId: album.albumThumbnailAssetId ?? firstNewAssetId,
        },
        auth.user.id,
      );

      const userIds = album.albumUsers.map(({ user }) => user.id);
      const recipientIds = userIds.filter((userId) => userId !== auth.user.id);
      await this.eventRepository.emit('AlbumUpdate', { id, userIds, recipientIds });
    }

    return results;
  }

  async addAssetsToAlbums(auth: AuthDto, dto: AlbumsAddAssetsDto): Promise<AlbumsAddAssetsResponseDto> {
    const results: AlbumsAddAssetsResponseDto = {
      success: false,
      error: BulkIdErrorReason.DUPLICATE,
    };

    const allowedAlbumIds = await this.checkAccess({
      auth,
      permission: Permission.AlbumAssetCreate,
      ids: dto.albumIds,
    });
    for (const folderAlbumId of await this.albumRepository.getFolderAlbumIds([...allowedAlbumIds])) {
      allowedAlbumIds.delete(folderAlbumId);
    }
    if (allowedAlbumIds.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    const allowedAssetIds = await this.checkAccess({ auth, permission: Permission.AssetShare, ids: dto.assetIds });
    if (allowedAssetIds.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    const albumAssetValues: { albumId: string; assetId: string }[] = [];
    const events: { id: string; userIds: string[]; recipientIds: string[] }[] = [];
    for (const albumId of allowedAlbumIds) {
      const existingAssetIds = await this.albumRepository.getAssetIds(albumId, [...allowedAssetIds]);
      const notPresentAssetIds = [...allowedAssetIds.difference(existingAssetIds)];
      if (notPresentAssetIds.length === 0) {
        continue;
      }
      const album = await this.findOrFail(albumId, auth.user.id);
      results.error = undefined;
      results.success = true;

      for (const assetId of notPresentAssetIds) {
        albumAssetValues.push({ albumId, assetId });
      }
      await this.albumRepository.update(
        albumId,
        {
          id: albumId,
          updatedAt: new Date(),
          albumThumbnailAssetId: album.albumThumbnailAssetId ?? notPresentAssetIds[0],
        },
        auth.user.id,
      );
      const userIds = album.albumUsers.map(({ user }) => user.id);
      const recipientIds = userIds.filter((userId) => userId !== auth.user.id);
      events.push({ id: albumId, userIds, recipientIds });
    }

    await this.albumRepository.addAssetIdsToAlbums(albumAssetValues);
    for (const event of events) {
      await this.eventRepository.emit('AlbumUpdate', event);
    }

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumAssetDelete, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id);
    if (album.folderPath) {
      return this.folderAlbumReadOnly(dto.ids);
    }

    const results = await removeAssets(
      auth,
      { access: this.accessRepository, bulk: this.albumRepository },
      { parentId: id, assetIds: dto.ids, canAlwaysRemove: Permission.AlbumDelete },
    );

    const removedIds = results.filter(({ success }) => success).map(({ id }) => id);
    if (removedIds.length > 0) {
      if (album.albumThumbnailAssetId && removedIds.includes(album.albumThumbnailAssetId)) {
        await this.albumRepository.updateThumbnails();
      }

      await this.eventRepository.emit('AlbumUpdate', {
        id,
        userIds: album.albumUsers.map(({ user }) => user.id),
        recipientIds: [],
      });
    }

    return results;
  }

  async addUsers(auth: AuthDto, id: string, { albumUsers }: AddUsersDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id);

    for (const { userId, role } of albumUsers) {
      if (role === AlbumUserRole.Owner) {
        throw new BadRequestException('Cannot add another owner');
      }

      const exists = album.albumUsers.some(({ user: { id } }) => id === userId);
      if (exists) {
        continue;
      }

      const user = await this.userRepository.get(userId, {});
      if (!user) {
        this.logger.debug('Adding user to album failed: user not found');
        throw new BadRequestException('Invalid user');
      }

      await this.albumUserRepository.create({ userId, albumId: id, role });
      await this.eventRepository.emit('AlbumInvite', { id, userId, senderName: auth.user.name });
    }

    return this.mapWithMetadata(await this.findOrFail(id, auth.user.id), auth);
  }

  async removeUser(auth: AuthDto, id: string, userId: string | 'me'): Promise<void> {
    if (userId === 'me') {
      userId = auth.user.id;
    }

    const album = await this.findOrFail(id, auth.user.id);

    const exists = album.albumUsers.find(({ user: { id } }) => id === userId);
    if (!exists) {
      throw new BadRequestException('Album not shared with user');
    }

    if (
      exists.role === AlbumUserRole.Owner &&
      album.albumUsers.filter(({ role }) => role === AlbumUserRole.Owner).length === 1
    ) {
      throw new BadRequestException('Cannot remove the last album owner');
    }

    // non-admin can remove themselves
    if (auth.user.id !== userId) {
      await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });
    }

    await this.albumUserRepository.delete({ albumId: id, userId });
  }

  async updateUser(auth: AuthDto, id: string, userId: string, dto: UpdateAlbumUserDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });

    const album = await this.findOrFail(id, userId);
    const owner = album.albumUsers[0];

    if (owner.user.id === userId) {
      throw new BadRequestException('User is owner');
    }

    await this.albumUserRepository.update({ albumId: id, userId }, { role: dto.role });
  }

  private findOrFail(id: string, authUserId: string) {
    return findOrFail(() => this.albumRepository.getById(id, authUserId), 'Album');
  }

  private folderAlbumReadOnly(ids: string[]): BulkIdResponseDto[] {
    return ids.map((id) => ({ id, success: false, error: BulkIdErrorReason.NO_PERMISSION }));
  }

  private async mapAlbumList(albums: MapAlbumDto[], userId: string): Promise<AlbumResponseDto[]> {
    if (albums.length === 0) {
      return [];
    }

    const ids = albums.map((album) => album.id);
    const [results, childCounts] = await Promise.all([
      this.albumRepository.getMetadataForIds(ids),
      this.albumRepository.getChildAlbumCounts(ids, userId),
    ]);
    const albumMetadata: Record<string, AlbumAssetCount> = {};
    for (const metadata of results) {
      albumMetadata[metadata.albumId] = metadata;
    }
    const childAlbumCounts = new Map(childCounts.map(({ albumId, childAlbumCount }) => [albumId, childAlbumCount]));

    return albums.map((album) => ({
      ...mapAlbum({ ...album, childAlbumCount: childAlbumCounts.get(album.id) ?? 0 }),
      sharedLinks: undefined,
      ...mapAlbumMetadata(albumMetadata[album.id]),
    }));
  }

  private async mapWithMetadata(album: MapAlbumDto, auth?: AuthDto): Promise<AlbumResponseDto> {
    const [[metadata], childCounts] = await Promise.all([
      this.albumRepository.getMetadataForIds([album.id]),
      auth && !auth.sharedLink
        ? this.albumRepository.getChildAlbumCounts([album.id], auth.user.id)
        : Promise.resolve([]),
    ]);
    return {
      ...mapAlbum(
        { ...album, childAlbumCount: auth && !auth.sharedLink ? (childCounts[0]?.childAlbumCount ?? 0) : undefined },
        { auth },
      ),
      ...mapAlbumMetadata(metadata),
    };
  }
}
