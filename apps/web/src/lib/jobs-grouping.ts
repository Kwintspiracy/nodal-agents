// jobs-grouping.ts — collapse conversational jobs into one row for the Jobs
// page (migration 0059). Pure, no DB/Next.js — a plain `'use server'` file
// (actions.ts) can only export async functions, so this grouping logic lives
// in its own module and gets imported there.
//
// Scope: only TOP-LEVEL rows (role 'orchestrator' | 'standalone') are ever
// grouped into a conversation. Delegated jobs (role 'delegated') already
// render indented under their orchestrator via listDelegationRunsAction's
// parent-then-children ordering — that's a separate, working mechanism this
// does not touch. In practice this is also the only case that matters: a
// Telegram/dashboard-chat exchange is always a top-level job (no
// parent_job_id), so the "10 identical Telegram rows" problem this exists to
// fix never involves delegated rows anyway.

import { classifyJob } from '@nodal-agents/shared';
import type { DelegationRunRow } from './actions.ts';

export type ConversationGroupRow = {
  kind: 'conversation';
  conversationId: string;
  agentName: string;
  agentSlug: string | null;
  agentAvatarUrl: string | null;
  channel: string;
  exchangeCount: number;
  firstCreatedAt: Date | null;
  /** Most recent activity — last completedAt, falling back to createdAt for
   *  a still-open job (same convention as thread-history.ts's gap logic). */
  lastActivityAt: Date | null;
  totalCostUsd: number;
  totalTokens: number;
  status: 'failed' | 'running' | 'completed';
  /** The individual jobs in this conversation, for the expand/collapse UI. */
  jobs: DelegationRunRow[];
};

export type JobsPageRow = { kind: 'job'; job: DelegationRunRow } | ConversationGroupRow;

const isLiveStatus = (s: string | null): boolean =>
  s === 'processing' || s === 'pending' || (s?.startsWith('awaiting') ?? false);

const isFailedStatus = (s: string | null): boolean => s === 'failed' || s === 'cancelled';

/**
 * Group `rows` (already ordered by listDelegationRunsAction: parent-then-
 * children, each subtree in desc(createdAt) order) into the rows the Jobs
 * page actually renders: chat-classified top-level jobs sharing a
 * conversation_id collapse into ONE ConversationGroupRow; everything else
 * (task jobs, delegated jobs, jobs with no conversation_id) passes through
 * unchanged as an individual row.
 *
 * Position: a conversation row is emitted at the position of its FIRST
 * occurrence in `rows` — since `rows` is desc(createdAt) among top-level
 * jobs, that's its most recent exchange, so the list still reads
 * most-recent-first.
 */
export function groupJobsForJobsPage(rows: DelegationRunRow[]): JobsPageRow[] {
  const out: JobsPageRow[] = [];
  const consumed = new Set<string>();

  for (const row of rows) {
    if (row.role === 'delegated') {
      out.push({ kind: 'job', job: row });
      continue;
    }

    const isChat = classifyJob(row.toolsUsed) === 'chat';
    if (!isChat || !row.conversationId) {
      out.push({ kind: 'job', job: row });
      continue;
    }

    if (consumed.has(row.conversationId)) continue; // already emitted, further occurrence
    consumed.add(row.conversationId);

    const members = rows.filter(
      (r) =>
        r.role !== 'delegated' &&
        r.conversationId === row.conversationId &&
        classifyJob(r.toolsUsed) === 'chat',
    );
    out.push(aggregateConversation(row.conversationId, members));
  }

  return out;
}

function aggregateConversation(
  conversationId: string,
  jobs: DelegationRunRow[],
): ConversationGroupRow {
  // `jobs` inherits desc(createdAt) order from the caller — [0] is the most
  // recent exchange, used for the agent/channel identity (a conversation is
  // scoped to one agent by construction, see conversation-id.ts).
  const head = jobs[0]!;

  const totalCostUsd = jobs.reduce((sum, j) => sum + j.costUsd, 0);
  // Cache-aware input (falls back to raw for jobs predating effectiveInputTokens,
  // where it defaults to 0 — see DelegationRunRow doc).
  const totalTokens = jobs.reduce(
    (sum, j) => sum + (j.effectiveInputTokens || j.inputTokens) + j.outputTokens,
    0,
  );

  const status: ConversationGroupRow['status'] = jobs.some((j) => isFailedStatus(j.status))
    ? 'failed'
    : jobs.some((j) => isLiveStatus(j.status))
      ? 'running'
      : 'completed';

  const createdTimes = jobs
    .map((j) => j.createdAt)
    .filter((d): d is Date => d !== null)
    .map((d) => d.getTime());
  const activityTimes = jobs
    .map((j) => j.completedAt ?? j.createdAt)
    .filter((d): d is Date => d !== null)
    .map((d) => d.getTime());

  return {
    kind: 'conversation',
    conversationId,
    agentName: head.agentName,
    agentSlug: head.agentSlug,
    agentAvatarUrl: head.agentAvatarUrl,
    channel: head.channel,
    exchangeCount: jobs.length,
    firstCreatedAt: createdTimes.length ? new Date(Math.min(...createdTimes)) : null,
    lastActivityAt: activityTimes.length ? new Date(Math.max(...activityTimes)) : null,
    totalCostUsd,
    totalTokens,
    status,
    jobs,
  };
}
