import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "upload_session" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "ownerId" uuid NOT NULL,
  "libraryId" uuid NOT NULL,
  "batchId" uuid,
  "relativePath" text NOT NULL,
  "tempPath" text,
  "finalRelativePath" text,
  "size" bigint NOT NULL,
  "checksum" bytea NOT NULL,
  "duplicatePolicy" character varying NOT NULL,
  "status" character varying NOT NULL DEFAULT 'active',
  "outcome" character varying,
  "message" text,
  "assetId" uuid,
  "fileModifiedAt" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "expiresAt" timestamp with time zone NOT NULL,
  CONSTRAINT "upload_session_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "upload_session_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "library" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "upload_session_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "upload_session_size_chk" CHECK ("size" >= 0),
  CONSTRAINT "upload_session_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "upload_session_ownerId_idx" ON "upload_session" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "upload_session_libraryId_idx" ON "upload_session" ("libraryId");`.execute(db);
  await sql`CREATE INDEX "upload_session_batchId_idx" ON "upload_session" ("batchId");`.execute(db);
  await sql`CREATE INDEX "upload_session_assetId_idx" ON "upload_session" ("assetId");`.execute(db);
  await sql`CREATE INDEX "upload_session_expiresAt_idx" ON "upload_session" ("expiresAt");`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "upload_session_updatedAt"
  BEFORE UPDATE ON "upload_session"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_upload_session_updatedAt', '{"type":"trigger","name":"upload_session_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"upload_session_updatedAt\\"\\n  BEFORE UPDATE ON \\"upload_session\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_upload_session_updatedAt';`.execute(db);
  await sql`DROP TRIGGER "upload_session_updatedAt" ON "upload_session";`.execute(db);
  await sql`DROP TABLE "upload_session";`.execute(db);
}
