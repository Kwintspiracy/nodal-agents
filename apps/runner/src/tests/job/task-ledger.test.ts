// task-ledger.test.ts — delegated-task visibility (2026-07-12 incident).
//
// loadTaskLedger surfaces the REAL tool calls a task-board child job made,
// keyed by the creating job's id (agent_tasks.root_job_id) — the only signal
// that a delegated action (e.g. telegram_send_message) actually happened,
// since the creating job's own compiled result is just the child's prose.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, agentTasks } from '@nodal-agents/db';
import {
  loadTaskLedger,
  formatTaskLedgerEntry,
  formatTaskLedgerLines,
  MAX_TASKS_PER_EXCHANGE,
} from '../../job/task-ledger.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  await db.delete(agentTasks);
  await db.delete(agentJobs);
});

/** Insert a task-board child job (the one that actually ran the delegated work). */
async function insertChildJob(opts: { toolsUsed?: string[] }): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'task-board',
      task: 'do the delegated work',
      status: 'completed',
      ...(opts.toolsUsed !== undefined ? { toolsUsed: opts.toolsUsed } : {}),
    })
    .returning({ id: agentJobs.id });
  if (!row) throw new Error('insert returned no row');
  return row.id;
}

/** Insert an agent_tasks row linked to a root job and (optionally) its own child job. */
async function insertTask(opts: {
  rootJobId: string;
  title: string;
  status: 'todo' | 'in_progress' | 'done' | 'cancelled' | 'blocked';
  result?: string | null;
  jobId?: string | null;
  updatedAt?: Date;
}): Promise<string> {
  const [row] = await db
    .insert(agentTasks)
    .values({
      entityId: seed.entityId,
      orchestratorId: seed.agentId,
      title: opts.title,
      status: opts.status,
      result: opts.result ?? null,
      rootJobId: opts.rootJobId,
      jobId: opts.jobId ?? null,
      ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
    })
    .returning({ id: agentTasks.id });
  if (!row) throw new Error('insert returned no row');
  return row.id;
}

