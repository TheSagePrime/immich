import {
  Check,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  ForeignKeyColumn,
  Index,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
  type Generated,
} from '@immich/sql-tools';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { AssetOrder } from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table({ name: 'album' })
@UpdatedAtTrigger('album_updatedAt')
@Index({
  name: 'album_folderOwnerId_folderPath_uq',
  columns: ['folderOwnerId', 'folderPath'],
  unique: true,
  where: '"folderPath" IS NOT NULL',
})
@Check({ name: 'album_folder_chk', expression: '("folderPath" IS NULL) = ("folderOwnerId" IS NULL)' })
export class AlbumTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ default: 'Untitled Album' })
  albumName!: Generated<string>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @ForeignKeyColumn(() => AssetTable, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    comment: 'Asset ID to be used as thumbnail',
  })
  albumThumbnailAssetId!: string | null;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @DeleteDateColumn()
  deletedAt!: Timestamp | null;

  @Column({ type: 'boolean', default: true })
  isActivityEnabled!: Generated<boolean>;

  @Column({ default: AssetOrder.Desc })
  order!: Generated<AssetOrder>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;

  @ForeignKeyColumn(() => AlbumTable, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE', index: true })
  parentAlbumId!: string | null;

  @ForeignKeyColumn(() => UserTable, { nullable: true, onDelete: 'CASCADE', onUpdate: 'CASCADE', index: false })
  folderOwnerId!: string | null;

  @Column({ type: 'text', nullable: true })
  folderPath!: string | null;
}
