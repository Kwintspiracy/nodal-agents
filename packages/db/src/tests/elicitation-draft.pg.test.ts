// elicitation-draft.pg.test.ts — migration 0146 against a REAL Postgres.
//
// WHY A SEPARATE FILE. `pnpm test` builds its database from the inline SQL in
// `helpers.ts`, never from `migrations/`. A migration missing from
// `meta/_journal.json` is skipped IN SILENCE while the whole suite stays green;
// only a real upgrade breaks — here the first gesture on a channel card after
// the upgrade would fail its write, and the card would never fill.
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

describe('migration 0146_elicitation_draft @cap:approuver-une-action/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('adds approval_requests.draft, a nullable jsonb', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const rows = (await db.execute(
        sql`SELECT data_type, is_nullable FROM information_schema.columns
            WHERE table_name = 'approval_requests' AND column_name = 'draft'`,
      )) as unknown as Array<{ data_type: string; is_nullable: string }>;
      expect(rows).toEqual([{ data_type: 'jsonb', is_nullable: 'YES' }]);
    } finally {
      await close();
    }
  });

  it('records the migration in the journal, after every migration numbered before it', async () => {
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string; when: number }> } };
    const entries = journal.default.entries;
    const mine = entries.find((e) => e.tag === '0146_elicitation_draft');
    expect(mine).toBeDefined();
    for (const e of entries.filter((x) => x.idx < mine!.idx)) {
      expect(e.when).toBeLessThan(mine!.when);
    }
  });
});
