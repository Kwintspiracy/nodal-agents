// tool-call-outcome-migration.pg.test.ts — migration 0170 against a REAL Postgres.
//
// @cap:verifier-un-livrable/moteur
//
// What `pnpm test` cannot prove (its database is built from the inline SQL of
// helpers.ts, never from `migrations/`): the columns exist AFTER the real
// migrations, the closed set is enforced by the database, and the backfill of
// existing rows types them once, by the rule the seam applies from now on: what
// it wrote explicitly, each declaration of 0170 for the shape it reads, and
// `done` for what returned and declares nothing.
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
import { createClient, sql, toolCalls } from '@nodal-agents/db';
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

  it('existing rows are typed once, by the rule the seam now applies, and never guessed again', async () => {
    const { db, close } = createClient(harness().url, { max: 1 });
    try {
      const tag = `m0170-${Date.now()}`;
      const rows: Array<{
        case: string;
        toolName: string;
        toolOutput: string | null;
        executionStarted?: boolean;
        expected: string | null;
      }> = [
        // What the seam wrote explicitly.
        {
          case: 'failed',
          toolName: 'gmail_send_email',
          toolOutput: '{"outcome":"error","error":"403","raisedByTool":true}',
          expected: 'failed',
        },
        {
          case: 'unknown',
          toolName: 'telegram_send_message',
          toolOutput: '{"outcome":"error","error":"timed out","mayHaveDelivered":true}',
          expected: 'unknown',
        },
        {
          case: 'refused',
          toolName: 'run_command',
          toolOutput: '{"outcome":"error","error":"blocked: an approval rule forbids"}',
          expected: 'refused',
        },
        {
          case: 'rejected',
          toolName: 'run_command',
          toolOutput: '{"outcome":"error","error":"approval_already_rejected: the owner already"}',
          expected: 'refused',
        },
        {
          case: 'held',
          toolName: 'run_command',
          toolOutput: '{"outcome":"awaiting_approval","approvalRequestId":"r"}',
          expected: 'awaiting_approval',
        },
        {
          case: 'delegated',
          toolName: 'assign_x',
          toolOutput: '{"outcome":"delegation_requested","to":"x"}',
          expected: 'done',
        },
        {
          case: 'mark',
          toolName: 'file_write',
          toolOutput: null,
          executionStarted: true,
          expected: 'unknown',
        },
        {
          case: 'never-ran',
          toolName: 'file_write',
          toolOutput: null,
          executionStarted: false,
          expected: null,
        },
        // The declarations 0170 introduces, for the shapes they read.
        {
          case: 'cli-refused',
          toolName: 'cli:Write',
          toolOutput: '<tool_use_error>No such tool</tool_use_error>',
          expected: 'failed',
        },
        {
          case: 'ok-false',
          toolName: 'file_edit',
          toolOutput: '{"ok":false,"reason":"old_string not found"}',
          expected: 'failed',
        },
        {
          case: 'timed-out',
          toolName: 'run_command',
          toolOutput: '{"sandbox":{},"exitCode":null,"stdout":"","timedOut":true}',
          expected: 'failed',
        },
        {
          case: 'exit-1',
          toolName: 'run_command',
          toolOutput: '{"sandbox":{},"exitCode":1,"stdout":"","timedOut":false}',
          expected: 'done',
        },
        {
          case: 'code-error',
          toolName: 'code_task',
          toolOutput: '{"provider":"claude","isError":true}',
          expected: 'failed',
        },
        {
          case: 'declared-not',
          toolName: 'declare_verification',
          toolOutput: '{"declared":false,"reason":"no write"}',
          expected: 'failed',
        },
        {
          case: 'still-running',
          toolName: 'poyo_generate_image',
          toolOutput: '{"taskId":"t","status":"running","images":[]}',
          expected: 'unknown',
        },
        {
          case: 'apify-running',
          toolName: 'apify_run_actor',
          toolOutput: '{"runId":"r","status":"RUNNING"}',
          expected: 'unknown',
        },
        {
          case: 'apify-failed',
          toolName: 'apify_run_actor',
          toolOutput: '{"runId":"r","status":"FAILED"}',
          expected: 'failed',
        },
        {
          case: 'apify-done',
          toolName: 'apify_run_actor',
          toolOutput: '{"runId":"r","status":"SUCCEEDED"}',
          expected: 'done',
        },
        // What returned and declares nothing: done, as the seam writes it now.
        {
          case: 'returned',
          toolName: 'file_write',
          toolOutput: '{"ok":true,"path":"a.txt"}',
          expected: 'done',
        },
        { case: 'text', toolName: 'web_fetch', toolOutput: 'plain text result', expected: 'done' },
      ];
      for (const r of rows) {
        await db.insert(toolCalls).values({
          toolName: r.toolName,
          toolInput: { tag, case: r.case },
          toolOutput: r.toolOutput,
          executionStarted: r.executionStarted ?? true,
        });
      }
      const read = async () =>
        new Map(
          (
            (await db.execute(
              sql`SELECT tool_input->>'case' AS c, outcome, target FROM tool_calls
                  WHERE tool_input->>'tag' = ${tag}`,
            )) as unknown as Array<{ c: string; outcome: string | null; target: string | null }>
          ).map((r) => [r.c, r]),
        );

      await db.execute(sql.raw(readFileSync(MIGRATION, 'utf-8')));
      const after = await read();
      for (const r of rows) {
        expect(after.get(r.case)?.outcome, r.case).toBe(r.expected);
        // What an old call acted on was never recorded: not reconstructed.
        expect(after.get(r.case)?.target, r.case).toBeNull();
      }

      // Run again: nothing moves.
      await db.execute(sql.raw(readFileSync(MIGRATION, 'utf-8')));
      expect(await read()).toEqual(after);
    } finally {
      await close();
    }
  });
});
