// builtin/code-task/db.ts — budget, audit record, and workspace write-lock.
//
// All SQL goes through the @nodal-agents/db barrel (the dep-cruiser rule
// forbids importing pg/drizzle-orm node_modules outside packages/db; the
// barrel is the sanctioned seam — same as search-history.ts).

import {
  agents,
  cliRuns,
  workspaceLocks,
  approvalRules,
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

export interface CliAgentConfig {
  /**
   * Per-provider model/effort defaults (étape B-bis) + owner allow-flag
   * (demande Quentin 20/08). Null = CLI defaults, everything allowed.
   * `enabled` absent/true = allowed; false = provider refused loud.
   */
  defaults: {
    claude?: { model?: string; effort?: string; enabled?: boolean };
    codex?: { model?: string; effort?: string; enabled?: boolean };
  } | null;
}

export class CliProviderDisabledError extends Error {
  constructor(provider: string, enabledProviders: string[]) {
    super(
      `provider_disabled: the "${provider}" coding CLI is disabled for this agent by its owner. ` +
        (enabledProviders.length > 0
          ? `Use provider ${enabledProviders.map((p) => `"${p}"`).join(' or ')} instead.`
          : `No coding CLI provider is currently enabled for this agent.`),
    );
    this.name = 'CliProviderDisabledError';
  }
}

/**
 * Owner allow-list gate (invariant #9 at the provider level): refuse a
 * code_task call for a provider the owner switched off. Absent config or
 * absent `enabled` = allowed (back-compat with pre-feature rows). Pure —
 * exported for unit tests.
 */
export function assertCliProviderEnabled(
  defaults: CliAgentConfig['defaults'],
  provider: 'claude' | 'codex',
): void {
  if (defaults?.[provider]?.enabled === false) {
    const enabled = (['claude', 'codex'] as const).filter((p) => defaults?.[p]?.enabled !== false);
    throw new CliProviderDisabledError(provider, enabled);
  }
}

/**
 * Enforce the per-agent daily cap on notional CLI cost BEFORE spawning, and
 * return the agent's CLI config (one roundtrip serves both needs).
 * Budget 0 = uncapped. Fails loud — never silently skips the run.
 */
export async function assertCliBudget(db: AnyDrizzleDb, agentId: string): Promise<CliAgentConfig> {
  const [agentRow] = await db
    .select({ budget: agents.cliDailyBudgetUsd, defaults: agents.cliDefaults })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  const config: CliAgentConfig = { defaults: agentRow?.defaults ?? null };
  const budget = agentRow?.budget ?? 0;
  if (budget <= 0) return config; // 0 = no cap (same convention as daily_token_limit)

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
  return config;
}

export class ReadOnlyAgentError extends Error {
  constructor() {
    super(
      `read_only_agent_write_mode: this agent is read-only (the owner blocked its write tools ` +
        `via approval rules), so code_task mode "write" is refused too. This is intentional — ` +
        `do NOT retry or work around it. Use mode "read", or report findings instead of fixing.`,
    );
    this.name = 'ReadOnlyAgentError';
  }
}

/**
 * Data-driven read-only detection (étape C): an agent whose owner blocked
 * `file_write` via an approval rule is a read-only agent (that is exactly
 * what the "Read-only (reviewer)" preset writes). code_task mode "write"
 * must honor the same posture — the CLI would otherwise be a write hole.
 */
export async function assertNotReadOnlyAgent(db: AnyDrizzleDb, agentId: string): Promise<void> {
  const [row] = await db
    .select({ id: approvalRules.id })
    .from(approvalRules)
    .where(
      and(
        eq(approvalRules.agentId, agentId),
        eq(approvalRules.toolName, 'file_write'),
        eq(approvalRules.action, 'block'),
      ),
    )
    .limit(1);
  if (row) throw new ReadOnlyAgentError();
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
