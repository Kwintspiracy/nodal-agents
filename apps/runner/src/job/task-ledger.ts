// job/task-ledger.ts — delegated-task action ledger for conversational history.
//
// Incident (2026-07-12): a dashboard chat turn ("research Law & Order and send
// the result to Mathilde") escalated into a ROOT job that delegated via
// `create_task` (packages/orchestration/src/planner/task-tools.ts). The task
// ran in its OWN child `agent_jobs` row (channel='task-board') and really did
// call `telegram_send_message` — but the root job's compiled result
// (deliverCompletedRoots' `compileTaskResults`) is just the child agent's own
// PROSE, not a structural record of its tool calls. When the user asked "did
// you send it?", neither history-loading path (loadThreadHistory for
// telegram/slack/discord threads, runChatTurn's own history for dashboard
// conversations) had any way to see the delegated job's real actions — only
// the ROOT job's status/result was replayed, and a prose summary that doesn't
// happen to mention "sent via Telegram" reads as silence. The agent denied
// sending it — sincerely, because nothing in its context said otherwise.
//
// This is the delegation-boundary extension of thread-history.ts's Layer 1
// (STATE_CHANGING_TOOLS ledger): that ledger covers a job's OWN tools_used;
// this one covers the tools_used of jobs it DELEGATED to via create_task,
// keyed by `agent_tasks.root_job_id` — the exact link create_task stamps
// (task-tools.ts: `rootJobId: ctx.jobId`) and execute-ready.ts resolves to a
// child `agent_jobs` row (`agent_tasks.job_id`).
//
// Scope: only TERMINAL tasks (done/blocked) — a still-running task hasn't
// finished acting yet, so surfacing it as a ledger fact would be premature.
// `cancelled` tasks are also excluded: nothing happened to report.

import { eq, and, inArray, desc } from '@nodal-agents/db';
import { agentTasks, agentJobs } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';

/** Max ledger entries surfaced per root job — keeps a busy fan-out bounded. */
export const MAX_TASKS_PER_EXCHANGE = 3;

/** Task result/error text is truncated to this many chars in the ledger line. */
const RESULT_TRUNCATE_CHARS = 200;

const TERMINAL_TASK_STATUSES = ['done', 'blocked'] as const;

export interface TaskLedgerEntry {
  title: string;
  status: 'done' | 'blocked';
  toolsUsed: string[];
  result: string | null;
}

/**
 * Load the delegated-task ledger for a set of root jobs (jobs that may have
 * called `create_task`). Returns a `Map<rootJobId, entries>` — entries are
 * the up-to-`MAX_TASKS_PER_EXCHANGE` most recently finished terminal tasks,
 * in chronological order (oldest of that kept window first, matching
 * thread-history.ts's "read the thread the way the user lived it" convention).
 *
 * A rootJobId with no delegated tasks (or none yet terminal) is simply absent
 * from the map — callers should treat `.get(id) ?? []` as "nothing to add".
 */
export async function loadTaskLedger(
  db: RunnerDeps['db'],
  rootJobIds: readonly (string | null)[],
): Promise<Map<string, TaskLedgerEntry[]>> {
  const ledger = new Map<string, TaskLedgerEntry[]>();
  const ids = [...new Set(rootJobIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return ledger;

  const rows = await db
    .select({
      rootJobId: agentTasks.rootJobId,
      title: agentTasks.title,
      status: agentTasks.status,
      result: agentTasks.result,
      toolsUsed: agentJobs.toolsUsed,
    })
    .from(agentTasks)
    .leftJoin(agentJobs, eq(agentJobs.id, agentTasks.jobId))
    .where(
      and(
        inArray(agentTasks.rootJobId, ids),
        inArray(agentTasks.status, TERMINAL_TASK_STATUSES as unknown as string[]),
      ),
    )
    .orderBy(desc(agentTasks.updatedAt));

  for (const row of rows) {
    if (!row.rootJobId) continue;
    const list = ledger.get(row.rootJobId) ?? [];
    if (list.length >= MAX_TASKS_PER_EXCHANGE) continue; // newest-first from ORDER BY — bounded here
    list.push({
      title: row.title,
      status: row.status as 'done' | 'blocked',
      toolsUsed: Array.isArray(row.toolsUsed) ? (row.toolsUsed as string[]) : [],
      result: row.result,
    });
    ledger.set(row.rootJobId, list);
  }

  for (const [key, list] of ledger) {
    ledger.set(key, list.reverse()); // newest-first -> chronological within the kept window
  }

  return ledger;
}

/** Collapse repeated tool names to `name ×N` — "web_search, telegram_send_message ×2". */
function formatTools(tools: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
}

function truncateResult(s: string | null): string {
  const text = (s ?? '').trim();
  if (!text) return '(no result)';
  return text.length > RESULT_TRUNCATE_CHARS ? `${text.slice(0, RESULT_TRUNCATE_CHARS)}…` : text;
}

/**
 * Render one ledger entry as the structural `[Task "…" …]` line injected into
 * conversational history — the real tool calls a delegated task made, pulled
 * from its OWN child job's `tools_used`, never from the creating job's prose.
 */
export function formatTaskLedgerEntry(entry: TaskLedgerEntry): string {
  const toolsStr = formatTools(entry.toolsUsed);
  const actionsPart = toolsStr ? `actions — ${toolsStr}; ` : '';
  return entry.status === 'blocked'
    ? `[Task "${entry.title}" failed: ${actionsPart}error: ${truncateResult(entry.result)}]`
    : `[Task "${entry.title}" completed: ${actionsPart}result: ${truncateResult(entry.result)}]`;
}

/** Format every entry for one root job into ready-to-append ledger lines. */
export function formatTaskLedgerLines(entries: readonly TaskLedgerEntry[]): string[] {
  return entries.map(formatTaskLedgerEntry);
}
