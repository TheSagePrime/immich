import { Column, PrimaryColumn, Table, type Timestamp } from '@immich/sql-tools';

@Table('login_attempt')
export class LoginAttemptTable {
  @PrimaryColumn({ type: 'text' })
  key!: string;

  @Column({ type: 'integer' })
  failures!: number;

  @Column({ type: 'timestamp with time zone', index: true })
  lastFailureAt!: Timestamp;

  @Column({ type: 'timestamp with time zone', nullable: true })
  lockedUntil!: Timestamp | null;
}
