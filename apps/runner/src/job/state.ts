// job/state.ts — JobState machine: transitions and typed state values
// All transitions are explicit. Invalid transitions throw JobStateError.

import { and, eq, notInArray, or, isNull } from '@nodal-agents/db';
import { agentJobs, agents } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { flattenTranscript } from './transcript-text.ts';

// ─── JobState ─────────────────────────────────────────────────────────────────

export type JobStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'awaiting_approval'
  | 'awaiting_delegation'
  | 'cancelled';

// ─── JobStateError ────────────────────────────────────────────────────────────

export class JobStateError extends Error {
  readonly code = 'invalid_job_transition' as const;

  constructor(
    public readonly jobId: string,
    public readonly from: string,
    public readonly to: JobStatus,
  ) {
    super(`invalid_job_transition: ${jobId} cannot go from '${from}' to '${to}'`);
    this.name = 'JobStateError';
  }
}

// ─── Valid transitions ────────────────────────────────────────────────────────

/**
 * Allowed transitions for the job state machine.
 * Only listed transitions are valid. Any other is rejected by assertTransition().
 */
const VALID_TRANSITIONS: ReadonlyMap<JobStatus, ReadonlySet<JobStatus>> = new Map([
  ['pending', new Set<JobStatus>(['processing', 'cancelled'])],
  [
    'processing',
    new Set<JobStatus>([
      'completed',
      'failed',
      'awaiting_approval',
      'awaiting_delegation',
      'pending', // self-chain reset (saves checkpoint then retriggers)
    ]),
  ],
  ['awaiting_approval', new Set<JobStatus>(['pending', 'failed', 'cancelled'])],
  ['awaiting_delegation', new Set<JobStatus>(['pending', 'failed', 'cancelled'])],
  ['completed', new Set<JobStatus>([])],
  ['failed', new Set<JobStatus>([])],
  ['cancelled', new Set<JobStatus>([])],
]);

// ─── assertTransition ─────────────────────────────────────────────────────────

/**
 * Throw JobStateError if `from → to` is not a valid transition.
 */
export function assertTransition(jobId: string, from: JobStatus, to: JobStatus): void {
  const allowed = VALID_TRANSITIONS.get(from);
  if (!allowed?.has(to)) {
    throw new JobStateError(jobId, from, to);
  }
}

// ─── DB state helpers ─────────────────────────────────────────────────────────

/**
 * Update a job's status in DB. Does NOT validate transition — caller must call
 * assertTransition() first. Used by execute.ts where we've already validated.
 */
export async function setJobStatus(
  db: AnyDrizzleDb,
  jobId: string,
  status: JobStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db
    .update(agentJobs)
    .set({ status, updatedAt: new Date(), ...extra })
    .where(eq(agentJobs.id, jobId));
}

/**
 * Atomic claim: flip status pending → processing in a single UPDATE WHERE id=$1
 * AND status='pending'. Returns true iff exactly one row was updated — i.e. this
 * caller won the race. Returns false when the row is missing, already processing,
 * or in any other non-pending state (concurrent claim, orphan reaper already
 * acted, etc.).
 *
 * Only 'pending' is a valid entry point. All legitimate resume paths
 * (approval, delegation, self-chain) reset the row to 'pending' before calling
 * executeJob, so the WHERE status='pending' predicate never blocks a real resume.
 */
export async function claimJob(db: AnyDrizzleDb, jobId: string): Promise<boolean> {
  const rows = await db
    .update(agentJobs)
    .set({
      status: 'processing',
      updatedAt: new Date(),
    })
    .where(and(eq(agentJobs.id, jobId), eq(agentJobs.status, 'pending')))
    .returning({ id: agentJobs.id });

  return rows.length > 0 && rows[0]?.id === jobId;
}

