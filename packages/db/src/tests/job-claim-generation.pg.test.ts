// job-claim-generation.pg.test.ts — migration 0135 against a REAL Postgres (#566).
//
// @cap:suivre-execution/moteur
//
// WHY A SEPARATE FILE. `pnpm test` builds its database from the inline SQL in
// `helpers.ts`, never from `migrations/`. A migration missing from
// `meta/_journal.json` is skipped IN SILENCE while the whole suite stays green;
// only a real upgrade breaks — and here the runner's `claimJob` would fail on
// the first job of an upgraded install.
//
// The startup is a TEST, not a beforeAll: a beforeAll that throws marks the
// tests "skipped", and a silently skipped test is a false green (invariant #4).

import { describe, it, expect, afterAll } from 'vitest';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import { createClient, sql } from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

describe('migration 0135_job_claim_generation @cap:suivre-execution/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('leaves agent_jobs.claim_generation a NOT NULL integer defaulting to 0', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const rows = (await db.execute(
        sql`SELECT data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'agent_jobs'
              AND column_name = 'claim_generation'`,
      )) as unknown as Array<{ data_type: string; is_nullable: string; column_default: string }>;

      expect(rows, 'agent_jobs.claim_generation absent after the real migrations').toEqual([
        { data_type: 'integer', is_nullable: 'NO', column_default: '0' },
      ]);
    } finally {
      await close();
    }
  });

  it('records the migration in the journal drizzle-kit actually reads', async () => {
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string }> } };
    const tags = journal.default.entries.map((e) => e.tag);
    expect(tags).toContain('0135_job_claim_generation');
  });
});
