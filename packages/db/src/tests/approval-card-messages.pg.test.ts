// approval-card-messages.pg.test.ts — migration 0140 against a REAL Postgres (#637).
//
// WHY A SEPARATE FILE. `pnpm test` builds its database from the inline SQL in
// `helpers.ts`, never from `migrations/`. A migration missing from
// `meta/_journal.json` is skipped IN SILENCE while the whole suite stays green;
// only a real upgrade breaks — here every approval card sent after the upgrade
// would fail to be recorded, and would never follow its request again.
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

describe('migration 0140_approval_card_messages @cap:approuver-une-action/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('creates approval_card_messages with the columns the runner writes and reads', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const rows = (await db.execute(
        sql`SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'approval_card_messages'
            ORDER BY column_name`,
      )) as unknown as Array<{ column_name: string; data_type: string; is_nullable: string }>;

      expect(rows).toEqual([
        { column_name: 'agent_id', data_type: 'uuid', is_nullable: 'NO' },
        { column_name: 'approval_request_id', data_type: 'uuid', is_nullable: 'NO' },
        { column_name: 'attempts', data_type: 'integer', is_nullable: 'NO' },
        { column_name: 'channel', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'claimed_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
        { column_name: 'conversation_id', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
        { column_name: 'last_error', data_type: 'text', is_nullable: 'YES' },
        { column_name: 'message_id', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'outcome', data_type: 'text', is_nullable: 'YES' },
        { column_name: 'sent_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
        { column_name: 'settled_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
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
    expect(tags).toContain('0140_approval_card_messages');
  });
});
