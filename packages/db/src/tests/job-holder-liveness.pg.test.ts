// job-holder-liveness.pg.test.ts — migration 0173 against a REAL Postgres (#1204).
//
// WHY A SEPARATE FILE. `pnpm test` builds its database from the inline SQL in
// `helpers.ts`, never from `migrations/`. A migration missing from
// `meta/_journal.json` is skipped IN SILENCE while the whole suite stays green;
// only a real upgrade breaks — and here every claim (`claimJob` writes
// `claimed_by`) would fail on the first job of an upgraded install.
//
// The startup is a TEST, not a beforeAll: a beforeAll that throws marks the
// tests "skipped", and a silently skipped test is a false green (invariant #4).

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import { createClient, sql, runnerInstances } from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

describe('migration 0173_job_holder_liveness @cap:parler-a-un-agent/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('adds agent_jobs.claimed_by (uuid) and sweeper_observed (jsonb), both nullable', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const rows = (await db.execute(
        sql`SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'agent_jobs'
              AND column_name IN ('claimed_by', 'sweeper_observed')
            ORDER BY column_name`,
      )) as unknown as Array<{ column_name: string; data_type: string; is_nullable: string }>;
      expect(rows).toEqual([
        { column_name: 'claimed_by', data_type: 'uuid', is_nullable: 'YES' },
        { column_name: 'sweeper_observed', data_type: 'jsonb', is_nullable: 'YES' },
      ]);
    } finally {
      await close();
    }
  });

  it('creates runner_instances, whose beat is written on the database clock', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const id = randomUUID();
      // The beat the runner writes (job/liveness.ts `beatInstance`): an
      // upsert whose `last_seen_at` is `now()`, never a value from the runner.
      const [first] = await db
        .insert(runnerInstances)
        .values({ id, host: 'h', pid: 1 })
        .onConflictDoUpdate({ target: runnerInstances.id, set: { lastSeenAt: sql`now()` } })
        .returning({
          lastSeenAt: runnerInstances.lastSeenAt,
          stoppedAt: runnerInstances.stoppedAt,
        });
      const [again] = await db
        .insert(runnerInstances)
        .values({ id, host: 'h', pid: 1 })
        .onConflictDoUpdate({ target: runnerInstances.id, set: { lastSeenAt: sql`now()` } })
        .returning({ lastSeenAt: runnerInstances.lastSeenAt });
      expect(first?.stoppedAt).toBeNull();
      expect(first?.lastSeenAt).toBeInstanceOf(Date);
      expect(again!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first!.lastSeenAt.getTime());

      // The database's clock as the sweepers read it, in milliseconds.
      const [clock] = await db
        .select({ ms: sql<string>`(extract(epoch from now()) * 1000)::bigint` })
        .from(runnerInstances)
        .limit(1);
      expect(Math.abs(Number(clock!.ms) - Date.now())).toBeLessThan(60_000);
    } finally {
      await close();
    }
  });

  it('records the migration in the journal drizzle-kit actually reads', async () => {
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string; when: number }> } };
    const entries = journal.default.entries;
    const mine = entries.find((e) => e.tag === '0173_job_holder_liveness');
    expect(mine?.idx).toBe(173);
    // `migrate()` applies only entries whose `when` is past the last applied
    // one: this entry must come after every migration numbered before it, and
    // before every one numbered after it (a later migration may follow it in
    // the journal; `pnpm migrations:check` holds the order against releases).
    const before = entries.filter((e) => e.idx < 173).map((e) => e.when);
    const after = entries.filter((e) => e.idx > 173).map((e) => e.when);
    expect(Math.max(...before)).toBeLessThan(mine!.when);
    for (const w of after) expect(w).toBeGreaterThan(mine!.when);
  });
});