interface RunStats {
  inputTokens: number;
  outputTokens: number;
  /** Cumulative effective (non-cached) input — what Guard 1a's budget measures. */
  effectiveInputTokens?: number;
  /** Cumulative real dollar cost billed by the provider (Guard 1e). Undefined when the provider doesn't report cost. */
  totalCostUsd?: number;
  /** The upstream provider that last served an LLM call for this job (from providerMetadata.openrouter.provider). Null when not reported. */
  servedProvider?: string | null;
  turn: number;
  totalDurationMs?: number;
}

// Terminal statuses — a row already in one of these must not be overwritten by
// completeJob / failJob (Leg 3: conditional terminal writers). Exported so
// other modules (e.g. the Telegram workspace pruner, F-13) can tell a
// finished job from one still in flight without re-deriving the list.
export const TERMINAL_STATUSES: JobStatus[] = ['completed', 'failed', 'cancelled'];

/**
 * Generic, user-facing explanation for a failure that carried no other message.
 *
 * Invariant #2 exception (no hardcoded user-facing text in the runner): this is
 * the deliberate, minimal exception that invariant #4 (no silent failures)
 * demands and that the product explicitly requires — a job must NEVER leave the
 * user without an explanation after a fail/block. The machine `errorCode` stays
 * in agent_jobs.error for diagnostics; this string is the last-resort prose the
 * user reads when neither the agent nor a delivery tool left anything.
 */
function genericFailExplanation(errorCode: string): string {
  return `⚠️ The task could not be completed (${errorCode}) and no explanation was provided.`;
}

/**
 * Compile the results of a job's delegated children (sub-agent jobs) into one
 * user-facing string. A delegating parent that hands work to sub-agents and then
 * finalizes WITHOUT re-publishing a summary leaves its own `result` empty even
 * though the real content lives on the children — so the dashboard, the chat
 * poll, and the orchestrator's next turn all see nothing. This surfaces that
 * content. Returns '' when the job delegated to no children.
 */
async function compileChildResults(db: AnyDrizzleDb, parentJobId: string): Promise<string> {
  const kids = await db
    .select({
      name: agents.name,
      slug: agents.slug,
      status: agentJobs.status,
      result: agentJobs.result,
      error: agentJobs.error,
    })
    .from(agentJobs)
    .leftJoin(agents, eq(agents.id, agentJobs.agentId))
    .where(eq(agentJobs.parentJobId, parentJobId))
    .orderBy(agentJobs.createdAt);
  if (kids.length === 0) return '';
  return kids
    .map((k) => {
      const who = k.name ?? k.slug ?? 'Agent';
      const tag = k.status === 'completed' ? '' : ` [${k.status ?? 'pending'}]`;
      const body =
        (k.result ?? '').trim() ||
        (k.status === 'failed' ? (k.error ?? '(failed, no detail)') : '(no output)');
      return `## ${who}${tag}\n${body}`;
    })
    .join('\n\n---\n\n');
}

/**
 * After a job reaches a terminal state, guarantee its user-facing `result` is not
 * an empty delegation: if the result is still blank but the job delegated to
 * children, fill it with their compiled output. Preserves any existing non-empty
 * result (a partial delivery the parent did publish). No-op for non-delegating
 * jobs (no children → nothing to compile).
 */
async function fillResultFromChildrenIfEmpty(db: AnyDrizzleDb, jobId: string): Promise<void> {
  const [row] = await db
    .select({ result: agentJobs.result })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId))
    .limit(1);
  if ((row?.result ?? '').trim().length > 0) return;
  const compiled = await compileChildResults(db, jobId);
  if (!compiled) return;
  await db
    .update(agentJobs)
    .set({ result: compiled, updatedAt: new Date() })
    .where(and(eq(agentJobs.id, jobId), or(isNull(agentJobs.result), eq(agentJobs.result, ''))));
}

/**
 * Extract the agent's last substantive assistant text from a transcript.
 * Used as the final fallback to capture a leaf agent's answer when it produced
 * a written reply but never called a delivery tool (dashboard_publish / a send
 * tool) that would have populated `result`. Returns '' if there is no usable text.
 */
function lastAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    if (!m || m.role !== 'assistant') continue;
    const c = m.content;
    if (typeof c === 'string' && c.trim() !== '') return c.trim();
    if (Array.isArray(c)) {
      const parts: string[] = [];
      for (const p of c) {
        const part = p as { type?: unknown; text?: unknown } | null;
        if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
      }
      const joined = parts.join('').trim();
      if (joined !== '') return joined;
    }
  }
  return '';
}

/**
 * Final result-capture fallback (Result-capture fix): after children-compile, if
 * the job's `result` is STILL empty, capture the agent's last written answer from
 * the transcript. Guarantees a leaf agent's substantive output is never lost just
 * because it forgot to call a delivery tool — the captured result then flows to
 * dependents, run memory, and delivery. No-op if there is no usable text.
 */
async function fillResultFromFinalTextIfEmpty(
  db: AnyDrizzleDb,
  jobId: string,
  messages: unknown,
): Promise<void> {
  const [row] = await db
    .select({ result: agentJobs.result })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId))
    .limit(1);
  if ((row?.result ?? '').trim().length > 0) return;
  const text = lastAssistantText(messages);
  if (!text) return;
  await db
    .update(agentJobs)
    .set({ result: text, updatedAt: new Date() })
    .where(and(eq(agentJobs.id, jobId), or(isNull(agentJobs.result), eq(agentJobs.result, ''))));
}

/**
 * Mark a job as completed. Sets result, completedAt, and clears error.
 * Persists per-turn accumulated token counts and final turn when provided.
 *
 * The `messages` parameter persists the full conversation transcript so the
 * dashboard /jobs/[id] panel can show the assistant's tool-call turns. Without
 * it, single-turn jobs that complete via return_result leave the messages
 * JSONB at its initial `[user]`-only state — the assistant's response never
 * lands in DB even though it ran in memory.
 *
 * Brique 33: when `result` is empty, we do NOT overwrite the existing
 * agent_jobs.result column. This preserves any value written earlier by
 * dashboard_publish (or any other delivery tool side-effect). Only a non-empty
 * result (e.g. from the no-tool-calls text branch) replaces the stored value.
 *
 * Conditional write (Leg 3): only applies when the row is NOT already in a
 * terminal state. Returns true if the write landed, false if the row was already
 * terminal (race lost — e.g. orphan reaper already marked it failed).
 */
export async function completeJob(
  db: AnyDrizzleDb,
  jobId: string,
  result: string,
  toolsUsed: string[] = [],
  stats?: RunStats,
  messages?: unknown[],
): Promise<boolean> {
  const rows = await db
    .update(agentJobs)
    .set({
      status: 'completed',
      // Brique 33: preserve existing result (e.g. set by dashboard_publish
      // earlier in this job) when no new text is provided.
      ...(result.length > 0 ? { result } : {}),
      toolsUsed,
      // Clear stale error from any prior failed attempt — the docstring already
      // promised this; without it, a resumed/retried job ends up `completed` with
      // a leftover error column, which is confusing in the dashboard.
      error: null,
      completedAt: new Date(),
      updatedAt: new Date(),
      // Persist the transcript AND its flattened search text together so the
      // episodic full-text index (search_history) always reflects the final
      // transcript. search_tsv is a generated column — setting search_text
      // recomputes it. (Brick 2.)
      ...(messages !== undefined && {
        messages,
        searchText: flattenTranscript(messages, result),
      }),
      ...(stats && {
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        turn: stats.turn,
        ...(stats.effectiveInputTokens !== undefined && {
          effectiveInputTokens: stats.effectiveInputTokens,
        }),
        ...(stats.totalCostUsd !== undefined && { totalCostUsd: stats.totalCostUsd }),
        ...(stats.servedProvider !== undefined && { servedProvider: stats.servedProvider }),
        ...(stats.totalDurationMs !== undefined && { totalDurationMs: stats.totalDurationMs }),
      }),
    })
    .where(and(eq(agentJobs.id, jobId), notInArray(agentJobs.status, TERMINAL_STATUSES)))
    .returning({ id: agentJobs.id });

  const landed = rows.length > 0 && rows[0]?.id === jobId;
  // A delegating parent that finished without re-publishing leaves `result`
  // empty while the content lives on its children — surface it so the result is
  // never a blank delegation. Only when WE won the terminal write, and only when
  // no fresh text was written this call (a non-empty `result` is already content;
  // an empty one may still hold an earlier dashboard_publish, so it's checked).
  if (landed && result.length === 0) {
    await fillResultFromChildrenIfEmpty(db, jobId);
    // Last resort: capture the agent's own written answer from the transcript so
    // a leaf job's substantive output is never lost (feeds dependents + delivery).
    if (messages !== undefined) await fillResultFromFinalTextIfEmpty(db, jobId, messages);
  }
  return landed;
}

