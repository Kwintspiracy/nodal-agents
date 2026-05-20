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
  notInArray,
  sql,
  agents,
  agentAssignments,
  agentJobs,
  connectors,
  credentials,
  approvalRequests,
  agentSkills,
  agentSkillAssignments,
  agentConnectorAssignments,
  mcpServers,
  agentMcpServers,
  toolCalls,
  agentSchedules,
  entityLlmKeys,
} from '@nodal-agents/db';
import { DeliveryError, getTelegramBotInfo, getTelegramUpdates } from '@nodal-agents/delivery';
import {
  listMemories,
  deleteMemory,
  updateMemory,
  MemoryNotFoundError,
} from '@nodal-agents/memory';
import { encrypt, decrypt, isEncrypted, last4 } from '@nodal-agents/secrets';
import { getLanAddresses } from './network.ts';
import type { AgentMemory, CredentialType, OperationDescriptor } from '@nodal-agents/shared';
import { getDb, getAuthProvider } from './server.ts';
import { requireAuth } from '@nodal-agents/auth';
import { env } from './env.ts';
import { mergeNodalaiConfig, readNodalaiConfig } from './cli-config.ts';
import { CONNECTOR_CATALOG, type ConnectorAuthType } from './connector-catalog.ts';
import { MCP_CATALOG } from './mcp-catalog.ts';
import { connectMcp } from '@nodal-agents/adapter-mcp';
import { getOAuthProvider } from './oauth-providers.ts';
import { computeNextRun } from './cron.ts';
import { ADAPTER_REGISTRY } from '@nodal-agents/runner-adapters';

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
    llmKeyId: z.string().guid().optional(),
    role: z.enum(['worker', 'router', 'planner']).default('worker'),
    subAgentIds: z.array(z.string().guid()).default([]),
    // Optional absolute filesystem path the agent's file_* tools are scoped
    // to. Empty string is normalized to null at the action layer so the
    // form's controlled input can stay a plain string.
    workspaceRootPath: z
      .string()
      .max(1024)
      .optional()
      .transform((v) => (v && v.trim() !== '' ? v.trim() : null)),
  })
  .refine((d) => d.role !== 'worker' || d.subAgentIds.length === 0, {
    message: 'Sub-agents only apply when role is router or planner',
    path: ['subAgentIds'],
  });

const SendTaskSchema = z.object({
  prompt: z.string().min(1),
  agentId: z.string().guid('Must select a valid agent'),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  sendViaTelegram: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((v) => v === true || v === 'true'),
});

// ─── Agent Actions ────────────────────────────────────────────────────────────

export type AgentRow = {
  id: string;
  entityId: string | null;
  name: string;
  slug: string;
  personality: string;
  model: string | null;
  llmKeyId: string | null;
  active: boolean | null;
  isDefault: boolean | null;
  role: string | null;
  createdAt: Date | null;
  telegramBotToken: string | null;
  lastSeenChatIdTelegram: string | null;
  workspaceRootPath: string | null;
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
    const { dbRole, orchestratorMode } = mapRoleToDb(role);

    const [row] = await db
      .insert(agents)
      .values({
        entityId: session.entityId,
        slug: parsed.data.slug,
        name: parsed.data.name,
        personality: parsed.data.personality,
        model: parsed.data.model,
        llmKeyId: parsed.data.llmKeyId ?? null,
        role: dbRole,
        orchestratorMode,
        workspaceRootPath: parsed.data.workspaceRootPath,
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
    if (!z.string().guid().safeParse(id).success) {
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

// ─── Agent update ─────────────────────────────────────────────────────────────

const UpdateAgentSchema = z.object({
  id: z.string().guid(),
  name: z.string().min(1).max(120),
  personality: z.string().min(1),
  model: z.string().min(1),
  llmKeyId: z.string().guid().nullable().optional(),
  role: z.enum(['worker', 'router', 'planner']),
  subAgentIds: z.array(z.string().guid()).default([]),
  workspaceRootPath: z
    .string()
    .max(1024)
    .optional()
    .transform((v) => (v && v.trim() !== '' ? v.trim() : null)),
  // slug NOT here — it is a stable identifier. Excluded at schema level so
  // even a raw payload with a slug field is silently stripped by safeParse.
});

// Shared role/orchestratorMode mapping used by both create and update.
function mapRoleToDb(role: 'worker' | 'router' | 'planner'): {
  dbRole: 'agent' | 'orchestrator';
  orchestratorMode: 'router' | 'planner' | null;
} {
  if (role === 'worker') return { dbRole: 'agent', orchestratorMode: null };
  return { dbRole: 'orchestrator', orchestratorMode: role };
}

export async function updateAgentAction(raw: unknown): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = UpdateAgentSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const { id, name, personality, model, llmKeyId, role, subAgentIds, workspaceRootPath } =
      parsed.data;
    const db = getDb();

    // Verify agent exists and belongs to this entity
    const [existing] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.entityId, session.entityId)));
    if (!existing) return fail('not_found', 'Agent not found');

    const { dbRole, orchestratorMode } = mapRoleToDb(role);

    // Update core fields. llmKeyId: undefined means "don't touch", null clears.
    const patch: Record<string, unknown> = {
      name,
      personality,
      model,
      role: dbRole,
      orchestratorMode,
      workspaceRootPath,
      updatedAt: new Date(),
    };
    if (llmKeyId !== undefined) {
      patch['llmKeyId'] = llmKeyId;
    }

    await db.update(agents).set(patch).where(eq(agents.id, id));

    // Rewrite sub-agent assignments atomically: delete existing, insert new
    await db.delete(agentAssignments).where(eq(agentAssignments.orchestratorId, id));
    if (role !== 'worker' && subAgentIds.length > 0) {
      await db.insert(agentAssignments).values(
        subAgentIds.map((subId) => ({
          orchestratorId: id,
          subAgentId: subId,
          entityId: session.entityId,
        })),
      );
    }

    // Invalidate cached system_prompt for active (in-flight) jobs only.
    // Completed/failed/cancelled jobs keep their historical prompt for audit.
    await db
      .update(agentJobs)
      .set({ systemPrompt: null, updatedAt: new Date() })
      .where(
        and(
          eq(agentJobs.agentId, id),
          notInArray(agentJobs.status, ['completed', 'failed', 'cancelled']),
        ),
      );

    revalidatePath('/agents');
    return ok(undefined);
  } catch (err) {
    console.error('[updateAgentAction]', err);
    return fail('db_error', 'Failed to update agent');
  }
}

export type AgentEditRow = AgentRow & {
  orchestratorMode: string | null;
  subAgentIds: string[];
};

export async function getAgentForEditAction(id: string): Promise<ActionResult<AgentEditRow>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid agent id');
    }
    const db = getDb();
    const [row] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.entityId, session.entityId)));
    if (!row) return fail('not_found', 'Agent not found');

    const assignments = await db
      .select({ subAgentId: agentAssignments.subAgentId })
      .from(agentAssignments)
      .where(eq(agentAssignments.orchestratorId, id));

    const fullRow = row as AgentRow & { orchestratorMode: string | null };
    return ok({
      ...fullRow,
      orchestratorMode: fullRow.orchestratorMode ?? null,
      subAgentIds: assignments.map((a) => a.subAgentId),
    });
  } catch (err) {
    console.error('[getAgentForEditAction]', err);
    return fail('db_error', 'Failed to load agent');
  }
}

// ─── Job Actions ──────────────────────────────────────────────────────────────

