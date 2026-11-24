import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "album" ADD "parentAlbumId" uuid;`.execute(db);
  await sql`ALTER TABLE "album" ADD "folderOwnerId" uuid;`.execute(db);
  await sql`ALTER TABLE "album" ADD "folderPath" text;`.execute(db);
  await sql`CREATE UNIQUE INDEX "album_folderOwnerId_folderPath_uq" ON "album" ("folderOwnerId", "folderPath") WHERE ("folderPath" IS NOT NULL);`.execute(db);
  await sql`CREATE INDEX "album_parentAlbumId_idx" ON "album" ("parentAlbumId");`.execute(db);
  await sql`ALTER TABLE "album" ADD CONSTRAINT "album_parentAlbumId_fkey" FOREIGN KEY ("parentAlbumId") REFERENCES "album" ("id") ON UPDATE CASCADE ON DELETE SET NULL;`.execute(db);
  await sql`ALTER TABLE "album" ADD CONSTRAINT "album_folderOwnerId_fkey" FOREIGN KEY ("folderOwnerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE;`.execute(db);
  await sql`ALTER TABLE "album" ADD CONSTRAINT "album_folder_chk" CHECK (("folderPath" IS NULL) = ("folderOwnerId" IS NULL));`.execute(db);
  await sql`CREATE TABLE "folder_album_sync" (
  "userId" uuid NOT NULL,
  "checkpointAt" timestamp with time zone,
  "fullSyncAt" timestamp with time zone,
  "rootsKey" text,
  CONSTRAINT "folder_album_sync_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "folder_album_sync_pkey" PRIMARY KEY ("userId")
);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_album_folderOwnerId_folderPath_uq', '{"type":"index","name":"album_folderOwnerId_folderPath_uq","sql":"CREATE UNIQUE INDEX \\"album_folderOwnerId_folderPath_uq\\" ON \\"album\\" (\\"folderOwnerId\\", \\"folderPath\\") WHERE (\\"folderPath\\" IS NOT NULL);"}'::jsonb);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM "album" WHERE "folderPath" IS NOT NULL;`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_album_folderOwnerId_folderPath_uq';`.execute(db);
  await sql`DROP TABLE "folder_album_sync";`.execute(db);
  await sql`ALTER TABLE "album" DROP CONSTRAINT "album_folder_chk";`.execute(db);
  await sql`ALTER TABLE "album" DROP CONSTRAINT "album_folderOwnerId_fkey";`.execute(db);
  await sql`ALTER TABLE "album" DROP CONSTRAINT "album_parentAlbumId_fkey";`.execute(db);
  await sql`DROP INDEX "album_parentAlbumId_idx";`.execute(db);
  await sql`DROP INDEX "album_folderOwnerId_folderPath_uq";`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "folderPath";`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "folderOwnerId";`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "parentAlbumId";`.execute(db);
}
