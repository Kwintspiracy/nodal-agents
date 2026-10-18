// approval-requests-seq.pg.test.ts — migration 0150 against a REAL Postgres (#801).
//
// WHY A SEPARATE FILE. `pnpm test` builds its database from the inline SQL in
// `helpers.ts`, never from `migrations/`; a migration missing from
// `meta/_journal.json` is skipped in silence. Only a real upgrade shows that
// `approval_requests.seq` exists, numbers the rows already written, and keeps
// counting above them.
//
// The startup is a TEST, not a beforeAll (a throwing beforeAll marks the tests
// "skipped", and a skipped test is a false green — invariant #4).

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import { runMigrations } from '@nodal-agents/db/migrate';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

describe('migration 0150_approval_requests_seq @cap:approuver-une-action/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations — red if the binary is missing, not skipped', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('adds seq as a NOT NULL bigint fed by the sequence a bigserial would own', async () => {
    const sql = postgres(harness().url, { max: 1 });
    try {
      const [col] = await sql`
        SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'approval_requests' AND column_name = 'seq'`;
      expect(col).toEqual({
        data_type: 'bigint',
        is_nullable: 'NO',
        column_default: "nextval('approval_requests_seq_seq'::regclass)",
      });
    } finally {
      await sql.end();
    }
  });

  it('numbers rows already written by (requested_at, id) and keeps counting above them', async () => {
    const sql = postgres(harness().url, { max: 1 });
    try {
      const [user] = await sql`INSERT INTO users (email) VALUES ('seq@example.com') RETURNING id`;
      const [entity] = await sql`
        INSERT INTO entities (user_id, name, slug) VALUES (${user!.id}, 'e', 'seq-e') RETURNING id`;
      const [agent] = await sql`
        INSERT INTO agents (entity_id, name, slug, personality)
        VALUES (${entity!.id}, 'a', 'a', 'p') RETURNING id`;
      const [job] = await sql`
        INSERT INTO agent_jobs (entity_id, agent_id, channel, task, status)
        VALUES (${entity!.id}, ${agent!.id}, 'telegram', 't', 'processing') RETURNING id`;
      const at = ['2026-10-18T10:00:03Z', '2026-10-18T10:00:01Z', '2026-10-18T10:00:02Z'];
      const ids: string[] = [];
      for (const t of at) {
        const [row] = await sql`
          INSERT INTO approval_requests (entity_id, job_id, agent_id, tool_name, tool_input, requested_at)
          VALUES (${entity!.id}, ${job!.id}, ${agent!.id}, 'run_command', '{}'::jsonb, ${t})
          RETURNING id`;
        ids.push(row!.id as string);
      }
      // L'état d'avant la migration : pas de numéro, pas de contrainte.
      await sql`ALTER TABLE approval_requests ALTER COLUMN seq DROP NOT NULL`;
      await sql`UPDATE approval_requests SET seq = NULL`;
      await sql.unsafe(
        readFileSync(
          join(__dirname, '..', '..', 'migrations', '0150_approval_requests_seq.sql'),
          'utf8',
        ),
      );

      const rows = await sql`
        SELECT id, seq::int AS seq FROM approval_requests WHERE job_id = ${job!.id} ORDER BY seq`;
      // Numérotées dans l'ordre de l'heure, pas dans celui de l'insertion.
      expect(rows.map((r) => r.id)).toEqual([ids[1], ids[2], ids[0]]);
      expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
      // Une ligne écrite ensuite reçoit un numéro supérieur à tout le remplissage.
      const [later] = await sql`
        INSERT INTO approval_requests (entity_id, job_id, agent_id, tool_name, tool_input)
        VALUES (${entity!.id}, ${job!.id}, ${agent!.id}, 'run_command', '{}'::jsonb)
        RETURNING seq::int AS seq`;
      expect(later!.seq).toBe(4);
    } finally {
      await sql.end();
    }
  });
});