// Kept for type completeness — agent_tasks rows are still produced by planner
// orchestrators internally (cron + child jobs). No UI exposes them currently;
// see plan: a kanban view on /jobs may surface them later.
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

    // Resolve chatId for Telegram delivery.
    // When sendViaTelegram=true, the agent's lastSeenChatIdTelegram is set as
    // chatId on the job row. The runner reads this to populate the Job context
    // block in the system_prompt. The agent's personality decides how to use it.
    // task field stays pristine (= exact user input, no suffix injection).
    let resolvedChatId: string | null = null;
    if (parsed.data.sendViaTelegram) {
      const [agentTg] = await db
        .select({ chatId: agents.lastSeenChatIdTelegram })
        .from(agents)
        .where(and(eq(agents.id, parsed.data.agentId), eq(agents.entityId, session.entityId)))
        .limit(1);
      if (!agentTg?.chatId) {
        return fail('no_telegram_recipient_known', 'DM the bot first to register a recipient.');
      }
      resolvedChatId = agentTg.chatId;
    }

    // Insert job — task is the pure user prompt (no suffix injection).
    // channel stays 'api' (origin = dashboard). chatId carries the Telegram
    // recipient when sendViaTelegram is checked, null otherwise.
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: session.entityId,
        agentId: agent.id,
        status: 'pending',
        channel: 'api',
        task: parsed.data.prompt,
        ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
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
    if (!z.string().guid().safeParse(id).success) {
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
    if (!z.string().guid().safeParse(id).success) {
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
  lastSeenChatIdTelegram: string | null;
};

const ConfigureTelegramSchema = z.object({
  agentId: z.string().guid(),
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
    if (!z.string().guid().safeParse(agentId).success) {
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
        lastSeenChatIdTelegram: agents.lastSeenChatIdTelegram,
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
      lastSeenChatIdTelegram: row.lastSeenChatIdTelegram,
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
      lastSeenChatIdTelegram: null,
    });
  } catch (err) {
    console.error('[configureAgentTelegramAction]', err);
    return fail('db_error', 'Failed to configure Telegram');
  }
}

export async function disconnectAgentTelegramAction(agentId: string): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(agentId).success) {
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
  agentId: z.string().guid().optional(),
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
    if (!z.string().guid().safeParse(id).success) {
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
    if (!z.string().guid().safeParse(id).success) {
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
    if (!z.string().guid().safeParse(id).success) {
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

export type ConnectorRow = {
  id: string;
  slug: string;
  name: string;
  authType: string;
  active: boolean;
  hasApiKey: boolean;
  /** Populated for oauth2 connectors only; null for api_key connectors */
  credentialId: string | null;
  credentialName: string | null;
  credentialType: CredentialType | null;
  /** Extracted from decrypted payload — display only, not the full payload */
  credentialAccountName: string | null;
  credentialExpiresAt: Date | null;
  credentialScopes: string | null;
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

    // Collect unique credential ids referenced by oauth connectors
    const credentialIds = [
      ...new Set(rows.map((r) => r.credentialId).filter((id): id is string => id !== null)),
    ];

    // Batch fetch credentials rows
    const credRows =
      credentialIds.length > 0
        ? await db.select().from(credentials).where(inArray(credentials.id, credentialIds))
        : [];

    const credById = new Map<string, (typeof credRows)[number]>();
    for (const c of credRows) credById.set(c.id, c);

    // Decrypt display-only fields from credential payloads (never expose full payload)
    type CredDisplayFields = {
      accountName: string | null;
      expiresAt: Date | null;
      scopes: string | null;
    };
    const credDisplayById = new Map<string, CredDisplayFields>();
    for (const cred of credRows) {
      try {
        const raw = cred.payload;
        const json = raw.startsWith('enc:v1:') ? decrypt(raw) : raw;
        const parsed = JSON.parse(json) as Record<string, unknown>;
        credDisplayById.set(cred.id, {
          accountName: typeof parsed['accountName'] === 'string' ? parsed['accountName'] : null,
          expiresAt:
            typeof parsed['expiresAt'] === 'string' && parsed['expiresAt']
              ? new Date(parsed['expiresAt'])
              : null,
          scopes: typeof parsed['scopes'] === 'string' ? parsed['scopes'] : null,
        });
      } catch {
        credDisplayById.set(cred.id, { accountName: null, expiresAt: null, scopes: null });
      }
    }

    const bySlug = new Map<string, (typeof rows)[number]>();
    for (const r of rows) bySlug.set(r.slug, r);

    const entries: ConnectorListEntry[] = CONNECTOR_CATALOG.map((c) => {
      const row = bySlug.get(c.slug);
      if (!row) {
        return {
          catalogSlug: c.slug,
          label: c.label,
          authType: c.authType,
          docsHint: c.docsHint,
          connector: null,
        };
      }

      const cred = row.credentialId ? credById.get(row.credentialId) : undefined;
      const display = row.credentialId ? (credDisplayById.get(row.credentialId) ?? null) : null;

      return {
        catalogSlug: c.slug,
        label: c.label,
        authType: c.authType,
        docsHint: c.docsHint,
        connector: {
          id: row.id,
          slug: row.slug,
          name: row.name,
          authType: row.authType,
          active: row.active ?? true,
          hasApiKey: !!row.apiKey,
          credentialId: row.credentialId ?? null,
          credentialName: cred?.name ?? null,
          credentialType: cred ? (cred.type as CredentialType) : null,
          credentialAccountName: display?.accountName ?? null,
          credentialExpiresAt: display?.expiresAt ?? null,
          credentialScopes: display?.scopes ?? null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
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
    // Encrypt idempotently: if value is already encrypted (enc:v1: prefix), keep it.
    const encApiKey = isEncrypted(parsed.data.apiKey)
      ? parsed.data.apiKey
      : encrypt(parsed.data.apiKey);

    if (existing) {
      await db
        .update(connectors)
        .set({
          name,
          apiKey: encApiKey,
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
        apiKey: encApiKey,
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

// saveOauthConnectorAction has been removed in Brique 34 v3.
// OAuth credentials are now managed via the credentials-first model:
// POST /api/oauth/[provider]/start → callback → persistCredentialFromOauthFlow
// Use assignCredentialAction to link a credential to a connector.

export async function deleteConnectorAction(id: string): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(id).success) {
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

// ─── MCP connector Actions ────────────────────────────────────────────────────

/** A cached MCP tool descriptor, stored in mcp_servers.available_tools. */
type McpToolSummary = { name: string; description: string | null };

export type McpServerListEntry = {
  catalogSlug: string;
  label: string;
  description: string;
  docsHint: string;
  keyPrefix: string;
  /** The connected mcp_servers row, or null if not connected yet. */
  server: {
    id: string;
    active: boolean;
    hasApiKey: boolean;
    apiKeyLast4: string | null;
    toolCount: number;
    createdAt: Date | null;
  } | null;
};

/**
 * List every MCP catalog entry, annotated with the entity's connected
 * mcp_servers row (if any). Never returns the encrypted key.
 */
export async function listMcpServersAction(): Promise<ActionResult<McpServerListEntry[]>> {
  try {
    const session = await getSession();
    const db = getDb();
    const rows = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.entityId, session.entityId));
    const bySlug = new Map<string, (typeof rows)[number]>();
    for (const r of rows) bySlug.set(r.slug, r);

    const entries: McpServerListEntry[] = MCP_CATALOG.map((c) => {
      const row = bySlug.get(c.slug);
      return {
        catalogSlug: c.slug,
        label: c.label,
        description: c.description,
        docsHint: c.docsHint,
        keyPrefix: c.keyPrefix,
        server: row
          ? {
              id: row.id,
              active: row.active ?? true,
              hasApiKey: !!row.apiKey,
              apiKeyLast4: row.apiKeyLast4 ?? null,
              toolCount: Array.isArray(row.availableTools) ? row.availableTools.length : 0,
              createdAt: row.createdAt,
            }
          : null,
      };
    });
    return ok(entries);
  } catch (err) {
    console.error('[listMcpServersAction]', err);
    return fail('db_error', 'Failed to load MCP connectors');
  }
}

const CreateMcpServerSchema = z.object({
  slug: z.string().min(1).max(80),
  apiKey: z.string().min(1, 'API key is required'),
});

/**
 * Connect an MCP catalog entry. Connect-and-verify against the live server
 * BEFORE persisting — a bad key fails loud here and writes no row, so the
 * catalog never shows a dead connector. On success the encrypted key + the
 * discovered tool list are upserted into mcp_servers.
 */
export async function createMcpServerFromCatalogAction(
  raw: unknown,
): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await getSession();
    const parsed = CreateMcpServerSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const catalog = MCP_CATALOG.find((e) => e.slug === parsed.data.slug);
    if (!catalog) return fail('validation_failed', 'Unknown MCP connector');
    const apiKey = parsed.data.apiKey.trim();
    if (!apiKey.startsWith(catalog.keyPrefix)) {
      return fail('validation_failed', `API key must start with "${catalog.keyPrefix}"`);
    }

    // Connect-and-verify before persisting. A bad key must fail loud here and
    // leave no row behind.
    let toolDescriptors: McpToolSummary[] = [];
    let conn: Awaited<ReturnType<typeof connectMcp>> | null = null;
    try {
      conn = await connectMcp({
        url: catalog.serverUrl,
        apiKey,
        authScheme: catalog.authScheme,
        authParamName: catalog.authParamName,
      });
      // Some servers accept listTools but reject the key on the first real
      // call — exercise the catalog's verify tool to be certain.
      const verify = await conn.client.callTool({
        name: catalog.verifyToolName,
        arguments: {},
      });
      if (verify.isError === true) {
        return fail('mcp_connect_failed', `${catalog.label} rejected the API key.`);
      }
      toolDescriptors = conn.tools.map((t) => ({
        name: t.name,
        description: t.description ?? null,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail('mcp_connect_failed', `Could not connect to ${catalog.label}: ${msg}`);
    } finally {
      if (conn) await conn.close().catch(() => {});
    }

    const db = getDb();
    const encApiKey = encrypt(apiKey);
    const [row] = await db
      .insert(mcpServers)
      .values({
        entityId: session.entityId,
        name: catalog.label,
        slug: catalog.slug,
        transport: catalog.transport,
        url: catalog.serverUrl,
        apiKey: encApiKey,
        apiKeyLast4: last4(apiKey),
        authScheme: catalog.authScheme,
        authParamName: catalog.authParamName,
        availableTools: toolDescriptors,
        active: true,
      })
      .onConflictDoUpdate({
        target: [mcpServers.entityId, mcpServers.slug],
        set: {
          name: catalog.label,
          transport: catalog.transport,
          url: catalog.serverUrl,
          apiKey: encApiKey,
          apiKeyLast4: last4(apiKey),
          authScheme: catalog.authScheme,
          authParamName: catalog.authParamName,
          availableTools: toolDescriptors,
          active: true,
          updatedAt: new Date(),
        },
      })
      .returning({ id: mcpServers.id });
    if (!row) return fail('db_error', 'Insert returned no row');
    revalidatePath('/mcp');
    return ok({ id: row.id });
  } catch (err) {
    console.error('[createMcpServerFromCatalogAction]', err);
    return fail('db_error', 'Failed to save MCP connector');
  }
}

export async function deleteMcpServerAction(id: string): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid MCP server id');
    }
    const db = getDb();
    const [existing] = await db
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(and(eq(mcpServers.id, id), eq(mcpServers.entityId, session.entityId)));
    if (!existing) return fail('not_found', 'MCP connector not found');
    // CASCADE removes the agent_mcp_servers assignment rows.
    await db.delete(mcpServers).where(eq(mcpServers.id, id));
    revalidatePath('/mcp');
    return ok(undefined);
  } catch (err) {
    console.error('[deleteMcpServerAction]', err);
    return fail('db_error', 'Failed to delete MCP connector');
  }
}

export type AgentMcpServerRow = {
  mcpServerId: string;
  slug: string;
  label: string;
  assigned: boolean;
  /** null = all tools enabled; array = whitelist of original (un-prefixed) tool names. */
  enabledTools: string[] | null;
  availableTools: McpToolSummary[];
};

/**
 * List the entity's active MCP servers, annotated with whether the given
 * agent has each assigned and which tools are enabled.
 */
export async function listAgentMcpServersAction(
  agentId: string,
): Promise<ActionResult<AgentMcpServerRow[]>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(agentId).success) {
      return fail('validation_failed', 'Invalid agent id');
    }
    const db = getDb();
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.entityId, session.entityId)));
    if (!agent) return fail('not_found', 'Agent not found');

    const serverRows = await db
      .select({
        id: mcpServers.id,
        slug: mcpServers.slug,
        name: mcpServers.name,
        availableTools: mcpServers.availableTools,
      })
      .from(mcpServers)
      .where(and(eq(mcpServers.entityId, session.entityId), eq(mcpServers.active, true)));
    if (serverRows.length === 0) return ok([]);

    const assignmentRows = await db
      .select({
        mcpServerId: agentMcpServers.mcpServerId,
        enabledTools: agentMcpServers.enabledTools,
      })
      .from(agentMcpServers)
      .where(eq(agentMcpServers.agentId, agentId));
    const assignmentByServerId = new Map<string, { enabledTools: string[] | null }>();
    for (const a of assignmentRows) {
      assignmentByServerId.set(a.mcpServerId, {
        enabledTools: (a.enabledTools as string[] | null) ?? null,
      });
    }

    const result: AgentMcpServerRow[] = serverRows.map((row) => {
      const assignment = assignmentByServerId.get(row.id);
      return {
        mcpServerId: row.id,
        slug: row.slug,
        label: row.name,
        assigned: assignment !== undefined,
        enabledTools: assignment?.enabledTools ?? null,
        availableTools: Array.isArray(row.availableTools)
          ? (row.availableTools as McpToolSummary[])
          : [],
      };
    });
    return ok(result);
  } catch (err) {
    console.error('[listAgentMcpServersAction]', err);
    return fail('db_error', 'Failed to load agent MCP connectors');
  }
}

/**
 * Assign or unassign an MCP server to an agent, with an optional per-tool
 * whitelist. Idempotent — mirrors setAgentConnectorAssignmentAction.
 */
export async function setAgentMcpServerAssignmentAction(
  agentId: string,
  mcpServerId: string,
  assigned: boolean,
  enabledTools: string[] | null,
): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(agentId).success) {
      return fail('validation_failed', 'Invalid agent id');
    }
    if (!z.string().guid().safeParse(mcpServerId).success) {
      return fail('validation_failed', 'Invalid MCP server id');
    }
    const db = getDb();
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.entityId, session.entityId)));
    if (!agent) return fail('not_found', 'Agent not found');
    const [server] = await db
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(and(eq(mcpServers.id, mcpServerId), eq(mcpServers.entityId, session.entityId)));
    if (!server) return fail('not_found', 'MCP connector not found');

    if (!assigned) {
      await db
        .delete(agentMcpServers)
        .where(
          and(
            eq(agentMcpServers.agentId, agentId),
            eq(agentMcpServers.mcpServerId, mcpServerId),
          ),
        );
    } else {
      await db
        .insert(agentMcpServers)
        .values({
          agentId,
          mcpServerId,
          entityId: session.entityId,
          enabledTools: enabledTools ?? null,
        })
        .onConflictDoUpdate({
          target: [agentMcpServers.agentId, agentMcpServers.mcpServerId],
          set: { enabledTools: enabledTools ?? null, updatedAt: new Date() },
        });
    }

    revalidatePath('/agents');
    return ok(undefined);
  } catch (err) {
    console.error('[setAgentMcpServerAssignmentAction]', err);
    return fail('db_error', 'Failed to update MCP assignment');
  }
}