describe('loadTaskLedger', () => {
  it('returns an empty map for an empty/null id list', async () => {
    expect(await loadTaskLedger(db, [])).toEqual(new Map());
    expect(await loadTaskLedger(db, [null, null])).toEqual(new Map());
  });

  it('returns nothing for a root job with no delegated tasks', async () => {
    const ledger = await loadTaskLedger(db, ['00000000-0000-0000-0000-000000000001']);
    expect(ledger.size).toBe(0);
  });

  it('surfaces the CHILD job tools_used, not the parent prose', async () => {
    const childJobId = await insertChildJob({
      toolsUsed: ['web_search', 'telegram_send_message'],
    });
    const rootJobId = crypto.randomUUID();
    await insertTask({
      rootJobId,
      title: 'Research Law & Order and send to Mathilde',
      status: 'done',
      result: 'Sent a summary to Mathilde via Telegram.',
      jobId: childJobId,
    });

    const ledger = await loadTaskLedger(db, [rootJobId]);
    const entries = ledger.get(rootJobId) ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      title: 'Research Law & Order and send to Mathilde',
      status: 'done',
      toolsUsed: ['web_search', 'telegram_send_message'],
      result: 'Sent a summary to Mathilde via Telegram.',
    });

    const line = formatTaskLedgerEntry(entries[0]!);
    expect(line).toBe(
      '[Task "Research Law & Order and send to Mathilde" completed: actions — web_search, ' +
        'telegram_send_message; result: Sent a summary to Mathilde via Telegram.]',
    );
  });

  it('collapses repeated tool calls to a ×N count', async () => {
    const childJobId = await insertChildJob({
      toolsUsed: ['telegram_send_message', 'telegram_send_message', 'web_search'],
    });
    const rootJobId = crypto.randomUUID();
    await insertTask({
      rootJobId,
      title: 'notify twice',
      status: 'done',
      result: 'done',
      jobId: childJobId,
    });

    const ledger = await loadTaskLedger(db, [rootJobId]);
    const line = formatTaskLedgerEntry(ledger.get(rootJobId)![0]!);
    expect(line).toContain('telegram_send_message ×2');
    expect(line).toContain('web_search');
  });

  it('does NOT surface a still-running (todo/in_progress) task', async () => {
    const rootJobId = crypto.randomUUID();
    await insertTask({ rootJobId, title: 'still going', status: 'in_progress', result: null });
    await insertTask({ rootJobId, title: 'not started', status: 'todo', result: null });

    const ledger = await loadTaskLedger(db, [rootJobId]);
    expect(ledger.size).toBe(0);
  });

  it('does NOT surface a voluntarily cancelled task', async () => {
    const rootJobId = crypto.randomUUID();
    await insertTask({
      rootJobId,
      title: 'aborted',
      status: 'cancelled',
      result: 'root cancelled',
    });

    const ledger = await loadTaskLedger(db, [rootJobId]);
    expect(ledger.size).toBe(0);
  });

  it('renders a blocked task as a failure line with the error text', async () => {
    const childJobId = await insertChildJob({ toolsUsed: ['web_search'] });
    const rootJobId = crypto.randomUUID();
    await insertTask({
      rootJobId,
      title: 'failed lookup',
      status: 'blocked',
      result: 'API quota exceeded',
      jobId: childJobId,
    });

    const ledger = await loadTaskLedger(db, [rootJobId]);
    const line = formatTaskLedgerEntry(ledger.get(rootJobId)![0]!);
    expect(line).toBe(
      '[Task "failed lookup" failed: actions — web_search; error: API quota exceeded]',
    );
  });

  it('truncates a long result to ~200 chars', async () => {
    const childJobId = await insertChildJob({ toolsUsed: ['web_search'] });
    const rootJobId = crypto.randomUUID();
    const huge = 'x'.repeat(500);
    await insertTask({
      rootJobId,
      title: 'long result',
      status: 'done',
      result: huge,
      jobId: childJobId,
    });

    const ledger = await loadTaskLedger(db, [rootJobId]);
    const line = formatTaskLedgerEntry(ledger.get(rootJobId)![0]!);
    // 200 chars of 'x' plus the ellipsis marker, well short of the full 500.
    expect(line.length).toBeLessThan(300);
    expect(line).toContain('…');
  });

  it('bounds to MAX_TASKS_PER_EXCHANGE most recent, in chronological order', async () => {
    const rootJobId = crypto.randomUUID();
    const now = Date.now();
    // 5 done tasks, oldest to newest by updatedAt.
    for (let i = 0; i < 5; i++) {
      await insertTask({
        rootJobId,
        title: `task-${i}`,
        status: 'done',
        result: `result-${i}`,
        updatedAt: new Date(now - (5 - i) * 60_000), // task-0 oldest ... task-4 newest
      });
    }

    const ledger = await loadTaskLedger(db, [rootJobId]);
    const entries = ledger.get(rootJobId) ?? [];
    expect(entries).toHaveLength(MAX_TASKS_PER_EXCHANGE);
    // Kept the 3 MOST RECENT (task-2, task-3, task-4), oldest-of-the-kept-window first.
    expect(entries.map((e) => e.title)).toEqual(['task-2', 'task-3', 'task-4']);
  });

  it('separates ledgers by root job id — no cross-exchange leakage', async () => {
    const rootA = crypto.randomUUID();
    const rootB = crypto.randomUUID();
    await insertTask({ rootJobId: rootA, title: 'in A', status: 'done', result: 'a' });
    await insertTask({ rootJobId: rootB, title: 'in B', status: 'done', result: 'b' });

    const ledger = await loadTaskLedger(db, [rootA, rootB]);
    expect(ledger.get(rootA)?.map((e) => e.title)).toEqual(['in A']);
    expect(ledger.get(rootB)?.map((e) => e.title)).toEqual(['in B']);
  });

  it('formatTaskLedgerLines maps a full entry list to formatted lines', () => {
    const lines = formatTaskLedgerLines([
      { title: 'a', status: 'done', toolsUsed: ['web_search'], result: 'ok' },
      { title: 'b', status: 'blocked', toolsUsed: [], result: null },
    ]);
    expect(lines).toEqual([
      '[Task "a" completed: actions — web_search; result: ok]',
      '[Task "b" failed: error: (no result)]',
    ]);
  });
});
