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
  sql,
  agents,
  agentAssignments,
  agentJobs,
  agentTasks,
  connectors,
  approvalRequests,
  agentSkills,
  agentSkillAssignments,
  toolCalls,
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

// ─── Connector Actions ────────────────────────────────────────────────────────

const CONNECTOR_AUTH_TYPES = ['api_key', 'oauth2', 'bearer', 'basic', 'none'] as const;
type ConnectorAuthType = (typeof CONNECTOR_AUTH_TYPES)[number];

/**
 * Catalog of adapter slugs the runner knows about. UI surfaces these so the
 * user picks from a list instead of typing a slug that no adapter listens to.
 * Order matters: we render them in this order on the page.
 */
export const CONNECTOR_CATALOG = [
  {
    slug: 'notion',
    label: 'Notion',
    authType: 'api_key' as ConnectorAuthType,
    docsHint: 'Create a Notion integration at notion.so/my-integrations and copy its internal secret.',
  },
  {
    slug: 'google-drive',
    label: 'Google Drive',
    authType: 'oauth2' as ConnectorAuthType,
    docsHint: 'OAuth flow not yet automated — paste raw tokens (clientId, clientSecret, refreshToken).',
  },
  {
    slug: 'gmail',
    label: 'Gmail',
    authType: 'oauth2' as ConnectorAuthType,
    docsHint: 'OAuth flow not yet automated — paste raw tokens (clientId, clientSecret, refreshToken).',
  },
  {
    slug: 'google-sheets',
    label: 'Google Sheets',
    authType: 'oauth2' as ConnectorAuthType,
    docsHint: 'OAuth flow not yet automated — paste raw tokens (clientId, clientSecret, refreshToken).',
  },
  {
    slug: 'google-docs',
    label: 'Google Docs',
    authType: 'oauth2' as ConnectorAuthType,
    docsHint: 'OAuth flow not yet automated — paste raw tokens (clientId, clientSecret, refreshToken).',
  },
] as const;

export type ConnectorRow = {
  id: string;
  slug: string;
  name: string;
  authType: string;
  active: boolean;
  hasApiKey: boolean;
  hasOauthAccessToken: boolean;
  hasOauthRefreshToken: boolean;
  oauthAccountName: string | null;
  oauthClientId: string | null;
  oauthScopes: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type ConnectorListEntry = {
  catalogSlug: string;
  label: string;
  authType: ConnectorAuthType;
  docsHint: string;
  /** Configured connector for this slug, if any. */
  connector: ConnectorRow | null;
};

export async function listConnectorsAction(): Promise<ActionResult<ConnectorListEntry[]>> {
  try {
    const session = await getSession();
    const db = getDb();
    const rows = await db
      .select()
      .from(connectors)
      .where(eq(connectors.entityId, session.entityId));

    const bySlug = new Map<string, (typeof rows)[number]>();
    for (const r of rows) bySlug.set(r.slug, r);

    const entries: ConnectorListEntry[] = CONNECTOR_CATALOG.map((c) => {
      const row = bySlug.get(c.slug);
      return {
        catalogSlug: c.slug,
        label: c.label,
        authType: c.authType,
        docsHint: c.docsHint,
        connector: row
          ? {
              id: row.id,
              slug: row.slug,
              name: row.name,
              authType: row.authType,
              active: row.active ?? true,
              hasApiKey: !!row.apiKey,
              hasOauthAccessToken: !!row.oauthAccessToken,
              hasOauthRefreshToken: !!row.oauthRefreshToken,
              oauthAccountName: row.oauthAccountName,
              oauthClientId: row.oauthClientId,
              oauthScopes: row.oauthScopes,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            }
          : null,
      };
    });

    return ok(entries);
  } catch (err) {
    console.error('[listConnectorsAction]', err);
    return fail('db_error', 'Failed to load connectors');
  }
}

const SaveApiKeyConnectorSchema = z.object({
  slug: z.string().min(1).max(80),
  name: z.string().min(1).max(120).optional(),
  apiKey: z.string().min(1, 'API key is required'),
});

export async function saveApiKeyConnectorAction(
  raw: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await getSession();
    const parsed = SaveApiKeyConnectorSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const catalog = CONNECTOR_CATALOG.find((c) => c.slug === parsed.data.slug);
    if (!catalog) {
      return fail('validation_failed', 'Unknown connector slug');
    }
    if (catalog.authType !== 'api_key') {
      return fail(
        'validation_failed',
        `Connector ${parsed.data.slug} uses ${catalog.authType}, not api_key`,
      );
    }

    const db = getDb();
    const [existing] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(eq(connectors.entityId, session.entityId), eq(connectors.slug, parsed.data.slug)));

    const name = parsed.data.name ?? catalog.label;

    if (existing) {
      await db
        .update(connectors)
        .set({
          name,
          apiKey: parsed.data.apiKey,
          authType: 'api_key',
          active: true,
          updatedAt: new Date(),
        })
        .where(eq(connectors.id, existing.id));
      revalidatePath('/connectors');
      return ok({ id: existing.id });
    }

    const [row] = await db
      .insert(connectors)
      .values({
        entityId: session.entityId,
        slug: parsed.data.slug,
        name,
        apiKey: parsed.data.apiKey,
        authType: 'api_key',
        active: true,
      })
      .returning({ id: connectors.id });
    if (!row) return fail('db_error', 'Insert returned no row');
    revalidatePath('/connectors');
    return ok({ id: row.id });
  } catch (err) {
    console.error('[saveApiKeyConnectorAction]', err);
    return fail('db_error', 'Failed to save connector');
  }
}