// refreshConnectorAction has been removed in Brique 34 v3.
// Use refreshCredentialAction(credentialId) instead (re-exported below).

/**
 * Assign (or unassign) a credential to a connector.
 * Verifies:
 *   - connector belongs to the current entity
 *   - credential (if not null) belongs to the current user
 *   - credential type matches the connector's catalog entry expected credentialType
 */
export async function assignCredentialAction(
  connectorId: string,
  credentialId: string | null,
): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(connectorId).success) {
      return fail('validation_failed', 'Invalid connector id');
    }
    if (credentialId !== null && !z.string().guid().safeParse(credentialId).success) {
      return fail('validation_failed', 'Invalid credential id');
    }

    const db = getDb();

    // 1. Verify connector ownership
    const [existingConnector] = await db
      .select({ id: connectors.id, slug: connectors.slug, authType: connectors.authType })
      .from(connectors)
      .where(and(eq(connectors.id, connectorId), eq(connectors.entityId, session.entityId)));
    if (!existingConnector) return fail('not_found', 'Connector not found');
    if (existingConnector.authType !== 'oauth2') {
      return fail('invalid_auth_type', 'Only OAuth2 connectors support credential assignment');
    }

    if (credentialId !== null) {
      // 2. Verify credential ownership
      const [existingCred] = await db
        .select({
          id: credentials.id,
          ownerUserId: credentials.ownerUserId,
          type: credentials.type,
        })
        .from(credentials)
        .where(eq(credentials.id, credentialId));
      if (!existingCred) return fail('not_found', 'Credential not found');
      if (existingCred.ownerUserId !== session.userId) return fail('forbidden', 'Access denied');

      // 3. Verify type compatibility: connector's catalog entry must declare the same credentialType
      const provider = getOAuthProvider(existingConnector.slug);
      if (provider && provider.credentialType !== existingCred.type) {
        return fail(
          'type_mismatch',
          `Credential type '${existingCred.type}' is not compatible with connector '${existingConnector.slug}' (expects '${provider.credentialType}')`,
        );
      }
    }

    // 4. Update FK
    await db
      .update(connectors)
      .set({ credentialId, updatedAt: new Date() })
      .where(eq(connectors.id, connectorId));

    revalidatePath('/connectors');
    return ok(undefined);
  } catch (err) {
    console.error('[assignCredentialAction]', err);
    const detail = err instanceof Error ? err.message : String(err);
    return fail('db_error', `Failed to assign credential: ${detail}`);
  }
}

