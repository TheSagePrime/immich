import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE INDEX "asset_ownerId_originalPath_pattern_idx" ON "asset" ("ownerId", "originalPath" text_pattern_ops);`.execute(
    db,
  );
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('index_asset_ownerId_originalPath_pattern_idx', '{"type":"index","name":"asset_ownerId_originalPath_pattern_idx","sql":"CREATE INDEX \\"asset_ownerId_originalPath_pattern_idx\\" ON \\"asset\\" (\\"ownerId\\", \\"originalPath\\" text_pattern_ops);"}'::jsonb);`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX "asset_ownerId_originalPath_pattern_idx";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'index_asset_ownerId_originalPath_pattern_idx';`.execute(db);
}
