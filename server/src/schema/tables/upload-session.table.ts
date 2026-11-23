import {
  Check,
  Column,
  CreateDateColumn,
  ForeignKeyColumn,
  PrimaryGeneratedColumn,
  Table,
  UpdateDateColumn,
  type Generated,
  type Int8,
  type Timestamp,
} from '@immich/sql-tools';
import { UpdateIdColumn, UpdatedAtTrigger } from 'src/decorators.js';
import { UploadDuplicatePolicy, UploadOutcome, UploadSessionStatus } from 'src/enum.js';
import { AssetTable } from 'src/schema/tables/asset.table.js';
import { LibraryTable } from 'src/schema/tables/library.table.js';
import { UserTable } from 'src/schema/tables/user.table.js';

@Table('upload_session')
@UpdatedAtTrigger('upload_session_updatedAt')
@Check({ name: 'upload_session_size_chk', expression: `"size" >= 0` })
export class UploadSessionTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  @ForeignKeyColumn(() => LibraryTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  libraryId!: string;

  @Column({ type: 'uuid', nullable: true, index: true })
  batchId!: string | null;

  @Column({ type: 'text' })
  relativePath!: string;

  @Column({ type: 'text', nullable: true })
  tempPath!: string | null;

  @Column({ type: 'text', nullable: true })
  finalRelativePath!: string | null;

  @Column({ type: 'bigint' })
  size!: Int8;

  @Column({ type: 'bytea' })
  checksum!: Buffer;

  @Column({ type: 'character varying' })
  duplicatePolicy!: UploadDuplicatePolicy;

  @Column({ type: 'character varying', default: UploadSessionStatus.Active })
  status!: Generated<UploadSessionStatus>;

  @Column({ type: 'character varying', nullable: true })
  outcome!: UploadOutcome | null;

  @Column({ type: 'text', nullable: true })
  message!: string | null;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'SET NULL', onUpdate: 'CASCADE', nullable: true })
  assetId!: string | null;

  @Column({ type: 'timestamp with time zone', nullable: true })
  fileModifiedAt!: Timestamp | null;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn()
  updateId!: Generated<string>;

  @Column({ type: 'timestamp with time zone', index: true })
  expiresAt!: Timestamp;
}