/**
 * Create-or-assign an OAuth credential to a connector (upsert-style).
 *
 * Called from the /connectors page auto-assignment block when the OAuth callback
 * returns ?connectorSlug=X&credentialId=Y. Unlike `assignCredentialAction`, this
 * will INSERT a new connector row if none exists yet for the slug.
 *
 * Security:
 *   - credential ownership verified against session.userId
 *   - credentialType verified against catalog entry
 */
export async function createOrAssignOAuthConnectorAction(
  slug: string,
  credentialId: string,
): Promise<ActionResult<{ connectorId: string }>> {
  try {
    const session = await getSession();
    if (!z.string().min(1).max(80).safeParse(slug).success) {
      return fail('validation_failed', 'Invalid connector slug');
    }
    if (!z.string().guid().safeParse(credentialId).success) {
      return fail('validation_failed', 'Invalid credential id');
    }

    const catalogEntry = CONNECTOR_CATALOG.find((c) => c.slug === slug);
    if (!catalogEntry) return fail('validation_failed', 'Unknown connector slug');
    if (catalogEntry.authType !== 'oauth2') {
      return fail('invalid_auth_type', 'Only OAuth2 connectors support credential assignment');
    }

    const db = getDb();

    // Verify credential ownership + type
    const [existingCred] = await db
      .select({ id: credentials.id, ownerUserId: credentials.ownerUserId, type: credentials.type })
      .from(credentials)
      .where(eq(credentials.id, credentialId));
    if (!existingCred) return fail('not_found', 'Credential not found');
    if (existingCred.ownerUserId !== session.userId) return fail('forbidden', 'Access denied');

    // Verify type compatibility
    if (catalogEntry.credentialType && catalogEntry.credentialType !== existingCred.type) {
      return fail(
        'type_mismatch',
        `Credential type '${existingCred.type}' is not compatible with connector '${slug}' (expects '${catalogEntry.credentialType}')`,
      );
    }

    // Check for existing connector row
    const [existing] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(eq(connectors.entityId, session.entityId), eq(connectors.slug, slug)));

    let connectorId: string;
    if (existing) {
      // Update existing row
      await db
        .update(connectors)
        .set({ credentialId, active: true, updatedAt: new Date() })
        .where(eq(connectors.id, existing.id));
      connectorId = existing.id;
    } else {
      // Insert new connector row
      const [row] = await db
        .insert(connectors)
        .values({
          entityId: session.entityId,
          slug,
          name: catalogEntry.label,
          authType: 'oauth2',
          credentialId,
          active: true,
        })
        .returning({ id: connectors.id });
      if (!row) return fail('db_error', 'Insert returned no row');
      connectorId = row.id;
    }

    revalidatePath('/connectors');
    return ok({ connectorId });
  } catch (err) {
    console.error('[createOrAssignOAuthConnectorAction]', err);
    const detail = err instanceof Error ? err.message : String(err);
    return fail('db_error', `Failed to assign credential: ${detail}`);
  }
}

// Credential actions live in `./credentials.ts` and must be imported directly
// from there (no re-export here). Re-exporting a `'use server'` function from
// another `'use server'` file makes Next.js 16 + Turbopack register the same
// function under TWO action IDs — one per source file. When a page passes the
// re-exported action as a prop, Turbopack may embed the wrong ID in the RSC
// stream while the page's manifest registers the original ID, producing
// "Server action was not found on the server" at click time.

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
  approvalRequestId: z.string().guid(),
  decision: z.enum(['approve', 'reject']),
  notes: z.string().max(5000).optional(),
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
  defaultContent: string | null;
  contentOverridden: boolean;
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
        defaultContent: agentSkills.defaultContent,
        contentOverridden: agentSkills.contentOverridden,
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
        defaultContent: r.defaultContent,
        contentOverridden: r.contentOverridden ?? false,
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
    if (!z.string().guid().safeParse(id).success) {
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
  skillId: z.string().guid(),
  agentId: z.string().guid(),
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
    if (!z.string().guid().safeParse(skillId).success) {
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
      .where(
        and(eq(agentSkills.id, parsed.data.skillId), eq(agentSkills.entityId, session.entityId)),
      );
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

// ─── Skill update ─────────────────────────────────────────────────────────────

const UpdateSkillSchema = z.object({
  id: z.string().guid(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  content: z.string().min(1),
  active: z.boolean().optional(),
  // slug NOT here — it is a stable identifier. Excluded at schema level so
  // even a raw payload with a slug field is silently stripped by safeParse.
});

export async function updateSkillAction(raw: unknown): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = UpdateSkillSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const { id, name, description, content, active } = parsed.data;
    const db = getDb();

    // Verify skill exists and belongs to this entity; capture current content
    // so we know whether the user is editing it (which flips contentOverridden
    // so the catalog seeder leaves it alone on the next boot).
    const [existing] = await db
      .select({ id: agentSkills.id, content: agentSkills.content })
      .from(agentSkills)
      .where(and(eq(agentSkills.id, id), eq(agentSkills.entityId, session.entityId)));
    if (!existing) return fail('not_found', 'Skill not found');

    const patch: Record<string, unknown> = {
      name,
      description: description ?? null,
      content,
      ...(active !== undefined ? { active } : {}),
      updatedAt: new Date(),
    };
    if (content !== existing.content) {
      patch['contentOverridden'] = true;
    }

    await db.update(agentSkills).set(patch).where(eq(agentSkills.id, id));

    revalidatePath('/skills');
    return ok(undefined);
  } catch (err) {
    console.error('[updateSkillAction]', err);
    return fail('db_error', 'Failed to update skill');
  }
}

export async function resetSkillToDefaultAction(id: string): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid skill id');
    }
    const db = getDb();

    const [existing] = await db
      .select({
        id: agentSkills.id,
        defaultContent: agentSkills.defaultContent,
      })
      .from(agentSkills)
      .where(and(eq(agentSkills.id, id), eq(agentSkills.entityId, session.entityId)));
    if (!existing) return fail('not_found', 'Skill not found');
    if (existing.defaultContent === null) {
      return fail(
        'not_applicable',
        'No default available — this is a user-created skill',
      );
    }

    await db
      .update(agentSkills)
      .set({
        content: existing.defaultContent,
        contentOverridden: false,
        updatedAt: new Date(),
      })
      .where(eq(agentSkills.id, id));

    revalidatePath('/skills');
    return ok(undefined);
  } catch (err) {
    console.error('[resetSkillToDefaultAction]', err);
    return fail('db_error', 'Failed to reset skill');
  }
}