const SaveOauthConnectorSchema = z.object({
  slug: z.string().min(1).max(80),
  name: z.string().min(1).max(120).optional(),
  oauthClientId: z.string().min(1, 'Client ID is required'),
  oauthClientSecret: z.string().min(1, 'Client secret is required'),
  oauthRefreshToken: z.string().min(1, 'Refresh token is required'),
  oauthAccessToken: z.string().optional(),
  oauthTokenUrl: z.string().url().optional(),
  oauthScopes: z.string().optional(),
  oauthAccountName: z.string().optional(),
});

export async function saveOauthConnectorAction(
  raw: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await getSession();
    const parsed = SaveOauthConnectorSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const catalog = CONNECTOR_CATALOG.find((c) => c.slug === parsed.data.slug);
    if (!catalog) {
      return fail('validation_failed', 'Unknown connector slug');
    }
    if (catalog.authType !== 'oauth2') {
      return fail(
        'validation_failed',
        `Connector ${parsed.data.slug} uses ${catalog.authType}, not oauth2`,
      );
    }

    const db = getDb();
    const [existing] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(eq(connectors.entityId, session.entityId), eq(connectors.slug, parsed.data.slug)));

    const name = parsed.data.name ?? catalog.label;
    const fields = {
      name,
      authType: 'oauth2' as const,
      active: true,
      oauthClientId: parsed.data.oauthClientId,
      oauthClientSecret: parsed.data.oauthClientSecret,
      oauthRefreshToken: parsed.data.oauthRefreshToken,
      oauthAccessToken: parsed.data.oauthAccessToken ?? null,
      oauthTokenUrl: parsed.data.oauthTokenUrl ?? null,
      oauthScopes: parsed.data.oauthScopes ?? null,
      oauthAccountName: parsed.data.oauthAccountName ?? null,
    };

    if (existing) {
      await db
        .update(connectors)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(connectors.id, existing.id));
      revalidatePath('/connectors');
      return ok({ id: existing.id });
    }

    const [row] = await db
      .insert(connectors)
      .values({
        entityId: session.entityId,
        slug: parsed.data.slug,
        ...fields,
      })
      .returning({ id: connectors.id });
    if (!row) return fail('db_error', 'Insert returned no row');
    revalidatePath('/connectors');
    return ok({ id: row.id });
  } catch (err) {
    console.error('[saveOauthConnectorAction]', err);
    return fail('db_error', 'Failed to save connector');
  }
}

