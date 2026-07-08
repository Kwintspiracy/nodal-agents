#!/usr/bin/env node
// backfill-conversation-ids.mjs — one-shot backfill for the new
// agent_jobs.conversation_id column (migration 0059, Jobs page grouping).
//
// Replays, on HISTORICAL data, the exact same rules the runner now applies
// going forward at job-creation time (apps/runner/src/job/conversation-id.ts,
// apps/runner/src/chat/run-chat-turn.ts, packages/orchestration/src/router/
// delegate.ts, apps/runner/src/cron/execute-ready.ts, apps/runner/src/routes/
// agent.ts):
//   - Delegated / task-board children (parent_job_id set) inherit their
//     parent's conversation_id verbatim.
//   - Dashboard-chat escalations (channel='dashboard') take the id of the
//     `conversations` row they were escalated from, via the chat_messages
//     link (jobId -> conversationId) — that's the REAL conversation entity
//     for that channel, not a re-derived heuristic.
//   - Conversational-channel root jobs (telegram/slack/discord, chat_id set,
//     no parent) share a conversation_id with the previous root job in the
//     same (entity_id, agent_id, channel, chat_id) tuple as long as the gap
//     since it was delivered (completed_at, falling back to created_at for a
//     job that never completed) is under the idle-reset window — same
//     session-boundary rule as thread-history.ts's loadThreadHistory.
//   - Everything else (api/cron/task-board/internal with no parent, or no
//     chat_id) stays NULL — not a conversation.
//
// Idempotent: only fills rows where conversation_id IS currently NULL. A
// second run touches zero rows.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/backfill-conversation-ids.mjs [--dry-run]

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Mirrors apps/runner/src/job/thread-history.ts's CONVERSATIONAL_CHANNELS.
export const CONVERSATIONAL_CHANNELS = new Set(['telegram', 'slack', 'discord']);

/**
 * Pure computation — no I/O. Given every agent_jobs row (chronological,
 * oldest first) and the job_id -> conversation_id links derived from
 * chat_messages, decide each job's conversation_id and which rows actually
 * need a DB write (still NULL today).
 *
 * @param jobs Array of { id, parent_job_id, entity_id, agent_id, channel,
 *   chat_id, created_at, completed_at, conversation_id }, ordered by
 *   created_at ASC (ties broken by id) — callers MUST sort this way, since
 *   a child's parent must already be resolved by the time it's reached.
 * @param chatLinks Array of { job_id, conversation_id } — one row per
 *   dashboard-chat escalation (chat_messages joined to its spawned job).
 * @param idleResetMs Same session-boundary gap as thread-history.ts's
 *   IDLE_RESET_MS.
 * @returns { resolved: Map<jobId, conversationId|null>, updates: Array<{id, conversationId}> }
 */
export function computeConversationIds(jobs, chatLinks, idleResetMs) {
  const conversationByJobId = new Map(chatLinks.map((r) => [r.job_id, r.conversation_id]));
  const resolved = new Map();
  // Per-thread gap state for conversational-channel root jobs:
  // tupleKey -> { conversationId, deliveredAtMs }.
  const tupleState = new Map();
  const updates = [];

  for (const job of jobs) {
    const createdAtMs = new Date(job.created_at).getTime();
    const deliveredAtMs = job.completed_at ? new Date(job.completed_at).getTime() : createdAtMs;
    const tupleKey = `${job.entity_id}|${job.agent_id}|${job.channel}|${job.chat_id}`;

    let conversationId;

    if (job.conversation_id) {
      // Already stamped (a prior partial run, or the runner already stamped
      // it live before this backfill caught up) — keep it, and let it seed
      // the tuple/parent chains below.
      conversationId = job.conversation_id;
    } else if (job.parent_job_id) {
      // Delegated / task-board child — same conversation as its creator.
      // The creator was necessarily inserted earlier, so (sorted by
      // created_at) it's already in `resolved` by the time we get here.
      conversationId = resolved.get(job.parent_job_id) ?? null;
    } else if (job.channel === 'dashboard') {
      conversationId = conversationByJobId.get(job.id) ?? null;
    } else if (CONVERSATIONAL_CHANNELS.has(job.channel) && job.chat_id) {
      const prior = tupleState.get(tupleKey);
      if (prior && createdAtMs - prior.deliveredAtMs < idleResetMs) {
        conversationId = prior.conversationId;
      } else {
        conversationId = randomUUID();
      }
    } else {
      conversationId = null;
    }

    resolved.set(job.id, conversationId);

    // Only conversational-channel root jobs feed the gap chain for their own
    // tuple — a delegated child runs on channel='internal' and would never
    // match this branch's channel filter anyway, so this naturally excludes
    // children from the chain.
    if (CONVERSATIONAL_CHANNELS.has(job.channel) && job.chat_id && !job.parent_job_id) {
      tupleState.set(tupleKey, { conversationId, deliveredAtMs });
    }

    if (!job.conversation_id && conversationId) {
      updates.push({ id: job.id, conversationId });
    }
  }

  return { resolved, updates };
}

// ─── CLI entry point (only runs when this file is executed directly, not on import) ──

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }

  // Same default/env-var as apps/runner/src/job/thread-history.ts's
  // IDLE_RESET_MINUTES — reused here so a re-configured install backfills
  // with the same boundary the runner is actually using.
  const idleResetMs = (Number(process.env.THREAD_IDLE_RESET_MINUTES) || 240) * 60_000;

  // 'postgres' is @nodal-agents/db's own dependency, not this repo root's —
  // packages/db's package.json declares it, so resolve it from there rather
  // than requiring a duplicate root-level install (pnpm doesn't hoist by
  // default).
  const here = dirname(fileURLToPath(import.meta.url));
  const require = createRequire(join(here, '..', 'packages', 'db', 'package.json'));
  const postgres = require('postgres');
  const sql = postgres(databaseUrl, { max: 1 });

  console.log(`Backfilling agent_jobs.conversation_id${dryRun ? ' (dry run)' : ''}…`);

  const jobs = await sql`
    SELECT id, parent_job_id, entity_id, agent_id, channel, chat_id,
           created_at, completed_at, conversation_id
    FROM agent_jobs
    ORDER BY created_at ASC, id ASC
  `;

  // chat_messages links a dashboard-chat escalation's job back to the real
  // `conversations` row it came from — the source of truth for that channel.
  const chatLinks = await sql`
    SELECT job_id, conversation_id
    FROM chat_messages
    WHERE job_id IS NOT NULL AND conversation_id IS NOT NULL
  `;

  const { updates } = computeConversationIds(jobs, chatLinks, idleResetMs);

  console.log(`${jobs.length} jobs scanned, ${updates.length} need a conversation_id.`);

  if (dryRun) {
    console.log('Dry run — no rows written.');
    await sql.end();
    return;
  }

  let written = 0;
  for (const u of updates) {
    // Guarded WHERE so a concurrent live write (the runner stamping a brand
    // new job) can never be clobbered — this only ever fills a still-NULL
    // value, exactly the idempotency contract above.
    const result = await sql`
      UPDATE agent_jobs
      SET conversation_id = ${u.conversationId}
      WHERE id = ${u.id} AND conversation_id IS NULL
    `;
    written += result.count;
    if (written % 500 === 0) console.log(`  …${written} written`);
  }

  console.log(`Done. ${written} rows updated.`);
  await sql.end();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
}