export async function getSkillByIdAction(id: string): Promise<ActionResult<SkillRow>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid skill id');
    }
    const db = getDb();
    const [row] = await db
      .select({
        id: agentSkills.id,
        name: agentSkills.name,
        slug: agentSkills.slug,
        content: agentSkills.content,
        defaultContent: agentSkills.defaultContent,
        contentOverridden: agentSkills.contentOverridden,
        description: agentSkills.description,
        active: agentSkills.active,
        requiredBuiltins: agentSkills.requiredBuiltins,
        createdAt: agentSkills.createdAt,
        updatedAt: agentSkills.updatedAt,
      })
      .from(agentSkills)
      .where(and(eq(agentSkills.id, id), eq(agentSkills.entityId, session.entityId)));
    if (!row) return fail('not_found', 'Skill not found');

    return ok({
      id: row.id,
      name: row.name,
      slug: row.slug,
      content: row.content,
      defaultContent: row.defaultContent,
      contentOverridden: row.contentOverridden ?? false,
      description: row.description,
      active: row.active ?? true,
      requiredBuiltins: (row.requiredBuiltins as string[] | null) ?? [],
      assignmentCount: 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  } catch (err) {
    console.error('[getSkillByIdAction]', err);
    return fail('db_error', 'Failed to load skill');
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
  agentId: z.string().guid().optional(),
  toolName: z.string().min(1).max(120).optional(),
  jobId: z.string().guid().optional(),
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

/**
 * Distinct tool_name values for the current entity, sorted alphabetically.
 * Brique 36 — feeds the /logs Tool Name filter <select> so the user doesn't
 * have to know the exact slug.
 */
export async function listToolNamesAction(): Promise<ActionResult<string[]>> {
  try {
    const session = await getSession();
    const db = getDb();
    const rows = await db
      .selectDistinct({ toolName: toolCalls.toolName })
      .from(toolCalls)
      .where(eq(toolCalls.entityId, session.entityId))
      .orderBy(toolCalls.toolName);
    return ok(rows.map((r) => r.toolName));
  } catch (err) {
    console.error('[listToolNamesAction]', err);
    return fail('db_error', 'Failed to load tool names');
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

// ─── Settings Action ──────────────────────────────────────────────────────────

export type SettingsView = {
  llm: {
    provider: string | null;
    model: string | null;
    baseURL: string | null;
  };
  authMode: 'local-trust' | 'local-auth' | 'bearer-token';
  runnerUrl: string;
  appUrl: string;
  workerSecretConfigured: boolean;
  user: {
    userId: string;
    entityId: string;
  };
};

export async function getSettingsAction(): Promise<ActionResult<SettingsView>> {
  try {
    const session = await getSession();
    return ok({
      llm: {
        provider: env.LLM_PROVIDER ?? null,
        model: env.LLM_MODEL ?? null,
        baseURL: env.LLM_BASE_URL ?? null,
      },
      authMode: env.AUTH_MODE,
      runnerUrl: env.RUNNER_URL,
      appUrl: env.NEXT_PUBLIC_APP_URL,
      workerSecretConfigured: Boolean(env.WORKER_SECRET),
      user: {
        userId: session.userId,
        entityId: session.entityId,
      },
    });
  } catch (err) {
    console.error('[getSettingsAction]', err);
    return fail('db_error', 'Failed to load settings');
  }
}

// ─── Automation Actions ───────────────────────────────────────────────────────

export type ScheduleRow = {
  id: string;
  agentId: string;
  agentName: string | null;
  agentSlug: string | null;
  name: string;
  cronExpr: string;
  task: string | null;
  active: boolean;
  lastRun: Date | null;
  nextRun: Date | null;
  lastStatus: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export async function listSchedulesAction(): Promise<ActionResult<ScheduleRow[]>> {
  try {
    const session = await getSession();
    const db = getDb();
    const rows = await db
      .select({
        id: agentSchedules.id,
        agentId: agentSchedules.agentId,
        agentName: agents.name,
        agentSlug: agents.slug,
        name: agentSchedules.name,
        cronExpr: agentSchedules.cronExpr,
        task: agentSchedules.task,
        active: agentSchedules.active,
        lastRun: agentSchedules.lastRun,
        nextRun: agentSchedules.nextRun,
        lastStatus: agentSchedules.lastStatus,
        createdAt: agentSchedules.createdAt,
        updatedAt: agentSchedules.updatedAt,
      })
      .from(agentSchedules)
      .leftJoin(agents, eq(agents.id, agentSchedules.agentId))
      .where(eq(agentSchedules.entityId, session.entityId))
      .orderBy(desc(agentSchedules.updatedAt));

    return ok(
      rows.map((r) => ({
        ...r,
        active: r.active ?? true,
      })) as ScheduleRow[],
    );
  } catch (err) {
    console.error('[listSchedulesAction]', err);
    return fail('db_error', 'Failed to load schedules');
  }
}

const CreateScheduleSchema = z.object({
  agentId: z.string().guid('Pick an agent'),
  name: z.string().min(1).max(120),
  cronExpr: z.string().min(1).max(100),
  task: z.string().min(1),
});

export async function createScheduleAction(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await getSession();
    const parsed = CreateScheduleSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const db = getDb();

    // Verify the agent belongs to this entity.
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, parsed.data.agentId), eq(agents.entityId, session.entityId)));
    if (!agent) return fail('not_found', 'Agent not found');

    const nextRun = computeNextRun(parsed.data.cronExpr);
    if (!nextRun) {
      return fail('validation_failed', 'Invalid cron expression');
    }

    const [row] = await db
      .insert(agentSchedules)
      .values({
        entityId: session.entityId,
        agentId: parsed.data.agentId,
        type: 'cron',
        name: parsed.data.name,
        cronExpr: parsed.data.cronExpr,
        task: parsed.data.task,
        active: true,
        nextRun,
      })
      .returning({ id: agentSchedules.id });
    if (!row) return fail('db_error', 'Insert returned no row');

    revalidatePath('/automations');
    return ok({ id: row.id });
  } catch (err) {
    console.error('[createScheduleAction]', err);
    return fail('db_error', 'Failed to create schedule');
  }
}

const UpdateScheduleSchema = z.object({
  id: z.string().guid(),
  agentId: z.string().guid('Pick an agent'),
  name: z.string().min(1).max(120),
  cronExpr: z.string().min(1).max(100),
  task: z.string().min(1),
});

export async function updateScheduleAction(raw: unknown): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = UpdateScheduleSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const db = getDb();

    // Verify schedule exists and belongs to this entity
    const [existing] = await db
      .select({ id: agentSchedules.id })
      .from(agentSchedules)
      .where(
        and(eq(agentSchedules.id, parsed.data.id), eq(agentSchedules.entityId, session.entityId)),
      );
    if (!existing) return fail('not_found', 'Schedule not found');

    // Verify the agent belongs to this entity
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, parsed.data.agentId), eq(agents.entityId, session.entityId)));
    if (!agent) return fail('not_found', 'Agent not found');

    const nextRun = computeNextRun(parsed.data.cronExpr);
    if (!nextRun) {
      return fail('validation_failed', 'Invalid cron expression');
    }

    await db
      .update(agentSchedules)
      .set({
        agentId: parsed.data.agentId,
        name: parsed.data.name,
        cronExpr: parsed.data.cronExpr,
        task: parsed.data.task,
        nextRun,
        updatedAt: new Date(),
      })
      .where(eq(agentSchedules.id, parsed.data.id));

    revalidatePath('/automations');
    return ok(undefined);
  } catch (err) {
    console.error('[updateScheduleAction]', err);
    return fail('db_error', 'Failed to update schedule');
  }
}

export async function toggleScheduleAction(id: string): Promise<ActionResult<{ active: boolean }>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid schedule id');
    }
    const db = getDb();
    const [existing] = await db
      .select({ id: agentSchedules.id, active: agentSchedules.active })
      .from(agentSchedules)
      .where(and(eq(agentSchedules.id, id), eq(agentSchedules.entityId, session.entityId)));
    if (!existing) return fail('not_found', 'Schedule not found');

    const next = !(existing.active ?? true);
    await db
      .update(agentSchedules)
      .set({ active: next, updatedAt: new Date() })
      .where(eq(agentSchedules.id, id));
    revalidatePath('/automations');
    return ok({ active: next });
  } catch (err) {
    console.error('[toggleScheduleAction]', err);
    return fail('db_error', 'Failed to toggle schedule');
  }
}

export async function deleteScheduleAction(id: string): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid schedule id');
    }
    const db = getDb();
    const [existing] = await db
      .select({ id: agentSchedules.id })
      .from(agentSchedules)
      .where(and(eq(agentSchedules.id, id), eq(agentSchedules.entityId, session.entityId)));
    if (!existing) return fail('not_found', 'Schedule not found');
    await db.delete(agentSchedules).where(eq(agentSchedules.id, id));
    revalidatePath('/automations');
    return ok(undefined);
  } catch (err) {
    console.error('[deleteScheduleAction]', err);
    return fail('db_error', 'Failed to delete schedule');
  }
}