export async function deleteConnectorAction(id: string): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().uuid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid connector id');
    }
    const db = getDb();
    const [existing] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(eq(connectors.id, id), eq(connectors.entityId, session.entityId)));
    if (!existing) return fail('not_found', 'Connector not found');
    await db.delete(connectors).where(eq(connectors.id, id));
    revalidatePath('/connectors');
    return ok(undefined);
  } catch (err) {
    console.error('[deleteConnectorAction]', err);
    return fail('db_error', 'Failed to delete connector');
  }
}

// ─── Approval Actions ─────────────────────────────────────────────────────────

export type ApprovalRow = {
  id: string;
  jobId: string;
  agentId: string | null;
  agentName: string | null;
  agentSlug: string | null;
  toolName: string;
  toolInput: unknown;
  status: string;
  requestedAt: Date | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  expiresAt: Date | null;
  notes: string | null;
  jobTask: string | null;
};

export async function listApprovalsAction(
  opts: { status?: 'pending' | 'approved' | 'rejected' | 'expired' | 'all' } = {},
): Promise<ActionResult<ApprovalRow[]>> {
  try {
    const session = await getSession();
    const db = getDb();
    const status = opts.status ?? 'pending';

    const baseConditions = eq(approvalRequests.entityId, session.entityId);
    const where =
      status === 'all' ? baseConditions : and(baseConditions, eq(approvalRequests.status, status));

    const rows = await db
      .select({
        id: approvalRequests.id,
        jobId: approvalRequests.jobId,
        agentId: approvalRequests.agentId,
        agentName: agents.name,
        agentSlug: agents.slug,
        toolName: approvalRequests.toolName,
        toolInput: approvalRequests.toolInput,
        status: approvalRequests.status,
        requestedAt: approvalRequests.requestedAt,
        resolvedAt: approvalRequests.resolvedAt,
        resolvedBy: approvalRequests.resolvedBy,
        expiresAt: approvalRequests.expiresAt,
        notes: approvalRequests.notes,
        jobTask: agentJobs.task,
      })
      .from(approvalRequests)
      .leftJoin(agents, eq(agents.id, approvalRequests.agentId))
      .leftJoin(agentJobs, eq(agentJobs.id, approvalRequests.jobId))
      .where(where)
      .orderBy(desc(approvalRequests.requestedAt))
      .limit(100);

    return ok(
      rows.map((r) => ({
        ...r,
        status: r.status ?? 'pending',
      })) as ApprovalRow[],
    );
  } catch (err) {
    console.error('[listApprovalsAction]', err);
    return fail('db_error', 'Failed to load approvals');
  }
}

const ResolveApprovalSchema = z.object({
  approvalRequestId: z.string().uuid(),
  decision: z.enum(['approve', 'reject']),
  notes: z.string().max(500).optional(),
});

/**
 * Resolve an approval request by calling the runner's /api/approve endpoint.
 * The runner mutates the parent job's messages, marks the approval row, and
 * resumes the worker — single source of truth for resolution logic.
 *
 * Auth: signs the request with WORKER_SECRET (the runner's /api/approve
 * middleware accepts session OR bearer; cross-process cookies don't work).
 */
