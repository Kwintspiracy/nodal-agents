// builtin/code-task/db.ts — budget, audit record, and workspace write-lock.
//
// All SQL goes through the @nodal-agents/db barrel (the dep-cruiser rule
// forbids importing pg/drizzle-orm node_modules outside packages/db; the
// barrel is the sanctioned seam — same as search-history.ts).

import {
  agents,
  cliRuns,
  workspaceLocks,
  eq,
  and,
  sql,
  type AnyDrizzleDb,
  type CliRunInsert,
} from '@nodal-agents/db';

/** A write lock older than this is considered abandoned and can be stolen. */
const LOCK_STALE_MINUTES = 30;

// ─── Daily budget ────────────────────────────────────────────────────────────

export class CliBudgetExceededError extends Error {
  constructor(spentUsd: number, budgetUsd: number) {
    super(
      `cli_daily_budget_exceeded: this agent has already spent $${spentUsd.toFixed(2)} ` +
        `(notional) on coding-CLI runs today, at or over its $${budgetUsd.toFixed(2)}/day cap. ` +
        `No CLI run was started. The owner can raise the cap in the agent's Autonomy settings.`,
    );
    this.name = 'CliBudgetExceededError';
  }
}

/**
 * Enforce the per-agent daily cap on notional CLI cost BEFORE spawning.
 * Budget 0 = uncapped. Fails loud — never silently skips the run.
 */
export async function assertCliBudget(db: AnyDrizzleDb, agentId: string): Promise<void> {
  const [agentRow] = await db
    .select({ budget: agents.cliDailyBudgetUsd })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  const budget = agentRow?.budget ?? 0;
  if (budget <= 0) return; // 0 = no cap (same convention as daily_token_limit)

  const [row] = await db
    .select({
      spent: sql<number>`coalesce(sum(${cliRuns.costUsd}), 0)`,
    })
    .from(cliRuns)
    .where(
      and(eq(cliRuns.agentId, agentId), sql`${cliRuns.createdAt} >= date_trunc('day', now())`),
    );
  const spent = Number(row?.spent ?? 0);
  if (spent >= budget) {
    throw new CliBudgetExceededError(spent, budget);
  }
}

/** Record one CLI invocation (success or failure — the cost is real either way). */
export async function recordCliRun(db: AnyDrizzleDb, run: CliRunInsert): Promise<void> {
  await db.insert(cliRuns).values(run);
}

// ─── Workspace write-lock ────────────────────────────────────────────────────

export class WorkspaceLockedError extends Error {
  constructor(workspacePath: string, holderJobId: string) {
    super(
      `workspace_locked: another WRITE-mode CLI run (job ${holderJobId}) is currently ` +
        `working in "${workspacePath}". Wait for it to finish, then retry. ` +
        `Read-mode runs are not blocked.`,
    );
    this.name = 'WorkspaceLockedError';
  }
}

/**
 * Acquire the single write-slot for a workspace. Atomic INSERT … ON CONFLICT
 * DO NOTHING; on conflict, one conditional-UPDATE attempt to steal a stale
 * lock (holder older than 30 min — a crashed runner must not wedge the
 * workspace forever). Loses → throws WorkspaceLockedError (fail loud).
 */
export async function acquireWorkspaceLock(
  db: AnyDrizzleDb,
  workspacePath: string,
  jobId: string,
  agentId: string,
): Promise<void> {
  const inserted = await db
    .insert(workspaceLocks)
    .values({ workspacePath, jobId, agentId })
    .onConflictDoNothing()
    .returning({ workspacePath: workspaceLocks.workspacePath });
  if (inserted.length > 0) return;

  // Occupied — steal only if stale. The WHERE makes the takeover atomic:
  // two stealers race, one wins (rowCount 1), the other sees 0 rows.
  const stolen = await db
    .update(workspaceLocks)
    .set({ jobId, agentId, acquiredAt: sql`now()` })
    .where(
      and(
        eq(workspaceLocks.workspacePath, workspacePath),
        sql`${workspaceLocks.acquiredAt} < now() - interval '${sql.raw(String(LOCK_STALE_MINUTES))} minutes'`,
      ),
    )
    .returning({ workspacePath: workspaceLocks.workspacePath });
  if (stolen.length > 0) return;

  const [holder] = await db
    .select({ jobId: workspaceLocks.jobId })
    .from(workspaceLocks)
    .where(eq(workspaceLocks.workspacePath, workspacePath))
    .limit(1);
  throw new WorkspaceLockedError(workspacePath, holder?.jobId ?? 'unknown');
}

/** Release the lock — only if THIS job still holds it (a stealer may have won). */
export async function releaseWorkspaceLock(
  db: AnyDrizzleDb,
  workspacePath: string,
  jobId: string,
): Promise<void> {
  await db
    .delete(workspaceLocks)
    .where(and(eq(workspaceLocks.workspacePath, workspacePath), eq(workspaceLocks.jobId, jobId)));
}