// ─── Auth Settings (Security) ─────────────────────────────────────────────────

export type SecurityView = {
  /** Mode currently in effect for this running web process. */
  runtimeMode: 'local-trust' | 'local-auth' | 'bearer-token';
  /**
   * Mode persisted in ~/.nodalai/config.json. Differs from runtimeMode after
   * a settings save until the user restarts `nodal-agents up`.
   */
  configuredMode: 'local-trust' | 'local-auth';
  /** True when Google OAuth client id/secret are present in config. */
  googleConfigured: boolean;
  /** True when GOOGLE_CLIENT_ID/SECRET are exposed to the running process. */
  googleAvailableInRuntime: boolean;
  configPathExists: boolean;
};

function readConfiguredAuth(): {
  configuredMode: 'local-trust' | 'local-auth';
  googleConfigured: boolean;
  configPathExists: boolean;
} {
  const cfg = readNodalaiConfig();
  if (!cfg) {
    return {
      configuredMode: 'local-trust',
      googleConfigured: false,
      configPathExists: false,
    };
  }
  const auth = (cfg['auth'] ?? null) as {
    mode?: 'local-trust' | 'local-auth';
    googleClientId?: string;
    googleClientSecret?: string;
  } | null;
  const bind = cfg['bind'] as 'loopback' | 'lan' | undefined;
  const fallback: 'local-trust' | 'local-auth' = bind === 'lan' ? 'local-auth' : 'local-trust';
  return {
    configuredMode: auth?.mode ?? fallback,
    googleConfigured: Boolean(auth?.googleClientId && auth?.googleClientSecret),
    configPathExists: true,
  };
}

export async function getSecuritySettingsAction(): Promise<ActionResult<SecurityView>> {
  try {
    await getSession();
    const persisted = readConfiguredAuth();
    return ok({
      runtimeMode: env.AUTH_MODE,
      configuredMode: persisted.configuredMode,
      googleConfigured: persisted.googleConfigured,
      googleAvailableInRuntime: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      configPathExists: persisted.configPathExists,
    });
  } catch (err) {
    console.error('[getSecuritySettingsAction]', err);
    return fail('db_error', 'Failed to load security settings');
  }
}

const UpdateAuthSchema = z.object({
  mode: z.enum(['local-trust', 'local-auth']),
  googleClientId: z.string().max(200).optional(),
  googleClientSecret: z.string().max(200).optional(),
  /** When true, clear googleClientId+Secret from config. */
  clearGoogle: z.boolean().default(false),
});

export async function updateAuthSettingsAction(
  raw: unknown,
): Promise<ActionResult<{ requiresRestart: boolean }>> {
  try {
    await getSession();
    const parsed = UpdateAuthSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }

    const existing = readNodalaiConfig();
    if (!existing) {
      return fail(
        'cli_config_missing',
        'Cannot find ~/.nodalai/config.json — run `nodal-agents init` first.',
      );
    }

    const prevAuth = (existing['auth'] ?? {}) as Record<string, unknown>;
    const nextAuth: Record<string, unknown> = {
      ...prevAuth,
      mode: parsed.data.mode,
    };

    if (parsed.data.clearGoogle) {
      delete nextAuth['googleClientId'];
      delete nextAuth['googleClientSecret'];
    } else {
      // Only overwrite when a non-empty value is provided so users can edit
      // the mode without re-pasting their secrets.
      if (parsed.data.googleClientId && parsed.data.googleClientId.trim().length > 0) {
        nextAuth['googleClientId'] = parsed.data.googleClientId.trim();
      }
      if (parsed.data.googleClientSecret && parsed.data.googleClientSecret.trim().length > 0) {
        nextAuth['googleClientSecret'] = parsed.data.googleClientSecret.trim();
      }
    }

    try {
      mergeNodalaiConfig({ auth: nextAuth });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'cli_config_missing') {
        return fail('cli_config_missing', 'Config file disappeared between read and write.');
      }
      throw err;
    }

    revalidatePath('/settings');
    const requiresRestart = parsed.data.mode !== env.AUTH_MODE;
    return ok({ requiresRestart });
  } catch (err) {
    console.error('[updateAuthSettingsAction]', err);
    return fail('db_error', 'Failed to update auth settings');
  }
}

// ─── Network Settings (Brique 35) ─────────────────────────────────────────────
//
// Toggle between loopback (local-only) and LAN (0.0.0.0) bind from the
// dashboard. Mirrors the SecurityForm pattern: read config + runtime, surface
// drift, write through mergeNodalaiConfig. The user restarts the stack to
// apply the new bind — we don't auto-restart from the UI.

export type NetworkView = {
  /** Bind value persisted in ~/.nodalai/config.json. */
  configuredBind: 'loopback' | 'lan';
  /** Bind value currently in effect for the running processes. */
  runtimeBind: 'loopback' | 'lan';
  /** IPv4 LAN addresses detected on this host (for the user to share). */
  lanAddresses: string[];
  /** Web port — used to render shareable URLs alongside lanAddresses. */
  webPort: number;
  /** Always populated by the CLI; we don't bootstrap a config from the web. */
  configPathExists: boolean;
};

function readConfiguredBind(): {
  configuredBind: 'loopback' | 'lan';
  configPathExists: boolean;
} {
  const cfg = readNodalaiConfig();
  if (!cfg) {
    return { configuredBind: 'loopback', configPathExists: false };
  }
  const bind = cfg['bind'] as 'loopback' | 'lan' | undefined;
  return {
    configuredBind: bind === 'lan' ? 'lan' : 'loopback',
    configPathExists: true,
  };
}

export async function getNetworkSettingsAction(): Promise<ActionResult<NetworkView>> {
  try {
    await getSession();
    const persisted = readConfiguredBind();
    const runtimeBind: 'loopback' | 'lan' = env.BIND === '0.0.0.0' ? 'lan' : 'loopback';
    return ok({
      configuredBind: persisted.configuredBind,
      runtimeBind,
      lanAddresses: getLanAddresses(),
      webPort: parseWebPort(env.NEXT_PUBLIC_APP_URL),
      configPathExists: persisted.configPathExists,
    });
  } catch (err) {
    console.error('[getNetworkSettingsAction]', err);
    return fail('db_error', 'Failed to load network settings');
  }
}

function parseWebPort(appUrl: string): number {
  try {
    const u = new URL(appUrl);
    if (u.port) return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
  } catch {
    return 3000;
  }
}

const UpdateNetworkSchema = z.object({
  bind: z.enum(['loopback', 'lan']),
});

export async function updateNetworkSettingsAction(
  raw: unknown,
): Promise<ActionResult<{ requiresRestart: boolean }>> {
  try {
    await getSession();
    const parsed = UpdateNetworkSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }

    try {
      mergeNodalaiConfig({ bind: parsed.data.bind });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg === 'cli_config_missing') {
        return fail(
          'cli_config_missing',
          'Cannot find ~/.nodalai/config.json — run `nodal-agents init` first.',
        );
      }
      throw err;
    }

    revalidatePath('/settings');
    const runtimeBind: 'loopback' | 'lan' = env.BIND === '0.0.0.0' ? 'lan' : 'loopback';
    return ok({ requiresRestart: parsed.data.bind !== runtimeBind });
  } catch (err) {
    console.error('[updateNetworkSettingsAction]', err);
    return fail('db_error', 'Failed to update network settings');
  }
}

// ─── LLM key actions (Brique 24) ──────────────────────────────────────────────
//
// Manages rows in entity_llm_keys. Each row is one (provider + apiKey + baseUrl
// + nickname + defaultModel) tuple — agents reference a row via agents.llmKeyId
// and pick their own free-text model on top.
//
// Security invariants (CRITICAL — enforced by tests):
//   • listLlmKeysAction NEVER returns the apiKey field. Only `hasApiKey: boolean`.
//   • testLlmKeyAction redacts the apiKey in any error message before return.
//   • All actions verify entityId ownership via getSession().

const PROVIDER_VALUES = [
  'anthropic',
  'openai',
  'openai-compatible',
  'ollama',
  'openrouter',
  'google',
  'mistral',
  'groq',
] as const;

export type LlmProvider = (typeof PROVIDER_VALUES)[number];

