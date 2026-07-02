// routes/agent.ts — POST /api/agent — create a pending job, optionally trigger
// 1:1 with legacy api/agent.py async mode
//
// POST /api/agent { agentSlug, task, channel?, chatId?, parentJobId? } → { jobId }

import type { Context } from 'hono';
import { z } from 'zod';
import { eq, and } from '@nodal-agents/db';
import { agentJobs, agents } from '@nodal-agents/db';
import type { RunnerDeps } from '../deps.ts';
import type { RunnerEnv } from '../env.ts';

// ─── Request schema ───────────────────────────────────────────────────────────

export const AgentRequestSchema = z.object({
  task: z.string().min(1).max(200_000), // generous: large pasted tasks / skill content
  agentSlug: z.string().optional(),
  channel: z
    .enum(['telegram', 'api', 'whatsapp', 'internal', 'cron', 'task-board', 'slack', 'discord'])
    .default('api'),
  chatId: z.string().optional().nullable(),
  parentJobId: z.string().guid().optional().nullable(),
  triggerImmediately: z.boolean().default(true),
});

export type AgentRequest = z.infer<typeof AgentRequestSchema>;

// ─── agentRoute ───────────────────────────────────────────────────────────────

export async function agentRoute(
  c: Context,
  deps: RunnerDeps,
  runnerEnv: RunnerEnv,
): Promise<Response> {
  // Parse + validate body
  const body = await c.req.json().catch(() => null);
  const parsed = AgentRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const { task, agentSlug, channel, chatId, parentJobId, triggerImmediately } = parsed.data;

  // Resolve agentSlug → agentId (entity-scoped via caller — finding #4/#5).
  // A trusted caller (web via WORKER_SECRET, local-trust) may or may not
  // forward a session cookie — no cookie means a global caller (cron/
  // internal/Telegram dispatch has no entity to scope to), so it keeps the
  // pre-existing session-or-null fallback. An UNTRUSTED session bearer-token
  // caller is never allowed to fall through to that global (entityId=null,
  // cross-entity) slug resolution below — its entity is always its own
  // session's, taken from the auth context requireRunnerAuth already
  // verified (never null, since that path requires a session to pass).
  const callerTrusted = c.get('callerTrusted');
  let entityId: string | null;
  if (callerTrusted) {
    const session = await deps.authProvider.getSession(c.req.raw);
    entityId = session?.entityId ?? null;
  } else {
    entityId = c.get('callerEntityId') ?? null;
  }

  let agentId: string | null = null;

  if (agentSlug) {
    const conditions = [eq(agents.slug, agentSlug), eq(agents.active, true)];
    if (entityId) {
      conditions.push(eq(agents.entityId, entityId));
    }

    const agentRows = await deps.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(...conditions))
      .limit(1);

    if (agentRows.length === 0) {
      return c.json({ error: 'agent_not_found', agentSlug }, 400);
    }
    agentId = agentRows[0]?.id ?? null;
  } else {
    // Default: find the entity's default agent
    const defaultAgentRows = await deps.db
      .select({ id: agents.id })
      .from(agents)
      .where(
        entityId
          ? and(eq(agents.entityId, entityId), eq(agents.isDefault, true), eq(agents.active, true))
          : and(eq(agents.isDefault, true), eq(agents.active, true)),
      )
      .limit(1);
    agentId = defaultAgentRows[0]?.id ?? null;
  }

  // Create the job row
  const [job] = await deps.db
    .insert(agentJobs)
    .values({
      entityId: entityId ?? undefined,
      agentId: agentId ?? undefined,
      channel,
      task,
      chatId: chatId ?? undefined,
      parentJobId: parentJobId ?? undefined,
      status: 'pending',
      messages: [{ role: 'user', content: task }],
    })
    .returning({ id: agentJobs.id });

  if (!job) {
    return c.json({ error: 'job_creation_failed' }, 500);
  }

  // Trigger immediately (fire-and-forget to /api/worker)
  if (triggerImmediately) {
    void triggerWorker(job.id, runnerEnv);
  }

  return c.json({ jobId: job.id, status: 'pending' }, 202);
}

// ─── triggerWorker helper ─────────────────────────────────────────────────────

/**
 * Fire-and-forget POST to /api/worker.
 * Exported so routes/telegram.ts and other callers can reuse it.
 */
export async function triggerWorker(jobId: string, runnerEnv: RunnerEnv): Promise<void> {
  const baseUrl = runnerEnv.APP_URL ?? 'http://localhost:3001';
  const url = `${baseUrl}/api/worker`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (runnerEnv.WORKER_SECRET) {
    headers['Authorization'] = `Bearer ${runnerEnv.WORKER_SECRET}`;
  }

  void fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jobId }),
  }).catch(() => {
    // Ignored — orphan detection in cron will recover stuck jobs
  });
}
