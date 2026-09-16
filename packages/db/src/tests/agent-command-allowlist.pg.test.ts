// agent-command-allowlist.pg.test.ts — migration 0108 against a REAL Postgres.
//
// @cap:assigner-outils/moteur
//
// WHY A SEPARATE FILE. `pnpm test` builds its database from the inline SQL in
// `helpers.ts`, never from `migrations/`. A migration can therefore be wrong —
// or, worse, missing from `meta/_journal.json`, which makes drizzle-kit skip it
// IN SILENCE — while the whole suite stays green and only a real upgrade
// breaks. `agents.command_allowlist` was in the schema, in the inline SQL and
// in a migration file, and NOTHING applied that migration. This closes that.
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
  udt_name: string;
}

describe('migration 0108_agent_command_allowlist @cap:assigner-outils/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    // The real 0000→N, not the inline DDL of helpers.ts. No pgvector in the
    // embedded Postgres: vector columns are rewritten to text, exactly as
    // `nodal-agents up` does on a machine without the extension.
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('leaves agents.command_allowlist as a NULLABLE text[] — the column an upgraded install gets', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const rows = (await db.execute(
        sql`SELECT data_type, is_nullable, udt_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'agents'
              AND column_name = 'command_allowlist'`,
      )) as unknown as ColumnRow[];

      expect(rows, 'agents.command_allowlist absent after the real migrations').toHaveLength(1);
      // `text[]` reports as ARRAY with an element udt of `_text`.
      expect(rows[0]!.data_type).toBe('ARRAY');
      expect(rows[0]!.udt_name).toBe('_text');
      // NULL is the historical "no list, unrestricted" state — an upgrade that
      // defaulted it to `{}` would refuse every command on every existing
      // agent.
      expect(rows[0]!.is_nullable).toBe('YES');
    } finally {
      await close();
    }
  });

  it('accepts the three states the allowlist can be in: NULL, empty, populated', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS allowlist_probe (
        id int PRIMARY KEY,
        command_allowlist text[]
      )`);
      await db.execute(sql`DELETE FROM allowlist_probe`);
      await db.execute(sql`INSERT INTO allowlist_probe (id, command_allowlist) VALUES
        (1, NULL), (2, '{}'), (3, '{node,"npx vitest"}')`);

      const rows = (await db.execute(
        sql`SELECT id, command_allowlist FROM allowlist_probe ORDER BY id`,
      )) as unknown as Array<{ id: number; command_allowlist: string[] | null }>;

      expect(rows[0]!.command_allowlist).toBeNull();
      expect(rows[1]!.command_allowlist).toEqual([]);
      // A multi-word entry must survive the round trip as ONE entry: `npx
      // vitest` split into two would allow bare `npx`.
      expect(rows[2]!.command_allowlist).toEqual(['node', 'npx vitest']);
    } finally {
      await close();
    }
  });
});
