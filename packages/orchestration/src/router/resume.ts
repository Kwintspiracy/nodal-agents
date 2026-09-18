// router/resume.ts — inject child result into parent and resume
// Called when a child job completes (by cron or worker completing a child job).

import { eq, and } from '@nodal-agents/db';
import { agentJobs } from '@nodal-agents/db';
import type { JobFailureHint } from '@nodal-agents/shared';
import { OrchestrationError } from '../errors';
import { readDeliveredReviewVerdict } from './review-verdict';
import type { ReviewVerdictRecord } from './review-verdict';
import type { AgentId, EntityId, JobId, AnyDrizzleDb, AgentJob } from '../types';

/**
 * The TYPED outcome of one delegation, as the parent receives it.
 *
 * Modelled on Hermes (`tools/delegate_tool.py:2080-2130`): the parent never
 * gets a bare string it has to guess the meaning of, it gets a record whose
 * `status` field says whether anything was actually delivered. `summary` is the
 * child's deliverable — its final assistant text — and an empty summary on a
 * `completed` status is impossible by construction: the runner fails such a
 * child before it ever reaches here (execute.ts, empty-deliverable guard).
 */
export interface DelegationOutcomeRecord {
  status: 'completed' | 'failed' | 'blocked';
  /** The child's deliverable: the last assistant text it produced. */
  summary: string;
  /** Machine reason when status is not `completed`. */
  error?: string | null;
  /** How the child's run ended (`return_result_success`, `empty_deliverable`, …). */
  exit_reason?: string | null;
  /** Tools the child actually ran, so the parent can see what was attempted. */
  tools_used?: string[];
  /**
   * Le verdict de revue que l'enfant a ENREGISTRÉ, quand il en a enregistré un
   * (issue #124). `summary` reste la dernière phrase du modèle ; ce champ, lui,
   * porte ce que l'outil `review_verdict` a validé — verdict, résumé, constats.
   * `null` sur l'immense majorité des délégations, qui ne sont pas des revues.
   */
  review_verdict?: ReviewVerdictRecord | null;
  /**
   * Le geste que ce code d'échec appelle, quand il en appelle un — un CHAMP,
   * jamais une phrase (#119, revue passe 1). Le harnais n'a pas à écrire
   * « essaie un autre modèle » : il pose le fait, et l'écran ou le modèle le
   * dit dans la langue de la personne (invariant #2).
   */
  hint?: JobFailureHint | null;
}

/**
 * Les gestes que le harnais peut nommer après un échec.
 *
 * Le type vit dans `@nodal-agents/shared` (#194, revue passe 1) : le runner le
 * POSE, l'orchestration le TRANSPORTE, l'écran le DIT — trois paquets dont
 * aucun ne dépend des deux autres. Il reste exporté d'ici, où vit le record qui
 * le porte, pour que les appelants n'aient pas à changer d'import.
 */
export type { JobFailureHint };

/**
 * What the child handed back. `string` = the child's text result on success and
 * `{ error: string }` = a bare failure; both are legacy shapes kept for callers
 * that have no richer information, and both are normalized into a
 * `DelegationOutcomeRecord` before injection. A failure is injected as an `error-text`
 * tool_result so the parent's LLM treats it as a tool failure and can react
 * (notify the user, try a different sub-agent, `return_result{status:'blocked'}`)
 * instead of dying silently alongside the child.
 */
export type DelegationOutcome = string | { error: string } | DelegationOutcomeRecord;

/**
 * Marker opening the tool-result of a delegation that DELIVERED NOTHING.
 *
 * It exists so the runner can tell that case apart from the other `error-text`
 * tool-result an `assign_*` call can carry: a DEFERRAL (`buildDeferredToolResults`
 * — "another handoff took priority, call me again"), which is not a failure at
 * all. Without the marker, guard 3b's cross-run seeding would read a deferral as
 * an unresolved failure and refuse the parent's honest success.
 */
