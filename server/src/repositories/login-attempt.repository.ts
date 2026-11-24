import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';

@Injectable()
export class LoginAttemptRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [[DummyValue.STRING], DummyValue.DATE] })
  getLocked(keys: string[], now: Date) {
    return this.db
      .selectFrom('login_attempt')
      .select(['key', 'failures', 'lockedUntil'])
      .where('key', 'in', keys)
      .where('lockedUntil', '>', now)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.STRING, DummyValue.DATE, DummyValue.DATE] })
  async recordFailure(key: string, now: Date, resetBefore: Date) {
    const { failures } = await this.db
      .insertInto('login_attempt')
      .values({ key, failures: 1, lastFailureAt: now, lockedUntil: null })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({
          failures: sql<number>`case when greatest("login_attempt"."lastFailureAt", coalesce("login_attempt"."lockedUntil", "login_attempt"."lastFailureAt")) < ${resetBefore} then 1 else "login_attempt"."failures" + 1 end`,
          lastFailureAt: now,
        }),
      )
      .returning(['failures'])
      .executeTakeFirstOrThrow();

    return failures;
  }

  @GenerateSql({ params: [DummyValue.STRING, DummyValue.DATE] })
  async lock(key: string, lockedUntil: Date) {
    await this.db
      .updateTable('login_attempt')
      .set({ lockedUntil: sql<Date>`greatest(coalesce("lockedUntil", ${lockedUntil}), ${lockedUntil})` })
      .where('key', '=', key)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.STRING] })
  async reset(key: string) {
    await this.db.deleteFrom('login_attempt').where('key', '=', key).execute();
  }

  @GenerateSql({ params: [DummyValue.DATE] })
  async cleanup(olderThan: Date) {
    const result = await this.db
      .deleteFrom('login_attempt')
      .where('lastFailureAt', '<', olderThan)
      .where((eb) => eb.or([eb('lockedUntil', 'is', null), eb('lockedUntil', '<', olderThan)]))
      .executeTakeFirst();

    return Number(result.numDeletedRows);
  }
}