export type LlmKeyUiRow = {
  id: string;
  provider: string;
  baseUrl: string | null;
  nickname: string | null;
  defaultModel: string | null;
  isActive: boolean;
  /** True when an apiKey is stored. The actual key NEVER leaves the server. */
  hasApiKey: boolean;
  /**
   * Last 4 chars of the stored apiKey, for masked display in the edit form.
   * Null when the apiKey is empty. The full key NEVER leaves the server.
   */
  apiKeyLast4: string | null;
};

// baseUrl is optional, accepts empty string (transformed to null) or a valid URL.
const optionalBaseUrl = z
  .string()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : null))
  .pipe(z.string().url().nullable().or(z.null()));

const CreateLlmKeySchema = z.object({
  provider: z.enum(PROVIDER_VALUES),
  baseUrl: optionalBaseUrl,
  apiKey: z.string().optional(),
  nickname: z.string().min(1).max(120),
  defaultModel: z.string().min(1).max(200),
  isActive: z.boolean().default(true),
});

const UpdateLlmKeySchema = z.object({
  id: z.string().guid(),
  provider: z.enum(PROVIDER_VALUES),
  baseUrl: optionalBaseUrl,
  // apiKey absent → keep existing. Empty string also means "keep existing".
  apiKey: z.string().optional(),
  nickname: z.string().min(1).max(120),
  defaultModel: z.string().min(1).max(200),
  isActive: z.boolean(),
});

const TestLlmKeySchema = z.object({
  provider: z.enum(PROVIDER_VALUES),
  baseUrl: optionalBaseUrl,
  apiKey: z.string().optional(),
  model: z.string().optional(),
  // When testing in edit mode without re-typing the key, pass the keyId and
  // the server will fetch the saved key (ownership-checked) instead.
  keyId: z.string().guid().optional(),
});

/** Strip the apiKey out of any string before returning it to the UI. */
function redactKey(message: string, apiKey: string | undefined): string {
  if (!apiKey || apiKey.length === 0) return message;
  return message.replaceAll(apiKey, '[REDACTED]');
}

export async function listLlmKeysAction(): Promise<ActionResult<LlmKeyUiRow[]>> {
  try {
    const session = await getSession();
    const db = getDb();
    // Explicitly select only the safe columns. The encrypted apiKey ciphertext
    // is NEVER fetched. apiKeyLast4 is a plaintext column populated at write-time
    // (Brique 26) — last4 of the ciphertext would be base64 garbage.
    const rows = await db
      .select({
        id: entityLlmKeys.id,
        provider: entityLlmKeys.provider,
        baseUrl: entityLlmKeys.baseUrl,
        nickname: entityLlmKeys.nickname,
        defaultModel: entityLlmKeys.defaultModel,
        isActive: entityLlmKeys.isActive,
        hasApiKey: sql<boolean>`(${entityLlmKeys.apiKey} <> '')`,
        apiKeyLast4: entityLlmKeys.apiKeyLast4,
      })
      .from(entityLlmKeys)
      .where(eq(entityLlmKeys.entityId, session.entityId))
      .orderBy(desc(entityLlmKeys.createdAt));

    return ok(
      rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        baseUrl: r.baseUrl,
        nickname: r.nickname,
        defaultModel: r.defaultModel,
        isActive: r.isActive,
        hasApiKey: Boolean(r.hasApiKey),
        apiKeyLast4: r.apiKeyLast4 ? r.apiKeyLast4 : null,
      })),
    );
  } catch (err) {
    console.error('[listLlmKeysAction]', err);
    return fail('db_error', 'Failed to load LLM providers');
  }
}

export async function createLlmKeyAction(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await getSession();
    const parsed = CreateLlmKeySchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const db = getDb();
    const plaintextKey = parsed.data.apiKey ?? '';
    const [row] = await db
      .insert(entityLlmKeys)
      .values({
        entityId: session.entityId,
        provider: parsed.data.provider,
        apiKey: encrypt(plaintextKey),
        apiKeyLast4: last4(plaintextKey),
        baseUrl: parsed.data.baseUrl,
        nickname: parsed.data.nickname,
        defaultModel: parsed.data.defaultModel,
        isActive: parsed.data.isActive,
      })
      .returning({ id: entityLlmKeys.id });
    if (!row) return fail('db_error', 'Insert returned no row');
    revalidatePath('/settings');
    return ok({ id: row.id });
  } catch (err) {
    console.error('[createLlmKeyAction]', err);
    return fail('db_error', 'Failed to create LLM provider');
  }
}

export async function updateLlmKeyAction(raw: unknown): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = UpdateLlmKeySchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const { id, provider, baseUrl, apiKey, nickname, defaultModel, isActive } = parsed.data;
    const db = getDb();

    const [existing] = await db
      .select({ id: entityLlmKeys.id })
      .from(entityLlmKeys)
      .where(and(eq(entityLlmKeys.id, id), eq(entityLlmKeys.entityId, session.entityId)));
    if (!existing) return fail('not_found', 'LLM provider not found');

    // Build patch: apiKey is included only if a non-empty value was provided.
    // Empty string / undefined → keep existing key (so users can edit other
    // fields without re-typing the secret).
    const patch: Record<string, unknown> = {
      provider,
      baseUrl,
      nickname,
      defaultModel,
      isActive,
      updatedAt: new Date(),
    };
    if (apiKey && apiKey.length > 0) {
      patch['apiKey'] = encrypt(apiKey);
      patch['apiKeyLast4'] = last4(apiKey);
    }

    await db.update(entityLlmKeys).set(patch).where(eq(entityLlmKeys.id, id));
    revalidatePath('/settings');
    return ok(undefined);
  } catch (err) {
    console.error('[updateLlmKeyAction]', err);
    return fail('db_error', 'Failed to update LLM provider');
  }
}

export async function deleteLlmKeyAction(id: string): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid LLM provider id');
    }
    const db = getDb();
    const [existing] = await db
      .select({ id: entityLlmKeys.id })
      .from(entityLlmKeys)
      .where(and(eq(entityLlmKeys.id, id), eq(entityLlmKeys.entityId, session.entityId)));
    if (!existing) return fail('not_found', 'LLM provider not found');
    // FK on agents.llm_key_id is ON DELETE SET NULL — agents are preserved.
    await db.delete(entityLlmKeys).where(eq(entityLlmKeys.id, id));
    revalidatePath('/settings');
    return ok(undefined);
  } catch (err) {
    console.error('[deleteLlmKeyAction]', err);
    return fail('db_error', 'Failed to delete LLM provider');
  }
}

/**
 * Test connectivity to an LLM provider before saving.
 * Hits the provider's `list models` (or equivalent) endpoint with the supplied
 * apiKey. Errors are returned with the apiKey REDACTED so the form's inline
 * error display can never leak the secret to the DOM.
 */