export const DELEGATION_FAILED_MARKER = '[delegation-produced-nothing]';

/** Normalize any accepted outcome shape into the typed record. */
export function normalizeDelegationOutcome(outcome: DelegationOutcome): DelegationOutcomeRecord {
  if (typeof outcome === 'string') {
    return { status: 'completed', summary: outcome, error: null, exit_reason: null };
  }
  if ('status' in outcome) return outcome;
  return { status: 'failed', summary: '', error: outcome.error, exit_reason: null };
}

/**
 * Render the typed outcome as the tool-result payload the parent's model reads.
 * JSON, deliberately: the fields are the contract, and a model that sees
 * `"status": "failed"` cannot mistake it for a specialist that answered.
 */
export function renderDelegationOutcome(result: DelegationOutcomeRecord): string {
  return JSON.stringify(
    {
      status: result.status,
      summary: result.summary,
      error: result.error ?? null,
      exit_reason: result.exit_reason ?? null,
      tools_used: result.tools_used ?? [],
      // Tous deux TOUJOURS présents, `null` quand il n'y a pas eu de revue ou
      // qu'aucun geste n'est nommé : un champ qui apparaît et disparaît se lit
      // comme une absence de contrat.
      review_verdict: result.review_verdict ?? null,
      hint: result.hint ?? null,
    },
    null,
    2,
  );
}

/**
 * Attache au record le verdict que l'enfant a enregistré, s'il en a enregistré
 * un. Le verdict déjà porté par l'appelant l'emporte — il l'a lu de plus près.
 *
 * Une ligne illisible ne remonte PAS en exception : elle deviendrait une sortie
 * de `resumeDelegated` AVANT la mise à jour du parent, qui resterait
 * `awaiting_delegation` avec un appel d'outil sans réponse, et personne ne
 * serait prévenu (revue de la PR #170, constat 2). La délégation devient donc
 * un ÉCHEC nommé : le parent reçoit le `error-text` des délégations ratées,
 * avec le code, et peut agir. Fort et à la bonne place.
 */
async function withDeliveredReviewVerdict(
  outcome: DelegationOutcomeRecord,
  childJobId: JobId,
  db: AnyDrizzleDb,
): Promise<DelegationOutcomeRecord> {
  if (outcome.review_verdict) return outcome;
  try {
    return { ...outcome, review_verdict: await readDeliveredReviewVerdict(db, childJobId) };
  } catch (err) {
    if (!(err instanceof OrchestrationError) || err.code !== 'review_verdict_malformed') throw err;
    console.error(
      `[resume] child ${childJobId} recorded an unreadable review_verdict — the delegation is reported as failed:`,
      err,
    );
    return {
      ...outcome,
      status: 'failed',
      error: 'review_verdict_malformed',
      review_verdict: null,
    };
  }
}

/**
 * Extract the child slug from a `pending_delegation.toolName` of the form
 * `assign_<slug>` (e.g. `assign_summarizer` → `summarizer`). The runner
 * applies the same transform when dispatching, so this is just its inverse.
 * Returns `null` if the tool name doesn't follow the convention.
 */
function childSlugFromToolName(toolName: string): string | null {
  if (!toolName.startsWith('assign_')) return null;
  return toolName.slice('assign_'.length).replace(/_/g, '-');
}

// ─── resumeDelegated ──────────────────────────────────────────────────────────

/**
 * Inject the child job's result as a tool_result into the parent job's messages,
 * then set parent.status = 'pending' so the runner picks it up again.
 *
 * This implements the "parent resumes" leg of the Router delegation flow:
 *   child completes → resumeDelegated() → parent.status = 'pending' → worker resumes
 *
 * Steps:
 * 1. Load parent job — verify status is 'awaiting_delegation'
 * 2. Read pending_delegation.toolUseId
 * 3. Append tool_result block to parent.messages (text on success, error-text on failure)
 * 4. Include sideToolResults from pending_delegation (message-integrity invariant)
 * 5. Set parent.status = 'pending', clear pending_delegation
 *
 * @param parentJobId  The ID of the waiting parent job
 * @param childJobId   The ID of the completed child job — read for its
 *                     `review_verdict` rows (#124), and for logging/audit
 * @param childOutcome The child's text result, OR `{error}` if the child failed
 * @param db           Drizzle DB handle
 * @returns            Updated parent job row
 */