export async function resolveApprovalAction(
  raw: unknown,
): Promise<ActionResult<{ jobId: string; decision: string }>> {
  try {
    await getSession();
    const parsed = ResolveApprovalSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    if (!env.WORKER_SECRET) {
      console.error('[resolveApprovalAction] WORKER_SECRET missing');
      return fail('config_error', 'WORKER_SECRET is not set');
    }

    const url = `${env.RUNNER_URL}/api/approve`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.WORKER_SECRET}`,
        },
        body: JSON.stringify(parsed.data),
      });
    } catch (err) {
      console.error('[resolveApprovalAction] fetch failed', err);
      return fail('runner_unreachable', 'Runner did not respond');
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      const code = body.error ?? `runner_${res.status}`;
      return fail(code, `Runner rejected: ${code}`);
    }

    const body = (await res.json()) as { jobId: string; decision: string };
    revalidatePath('/approvals');
    revalidatePath('/jobs');
    revalidatePath(`/jobs/${body.jobId}`);
    return ok({ jobId: body.jobId, decision: body.decision });
  } catch (err) {
    console.error('[resolveApprovalAction]', err);
    return fail('db_error', 'Failed to resolve approval');
  }
}

// ─── Skill Actions ────────────────────────────────────────────────────────────

export type SkillRow = {
  id: string;
  name: string;
  slug: string;
  content: string;
  description: string | null;
  active: boolean;
  requiredBuiltins: string[];
  assignmentCount: number;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export async function listSkillsAction(): Promise<ActionResult<SkillRow[]>> {
  try {
    const session = await getSession();
    const db = getDb();

    const rows = await db
      .select({
        id: agentSkills.id,
        name: agentSkills.name,
        slug: agentSkills.slug,
        content: agentSkills.content,
        description: agentSkills.description,
        active: agentSkills.active,
        requiredBuiltins: agentSkills.requiredBuiltins,
        createdAt: agentSkills.createdAt,
        updatedAt: agentSkills.updatedAt,
      })
      .from(agentSkills)
      .where(eq(agentSkills.entityId, session.entityId))
      .orderBy(desc(agentSkills.updatedAt));

    if (rows.length === 0) return ok([]);

    // Tally assignments per skill in a single roundtrip.
    const tallies = await db
      .select({
        skillId: agentSkillAssignments.skillId,
        c: sql<string>`count(*)`,
      })
      .from(agentSkillAssignments)
      .where(
        and(
          eq(agentSkillAssignments.entityId, session.entityId),
          inArray(
            agentSkillAssignments.skillId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .groupBy(agentSkillAssignments.skillId);

    const tallyMap = new Map<string, number>();
    for (const t of tallies) tallyMap.set(t.skillId, Number(t.c));

    return ok(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        content: r.content,
        description: r.description,
        active: r.active ?? true,
        requiredBuiltins: (r.requiredBuiltins as string[] | null) ?? [],
        assignmentCount: tallyMap.get(r.id) ?? 0,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    );
  } catch (err) {
    console.error('[listSkillsAction]', err);
    return fail('db_error', 'Failed to load skills');
  }
}

const CreateSkillSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with dashes'),
  name: z.string().min(1).max(120),
  content: z.string().min(1),
  description: z.string().max(500).optional(),
});

export async function createSkillAction(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await getSession();
    const parsed = CreateSkillSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const db = getDb();
    const [row] = await db
      .insert(agentSkills)
      .values({
        entityId: session.entityId,
        slug: parsed.data.slug,
        name: parsed.data.name,
        content: parsed.data.content,
        defaultContent: parsed.data.content,
        description: parsed.data.description ?? null,
        active: true,
      })
      .returning({ id: agentSkills.id });
    if (!row) return fail('db_error', 'Insert returned no row');
    revalidatePath('/skills');
    return ok({ id: row.id });
  } catch (err: unknown) {
    console.error('[createSkillAction]', err);
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('unique') || msg.includes('23505')) {
      return fail('conflict', 'A skill with this slug already exists');
    }
    return fail('db_error', 'Failed to create skill');
  }
}

export async function deleteSkillAction(id: string): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().uuid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid skill id');
    }
    const db = getDb();
    const [existing] = await db
      .select({ id: agentSkills.id })
      .from(agentSkills)
      .where(and(eq(agentSkills.id, id), eq(agentSkills.entityId, session.entityId)));
    if (!existing) return fail('not_found', 'Skill not found');
    // The schema has ON DELETE CASCADE on agent_skill_assignments, so
    // assignments are cleared automatically.
    await db.delete(agentSkills).where(eq(agentSkills.id, id));
    revalidatePath('/skills');
    return ok(undefined);
  } catch (err) {
    console.error('[deleteSkillAction]', err);
    return fail('db_error', 'Failed to delete skill');
  }
}

const SkillAssignmentSchema = z.object({
  skillId: z.string().uuid(),
  agentId: z.string().uuid(),
});

export type SkillAssignmentRow = {
  agentId: string;
  agentName: string;
  agentSlug: string;
  assigned: boolean;
};

/**
 * For a skill, return every agent in the entity with whether the skill is
 * currently assigned. Powers the per-skill assignment toggle UI.
 */
export async function listSkillAssignmentsAction(
  skillId: string,
): Promise<ActionResult<SkillAssignmentRow[]>> {
  try {
    const session = await getSession();
    if (!z.string().uuid().safeParse(skillId).success) {
      return fail('validation_failed', 'Invalid skill id');
    }
    const db = getDb();
    const [skill] = await db
      .select({ id: agentSkills.id })
      .from(agentSkills)
      .where(and(eq(agentSkills.id, skillId), eq(agentSkills.entityId, session.entityId)));
    if (!skill) return fail('not_found', 'Skill not found');

    const allAgents = await db
      .select({ id: agents.id, name: agents.name, slug: agents.slug })
      .from(agents)
      .where(eq(agents.entityId, session.entityId))
      .orderBy(agents.name);

    const assignments = await db
      .select({ agentId: agentSkillAssignments.agentId })
      .from(agentSkillAssignments)
      .where(eq(agentSkillAssignments.skillId, skillId));
    const assigned = new Set(assignments.map((a) => a.agentId));

    return ok(
      allAgents.map((a) => ({
        agentId: a.id,
        agentName: a.name,
        agentSlug: a.slug,
        assigned: assigned.has(a.id),
      })),
    );
  } catch (err) {
    console.error('[listSkillAssignmentsAction]', err);
    return fail('db_error', 'Failed to load skill assignments');
  }
}

export async function assignSkillAction(raw: unknown): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = SkillAssignmentSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const db = getDb();

    // Confirm both rows belong to the entity (defence in depth — a forged
    // request shouldn't be able to point one entity's skill at another's
    // agent).
    const [skill] = await db
      .select({ id: agentSkills.id })
      .from(agentSkills)
      .where(and(eq(agentSkills.id, parsed.data.skillId), eq(agentSkills.entityId, session.entityId)));
    if (!skill) return fail('not_found', 'Skill not found');
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, parsed.data.agentId), eq(agents.entityId, session.entityId)));
    if (!agent) return fail('not_found', 'Agent not found');

    // Idempotent: skip if already assigned.
    const [existing] = await db
      .select({ id: agentSkillAssignments.id })
      .from(agentSkillAssignments)
      .where(
        and(
          eq(agentSkillAssignments.skillId, parsed.data.skillId),
          eq(agentSkillAssignments.agentId, parsed.data.agentId),
        ),
      );
    if (existing) {
      revalidatePath('/skills');
      return ok(undefined);
    }

    await db.insert(agentSkillAssignments).values({
      entityId: session.entityId,
      skillId: parsed.data.skillId,
      agentId: parsed.data.agentId,
    });
    revalidatePath('/skills');
    return ok(undefined);
  } catch (err) {
    console.error('[assignSkillAction]', err);
    return fail('db_error', 'Failed to assign skill');
  }
}

export async function unassignSkillAction(raw: unknown): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = SkillAssignmentSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const db = getDb();
    // Scope the delete by the skill's entity (the agent_skill_assignments row
    // has its own entityId column for fast lookups).
    await db
      .delete(agentSkillAssignments)
      .where(
        and(
          eq(agentSkillAssignments.skillId, parsed.data.skillId),
          eq(agentSkillAssignments.agentId, parsed.data.agentId),
          eq(agentSkillAssignments.entityId, session.entityId),
        ),
      );
    revalidatePath('/skills');
    return ok(undefined);
  } catch (err) {
    console.error('[unassignSkillAction]', err);
    return fail('db_error', 'Failed to unassign skill');
  }
}

// ─── Log Actions ──────────────────────────────────────────────────────────────

export type ToolCallLogRow = {
  id: string;
  jobId: string | null;
  agentId: string | null;
  agentName: string | null;
  agentSlug: string | null;
  toolName: string;
  toolInput: unknown;
  toolOutput: string | null;
  durationMs: number | null;
  turn: number | null;
  createdAt: Date | null;
};

const ListToolCallsSchema = z.object({
  agentId: z.string().uuid().optional(),
  toolName: z.string().min(1).max(120).optional(),
  jobId: z.string().uuid().optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
});

export type ToolCallLogResult = {
  items: ToolCallLogRow[];
  page: number;
  pageSize: number;
};

export async function listToolCallsAction(
  raw: unknown = {},
): Promise<ActionResult<ToolCallLogResult>> {
  try {
    const session = await getSession();
    const parsed = ListToolCallsSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const db = getDb();

    const conditions = [eq(toolCalls.entityId, session.entityId)];
    if (parsed.data.toolName) conditions.push(eq(toolCalls.toolName, parsed.data.toolName));
    if (parsed.data.jobId) conditions.push(eq(toolCalls.jobId, parsed.data.jobId));
    // Filtering by agentId requires a join via agentJobs — we add it conditionally
    // below since the query shape changes when joined.

    const offset = (parsed.data.page - 1) * parsed.data.pageSize;

    const baseRows = parsed.data.agentId
      ? await db
          .select({
            id: toolCalls.id,
            jobId: toolCalls.jobId,
            agentId: agentJobs.agentId,
            toolName: toolCalls.toolName,
            toolInput: toolCalls.toolInput,
            toolOutput: toolCalls.toolOutput,
            durationMs: toolCalls.durationMs,
            turn: toolCalls.turn,
            createdAt: toolCalls.createdAt,
          })
          .from(toolCalls)
          .leftJoin(agentJobs, eq(agentJobs.id, toolCalls.jobId))
          .where(and(...conditions, eq(agentJobs.agentId, parsed.data.agentId)))
          .orderBy(desc(toolCalls.createdAt))
          .limit(parsed.data.pageSize)
          .offset(offset)
      : await db
          .select({
            id: toolCalls.id,
            jobId: toolCalls.jobId,
            agentId: agentJobs.agentId,
            toolName: toolCalls.toolName,
            toolInput: toolCalls.toolInput,
            toolOutput: toolCalls.toolOutput,
            durationMs: toolCalls.durationMs,
            turn: toolCalls.turn,
            createdAt: toolCalls.createdAt,
          })
          .from(toolCalls)
          .leftJoin(agentJobs, eq(agentJobs.id, toolCalls.jobId))
          .where(and(...conditions))
          .orderBy(desc(toolCalls.createdAt))
          .limit(parsed.data.pageSize)
          .offset(offset);

    // Resolve agent name+slug per unique agentId.
    const agentIds = Array.from(
      new Set(baseRows.map((r) => r.agentId).filter((x): x is string => x !== null)),
    );
    const lookup = new Map<string, { name: string; slug: string }>();
    if (agentIds.length > 0) {
      const rows = await db
        .select({ id: agents.id, name: agents.name, slug: agents.slug })
        .from(agents)
        .where(inArray(agents.id, agentIds));
      for (const r of rows) lookup.set(r.id, { name: r.name, slug: r.slug });
    }

    const items: ToolCallLogRow[] = baseRows.map((r) => {
      const agent = r.agentId ? lookup.get(r.agentId) : null;
      return {
        id: r.id,
        jobId: r.jobId,
        agentId: r.agentId,
        agentName: agent?.name ?? null,
        agentSlug: agent?.slug ?? null,
        toolName: r.toolName,
        toolInput: r.toolInput,
        toolOutput: r.toolOutput,
        durationMs: r.durationMs,
        turn: r.turn,
        createdAt: r.createdAt,
      };
    });

    return ok({ items, page: parsed.data.page, pageSize: parsed.data.pageSize });
  } catch (err) {
    console.error('[listToolCallsAction]', err);
    return fail('db_error', 'Failed to load tool calls');
  }
}

// ─── Stats Actions ────────────────────────────────────────────────────────────

export type EntityStats = {
  totalJobs: number;
  statusCounts: Record<string, number>;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalDurationMs: number;
  avgDurationMs: number | null;
  totalToolCalls: number;
  agentCount: number;
  perAgent: Array<{
    agentId: string;
    agentName: string;
    agentSlug: string;
    jobCount: number;
    inputTokens: number;
    outputTokens: number;
  }>;
};

export async function getEntityStatsAction(): Promise<ActionResult<EntityStats>> {
  try {
    const session = await getSession();
    const db = getDb();

    // Status counts + token / duration totals in a single roundtrip.
    const jobAgg = await db
      .select({
        status: agentJobs.status,
        count: sql<string>`count(*)`,
        inputTokens: sql<string>`coalesce(sum(${agentJobs.inputTokens}), 0)`,
        outputTokens: sql<string>`coalesce(sum(${agentJobs.outputTokens}), 0)`,
        durationMs: sql<string>`coalesce(sum(${agentJobs.totalDurationMs}), 0)`,
      })
      .from(agentJobs)
      .where(eq(agentJobs.entityId, session.entityId))
      .groupBy(agentJobs.status);

    const statusCounts: Record<string, number> = {};
    let totalJobs = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalDurationMs = 0;
    for (const row of jobAgg) {
      const s = row.status ?? 'unknown';
      const n = Number(row.count);
      statusCounts[s] = (statusCounts[s] ?? 0) + n;
      totalJobs += n;
      totalInputTokens += Number(row.inputTokens);
      totalOutputTokens += Number(row.outputTokens);
      totalDurationMs += Number(row.durationMs);
    }

    const completedCount = statusCounts['completed'] ?? 0;
    const avgDurationMs = completedCount > 0 ? totalDurationMs / completedCount : null;

    // Tool call count
    const [tcRow] = await db
      .select({ count: sql<string>`count(*)` })
      .from(toolCalls)
      .where(eq(toolCalls.entityId, session.entityId));
    const totalToolCalls = Number(tcRow?.count ?? 0);

    // Per-agent rollup
    const perAgentRaw = await db
      .select({
        agentId: agentJobs.agentId,
        agentName: agents.name,
        agentSlug: agents.slug,
        jobCount: sql<string>`count(*)`,
        inputTokens: sql<string>`coalesce(sum(${agentJobs.inputTokens}), 0)`,
        outputTokens: sql<string>`coalesce(sum(${agentJobs.outputTokens}), 0)`,
      })
      .from(agentJobs)
      .leftJoin(agents, eq(agents.id, agentJobs.agentId))
      .where(eq(agentJobs.entityId, session.entityId))
      .groupBy(agentJobs.agentId, agents.name, agents.slug)
      .orderBy(desc(sql`count(*)`));

    const perAgent = perAgentRaw
      .filter((r): r is typeof r & { agentId: string; agentName: string; agentSlug: string } =>
        Boolean(r.agentId && r.agentName && r.agentSlug),
      )
      .map((r) => ({
        agentId: r.agentId,
        agentName: r.agentName,
        agentSlug: r.agentSlug,
        jobCount: Number(r.jobCount),
        inputTokens: Number(r.inputTokens),
        outputTokens: Number(r.outputTokens),
      }));

    const [agentRow] = await db
      .select({ count: sql<string>`count(*)` })
      .from(agents)
      .where(eq(agents.entityId, session.entityId));
    const agentCount = Number(agentRow?.count ?? 0);

    return ok({
      totalJobs,
      statusCounts,
      totalInputTokens,
      totalOutputTokens,
      totalDurationMs,
      avgDurationMs,
      totalToolCalls,
      agentCount,
      perAgent,
    });
  } catch (err) {
    console.error('[getEntityStatsAction]', err);
    return fail('db_error', 'Failed to load stats');
  }
}