/**
 * Mark a job as failed. Stores the error code/message.
 * Persists tokens + turn + duration when provided so partial run state isn't lost.
 *
 * Sets `completedAt` so the row matches the terminal-state semantics of
 * completed jobs: dashboards / filters / cron `resetOrphanedJobs` all use
 * `completed_at IS NULL` to mean "still in flight". Without this set on
 * failure, failed jobs leaked into "in-flight" queries and never appeared in
 * "recent" / "delivered" listings.
 *
 * Conditional write (Leg 3): only applies when the row is NOT already in a
 * terminal state. Returns true if the write landed, false if the row was already
 * terminal (race lost — e.g. orphan reaper already marked it failed before this
 * call arrived).
 *
 * Explanation backstop (invariant #4 — no silent failures): after the status
 * write lands, guarantee the user-facing `result` column is non-empty. When the
 * caller supplies `userMessage` (e.g. a blocked agent's reason) it is used
 * verbatim; otherwise a generic, error-code-derived system notice is written.
 * Filled ONLY when `result` is currently empty, so a partial delivery written
 * earlier in the job (e.g. dashboard_publish) is preserved. This anchors the
 * rule "never leave the user without an explanation after a fail/block" for
 * EVERY fail path (return_result blocked, guards, transport death, orphan reap).
 */
export async function failJob(
  db: AnyDrizzleDb,
  jobId: string,
  errorCode: string,
  stats?: RunStats,
  messages?: unknown[],
  userMessage?: string,
): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .update(agentJobs)
    .set({
      status: 'failed',
      error: errorCode,
      completedAt: now,
      updatedAt: now,
      // Persist the transcript on failure (mirrors completeJob) so a failed job
      // is DIAGNOSABLE, not opaque. The resume/guard failure paths used to lose
      // it entirely. Omitted ⇒ the stored messages are left untouched. Also
      // index it for episodic search — a failed run is still worth recalling.
      ...(messages ? { messages, searchText: flattenTranscript(messages) } : {}),
      ...(stats && {
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        turn: stats.turn,
        ...(stats.effectiveInputTokens !== undefined && {
          effectiveInputTokens: stats.effectiveInputTokens,
        }),
        ...(stats.totalCostUsd !== undefined && { totalCostUsd: stats.totalCostUsd }),
        ...(stats.servedProvider !== undefined && { servedProvider: stats.servedProvider }),
        ...(stats.totalDurationMs !== undefined && { totalDurationMs: stats.totalDurationMs }),
      }),
    })
    .where(and(eq(agentJobs.id, jobId), notInArray(agentJobs.status, TERMINAL_STATUSES)))
    .returning({ id: agentJobs.id });

  const landed = rows.length > 0 && rows[0]?.id === jobId;

  // Explanation backstop — only when WE won the terminal write (don't clobber a
  // result owned by whoever already finalized the row). Fills `result` only if
  // it is still empty, preserving any partial delivery from earlier in the job.
  // Precedence: the caller's explicit reason → the delegated children's output
  // (a failed parent that delegated) → a generic error-code notice.
  if (landed) {
    let explanation = userMessage?.trim() ?? '';
    if (!explanation) explanation = await compileChildResults(db, jobId);
    if (!explanation) explanation = genericFailExplanation(errorCode);
    await db
      .update(agentJobs)
      .set({ result: explanation, updatedAt: new Date() })
      .where(and(eq(agentJobs.id, jobId), or(isNull(agentJobs.result), eq(agentJobs.result, ''))));
  }

  return landed;
}