export async function resumeDelegated(
  parentJobId: JobId,
  childJobId: JobId,
  childOutcome: DelegationOutcome,
  db: AnyDrizzleDb,
): Promise<AgentJob> {
  // 1. Load parent
  const parentRows = await db
    .select({
      id: agentJobs.id,
      status: agentJobs.status,
      messages: agentJobs.messages,
      pendingDelegation: agentJobs.pendingDelegation,
      agentId: agentJobs.agentId,
      entityId: agentJobs.entityId,
      chainCount: agentJobs.chainCount,
      delegationDepth: agentJobs.delegationDepth,
      lastFailedDelegationSlug: agentJobs.lastFailedDelegationSlug,
      parentJobId: agentJobs.parentJobId,
      task: agentJobs.task,
      channel: agentJobs.channel,
      chatId: agentJobs.chatId,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, parentJobId as string))
    .limit(1);

  const parent = parentRows[0];
  if (!parent) {
    throw new OrchestrationError('parent_not_found', `Parent job not found: ${parentJobId}`);
  }

  // 2. Verify parent is waiting for delegation.
  //
  // Special case — parent already terminal: when the user cancels a parent
  // that was awaiting delegation, the cascade in `cancelJobAction` flips
  // the parent to 'cancelled' immediately, but the child is typically
  // already executing and finishes its current LLM turn before observing
  // its own cancel. When that child then calls resumeDelegated, the
  // parent is in 'cancelled' / 'completed' / 'failed' rather than
  // 'awaiting_delegation' — that's a legal race, not a bug. Returning a
  // no-op snapshot lets the caller's `executeJob(parent)` re-entry see
  // the terminal status via its own guard and exit with 'already_handled'.
  //
  // For non-terminal mismatches (pending / processing) we still throw —
  // those indicate a real concurrency violation (the parent isn't waiting
  // for this child) and we want to fail loud rather than silently corrupt
  // the parent's messages array.
  const TERMINAL_PARENT_STATUSES = new Set(['cancelled', 'completed', 'failed']);
  if (parent.status !== 'awaiting_delegation') {
    if (parent.status && TERMINAL_PARENT_STATUSES.has(parent.status)) {
      return {
        id: parent.id as JobId,
        agentId: parent.agentId as AgentId | null,
        entityId: parent.entityId as EntityId | null,
        status: parent.status,
        messages: Array.isArray(parent.messages) ? (parent.messages as unknown[]) : [],
        pendingDelegation: null,
        chainCount: parent.chainCount ?? 0,
        delegationDepth: parent.delegationDepth ?? 0,
        parentJobId: parent.parentJobId as JobId | null,
        task: parent.task,
        channel: parent.channel,
        chatId: parent.chatId,
      };
    }
    throw new OrchestrationError(
      'parent_wrong_status',
      `Parent job ${parentJobId} has status '${parent.status}', expected 'awaiting_delegation'`,
    );
  }

  // 3. Extract the tool_use_id we need to match
  const pending = parent.pendingDelegation as {
    toolUseId?: string;
    toolName?: string;
    subJobId?: string;
    sideToolResults?: Array<{
      type: string;
      tool_use_id: string;
      toolName?: string;
      content: string;
      is_error?: boolean;
    }>;
  } | null;

  if (!pending?.toolUseId) {
    throw new OrchestrationError(
      'missing_tool_use_id',
      `Parent job ${parentJobId} has no toolUseId in pending_delegation`,
    );
  }

  const toolUseId = pending.toolUseId;

  // toolName is required by AI SDK v4 tool-result format. It was added to
  // pending_delegation by handleDelegation; legacy rows without it are
  // unrecoverable at this layer (we can't reconstruct the assign_<slug> tool
  // name without re-querying the orchestrator's children).
  const toolName = pending.toolName;
  if (!toolName) {
    throw new OrchestrationError(
      'missing_tool_use_id',
      `Parent job ${parentJobId} has no toolName in pending_delegation (legacy row?)`,
    );
  }

  // 4. Build a tool-role message in AI SDK v6 ModelMessage format.
  // Shape: { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName,
  //          output: ToolResultOutput }, …] }
  // ToolResultOutput is a discriminated union — we use 'text' for normal child
  // results (string) and 'error-text' for the deferred-sibling markers (which
  // carry is_error=true so the LLM treats them as failures, not normal results).
  type ToolResultOutput = { type: 'text'; value: string } | { type: 'error-text'; value: string };
  // Le livrable d'une revue est le verdict que l'enfant a enregistré, pas la
  // phrase par laquelle il l'annonce (issue #124). On le lit sur ses lignes
  // `tool_calls` et on le met dans le record TYPÉ, seul objet que le parent
  // reçoive : sans cela le parent redélègue la même revue.
  const outcome = await withDeliveredReviewVerdict(
    normalizeDelegationOutcome(childOutcome),
    childJobId,
    db,
  );
  const isFailure = outcome.status !== 'completed';

  // Per-slug delegation cap: track the slug of the LAST failed child so the
  // runner can block a naive same-slug retry while still letting the
  // orchestrator fall back to a DIFFERENT specialist.
  //
  // Live regression — job `7767a3c1` (2026-05-19): Conciergus delegated to
  // Summarizus → timeout (51 turns, 2.4M tokens, never wrote anything). The
  // prior global counter (`failed_delegations_count`) blocked Conciergus's
  // legitimate fallback to Obsidius (different specialist, same job)
  // alongside the naive retry of Summarizus. Per-slug semantics let the
  // fallback go through.
  //
  // Set on failure → child slug of the failing delegation.
  // Cleared on success → so subsequent same-slug delegations are allowed
  // once any progress has been made on the parent.
  const failedSlug = isFailure ? childSlugFromToolName(toolName) : null;
  const nextLastFailedSlug = isFailure ? failedSlug : null;

  // The parent MUST NOT be able to turn a failed delegation into a promise.
  // The incident this closes (#107, job f1852d35): the child produced nothing,
  // the parent read "(no output)" as an answer and told the user "recherche
  // lancée, je te renvoie la synthèse" — a result that had already failed to
  // exist. So the failure payload names the three legal moves and forbids the
  // fourth. LLM-channel text only; it never reaches the user (invariant #2).
  const errorValue = isFailure
    ? `${DELEGATION_FAILED_MARKER}
${renderDelegationOutcome(outcome)}

This delegation delivered NOTHING usable. DO NOT retry the same specialist (assign_${(failedSlug ?? '').replace(/-/g, '_')}). DO NOT tell the user the work is in progress, launched, or coming later: it is not, and nothing else will arrive. Your only options are: (1) do the work yourself with your own tools, (2) delegate to a DIFFERENT specialist whose skills match, or (3) tell the user the truth about what failed via your delivery tool. Then call return_result with the honest status.`
    : '';

  const primaryOutput: ToolResultOutput = isFailure
    ? { type: 'error-text', value: errorValue }
    : { type: 'text', value: renderDelegationOutcome(outcome) };

  const toolResultParts: Array<{
    type: 'tool-result';
    toolCallId: string;
    toolName: string;
    output: ToolResultOutput;
  }> = [
    {
      type: 'tool-result',
      toolCallId: toolUseId,
      toolName,
      output: primaryOutput,
    },
  ];

  // Append deferred siblings (other assign_* dropped this turn). They share the
  // message-integrity invariant: every tool_use needs a matching tool_result.
  const sideResults = pending.sideToolResults ?? [];
  for (const sr of sideResults) {
    if (!sr.toolName) {
      throw new OrchestrationError(
        'missing_tool_use_id',
        `Side tool_result for ${sr.tool_use_id} has no toolName (legacy row?)`,
      );
    }
    toolResultParts.push({
      type: 'tool-result',
      toolCallId: sr.tool_use_id,
      toolName: sr.toolName,
      output: sr.is_error
        ? { type: 'error-text', value: sr.content }
        : { type: 'text', value: sr.content },
    });
  }

  // 5. Build updated messages array
  const existingMessages = Array.isArray(parent.messages)
    ? (parent.messages as unknown[])
    : (JSON.parse(String(parent.messages ?? '[]')) as unknown[]);

  const updatedMessages = [...existingMessages, { role: 'tool', content: toolResultParts }];

  // 6. Update parent: inject messages, set status → pending, clear pending_delegation,
  // bump chain_count. Each resume from a delegation suspension counts as one
  // self-chain step — invariant 8 caps this at maxChains (15) to prevent runaway
  // orchestrators that delegate forever instead of returning a result.
  const nextChainCount = (parent.chainCount ?? 0) + 1;
  // Conditional on status STILL being 'awaiting_delegation' (B4, audit
  // followup). The read-time check above (step 2) can go stale: the user may
  // cancel the parent in the window between that read and this write. An
  // unconditional UPDATE would resurrect the cancelled parent back to
  // 'pending' and re-trigger it. Guarding the write closes that TOCTOU — cancel
  // wins, 0 rows land, and we return the terminal no-op snapshot exactly like
  // the read-time terminal branch does.
  const [updated] = await db
    .update(agentJobs)
    .set({
      messages: updatedMessages,
      status: 'pending',
      pendingDelegation: null,
      chainCount: nextChainCount,
      lastFailedDelegationSlug: nextLastFailedSlug,
      updatedAt: new Date(),
    })
    .where(
      and(eq(agentJobs.id, parentJobId as string), eq(agentJobs.status, 'awaiting_delegation')),
    )
    .returning();

  if (!updated) {
    // Lost the race to a concurrent cancel (or another resume). Re-read: a
    // terminal parent is a legal race (return a no-op snapshot so the caller's
    // executeJob re-entry exits via its own guard); anything else is a real
    // corruption and must fail loud.
    const [current] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJobId as string))
      .limit(1);
    if (current?.status && TERMINAL_PARENT_STATUSES.has(current.status)) {
      return {
        id: parent.id as JobId,
        agentId: parent.agentId as AgentId | null,
        entityId: parent.entityId as EntityId | null,
        status: current.status,
        messages: Array.isArray(parent.messages) ? (parent.messages as unknown[]) : [],
        pendingDelegation: null,
        chainCount: parent.chainCount ?? 0,
        delegationDepth: parent.delegationDepth ?? 0,
        parentJobId: parent.parentJobId as JobId | null,
        task: parent.task,
        channel: parent.channel,
        chatId: parent.chatId,
      };
    }
    throw new OrchestrationError('parent_not_found', `Failed to update parent job ${parentJobId}`);
  }

  return {
    id: updated.id as JobId,
    agentId: updated.agentId as AgentId | null,
    entityId: updated.entityId as EntityId | null,
    status: updated.status ?? 'pending',
    messages: Array.isArray(updated.messages) ? (updated.messages as unknown[]) : [],
    pendingDelegation: null,
    chainCount: updated.chainCount ?? 0,
    delegationDepth: updated.delegationDepth ?? 0,
    parentJobId: updated.parentJobId as JobId | null,
    task: updated.task,
    channel: updated.channel,
    chatId: updated.chatId,
  };
}
