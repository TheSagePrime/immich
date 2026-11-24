import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_playback_position" (
  "userId" uuid NOT NULL,
  "assetId" uuid NOT NULL,
  "position" double precision NOT NULL,
  "duration" double precision,
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "asset_playback_position_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_playback_position_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_playback_position_pkey" PRIMARY KEY ("userId", "assetId")
);`.execute(db);
  await sql`CREATE INDEX "asset_playback_position_userId_idx" ON "asset_playback_position" ("userId");`.execute(db);
  await sql`CREATE INDEX "asset_playback_position_assetId_idx" ON "asset_playback_position" ("assetId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "asset_playback_position";`.execute(db);
}