export async function testLlmKeyAction(raw: unknown): Promise<ActionResult<{ message: string }>> {
  let apiKey: string | undefined;
  try {
    const session = await getSession();
    const parsed = TestLlmKeySchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const { provider, baseUrl } = parsed.data;
    apiKey = parsed.data.apiKey;

    // If no apiKey was supplied in the form (edit mode, user didn't retype it)
    // but a keyId was provided, load the saved key from DB — ownership-checked.
    if ((!apiKey || apiKey.length === 0) && parsed.data.keyId) {
      const db = getDb();
      const [saved] = await db
        .select({ apiKey: entityLlmKeys.apiKey })
        .from(entityLlmKeys)
        .where(
          and(
            eq(entityLlmKeys.id, parsed.data.keyId),
            eq(entityLlmKeys.entityId, session.entityId),
          ),
        );
      if (!saved) {
        return fail('not_found', 'LLM provider not found');
      }
      // Decrypt the at-rest ciphertext (Brique 26). Throws on tamper / wrong
      // master key — caught by outer try/catch and surfaced as connection_failed.
      apiKey = saved.apiKey ? decrypt(saved.apiKey) : undefined;
    }

    // If a keyId was provided but the saved key turns out to be empty, fail
    // loudly — the row exists but has no usable credential.
    if (parsed.data.keyId && (!apiKey || apiKey.length === 0)) {
      return fail('no_api_key_provided', 'API key is required to test');
    }

    // ── Build the test request per provider ────────────────────────────────────
    // Each provider has a canonical base URL; the user's baseUrl (if set)
    // takes precedence so proxies / alternate regions / mocks can be tested.
    // The validation path is always the auth-required endpoint for that
    // provider — `/models` is public on OpenRouter so we hit `/auth/key`
    // there instead, which 401s on a bad key.
    const PROVIDER_TEST_CONFIG: Record<
      typeof provider,
      {
        canonicalBase: string | null;
        path: string;
        auth: 'bearer' | 'x-api-key' | 'query' | 'none';
      }
    > = {
      anthropic: {
        canonicalBase: 'https://api.anthropic.com/v1',
        path: '/models',
        auth: 'x-api-key',
      },
      openai: { canonicalBase: 'https://api.openai.com/v1', path: '/models', auth: 'bearer' },
      openrouter: {
        canonicalBase: 'https://openrouter.ai/api/v1',
        path: '/auth/key',
        auth: 'bearer',
      },
      google: {
        canonicalBase: 'https://generativelanguage.googleapis.com/v1beta',
        path: '/models',
        auth: 'query',
      },
      mistral: { canonicalBase: 'https://api.mistral.ai/v1', path: '/models', auth: 'bearer' },
      groq: { canonicalBase: 'https://api.groq.com/openai/v1', path: '/models', auth: 'bearer' },
      'openai-compatible': { canonicalBase: null, path: '/models', auth: 'bearer' },
      ollama: { canonicalBase: null, path: '/api/tags', auth: 'none' },
    };

    const cfg = PROVIDER_TEST_CONFIG[provider];
    // Resolve the effective base: user-provided wins, else canonical.
    // openai-compatible and ollama require a user-provided baseUrl.
    const effectiveBase = (baseUrl ?? '').replace(/\/$/, '') || cfg.canonicalBase;
    if (!effectiveBase) {
      return fail('validation_failed', `baseUrl is required for ${provider}`);
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    let url = `${effectiveBase}${cfg.path}`;

    if (cfg.auth === 'bearer' && apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (cfg.auth === 'x-api-key' && apiKey) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
    if (cfg.auth === 'query') {
      // Google uses ?key=... — built locally only for the fetch, never logged.
      url = `${url}?key=${encodeURIComponent(apiKey ?? '')}`;
    }

    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const truncated = body.slice(0, 200);
      return fail(
        'connection_failed',
        redactKey(`${provider} responded ${res.status}: ${truncated}`, apiKey),
      );
    }

    // Parse a model count where possible. We don't fail on parse error — a 200
    // response is enough proof of working credentials.
    let modelCount: number | null = null;
    try {
      const data = (await res.json()) as Record<string, unknown>;
      // anthropic / openai / mistral / groq / openrouter: { data: [...] }
      // google: { models: [...] }
      // ollama: { models: [...] }
      // openai-compatible: { data: [...] } (mostly)
      const arr = (data['data'] ?? data['models']) as unknown;
      if (Array.isArray(arr)) modelCount = arr.length;
    } catch {
      // ignore
    }

    return ok({
      message: modelCount !== null ? `Connected, ${modelCount} models available` : 'Connected',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return fail('connection_failed', redactKey(msg, apiKey));
  }
}

// ─── Agent Connector Assignment Actions (Brique 34bis) ────────────────────────

export type AgentConnectorRow = {
  connectorId: string;
  slug: string;
  label: string;
  credentialName: string | null;
  assigned: boolean;
  enabledOperations: string[] | null;
  availableOperations: OperationDescriptor[];
};

/**
 * Return all active connectors for this entity that have a known adapter,
 * annotated with whether the given agent currently has them assigned and
 * which operations are enabled.
 */
export async function listAgentConnectorsAction(
  agentId: string,
): Promise<ActionResult<AgentConnectorRow[]>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(agentId).success) {
      return fail('validation_failed', 'Invalid agent id');
    }
    const db = getDb();

    // Verify agent belongs to this entity
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.entityId, session.entityId)));
    if (!agent) return fail('not_found', 'Agent not found');

    // Fetch all active connectors for this entity
    const connectorRows = await db
      .select({
        id: connectors.id,
        slug: connectors.slug,
        name: connectors.name,
        credentialId: connectors.credentialId,
        active: connectors.active,
      })
      .from(connectors)
      .where(and(eq(connectors.entityId, session.entityId), eq(connectors.active, true)));

    if (connectorRows.length === 0) return ok([]);

    // Batch fetch credential names for display
    const credentialIds = [
      ...new Set(
        connectorRows.map((r) => r.credentialId).filter((id): id is string => id !== null),
      ),
    ];
    const credNameById = new Map<string, string>();
    if (credentialIds.length > 0) {
      const credRows = await db
        .select({ id: credentials.id, name: credentials.name })
        .from(credentials)
        .where(inArray(credentials.id, credentialIds));
      for (const c of credRows) credNameById.set(c.id, c.name);
    }

    // Fetch existing assignments for this agent
    const assignmentRows = await db
      .select({
        connectorId: agentConnectorAssignments.connectorId,
        enabledOperations: agentConnectorAssignments.enabledOperations,
      })
      .from(agentConnectorAssignments)
      .where(eq(agentConnectorAssignments.agentId, agentId));

    const assignmentByConnectorId = new Map<string, { enabledOperations: string[] | null }>();
    for (const a of assignmentRows) {
      assignmentByConnectorId.set(a.connectorId, {
        enabledOperations: (a.enabledOperations as string[] | null) ?? null,
      });
    }

    // Filter to connectors that have an adapter entry — surfacing connectors
    // without an adapter would create dead assignments.
    const result: AgentConnectorRow[] = [];
    for (const row of connectorRows) {
      const adapterEntry = ADAPTER_REGISTRY[row.slug];
      if (!adapterEntry) continue; // no adapter for this connector slug — skip

      const assignment = assignmentByConnectorId.get(row.id);

      result.push({
        connectorId: row.id,
        slug: row.slug,
        label: row.name,
        credentialName: row.credentialId ? (credNameById.get(row.credentialId) ?? null) : null,
        assigned: assignment !== undefined,
        enabledOperations: assignment?.enabledOperations ?? null,
        availableOperations: adapterEntry.operations,
      });
    }

    return ok(result);
  } catch (err) {
    console.error('[listAgentConnectorsAction]', err);
    return fail('db_error', 'Failed to load agent connectors');
  }
}

/**
 * Assign or unassign a connector to an agent, with optional per-operation
 * whitelist. Idempotent.
 *
 * assigned=false → DELETE the assignment row (no-op if absent).
 * assigned=true  → UPSERT with enabledOperations (null = all enabled, array = whitelist).
 */
export async function setAgentConnectorAssignmentAction(
  agentId: string,
  connectorId: string,
  assigned: boolean,
  enabledOperations: string[] | null,
): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(agentId).success) {
      return fail('validation_failed', 'Invalid agent id');
    }
    if (!z.string().guid().safeParse(connectorId).success) {
      return fail('validation_failed', 'Invalid connector id');
    }
    const db = getDb();

    // Verify agent ownership
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.entityId, session.entityId)));
    if (!agent) return fail('not_found', 'Agent not found');

    // Verify connector ownership (same entity)
    const [connector] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(eq(connectors.id, connectorId), eq(connectors.entityId, session.entityId)));
    if (!connector) return fail('not_found', 'Connector not found');

    if (!assigned) {
      // DELETE — idempotent (no error if row is absent)
      await db
        .delete(agentConnectorAssignments)
        .where(
          and(
            eq(agentConnectorAssignments.agentId, agentId),
            eq(agentConnectorAssignments.connectorId, connectorId),
          ),
        );
    } else {
      // UPSERT on the unique constraint (agent_id, connector_id)
      await db
        .insert(agentConnectorAssignments)
        .values({
          agentId,
          connectorId,
          entityId: session.entityId,
          enabledOperations: enabledOperations ?? null,
        })
        .onConflictDoUpdate({
          target: [agentConnectorAssignments.agentId, agentConnectorAssignments.connectorId],
          set: {
            enabledOperations: enabledOperations ?? null,
            updatedAt: new Date(),
          },
        });
    }

    revalidatePath('/agents');
    return ok(undefined);
  } catch (err) {
    console.error('[setAgentConnectorAssignmentAction]', err);
    return fail('db_error', 'Failed to update connector assignment');
  }
}