/**
 * Finalize a job that the user cancelled mid-flight.
 *
 * The status column is ALREADY 'cancelled' at this point — the dashboard
 * action `cancelJobAction` flipped it as soon as the user clicked. This
 * helper just persists the partial transcript + accumulated stats and
 * stamps `completed_at` so orphan-cleanup / "in-flight" filters treat
 * the row as terminal.
 *
 * Deliberately does NOT touch `status` again: the runner might be racing
 * against a SECOND status transition (e.g. user re-cancelling a
 * cancelled job is a no-op) and we never want to clobber a status
 * intentionally set by another writer.
 */
export async function cancelJob(
  db: AnyDrizzleDb,
  jobId: string,
  stats?: RunStats,
  messages?: unknown[],
): Promise<void> {
  const now = new Date();
  await db
    .update(agentJobs)
    .set({
      completedAt: now,
      updatedAt: now,
      ...(messages !== undefined && { messages }),
      ...(stats && {
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        turn: stats.turn,
        ...(stats.effectiveInputTokens !== undefined && {
          effectiveInputTokens: stats.effectiveInputTokens,
        }),
        ...(stats.totalCostUsd !== undefined && { totalCostUsd: stats.totalCostUsd }),
        ...(stats.servedProvider !== undefined && { servedProvider: stats.servedProvider }),
        ...(stats.totalDurationMs !== undefined && { totalDurationMs: stats.totalDurationMs }),
      }),
    })
    .where(eq(agentJobs.id, jobId));
}

/**
 * Save job checkpoint (messages + turn + chain_count) for self-chaining.
 * Does NOT change status — caller does that separately.
 */
export async function saveCheckpoint(
  db: AnyDrizzleDb,
  jobId: string,
  checkpoint: {
    messages: unknown[];
    turn: number;
    chainCount: number;
    toolsUsed: string[];
    inputTokens?: number;
    outputTokens?: number;
    effectiveInputTokens?: number;
    totalCostUsd?: number;
    servedProvider?: string | null;
    totalDurationMs?: number;
  },
): Promise<void> {
  await db
    .update(agentJobs)
    .set({
      messages: checkpoint.messages,
      turn: checkpoint.turn,
      chainCount: checkpoint.chainCount,
      toolsUsed: checkpoint.toolsUsed,
      updatedAt: new Date(),
      ...(checkpoint.inputTokens !== undefined && { inputTokens: checkpoint.inputTokens }),
      ...(checkpoint.outputTokens !== undefined && { outputTokens: checkpoint.outputTokens }),
      ...(checkpoint.effectiveInputTokens !== undefined && {
        effectiveInputTokens: checkpoint.effectiveInputTokens,
      }),
      ...(checkpoint.totalCostUsd !== undefined && { totalCostUsd: checkpoint.totalCostUsd }),
      ...(checkpoint.servedProvider !== undefined && { servedProvider: checkpoint.servedProvider }),
      ...(checkpoint.totalDurationMs !== undefined && {
        totalDurationMs: checkpoint.totalDurationMs,
      }),
    })
    .where(eq(agentJobs.id, jobId));
}

/**
 * Heartbeat: bump `updated_at` so the orphan-cleanup cron (resetOrphanedJobs,
 * staleMinutes=5) does not reap a job that is actively working but slow — e.g. a
 * turn running many blocking tool calls, or a long LLM call near the timeout.
 * Cheap single-column UPDATE; safe to call repeatedly mid-turn. Mirrors the bump
 * that reset-orphans itself does for legitimately-waiting delegation parents.
 */
export async function touchJob(db: AnyDrizzleDb, jobId: string): Promise<void> {
  await db.update(agentJobs).set({ updatedAt: new Date() }).where(eq(agentJobs.id, jobId));
}
