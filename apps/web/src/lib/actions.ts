'use server';

import 'server-only';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { eq, and, desc, agents, agentJobs, agentTasks } from '@nodalai/db';
import { getDb, getAuthProvider } from './server.ts';
import { requireAuth } from '@nodalai/auth';
import { env } from './env.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ActionResult<T = void> =
  | { ok: true; data: T }
  | { ok: false; code: string; message: string };

function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

function fail(code: string, message: string): ActionResult<never> {
  return { ok: false, code, message };
}

// ─── Auth helper ──────────────────────────────────────────────────────────────
// Server Actions don't receive a Request; we pass a dummy one.
// LocalTrustProvider ignores it — safe in local-trust mode.

async function getSession() {
  const provider = getAuthProvider();
  const req = new Request('http://localhost/');
  return requireAuth(req, provider);
}

// ─── Zod schemas (input validation) ──────────────────────────────────────────

const CreateAgentSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with dashes'),
  name: z.string().min(1).max(120),
  personality: z.string().min(1),
  model: z.string().min(1),
});

const SendTaskSchema = z.object({
  title: z.string().min(1).max(200),
  agentId: z.string().uuid('Must select a valid agent'),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
});

// ─── Agent Actions ────────────────────────────────────────────────────────────

export type AgentRow = {
  id: string;
  entityId: string | null;
  name: string;
  slug: string;
  personality: string;
  model: string | null;
  active: boolean | null;
  isDefault: boolean | null;
  role: string | null;
  createdAt: Date | null;
};

export async function listAgentsAction(): Promise<ActionResult<AgentRow[]>> {
  try {
    const session = await getSession();
    const db = getDb();
    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.entityId, session.entityId))
      .orderBy(desc(agents.createdAt));
    return ok(rows as AgentRow[]);
  } catch (err) {
    console.error('[listAgentsAction]', err);
    return fail('db_error', 'Failed to load agents');
  }
}

export async function createAgentAction(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await getSession();
    const parsed = CreateAgentSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const db = getDb();
    const [row] = await db
      .insert(agents)
      .values({
        entityId: session.entityId,
        slug: parsed.data.slug,
        name: parsed.data.name,
        personality: parsed.data.personality,
        model: parsed.data.model,
      })
      .returning({ id: agents.id });
    if (!row) return fail('db_error', 'Insert returned no row');
    revalidatePath('/agents');
    return ok({ id: row.id });
  } catch (err: unknown) {
    console.error('[createAgentAction]', err);
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('unique') || msg.includes('23505')) {
      return fail('conflict', 'An agent with this slug already exists');
    }
    return fail('db_error', 'Failed to create agent');
  }
}

export async function deleteAgentAction(id: string): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().uuid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid agent id');
    }
    const db = getDb();
    // Verify ownership before deleting
    const [existing] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.entityId, session.entityId)));
    if (!existing) return fail('not_found', 'Agent not found');
    await db.delete(agents).where(eq(agents.id, id));
    revalidatePath('/agents');
    return ok(undefined);
  } catch (err) {
    console.error('[deleteAgentAction]', err);
    return fail('db_error', 'Failed to delete agent');
  }
}

// ─── Task / Job Actions ───────────────────────────────────────────────────────

export type AgentTaskRow = {
  id: string;
  entityId: string;
  orchestratorId: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  jobId: string | null;
  result: string | null;
  createdAt: Date;
};

export async function listTasksAction(): Promise<ActionResult<AgentTaskRow[]>> {
  try {
    const session = await getSession();
    const db = getDb();
    const rows = await db
      .select()
      .from(agentTasks)
      .where(eq(agentTasks.entityId, session.entityId))
      .orderBy(desc(agentTasks.createdAt))
      .limit(50);
    return ok(rows as AgentTaskRow[]);
  } catch (err) {
    console.error('[listTasksAction]', err);
    return fail('db_error', 'Failed to load tasks');
  }
}

export type JobRow = {
  id: string;
  entityId: string | null;
  agentId: string | null;
  status: string | null;
  channel: string;
  task: string;
  result: string | null;
  error: string | null;
  chainCount: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  createdAt: Date | null;
  completedAt: Date | null;
};

