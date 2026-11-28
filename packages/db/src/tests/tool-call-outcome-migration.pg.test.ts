// tool-call-outcome-migration.pg.test.ts — migration 0170 against a REAL Postgres.
//
// @cap:verifier-un-livrable/moteur
//
// What `pnpm test` cannot prove (its database is built from the inline SQL of
// helpers.ts, never from `migrations/`): the columns exist AFTER the real
// migrations, the closed set is enforced by the database, and the backfill of
// existing rows types only what the seam had written explicitly, leaving every
// other row NULL ("not recorded"), never `done`.
//
// The backfill is proved on rows that exist BEFORE it runs: they are written
// with no outcome, then the migration's own file is run again (it is written
// to be re-runnable: `IF NOT EXISTS`, a guarded constraint, `WHERE outcome IS
// NULL`).
//
// Mutations checked: the 0170 entry removed from `meta/_journal.json` → the
// column test fails; the `'{"outcome":"error"%'` branch removed → the backfill
// test fails on the failed row.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startRealPostgres, type RealPostgres } from '@nodal-agents/test-kit';
import { createClient, sql, like, toolCalls } from '@nodal-agents/db';
import { runMigrations } from '@nodal-agents/db/migrate';

let pg: RealPostgres | null = null;

afterAll(async () => {
  await pg?.stop();
});

function harness(): RealPostgres {
  if (!pg) expect.fail('REAL_POSTGRES_NOT_STARTED — the startup test failed before this one');
  return pg;
}

const MIGRATION = fileURLToPath(
  new URL('../../migrations/0170_tool_call_outcome.sql', import.meta.url),
);

describe('migration 0170_tool_call_outcome @cap:verifier-un-livrable/moteur', () => {
  it('starts a real Postgres and applies the REAL migrations', async () => {
    pg = await startRealPostgres();
    await runMigrations(pg.url, { patchVectorAsText: true });
  }, 120_000);

  it('outcome and target exist, as nullable text, and the database refuses a value outside the set', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const cols = (await db.execute(
        sql`SELECT column_name, data_type, is_nullable FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'tool_calls'
              AND column_name IN ('outcome', 'target') ORDER BY column_name`,
      )) as unknown as Array<{ column_name: string; data_type: string; is_nullable: string }>;
      expect(cols).toEqual([
        { column_name: 'outcome', data_type: 'text', is_nullable: 'YES' },
        { column_name: 'target', data_type: 'text', is_nullable: 'YES' },
      ]);
      const refused = await db
        .insert(toolCalls)
        .values({ toolName: 'x', outcome: 'success' })
        .then(
          () => null,
          (e: unknown) => (e as { cause?: { constraint_name?: string } }).cause?.constraint_name,
        );
      expect(refused).toBe('tool_calls_outcome_check');
    } finally {
      await close();
    }
  });

  it('existing rows: the explicit shapes are typed once, every other row stays not recorded', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const tag = `m0170-${Date.now()}-`;
      const rows: Array<{
        name: string;
        toolOutput: string | null;
        executionStarted?: boolean;
        expected: string | null;
      }> = [
        {
          name: 'failed',
          toolOutput: '{"outcome":"error","error":"ECONNRESET","raisedByTool":true}',
          expected: 'failed',
        },
        {
          name: 'unknown',
          toolOutput: '{"outcome":"error","error":"timed out — AMBIGUOUS","mayHaveDelivered":true}',
          expected: 'unknown',
        },
        {
          name: 'refused',
          toolOutput: '{"outcome":"error","error":"blocked: an approval rule forbids"}',
          expected: 'refused',
        },
        {
          name: 'rejected',
          toolOutput: '{"outcome":"error","error":"approval_already_rejected: the owner already"}',
          expected: 'refused',
        },
        {
          name: 'held',
          toolOutput: '{"outcome":"awaiting_approval","approvalRequestId":"r"}',
          expected: 'awaiting_approval',
        },
        {
          name: 'delegated',
          toolOutput: '{"outcome":"delegation_requested","to":"x"}',
          expected: 'done',
        },
        { name: 'mark', toolOutput: null, executionStarted: true, expected: 'unknown' },
        {
          name: 'cli-refused',
          toolOutput: '<tool_use_error>No such tool</tool_use_error>',
          expected: 'failed',
        },
        {
          name: 'ok-false',
          toolOutput: '{"ok":false,"reason":"outside the workspace"}',
          expected: 'failed',
        },
        // A returned output is NOT read as done: that is the reading 0170 removes.
        { name: 'returned', toolOutput: '{"ok":true,"path":"a.txt"}', expected: null },
        {
          name: 'timed-out-command',
          toolOutput: '{"exitCode":null,"timedOut":true}',
          expected: null,
        },
        { name: 'text', toolOutput: 'plain text result', expected: null },
        { name: 'never-ran', toolOutput: null, executionStarted: false, expected: null },
      ];
      for (const r of rows) {
        await db.insert(toolCalls).values({
          toolName: tag + r.name,
          toolOutput: r.toolOutput,
          executionStarted: r.executionStarted ?? true,
        });
      }

      await db.execute(sql.raw(readFileSync(MIGRATION, 'utf-8')));

      const after = await db
        .select({
          toolName: toolCalls.toolName,
          outcome: toolCalls.outcome,
          target: toolCalls.target,
        })
        .from(toolCalls)
        .where(like(toolCalls.toolName, `${tag}%`));
      const byName = new Map(after.map((a) => [a.toolName.slice(tag.length), a]));
      for (const r of rows) {
        expect(byName.get(r.name)?.outcome, r.name).toBe(r.expected);
        // What an old call acted on was never recorded: not reconstructed.
        expect(byName.get(r.name)?.target, r.name).toBeNull();
      }

      // Run again: nothing moves.
      await db.execute(sql.raw(readFileSync(MIGRATION, 'utf-8')));
      const again = await db
        .select({ toolName: toolCalls.toolName, outcome: toolCalls.outcome })
        .from(toolCalls)
        .where(like(toolCalls.toolName, `${tag}%`));
      expect(new Map(again.map((a) => [a.toolName, a.outcome]))).toEqual(
        new Map(after.map((a) => [a.toolName, a.outcome])),
      );
    } finally {
      await close();
    }
  });
});
