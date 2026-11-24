import { Column, ForeignKeyColumn, Table, Timestamp, UpdateDateColumn, type Generated } from '@immich/sql-tools';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('asset_playback_position')
export class AssetPlaybackPositionTable {
  @ForeignKeyColumn(() => UserTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true })
  userId!: string;

  @ForeignKeyColumn(() => AssetTable, { onUpdate: 'CASCADE', onDelete: 'CASCADE', primary: true })
  assetId!: string;

  @Column({ type: 'double precision' })
  position!: number;

  @Column({ type: 'double precision', nullable: true })
  duration!: number | null;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;
}
