import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "login_attempt" (
  "key" text NOT NULL,
  "failures" integer NOT NULL,
  "lastFailureAt" timestamp with time zone NOT NULL,
  "lockedUntil" timestamp with time zone,
  CONSTRAINT "login_attempt_pkey" PRIMARY KEY ("key")
);`.execute(db);
  await sql`CREATE INDEX "login_attempt_lastFailureAt_idx" ON "login_attempt" ("lastFailureAt");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "login_attempt";`.execute(db);
}
