import { Column, ForeignKeyColumn, Table, type Timestamp } from '@immich/sql-tools';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('folder_album_sync')
export class FolderAlbumSyncTable {
  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', primary: true, index: false })
  userId!: string;

  @Column({ type: 'timestamp with time zone', nullable: true })
  checkpointAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  fullSyncAt!: Timestamp | null;

  @Column({ type: 'text', nullable: true })
  rootsKey!: string | null;
}
