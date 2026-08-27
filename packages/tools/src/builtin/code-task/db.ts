// builtin/code-task/db.ts — budget, audit record, and workspace write-lock.
//
// All SQL goes through the @nodal-agents/db barrel (the dep-cruiser rule
// forbids importing pg/drizzle-orm node_modules outside packages/db; the
// barrel is the sanctioned seam — same as search-history.ts).

import {
  agents,
  cliRuns,
  cliSessions,
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
 * Les fournisseurs qui ne rapportent AUCUN coût.
 *
 * Codex n'en écrit pas dans `cli_runs` : ses tours n'ajoutent rien à la somme,
 * et le plafond en dollars ne peut donc rien borner chez lui. L'interface le dit
 * (`CLI_RUNTIME_REPORTS_COST`, apps/web/src/lib/cli-runtimes.ts) et cesse de
 * proposer le champ.
 */
const UNMETERED_PROVIDERS = new Set(['codex']);

/**
 * Enforce the per-agent daily cap on notional CLI cost BEFORE spawning, and
 * return the agent's CLI config (one roundtrip serves both needs).
 * Budget 0 = uncapped. Fails loud — never silently skips the run.
 *
 * `provider` : quand il ne rapporte aucun coût, la garde ne s'applique pas.
 *
 * Sans ce paramètre, l'écran et le runner se contredisaient (revue Codex,
 * 27/08) : la carte annonçait « aucun plafond en dollars ne borne ce harnais »
 * et masquait le champ, pendant que le runner sommait TOUTES les dépenses de
 * l'agent — Claude et `code_task` compris. Un agent basculé sur Codex après une
 * journée de travail sous Claude se retrouvait bloqué jusqu'au lendemain, pour
 * un plafond qu'on venait de lui dire inapplicable, et sans champ pour le
 * relever.
 *
 * Ça ne desserre rien : un tour Codex n'ajoute aucun dollar à la somme, donc le
 * sauter ne laisse passer aucune dépense. Ce qui borne un tour Codex, c'est le
 * délai par tour et le plafond d'appels d'outils.
 */
export async function assertCliBudget(
  db: AnyDrizzleDb,
  agentId: string,
  provider?: string,
): Promise<CliAgentConfig> {
  const [agentRow] = await db
    .select({ budget: agents.cliDailyBudgetUsd, defaults: agents.cliDefaults })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  const config: CliAgentConfig = { defaults: agentRow?.defaults ?? null };
  if (provider !== undefined && UNMETERED_PROVIDERS.has(provider)) return config;
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
 * LA clé d'un verrou de dossier.
 *
 * Le même dossier s'écrit de plusieurs façons — `C:/Common`, `c:\common`,
 * `C:\Common\` — et le verrou vit dans une colonne texte : trois orthographes,
 * trois verrous, aucun ne bloquant les autres. Deux sessions en écriture
 * pouvaient donc modifier les mêmes fichiers en même temps (revue Codex,
 * 27/08), ce que le contrat d'un seul créneau promet d'empêcher. Le risque est
 * apparu en ouvrant les dossiers SECONDAIRES à l'écriture : jusque-là chaque
 * session ne verrouillait que son propre `cwd`.
 *
 * Normalisé ICI plutôt que chez les appelants : `code_task` et le runtime
 * passent tous les deux par cette fonction, et normaliser d'un seul côté aurait
 * fait cesser les deux de se voir — pire que le défaut d'origine.
 *
 * Même règle d'identité que les projets (`projectKey`) : la casse n'est repliée
 * que sur les chemins Windows, où elle n'est pas significative. Sur un système
 * sensible à la casse, `/srv/App` et `/srv/app` sont deux dossiers.
 */
export function workspaceLockKey(workspacePath: string): string {
  const s = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const isWindows = /^[a-z]:\//i.test(s) || s.startsWith('//');
  return isWindows ? s.toLowerCase() : s;
}

/**
 * Acquire the single write-slot for a workspace. Atomic INSERT … ON CONFLICT
 * DO NOTHING; on conflict, one conditional-UPDATE attempt to steal a stale
 * lock (holder older than 30 min — a crashed runner must not wedge the
 * workspace forever). Loses → throws WorkspaceLockedError (fail loud).
 */
export async function acquireWorkspaceLock(
  db: AnyDrizzleDb,
  rawWorkspacePath: string,
  jobId: string,
  agentId: string,
): Promise<void> {
  const workspacePath = workspaceLockKey(rawWorkspacePath);
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
  rawWorkspacePath: string,
  jobId: string,
): Promise<void> {
  // La MÊME clé qu'à la prise, sinon le verrou ne se rend jamais et le dossier
  // reste bloqué jusqu'à expiration.
  const workspacePath = workspaceLockKey(rawWorkspacePath);
  await db
    .delete(workspaceLocks)
    .where(and(eq(workspaceLocks.workspacePath, workspacePath), eq(workspaceLocks.jobId, jobId)));
}

// ─── Session continuity (manque 1 du lot « poste de développement ») ─────────

/**
 * The `cli_sessions` key a `code_task` run uses to find its own thread.
 *
 * NAMESPACED on purpose. `cli_sessions` is keyed `(agentId, conversationKey)`
 * and the runtime path already owns that space: `run-job.ts` stores its session
 * under `conversationId ?? chatId`. Writing a code_task session under a bare
 * conversation id would collide on the unique index — one row, two different
 * CLI sessions, whichever wrote last winning.
 *
 * Scoped to the JOB, not the conversation: several `code_task` calls inside one
 * job are one thread of work; a new job starts cold. The `cwd` is part of the
 * key because resuming a session that explored a different directory is worse
 * than starting fresh — it would answer confidently about the wrong tree.
 */
export function codeTaskSessionKey(jobId: string, cwd: string): string {
  return `${CODE_TASK_KEY_PREFIX}${jobId}:${cwd}`;
}

/**
 * Prefixes `cli_sessions.conversation_key` reserves for keys built by a
 * namespacing helper. Anything else in that column is a raw conversation id.
 */
export const CODE_TASK_KEY_PREFIX = 'code_task:';

/**
 * The runtime path (run-job / run-chat) writes into the SAME table, keyed by
 * `conversationId ?? chatId`, and the unique index is only
 * (agent_id, conversation_key). The two key spaces therefore MUST NOT overlap:
 * one row holding two different CLI sessions means whichever wrote last wins,
 * and an agent silently resumes the wrong session.
 *
 * Today they cannot collide — a conversation id is a uuid, a chat id is a
 * channel-assigned number, and neither can equal `code_task:<jobId>:<cwd>`.
 * But that is correct by luck, not by construction: nothing stopped a future
 * channel from producing an id in any shape at all. This turns the assumption
 * into a check, at the one place every runtime key passes through.
 *
 * Deliberately NOT solved by prefixing the runtime side too: that would orphan
 * every session row already written and cold-start live conversations, to
 * close a hole that has never been reachable.
 */
export function assertRuntimeSessionKey(conversationKey: string): string {
  if (conversationKey.startsWith(CODE_TASK_KEY_PREFIX)) {
    throw new Error(
      `refusing a runtime session key that collides with the code_task namespace: ` +
        `"${conversationKey}". Two different CLI sessions would share one row.`,
    );
  }
  return conversationKey;
}

/** The CLI session to resume for this (agent, job, cwd, provider), if any. */
export async function findResumableSession(
  db: AnyDrizzleDb,
  agentId: string,
  provider: string,
  key: string,
): Promise<string | null> {
  const [row] = await db
    .select({ sessionId: cliSessions.sessionId, provider: cliSessions.provider })
    .from(cliSessions)
    .where(and(eq(cliSessions.agentId, agentId), eq(cliSessions.conversationKey, key)))
    .limit(1);
  // A session belongs to the CLI that created it: resuming a claude session id
  // through codex (or the reverse) fails at the CLI, loudly but pointlessly.
  if (!row || row.provider !== provider) return null;
  return row.sessionId;
}

/** Remember this run's session so the next call in the same job can resume it. */
export async function rememberSession(
  db: AnyDrizzleDb,
  args: {
    entityId: string | null;
    agentId: string;
    provider: string;
    key: string;
    sessionId: string;
  },
): Promise<void> {
  await db
    .insert(cliSessions)
    .values({
      entityId: args.entityId,
      agentId: args.agentId,
      conversationKey: args.key,
      provider: args.provider,
      sessionId: args.sessionId,
    })
    .onConflictDoUpdate({
      target: [cliSessions.agentId, cliSessions.conversationKey],
      set: { sessionId: args.sessionId, provider: args.provider, updatedAt: new Date() },
    });
}
