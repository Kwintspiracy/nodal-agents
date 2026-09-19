// agent-may-change-team.pg.test.ts — migration 0111 against a REAL Postgres.
//
// @cap:assigner-outils/moteur
//
// WHY A SEPARATE FILE. `pnpm test` builds its database from the inline SQL in
// `helpers.ts`, never from `migrations/`. A migration can therefore be wrong —
// or missing from `meta/_journal.json`, which makes drizzle-kit skip it IN
// SILENCE — while the whole suite stays green and only a real upgrade breaks.
//
// WHAT THIS PROVES BEYOND THE COLUMN EXISTING. The decision of issue #137 is
// that an install upgrading to this version loses the three team tools until
// its owner asks for them back. That decision lives in ONE place — the DEFAULT
// of this column, applied to rows written before it existed. A migration that
// added the column nullable, or defaulted it to true, would leave every
// existing agent exactly as free as it was on the night of 2026-09-15, and no
// other test in the repository would notice.
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

interface ColumnRow {
  data_type: string;
  is_nullable: string;
  column_default: string | null;
}

describe('migration 0111_agent_may_change_team @cap:assigner-outils/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    // The real 0000→N, not the inline DDL of helpers.ts. No pgvector in the
    // embedded Postgres: vector columns are rewritten to text, exactly as
    // `nodal-agents up` does on a machine without the extension.
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('leaves agents.may_change_team a NOT NULL boolean defaulting to false', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const rows = (await db.execute(
        sql`SELECT data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'agents'
              AND column_name = 'may_change_team'`,
      )) as unknown as ColumnRow[];

      expect(rows, 'agents.may_change_team absent after the real migrations').toHaveLength(1);
      expect(rows[0]!.data_type).toBe('boolean');
      // Nullable would make "not set" a third state the runner would have to
      // guess at — the setting is a yes or a no.
      expect(rows[0]!.is_nullable).toBe('NO');
      expect(rows[0]!.column_default).toBe('false');
    } finally {
      await close();
    }
  });

  it('turns the setting OFF on an agent row that predates the column', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      // Rebuild the upgrade the migration performs, on a table shaped like the
      // one that existed before it: rows first, column after.
      await db.execute(sql`DROP TABLE IF EXISTS may_change_team_probe`);
      await db.execute(sql`CREATE TABLE may_change_team_probe (id int PRIMARY KEY, name text)`);
      await db.execute(
        sql`INSERT INTO may_change_team_probe (id, name) VALUES (1, 'Alfred'), (2, 'Lead-Dev')`,
      );
      await db.execute(
        sql`ALTER TABLE may_change_team_probe
            ADD COLUMN IF NOT EXISTS may_change_team boolean NOT NULL DEFAULT false`,
      );

      const rows = (await db.execute(
        sql`SELECT id, may_change_team FROM may_change_team_probe ORDER BY id`,
      )) as unknown as Array<{ id: number; may_change_team: boolean }>;

      expect(rows.map((r) => r.may_change_team)).toEqual([false, false]);
    } finally {
      await close();
    }
  });

  it('records the migration in the journal drizzle-kit actually reads', async () => {
    // A file without a journal entry is skipped IN SILENCE — the exact failure
    // that made 0108 need this kind of test.
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string }> } };
    const tags = journal.default.entries.map((e) => e.tag);
    expect(tags).toContain('0111_agent_may_change_team');
  });
});