export type JobDetailRow = JobRow & {
  messages: unknown[];
  systemPrompt: string | null;
  turn: number | null;
  totalDurationMs: number | null;
  delegationDepth: number | null;
};

/**
 * Send a task: creates a job row and fires it to the runner.
 * Uses 'api' channel so the runner knows it came from the dashboard.
 */
export async function sendTaskAction(raw: unknown): Promise<ActionResult<{ jobId: string }>> {
  try {
    const session = await getSession();
    const parsed = SendTaskSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }

    // Verify the agent belongs to this entity
    const db = getDb();
    const [agent] = await db
      .select({ id: agents.id, slug: agents.slug })
      .from(agents)
      .where(and(eq(agents.id, parsed.data.agentId), eq(agents.entityId, session.entityId)));
    if (!agent) return fail('not_found', 'Agent not found');

    // Insert job
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: session.entityId,
        agentId: agent.id,
        status: 'pending',
        channel: 'api',
        task: parsed.data.title,
      })
      .returning({ id: agentJobs.id });
    if (!job) return fail('db_error', 'Failed to create job');

    // Fire-and-forget: wake the runner
    const runnerUrl = `${env.RUNNER_URL}/api/worker`;
    void fetch(runnerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId: job.id }),
    }).catch((err: unknown) => {
      console.error('[sendTaskAction] runner ping failed:', err);
    });

    revalidatePath('/tasks');
    revalidatePath('/jobs');
    return ok({ jobId: job.id });
  } catch (err) {
    console.error('[sendTaskAction]', err);
    return fail('db_error', 'Failed to send task');
  }
}

export async function listJobsAction(
  opts: { limit?: number } = {},
): Promise<ActionResult<JobRow[]>> {
  try {
    const session = await getSession();
    const limit = Math.min(opts.limit ?? 50, 100);
    const db = getDb();
    const rows = await db
      .select({
        id: agentJobs.id,
        entityId: agentJobs.entityId,
        agentId: agentJobs.agentId,
        status: agentJobs.status,
        channel: agentJobs.channel,
        task: agentJobs.task,
        result: agentJobs.result,
        error: agentJobs.error,
        chainCount: agentJobs.chainCount,
        inputTokens: agentJobs.inputTokens,
        outputTokens: agentJobs.outputTokens,
        createdAt: agentJobs.createdAt,
        completedAt: agentJobs.completedAt,
      })
      .from(agentJobs)
      .where(eq(agentJobs.entityId, session.entityId))
      .orderBy(desc(agentJobs.createdAt))
      .limit(limit);
    return ok(rows as JobRow[]);
  } catch (err) {
    console.error('[listJobsAction]', err);
    return fail('db_error', 'Failed to load jobs');
  }
}

export async function getJobDetailAction(id: string): Promise<ActionResult<JobDetailRow>> {
  try {
    const session = await getSession();
    if (!z.string().uuid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid job id');
    }
    const db = getDb();
    const [row] = await db
      .select()
      .from(agentJobs)
      .where(and(eq(agentJobs.id, id), eq(agentJobs.entityId, session.entityId)));
    if (!row) return fail('not_found', 'Job not found');
    return ok(row as JobDetailRow);
  } catch (err) {
    console.error('[getJobDetailAction]', err);
    return fail('db_error', 'Failed to load job');
  }
}

export async function getJobStatusAction(
  id: string,
): Promise<ActionResult<{ status: string; result: string | null; error: string | null }>> {
  try {
    const session = await getSession();
    if (!z.string().uuid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid job id');
    }
    const db = getDb();
    const [row] = await db
      .select({
        status: agentJobs.status,
        result: agentJobs.result,
        error: agentJobs.error,
      })
      .from(agentJobs)
      .where(and(eq(agentJobs.id, id), eq(agentJobs.entityId, session.entityId)));
    if (!row) return fail('not_found', 'Job not found');
    return ok({
      status: row.status ?? 'pending',
      result: row.result,
      error: row.error,
    });
  } catch (err) {
    console.error('[getJobStatusAction]', err);
    return fail('db_error', 'Failed to load job status');
  }
}
