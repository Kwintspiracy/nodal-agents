'use server';

import 'server-only';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { z } from 'zod';
import {
  eq,
  and,
  desc,
  inArray,
  agents,
  agentAssignments,
  agentJobs,
  agentTasks,
} from '@nodalai/db';
import { DeliveryError, getTelegramBotInfo, getTelegramUpdates } from '@nodalai/delivery';
import {
  listMemories,
  deleteMemory,
  updateMemory,
  MemoryNotFoundError,
} from '@nodalai/memory';
import type { AgentMemory } from '@nodalai/shared';
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
// Server Actions don't receive a Request directly, but we can reconstruct one
// from the request headers (including cookies) via next/headers.
// This is critical for local-auth mode: better-auth needs the session cookie
// to resolve the authenticated user. LocalTrustProvider ignores the request,
// so the same code path works in both modes.

async function getSession() {
  const provider = getAuthProvider();
  // headers() throws outside a Next.js request scope (e.g. unit tests).
  // Fall back to an empty request — LocalTrustProvider ignores it anyway,
  // and tests inject their own auth state separately.
  let req: Request;
  try {
    const h = await headers();
    req = new Request('http://localhost/', { headers: h });
  } catch {
    req = new Request('http://localhost/');
  }
  return requireAuth(req, provider);
}

// ─── Zod schemas (input validation) ──────────────────────────────────────────

const CreateAgentSchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with dashes'),
    name: z.string().min(1).max(120),
    personality: z.string().min(1),
    model: z.string().min(1),
    role: z.enum(['worker', 'router', 'planner']).default('worker'),
    subAgentIds: z.array(z.string().uuid()).default([]),
  })
  .refine((d) => d.role !== 'worker' || d.subAgentIds.length === 0, {
    message: 'Sub-agents only apply when role is router or planner',
    path: ['subAgentIds'],
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
    const { role, subAgentIds } = parsed.data;
    const db = getDb();

    // Verify all sub-agents exist in the same entity. We do this BEFORE the
    // insert so we don't end up with a half-created orchestrator pointing at
    // ghost sub-agents.
    if (subAgentIds.length > 0) {
      const found = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(inArray(agents.id, subAgentIds), eq(agents.entityId, session.entityId)));
      if (found.length !== subAgentIds.length) {
        return fail('validation_failed', 'One or more sub-agents not found in this workspace');
      }
    }

    // role/orchestrator_mode mapping. The DB enum is { agent, orchestrator,
    // system } — we expose a friendlier UX-level enum (worker/router/planner)
    // and translate here.
    const dbRole = role === 'worker' ? 'agent' : 'orchestrator';
    const orchestratorMode = role === 'worker' ? null : role;

    const [row] = await db
      .insert(agents)
      .values({
        entityId: session.entityId,
        slug: parsed.data.slug,
        name: parsed.data.name,
        personality: parsed.data.personality,
        model: parsed.data.model,
        role: dbRole,
        orchestratorMode,
      })
      .returning({ id: agents.id });
    if (!row) return fail('db_error', 'Insert returned no row');

    if (subAgentIds.length > 0) {
      await db.insert(agentAssignments).values(
        subAgentIds.map((subId) => ({
          orchestratorId: row.id,
          subAgentId: subId,
          entityId: session.entityId,
        })),
      );
    }

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
  parentJobId: string | null;
  agentName: string | null;
  agentSlug: string | null;
  /** Direct children (delegated jobs) — id, agent, status. */
  children: Array<{
    id: string;
    agentName: string | null;
    agentSlug: string | null;
    status: string | null;
    result: string | null;
    error: string | null;
    createdAt: Date | null;
    completedAt: Date | null;
  }>;
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

    // Fire-and-forget: wake the runner. The /api/worker route requires the
    // shared WORKER_SECRET as a bearer token — without it the runner 403s
    // silently and the job stays `pending` forever.
    const runnerUrl = `${env.RUNNER_URL}/api/worker`;
    if (!env.WORKER_SECRET) {
      console.error('[sendTaskAction] WORKER_SECRET missing — cannot ping runner');
    } else {
      void fetch(runnerUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.WORKER_SECRET}`,
        },
        body: JSON.stringify({ jobId: job.id }),
      }).catch((err: unknown) => {
        console.error('[sendTaskAction] runner ping failed:', err);
      });
    }

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

    // Job + the agent that ran it. Left-join because legacy / orphaned jobs
    // may have a null agent_id.
    const [row] = await db
      .select({
        job: agentJobs,
        agentName: agents.name,
        agentSlug: agents.slug,
      })
      .from(agentJobs)
      .leftJoin(agents, eq(agents.id, agentJobs.agentId))
      .where(and(eq(agentJobs.id, id), eq(agentJobs.entityId, session.entityId)));

    if (!row) return fail('not_found', 'Job not found');

    // Children (delegated jobs whose parent_job_id is this one).
    const childRows = await db
      .select({
        id: agentJobs.id,
        agentName: agents.name,
        agentSlug: agents.slug,
        status: agentJobs.status,
        result: agentJobs.result,
        error: agentJobs.error,
        createdAt: agentJobs.createdAt,
        completedAt: agentJobs.completedAt,
      })
      .from(agentJobs)
      .leftJoin(agents, eq(agents.id, agentJobs.agentId))
      .where(eq(agentJobs.parentJobId, id))
      .orderBy(agentJobs.createdAt);

    return ok({
      ...(row.job as Omit<JobDetailRow, 'agentName' | 'agentSlug' | 'children'>),
      agentName: row.agentName,
      agentSlug: row.agentSlug,
      children: childRows,
    });
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

// ─── Telegram Actions ─────────────────────────────────────────────────────────
//
// Each agent can have its own Telegram bot. The user pastes a bot token from
// BotFather, we validate it via `getMe`, and persist token + bot username.
// The runner's TelegramManager picks up the new token within ~30s and starts
// long-polling Telegram for that bot — no public URL required, since this is
// a local-first product.

export type TelegramConfigStatus = 'connected' | 'disconnected';

export type TelegramConfigRow = {
  agentId: string;
  agentSlug: string;
  agentName: string;
  status: TelegramConfigStatus;
  botUsername: string | null;
};

const ConfigureTelegramSchema = z.object({
  agentId: z.string().uuid(),
  botToken: z
    .string()
    .min(20, 'Token looks too short')
    .max(200, 'Token looks too long')
    .regex(/^\d+:[A-Za-z0-9_-]+$/, 'Token must look like 123456789:AAAAA...'),
});

export async function getAgentTelegramConfigAction(
  agentId: string,
): Promise<ActionResult<TelegramConfigRow>> {
  try {
    const session = await getSession();
    if (!z.string().uuid().safeParse(agentId).success) {
      return fail('validation_failed', 'Invalid agent id');
    }

    const db = getDb();
    const [row] = await db
      .select({
        id: agents.id,
        slug: agents.slug,
        name: agents.name,
        botToken: agents.telegramBotToken,
        botUsername: agents.telegramBotUsername,
      })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.entityId, session.entityId)));

    if (!row) return fail('not_found', 'Agent not found');

    return ok({
      agentId: row.id,
      agentSlug: row.slug,
      agentName: row.name,
      status: row.botToken ? 'connected' : 'disconnected',
      botUsername: row.botUsername,
    });
  } catch (err) {
    console.error('[getAgentTelegramConfigAction]', err);
    return fail('db_error', 'Failed to load Telegram config');
  }
}

export async function configureAgentTelegramAction(
  raw: unknown,
): Promise<ActionResult<TelegramConfigRow>> {
  try {
    const session = await getSession();
    const parsed = ConfigureTelegramSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const { agentId, botToken } = parsed.data;

    const db = getDb();
    const [agent] = await db
      .select({ id: agents.id, slug: agents.slug, name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.entityId, session.entityId)));
    if (!agent) return fail('not_found', 'Agent not found');

    // Validate the token against Telegram's getMe. We need the bot's
    // username for display anyway, and getMe doubles as a token check.
    let botInfo: Awaited<ReturnType<typeof getTelegramBotInfo>>;
    try {
      botInfo = await getTelegramBotInfo(botToken);
    } catch (err) {
      if (err instanceof DeliveryError && err.code === 'telegram_invalid_token') {
        return fail(
          'telegram_invalid_token',
          'Telegram rejected this token. Double-check it from @BotFather.',
        );
      }
      throw err;
    }

    // Drain any backlog Telegram has buffered for this bot. Otherwise the
    // poller would replay messages sent BEFORE the (re)connect — including
    // ones sent during a disconnected window — which surprises the user
    // ("why is the bot answering my old messages?"). One getUpdates(-1, 0)
    // call fetches the latest pending update; we set the next offset to
    // that.update_id + 1 so the poller starts from "now".
    let initialOffset = 0;
    try {
      const recent = await getTelegramUpdates({
        botToken,
        offset: -1,
        timeout: 0,
        limit: 1,
      });
      if (recent.length > 0) {
        initialOffset = Math.max(...recent.map((u) => u.update_id)) + 1;
      }
    } catch {
      // Best-effort drain. If this single call fails (network blip), we
      // accept the small UX regression — the poller will still work, just
      // potentially replay a few seconds of backlog.
    }

    // Persist. The runner's TelegramManager will pick this up on its next
    // refresh tick (~30s) and start long-polling Telegram for this bot.
    await db
      .update(agents)
      .set({
        telegramBotToken: botToken,
        telegramBotUsername: botInfo.username,
        telegramOffset: initialOffset,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));

    revalidatePath('/agents');
    revalidatePath(`/agents/${agentId}/telegram`);

    return ok({
      agentId: agent.id,
      agentSlug: agent.slug,
      agentName: agent.name,
      status: 'connected',
      botUsername: botInfo.username,
    });
  } catch (err) {
    console.error('[configureAgentTelegramAction]', err);
    return fail('db_error', 'Failed to configure Telegram');
  }
}

export async function disconnectAgentTelegramAction(
  agentId: string,
): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().uuid().safeParse(agentId).success) {
      return fail('validation_failed', 'Invalid agent id');
    }
    const db = getDb();
    const [row] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.entityId, session.entityId)));
    if (!row) return fail('not_found', 'Agent not found');

    // Clear the token. The runner's TelegramManager will detect this on its
    // next refresh tick and abort the poller for this agent.
    await db
      .update(agents)
      .set({
        telegramBotToken: null,
        telegramBotUsername: null,
        telegramOffset: null,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, agentId));

    revalidatePath('/agents');
    revalidatePath(`/agents/${agentId}/telegram`);
    return ok(undefined);
  } catch (err) {
    console.error('[disconnectAgentTelegramAction]', err);
    return fail('db_error', 'Failed to disconnect Telegram');
  }
}

// ─── Memory Actions ───────────────────────────────────────────────────────────

const MEMORY_CATEGORIES = ['preference', 'context', 'outcome', 'learned_rule'] as const;
type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

const ListMemoriesSchema = z.object({
  agentId: z.string().uuid().optional(),
  category: z.enum(MEMORY_CATEGORIES).optional(),
  tag: z.string().min(1).max(80).optional(),
  archived: z.boolean().default(false),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
});

export type MemoryListRow = AgentMemory & {
  agentName: string | null;
  agentSlug: string | null;
};

export type MemoryListResult = {
  items: MemoryListRow[];
  page: number;
  pageSize: number;
  totalCount: number;
  hasMore: boolean;
};

export async function listMemoriesAction(
  raw: unknown = {},
): Promise<ActionResult<MemoryListResult>> {
  try {
    const session = await getSession();
    const parsed = ListMemoriesSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const db = getDb();

    const result = await listMemories(db, {
      entityId: session.entityId,
      agentId: parsed.data.agentId,
      category: parsed.data.category as MemoryCategory | undefined,
      tags: parsed.data.tag ? [parsed.data.tag] : undefined,
      archived: parsed.data.archived,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      sort: 'recent',
    });

    // Resolve agent name+slug for each unique agentId in the page so the UI
    // can render a friendly label instead of a raw uuid. Single roundtrip.
    const agentIds = Array.from(
      new Set(result.items.map((m) => m.agent_id).filter((x): x is string => x !== null)),
    );
    const agentLookup = new Map<string, { name: string; slug: string }>();
    if (agentIds.length > 0) {
      const rows = await db
        .select({ id: agents.id, name: agents.name, slug: agents.slug })
        .from(agents)
        .where(inArray(agents.id, agentIds));
      for (const r of rows) agentLookup.set(r.id, { name: r.name, slug: r.slug });
    }

    const items: MemoryListRow[] = result.items.map((m) => {
      const agent = m.agent_id ? agentLookup.get(m.agent_id) : null;
      return {
        ...m,
        agentName: agent?.name ?? null,
        agentSlug: agent?.slug ?? null,
      };
    });

    return ok({
      items,
      page: result.page,
      pageSize: result.pageSize,
      totalCount: result.totalCount,
      hasMore: result.hasMore,
    });
  } catch (err) {
    console.error('[listMemoriesAction]', err);
    return fail('db_error', 'Failed to load memories');
  }
}

export async function archiveMemoryAction(id: string): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().uuid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid memory id');
    }
    const db = getDb();
    await updateMemory(db, id, session.entityId, { archived: true });
    revalidatePath('/memories');
    return ok(undefined);
  } catch (err) {
    if (err instanceof MemoryNotFoundError) {
      return fail('not_found', 'Memory not found');
    }
    console.error('[archiveMemoryAction]', err);
    return fail('db_error', 'Failed to archive memory');
  }
}

export async function unarchiveMemoryAction(id: string): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().uuid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid memory id');
    }
    const db = getDb();
    await updateMemory(db, id, session.entityId, { archived: false });
    revalidatePath('/memories');
    return ok(undefined);
  } catch (err) {
    if (err instanceof MemoryNotFoundError) {
      return fail('not_found', 'Memory not found');
    }
    console.error('[unarchiveMemoryAction]', err);
    return fail('db_error', 'Failed to unarchive memory');
  }
}

export async function deleteMemoryAction(id: string): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().uuid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid memory id');
    }
    const db = getDb();
    await deleteMemory(db, id, session.entityId);
    revalidatePath('/memories');
    return ok(undefined);
  } catch (err) {
    if (err instanceof MemoryNotFoundError) {
      return fail('not_found', 'Memory not found');
    }
    console.error('[deleteMemoryAction]', err);
    return fail('db_error', 'Failed to delete memory');
  }
}
