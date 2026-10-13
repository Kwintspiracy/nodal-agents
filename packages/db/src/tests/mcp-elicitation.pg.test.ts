// mcp-elicitation.pg.test.ts — migration 0145 against a REAL Postgres.
//
// WHY A SEPARATE FILE. `pnpm test` builds its database from the inline SQL in
// `helpers.ts`, never from `migrations/`. A migration missing from
// `meta/_journal.json` is skipped IN SILENCE while the whole suite stays green;
// only a real upgrade breaks — here the first question an MCP server asks after
// the upgrade would fail its insert (`kind` refused), and the server would be
// answered with an error instead of a person.
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

async function query<T>(text: ReturnType<typeof sql>): Promise<T[]> {
  const { db, close } = createClient(harness().url, { max: 1 });
  try {
    return (await db.execute(text)) as unknown as T[];
  } finally {
    await close();
  }
}

describe('migration 0145_mcp_elicitation @cap:approuver-une-action/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    expect(pg.url).toMatch(/^postgresql:\/\//);
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it("accepts kind 'elicitation' next to the two kinds that were there, and nothing else", async () => {
    const [row] = await query<{ def: string }>(
      sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'approval_requests_kind_check'`,
    );
    expect(row!.def).toContain("'approval'");
    expect(row!.def).toContain("'question'");
    expect(row!.def).toContain("'elicitation'");
  });

  it('adds approval_requests.response, a nullable jsonb', async () => {
    const rows = await query<{ data_type: string; is_nullable: string }>(
      sql`SELECT data_type, is_nullable FROM information_schema.columns
          WHERE table_name = 'approval_requests' AND column_name = 'response'`,
    );
    expect(rows).toEqual([{ data_type: 'jsonb', is_nullable: 'YES' }]);
  });

  it('creates approval_request_attachments: images only, one per position, gone with their request', async () => {
    const columns = await query<{ column_name: string; data_type: string; is_nullable: string }>(
      sql`SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_name = 'approval_request_attachments' ORDER BY column_name`,
    );
    expect(columns).toEqual([
      { column_name: 'approval_request_id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'byte_size', data_type: 'integer', is_nullable: 'NO' },
      { column_name: 'caption', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'data', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'id', data_type: 'uuid', is_nullable: 'NO' },
      { column_name: 'mime_type', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'position', data_type: 'integer', is_nullable: 'NO' },
    ]);
    const constraints = await query<{ conname: string; def: string }>(
      sql`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'approval_request_attachments'::regclass ORDER BY conname`,
    );
    const byName = Object.fromEntries(constraints.map((c) => [c.conname, c.def]));
    expect(byName['approval_request_attachments_mime_check']).toMatch(
      /image\/png.*image\/jpeg.*image\/webp.*image\/gif/,
    );
    expect(byName['approval_request_attachments_position_unique']).toBe(
      'UNIQUE (approval_request_id, "position")',
    );
    const fk = constraints.find((c) => c.def.startsWith('FOREIGN KEY'));
    expect(fk?.def).toContain('REFERENCES approval_requests(id) ON DELETE CASCADE');
  });

  it('records the migration in the journal drizzle-kit actually reads', async () => {
    const journal = (await import('../../migrations/meta/_journal.json', {
      with: { type: 'json' },
    })) as { default: { entries: Array<{ idx: number; tag: string; when: number }> } };
    const entries = journal.default.entries;
    const mine = entries.find((e) => e.tag === '0145_mcp_elicitation');
    expect(mine).toBeDefined();
    // Strictly after every migration numbered before it: drizzle applies by `when`.
    for (const e of entries.filter((x) => x.idx < mine!.idx)) {
      expect(e.when).toBeLessThan(mine!.when);
    }
  });
});
