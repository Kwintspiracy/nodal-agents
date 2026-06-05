'use server';

import 'server-only';
import { revalidatePath } from 'next/cache';
import { headers, cookies } from 'next/headers';
import { z } from 'zod';
import {
  writeFile as fsWriteFile,
  rename as fsRename,
  unlink as fsUnlink,
  readdir as fsReaddir,
  stat as fsStat,
  mkdir as fsMkdir,
} from 'node:fs/promises';
import {
  join as pathJoin,
  basename as pathBasename,
  dirname as pathDirname,
  resolve as pathResolve,
  isAbsolute as pathIsAbsolute,
  sep as pathSep,
} from 'node:path';
import { realpath as fsRealpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  eq,
  and,
  or,
  desc,
  inArray,
  notInArray,
  sql,
  agents,
  agentAssignments,
  agentJobs,
  chatMessages,
  conversations,
  connectors,
  credentials,
  approvalRequests,
  approvalRules,
  agentSkills,
  agentSkillAssignments,
  agentConnectorAssignments,
  mcpServers,
  agentMcpServers,
  toolCalls,
  agentSchedules,
  entityLlmKeys,
  agentWorkspaces,
  entities,
  entityMembers,
  createAgentRepo,
  createSkillRepo,
  assignSkillRepo,
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
import {
  type RootGrants,
  META_TOOL_NAMES,
  enabledMetaTools,
  parseRootGrants,
} from '@nodal-agents/shared';
import { getDb, getAuthProvider, applyActiveEntity, ACTIVE_ENTITY_COOKIE } from './server.ts';
import { requireAuth } from '@nodal-agents/auth';
import { env } from './env.ts';
import { mergeNodalaiConfig, readNodalaiConfig } from './cli-config.ts';
import { CONNECTOR_CATALOG, type ConnectorAuthType } from './connector-catalog.ts';
import { isValidAvatarUrl } from './avatar-catalog.ts';
import { MCP_CATALOG } from './mcp-catalog.ts';
import { systemSkillSlugs } from '@nodal-agents/catalog';
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
  const session = await requireAuth(req, provider);
  return applyActiveEntity(session, req);
}

// ─── Workspaces (entities) ──────────────────────────────────────────────────────
// A workspace IS an `entity`: an isolated space with its own agents, skills,
// connectors, jobs, memory, schedules and LLM keys (all entity-scoped). The
// active workspace is persisted in ACTIVE_ENTITY_COOKIE and applied to the
// session by applyActiveEntity (server.ts). Switching re-scopes the dashboard.

export type WorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  role: string;
  active: boolean;
};

function workspaceSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return `${base || 'workspace'}-${randomBytes(3).toString('hex')}`;
}

export async function listWorkspacesAction(): Promise<ActionResult<WorkspaceRow[]>> {
  try {
    const session = await getSession();
    const db = getDb();
    const rows = await db
      .select({
        id: entities.id,
        name: entities.name,
        slug: entities.slug,
        icon: entities.icon,
        role: entityMembers.role,
      })
      .from(entityMembers)
      .innerJoin(entities, eq(entities.id, entityMembers.entityId))
      .where(eq(entityMembers.userId, session.userId))
      .orderBy(entities.createdAt);
    return ok(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        icon: r.icon,
        role: r.role ?? 'member',
        active: r.id === session.entityId,
      })),
    );
  } catch (err) {
    console.error('[listWorkspacesAction]', err);
    return fail('db_error', 'Failed to list workspaces');
  }
}

export async function createWorkspaceAction(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await getSession();
    const parsed = z
      .object({ name: z.string().min(1).max(60), icon: z.string().max(8).optional() })
      .safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const db = getDb();
    const id = crypto.randomUUID();
    await db.insert(entities).values({
      id,
      userId: session.userId,
      name: parsed.data.name,
      slug: workspaceSlug(parsed.data.name),
      icon: parsed.data.icon ?? '🗂️',
    });
    await db.insert(entityMembers).values({ entityId: id, userId: session.userId, role: 'owner' });
    revalidatePath('/', 'layout');
    return ok({ id });
  } catch (err) {
    console.error('[createWorkspaceAction]', err);
    return fail('db_error', 'Failed to create workspace');
  }
}

export async function switchWorkspaceAction(raw: unknown): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = z.object({ id: z.string().guid() }).safeParse(raw);
    if (!parsed.success) return fail('validation_failed', 'Invalid workspace id');
    const db = getDb();
    const [member] = await db
      .select({ id: entityMembers.id })
      .from(entityMembers)
      .where(
        and(eq(entityMembers.userId, session.userId), eq(entityMembers.entityId, parsed.data.id)),
      );
    if (!member) return fail('not_found', 'Workspace not found');
    const c = await cookies();
    c.set(ACTIVE_ENTITY_COOKIE, parsed.data.id, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
    });
    revalidatePath('/', 'layout');
    return ok(undefined);
  } catch (err) {
    console.error('[switchWorkspaceAction]', err);
    return fail('db_error', 'Failed to switch workspace');
  }
}

export async function renameWorkspaceAction(raw: unknown): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = z
      .object({
        id: z.string().guid(),
        name: z.string().min(1).max(60),
        icon: z.string().max(8).optional(),
      })
      .safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const db = getDb();
    const [member] = await db
      .select({ role: entityMembers.role })
      .from(entityMembers)
      .where(
        and(eq(entityMembers.userId, session.userId), eq(entityMembers.entityId, parsed.data.id)),
      );
    if (!member) return fail('not_found', 'Workspace not found');
    await db
      .update(entities)
      .set({
        name: parsed.data.name,
        ...(parsed.data.icon ? { icon: parsed.data.icon } : {}),
        updatedAt: new Date(),
      })
      .where(eq(entities.id, parsed.data.id));
    revalidatePath('/', 'layout');
    return ok(undefined);
  } catch (err) {
    console.error('[renameWorkspaceAction]', err);
    return fail('db_error', 'Failed to rename workspace');
  }
}

export async function deleteWorkspaceAction(raw: unknown): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = z.object({ id: z.string().guid() }).safeParse(raw);
    if (!parsed.success) return fail('validation_failed', 'Invalid workspace id');
    if (parsed.data.id === session.entityId) {
      return fail('validation_failed', 'Switch to another workspace before deleting this one.');
    }
    const db = getDb();
    const memberships = await db
      .select({ entityId: entityMembers.entityId, role: entityMembers.role })
      .from(entityMembers)
      .where(eq(entityMembers.userId, session.userId));
    if (memberships.length <= 1)
      return fail('validation_failed', 'Cannot delete your only workspace.');
    const target = memberships.find((m) => m.entityId === parsed.data.id);
    if (!target) return fail('not_found', 'Workspace not found');
    if (target.role !== 'owner') return fail('forbidden', 'Only the owner can delete a workspace.');
    // FK onDelete:cascade removes all entity-scoped rows + memberships.
    await db.delete(entities).where(eq(entities.id, parsed.data.id));
    revalidatePath('/', 'layout');
    return ok(undefined);
  } catch (err) {
    console.error('[deleteWorkspaceAction]', err);
    return fail('db_error', 'Failed to delete workspace');
  }
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
    // Optional avatar path. Empty string → null. Validated against the
    // bundled catalog in the action body (not via Zod refine) so the
    // error message is "Unknown avatar" rather than a regex blob.
    avatarUrl: z
      .string()
      .max(200)
      .optional()
      .nullable()
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
  // Ordered LLM-key failover chain (Guard 2): (keyId, model) pairs tried after
  // the primary. Optional so list queries that don't select it stay valid; the
  // edit loader (full row) populates it.
  fallbackChain?: Array<{ keyId: string; model: string }> | null;
  active: boolean | null;
  isDefault: boolean | null;
  role: string | null;
  avatarUrl: string | null;
  createdAt: Date | null;
  telegramBotToken: string | null;
  lastSeenChatIdTelegram: string | null;
  position: number;
};

export async function listAgentsAction(): Promise<ActionResult<AgentRow[]>> {
  try {
    const session = await getSession();
    const db = getDb();
    // Position-first ordering (Brique A): the user can drag agents around
    // on the /agents page; that user-controlled order should propagate to
    // every dropdown / picker too (Jobs filter, Memories selector, etc.).
    // `desc(createdAt)` is the tiebreaker — newly-created agents float to
    // the top when nothing else discriminates them.
    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.entityId, session.entityId))
      .orderBy(agents.position, agents.name, desc(agents.createdAt));
    return ok(rows as AgentRow[]);
  } catch (err) {
    console.error('[listAgentsAction]', err);
    return fail('db_error', 'Failed to load agents');
  }
}

/**
 * Grouped agent view for the /agents page.
 *
 * Layout the UI renders:
 *   - One section per orchestrator (sorted by position, then name), with
 *     the orchestrator as the header and its sub-agents listed under it
 *     (also sorted by position).
 *   - A final "Standalone" section for workers that no orchestrator owns.
 *
 * An orchestrator that has no sub-agents still gets its own section (just
 * the header) — it's still a parent in role, even if currently empty.
 *
 * Worker rows can technically be owned by multiple orchestrators
 * (agent_assignments doesn't enforce uniqueness on sub_agent_id). When
 * that happens we surface the worker under EACH of its parents — the
 * dashboard's mental model is "what team does this agent belong to" and
 * a multi-team agent legitimately appears in both.
 */
export type AgentGroup = {
  orchestrator: AgentRow | null;
  workers: AgentRow[];
};

export async function listAgentGroupsAction(): Promise<ActionResult<AgentGroup[]>> {
  try {
    const session = await getSession();
    const db = getDb();

    const allAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.entityId, session.entityId))
      .orderBy(agents.position, agents.name);

    const allAssignments = await db
      .select({
        orchestratorId: agentAssignments.orchestratorId,
        subAgentId: agentAssignments.subAgentId,
      })
      .from(agentAssignments)
      .where(eq(agentAssignments.entityId, session.entityId));

    const byId = new Map<string, AgentRow>();
    for (const a of allAgents) byId.set(a.id, a as AgentRow);

    // childIds per orchestrator (set so duplicates from row-level repeats
    // collapse). Iteration order = order of first appearance in
    // allAssignments, but we re-sort by position below before rendering.
    const childIdsByParent = new Map<string, Set<string>>();
    const childOf = new Set<string>(); // every agent that has at least one parent
    for (const a of allAssignments) {
      const bucket = childIdsByParent.get(a.orchestratorId) ?? new Set<string>();
      bucket.add(a.subAgentId);
      childIdsByParent.set(a.orchestratorId, bucket);
      childOf.add(a.subAgentId);
    }

    const groups: AgentGroup[] = [];

    // 1. One group per orchestrator, in their own `position` order.
    const orchestrators = allAgents.filter((a) => a.role === 'orchestrator') as AgentRow[];
    for (const orch of orchestrators) {
      const ids = childIdsByParent.get(orch.id) ?? new Set();
      const workers = Array.from(ids)
        .map((id) => byId.get(id))
        .filter((w): w is AgentRow => Boolean(w))
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
      groups.push({ orchestrator: orch, workers });
    }

    // 2. Standalone bucket: any non-orchestrator agent that doesn't appear
    //    as someone's sub_agent. Skip if empty so the section header isn't
    //    rendered on workspaces that don't need it.
    const standalone = (allAgents as AgentRow[])
      .filter((a) => a.role !== 'orchestrator' && !childOf.has(a.id))
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    if (standalone.length > 0) {
      groups.push({ orchestrator: null, workers: standalone });
    }

    return ok(groups);
  } catch (err) {
    console.error('[listAgentGroupsAction]', err);
    return fail('db_error', 'Failed to load agent groups');
  }
}

/**
 * Reorder agents by writing fresh position values to a contiguous slice
 * of IDs. Caller passes the IDs in the desired new order; the action
 * assigns `position = index * 10` so subsequent inserts at fractional
 * positions are cheap (no global renumber needed).
 *
 * Cross-entity safety: every ID must belong to the caller's entity. If
 * even one doesn't, we refuse the whole batch — partial reorders are
 * confusing and we'd rather fail loud.
 */
export async function reorderAgentsAction(orderedIds: string[]): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return fail('validation_failed', 'No agent ids provided');
    }
    for (const id of orderedIds) {
      if (!z.string().guid().safeParse(id).success) {
        return fail('validation_failed', `Invalid agent id: ${id}`);
      }
    }

    // Deduplicate while preserving order — accidental dupes shouldn't fail,
    // but only the first occurrence sets the position.
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const id of orderedIds) {
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(id);
      }
    }

    const db = getDb();
    const owned = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.entityId, session.entityId), inArray(agents.id, unique)));
    if (owned.length !== unique.length) {
      return fail('not_found', 'One or more agents not in this workspace');
    }

    // Sequential UPDATEs — Drizzle has no batched-CASE-WHEN UPDATE helper.
    // For N ≤ ~50 agents (realistic ceiling) this is fast enough and keeps
    // the action readable. A future drag-and-drop reorder of 1000 rows
    // would want a CTE; not our problem today.
    const now = new Date();
    for (let i = 0; i < unique.length; i++) {
      const id = unique[i];
      if (!id) continue;
      await db
        .update(agents)
        .set({ position: i * 10, updatedAt: now })
        .where(eq(agents.id, id));
    }

    revalidatePath('/agents');
    return ok(undefined);
  } catch (err) {
    console.error('[reorderAgentsAction]', err);
    return fail('db_error', 'Failed to reorder agents');
  }
}

export async function createAgentAction(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await getSession();
    const parsed = CreateAgentSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    // Avatar must come from the bundled catalog — refuse external URLs,
    // path traversal, and anything else that didn't ship with the app.
    if (!isValidAvatarUrl(parsed.data.avatarUrl)) {
      return fail('validation_failed', 'Unknown avatar — pick one from the gallery');
    }

    // role/orchestrator_mode mapping. The DB enum is { agent, orchestrator,
    // system } — we expose a friendlier UX-level enum (worker/router/planner)
    // and translate here.
    const { dbRole, orchestratorMode } = mapRoleToDb(parsed.data.role);

    const db = getDb();
    const result = await createAgentRepo(db, session.entityId, {
      slug: parsed.data.slug,
      name: parsed.data.name,
      personality: parsed.data.personality,
      model: parsed.data.model,
      llmKeyId: parsed.data.llmKeyId ?? null,
      role: dbRole,
      orchestratorMode,
      avatarUrl: parsed.data.avatarUrl,
      subAgentIds: parsed.data.subAgentIds,
    });

    if ('error' in result) {
      return fail('conflict', 'An agent with this slug already exists');
    }

    revalidatePath('/agents');
    return ok({ id: result.id });
  } catch (err: unknown) {
    console.error('[createAgentAction]', err);
    const msg = err instanceof Error ? err.message : '';
    if (msg === 'sub_agents_not_found') {
      return fail('validation_failed', 'One or more sub-agents not found in this workspace');
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
  // Guard 2: ordered failover chain — (keyId, model) pairs tried after the
  // primary. Primary is stripped out in the action body to keep it disjoint.
  // An empty model ⇒ the runtime uses that provider's catalog default.
  fallbackChain: z
    .array(z.object({ keyId: z.string().guid(), model: z.string().max(200) }))
    .default([]),
  role: z.enum(['worker', 'router', 'planner']),
  subAgentIds: z.array(z.string().guid()).default([]),
  // Avatar — symmetric with create. Catalog validation in the action body.
  avatarUrl: z
    .string()
    .max(200)
    .optional()
    .nullable()
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
    // Catalog avatar check — refuse external URLs or bogus paths.
    if (!isValidAvatarUrl(parsed.data.avatarUrl)) {
      return fail('validation_failed', 'Unknown avatar — pick one from the gallery');
    }
    const { id, name, personality, model, llmKeyId, fallbackChain, role, subAgentIds, avatarUrl } =
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
    // avatarUrl undefined → don't touch (legacy clients don't send it); null
    // explicitly clears the avatar; a string sets it.
    const patch: Record<string, unknown> = {
      name,
      personality,
      model,
      role: dbRole,
      orchestratorMode,
      updatedAt: new Date(),
    };
    if (llmKeyId !== undefined) {
      patch['llmKeyId'] = llmKeyId;
    }
    if (avatarUrl !== undefined) {
      patch['avatarUrl'] = avatarUrl;
    }
    // Failover chain — always rewritten from the form's full list. Strip the
    // primary so it can't appear twice, and drop any link that equals it.
    patch['fallbackChain'] = fallbackChain.filter((link) => link.keyId !== llmKeyId);

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

// ─── Agent workspace actions ──────────────────────────────────────────────────

export type AgentWorkspaceRow = {
  id: string;
  agentId: string;
  entityId: string | null;
  label: string;
  path: string;
  position: number;
};

export async function listAgentWorkspacesAction(
  agentId: string,
): Promise<ActionResult<AgentWorkspaceRow[]>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(agentId).success) {
      return fail('validation_failed', 'Invalid agent id');
    }
    const db = getDb();
    // Verify ownership via the agent's entityId
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.entityId, session.entityId)));
    if (!agent) return fail('not_found', 'Agent not found');

    const rows = await db
      .select()
      .from(agentWorkspaces)
      .where(eq(agentWorkspaces.agentId, agentId))
      .orderBy(agentWorkspaces.position, agentWorkspaces.label);
    return ok(rows as AgentWorkspaceRow[]);
  } catch (err) {
    console.error('[listAgentWorkspacesAction]', err);
    return fail('db_error', 'Failed to load workspaces');
  }
}

export async function addAgentWorkspaceAction(
  agentId: string,
  label: string,
  path: string,
): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await getSession();

    // Validate inputs
    if (!z.string().guid().safeParse(agentId).success) {
      return fail('validation_failed', 'Invalid agent id');
    }
    const labelParsed = z.string().min(1).max(80).safeParse(label);
    if (!labelParsed.success) {
      return fail('validation_failed', 'Label must be 1-80 characters');
    }
    const trimmedLabel = labelParsed.data.trim();
    const trimmedPath = path.trim();
    if (!trimmedPath) {
      return fail('validation_failed', 'Path is required');
    }
    // Validate absolute path (cross-platform: must start with / or X:\)
    const isAbsolutePath = /^([A-Za-z]:[/\\]|\/|\\\\)/.test(trimmedPath);
    if (!isAbsolutePath) {
      return fail(
        'validation_failed',
        'Path must be absolute (e.g. /home/user/notes or C:\\Users\\you\\notes)',
      );
    }

    const db = getDb();
    // Verify ownership
    const [agentRow] = await db
      .select({ id: agents.id, entityId: agents.entityId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.entityId, session.entityId)));
    if (!agentRow) return fail('not_found', 'Agent not found');

    const [row] = await db
      .insert(agentWorkspaces)
      .values({
        agentId,
        entityId: agentRow.entityId,
        label: trimmedLabel,
        path: trimmedPath,
        position: 0,
      })
      .returning({ id: agentWorkspaces.id });
    if (!row) return fail('db_error', 'Insert returned no row');

    revalidatePath(`/agents/${agentId}/edit`);
    return ok({ id: row.id });
  } catch (err: unknown) {
    console.error('[addAgentWorkspaceAction]', err);
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('unique') || msg.includes('23505')) {
      return fail('conflict', 'A workspace with this label already exists for this agent');
    }
    return fail('db_error', 'Failed to add workspace');
  }
}

export async function removeAgentWorkspaceAction(workspaceId: string): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(workspaceId).success) {
      return fail('validation_failed', 'Invalid workspace id');
    }
    const db = getDb();
    // Verify ownership: join to agents to confirm entity membership
    const [wsRow] = await db
      .select({ agentId: agentWorkspaces.agentId })
      .from(agentWorkspaces)
      .where(eq(agentWorkspaces.id, workspaceId));
    if (!wsRow) return fail('not_found', 'Workspace not found');

    const [agentRow] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, wsRow.agentId), eq(agents.entityId, session.entityId)));
    if (!agentRow) return fail('not_found', 'Workspace not found');

    await db.delete(agentWorkspaces).where(eq(agentWorkspaces.id, workspaceId));
    revalidatePath(`/agents/${wsRow.agentId}/edit`);
    return ok(undefined);
  } catch (err) {
    console.error('[removeAgentWorkspaceAction]', err);
    return fail('db_error', 'Failed to remove workspace');
  }
}

// ─── Workspace file upload / list / delete ─────────────────────────────────────

/** Max bytes accepted per uploaded Office/document file: 25 MiB. */
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** MIME → extension whitelist for workspace uploads. */
const UPLOAD_ALLOWED: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  // Browsers sometimes send these for .md / .csv
  'text/x-markdown': '.md',
  'application/octet-stream': '', // extension-only fallback — validated by ext below
};

const UPLOAD_ALLOWED_EXTS = new Set(['.docx', '.xlsx', '.pptx', '.pdf', '.txt', '.md', '.csv']);

/**
 * Resolve a workspace path for the given (agentId, workspaceLabel) and verify
 * the resulting path stays inside the workspace root. This is the server-side
 * equivalent of resolveAndCheckPath from the tools package — we duplicate the
 * boundary check here to avoid importing the tools package in the web app.
 */
async function resolveWorkspacePath(
  workspaceRoot: string,
  filename: string,
): Promise<{ ok: true; resolved: string } | { ok: false; reason: string }> {
  if (!pathIsAbsolute(workspaceRoot)) {
    return { ok: false, reason: 'Workspace root is not an absolute path.' };
  }
  // Prevent path traversal in filename
  const safe = pathBasename(filename);
  if (!safe || safe.startsWith('.')) {
    return { ok: false, reason: `Invalid filename: "${filename}"` };
  }
  const realRoot = await fsRealpath(workspaceRoot).catch(() => null);
  if (!realRoot) {
    return { ok: false, reason: `Workspace directory does not exist: "${workspaceRoot}"` };
  }
  const candidate = pathResolve(realRoot, safe);
  const rootWithSep = realRoot.endsWith(pathSep) ? realRoot : realRoot + pathSep;
  if (candidate !== realRoot && !candidate.startsWith(rootWithSep)) {
    return { ok: false, reason: `Path traversal blocked for filename "${filename}".` };
  }
  return { ok: true, resolved: candidate };
}

/**
 * Upload a file into a workspace.
 * Validates: ownership, workspace label, file size, MIME/extension whitelist,
 * path safety. Atomic write (temp-rename).
 */
export async function uploadToWorkspaceAction(
  agentId: string,
  workspaceLabel: string,
  formData: FormData,
): Promise<ActionResult<{ filename: string; bytes: number }>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(agentId).success) {
      return fail('validation_failed', 'Invalid agent id');
    }
    if (!z.string().min(1).max(80).safeParse(workspaceLabel).success) {
      return fail('validation_failed', 'Invalid workspace label');
    }

    const db = getDb();
    // Ownership check
    const [agentRow] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.entityId, session.entityId)));
    if (!agentRow) return fail('not_found', 'Agent not found');

    // Resolve workspace by label
    const [wsRow] = await db
      .select({ path: agentWorkspaces.path })
      .from(agentWorkspaces)
      .where(and(eq(agentWorkspaces.agentId, agentId), eq(agentWorkspaces.label, workspaceLabel)));
    if (!wsRow) return fail('not_found', `Workspace "${workspaceLabel}" not found for this agent`);

    const file = formData.get('file');
    if (!(file instanceof File)) {
      return fail('validation_failed', 'No file provided in FormData (field "file")');
    }

    // Size cap
    if (file.size > UPLOAD_MAX_BYTES) {
      return fail(
        'file_too_large',
        `File is ${file.size} bytes (max ${UPLOAD_MAX_BYTES}). Compress or split it first.`,
      );
    }

    // MIME + extension check
    const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    const mimeOk = file.type in UPLOAD_ALLOWED;
    const extOk = UPLOAD_ALLOWED_EXTS.has(ext);
    if (!mimeOk && !extOk) {
      return fail(
        'unsupported_file_type',
        `File type "${file.type}" / extension "${ext}" is not allowed. ` +
          `Allowed: ${[...UPLOAD_ALLOWED_EXTS].join(', ')}.`,
      );
    }
    // Special case: octet-stream is allowed only when extension is in the allowed set
    if (file.type === 'application/octet-stream' && !extOk) {
      return fail(
        'unsupported_file_type',
        `Extension "${ext}" is not allowed. Allowed: ${[...UPLOAD_ALLOWED_EXTS].join(', ')}.`,
      );
    }

    // Ensure workspace directory exists
    await fsMkdir(wsRow.path, { recursive: true });

    // Path safety check
    const pathResult = await resolveWorkspacePath(wsRow.path, file.name);
    if (!pathResult.ok) return fail('path_traversal_blocked', pathResult.reason);

    // Atomic write: tempfile in same dir → rename
    const dir = pathDirname(pathResult.resolved);
    const tmp = pathJoin(
      dir,
      `.${pathBasename(pathResult.resolved)}.${randomBytes(6).toString('hex')}.tmp`,
    );
    const bytes = await file.arrayBuffer();
    try {
      await fsWriteFile(tmp, Buffer.from(bytes));
      await fsRename(tmp, pathResult.resolved);
    } catch (err) {
      await fsUnlink(tmp).catch(() => undefined);
      throw err;
    }

    revalidatePath(`/agents/${agentId}/edit`);
    return ok({ filename: pathBasename(pathResult.resolved), bytes: file.size });
  } catch (err) {
    console.error('[uploadToWorkspaceAction]', err);
    return fail('db_error', 'Upload failed');
  }
}

export type WorkspaceFileRow = {
  name: string;
  size: number;
  modifiedAt: string;
};

/**
 * List files in a workspace directory.
 * Returns a flat list of regular files (no subdirectories) sorted by name.
 */
export async function listWorkspaceFilesAction(
  agentId: string,
  workspaceLabel: string,
): Promise<ActionResult<WorkspaceFileRow[]>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(agentId).success) {
      return fail('validation_failed', 'Invalid agent id');
    }
    const db = getDb();
    // Ownership check
    const [agentRow] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.entityId, session.entityId)));
    if (!agentRow) return fail('not_found', 'Agent not found');

    const [wsRow] = await db
      .select({ path: agentWorkspaces.path })
      .from(agentWorkspaces)
      .where(and(eq(agentWorkspaces.agentId, agentId), eq(agentWorkspaces.label, workspaceLabel)));
    if (!wsRow) return fail('not_found', `Workspace "${workspaceLabel}" not found for this agent`);

    // Directory may not exist yet (no files uploaded)
    const dirExists = await fsStat(wsRow.path)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (!dirExists) return ok([]);

    const entries = await fsReaddir(wsRow.path, { withFileTypes: true });
    const files: WorkspaceFileRow[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = pathJoin(wsRow.path, entry.name);
      const info = await fsStat(fullPath).catch(() => null);
      if (!info) continue;
      files.push({
        name: entry.name,
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
      });
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    return ok(files);
  } catch (err) {
    console.error('[listWorkspaceFilesAction]', err);
    return fail('db_error', 'Failed to list workspace files');
  }
}

/**
 * Delete a single file from a workspace.
 * Validates ownership + path safety before unlinking.
 */
export async function deleteWorkspaceFileAction(
  agentId: string,
  workspaceLabel: string,
  filename: string,
): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(agentId).success) {
      return fail('validation_failed', 'Invalid agent id');
    }
    const db = getDb();
    // Ownership check
    const [agentRow] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.entityId, session.entityId)));
    if (!agentRow) return fail('not_found', 'Agent not found');

    const [wsRow] = await db
      .select({ path: agentWorkspaces.path })
      .from(agentWorkspaces)
      .where(and(eq(agentWorkspaces.agentId, agentId), eq(agentWorkspaces.label, workspaceLabel)));
    if (!wsRow) return fail('not_found', `Workspace "${workspaceLabel}" not found for this agent`);

    // Path safety: only allow a bare filename (no slashes)
    const pathResult = await resolveWorkspacePath(wsRow.path, filename);
    if (!pathResult.ok) return fail('path_traversal_blocked', pathResult.reason);

    await fsUnlink(pathResult.resolved);
    revalidatePath(`/agents/${agentId}/edit`);
    return ok(undefined);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return fail('not_found', `File "${filename}" not found in workspace`);
    console.error('[deleteWorkspaceFileAction]', err);
    return fail('db_error', 'Failed to delete file');
  }
}

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

// Terminal job statuses — same set the runner's state machine treats as
// having no outbound edges (apps/runner/src/job/state.ts). Mirrored here
// so `cancelJobAction` refuses requests that would be no-ops anyway, and
// so the UI can hide the Cancel button on jobs that are already done.
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Cancel a job from any non-terminal state.
 *
 * Behaviour by current status:
 *   - pending / awaiting_approval / awaiting_delegation — set to 'cancelled'
 *     immediately. The runner's cron picks no work, so this is enough.
 *   - processing — set to 'cancelled' too. The runner's LLM loop checks
 *     the live status between turns (see apps/runner/src/job/execute.ts)
 *     and bails out cooperatively at the next checkpoint. Current
 *     in-flight LLM/tool calls finish naturally; we don't kill them
 *     mid-flight (interrupting an API call mid-stream tends to leave
 *     half-written DB rows and confused providers).
 *   - completed / failed / cancelled — refuse, nothing to do.
 *
 * Descendants cascade: every non-terminal job whose `parent_job_id`
 * chain reaches the target is also flipped to 'cancelled' in the same
 * UPDATE. Without this, a parent that's blocked awaiting a delegated
 * child would still see the child happily burning LLM turns to
 * completion — pointless work the user explicitly stopped wanting. The
 * delegation depth cap is 3 (DEFAULT_LIMITS), so the recursive CTE has
 * a bounded fan-out.
 *
 * Auth: scoped to the caller's entity; cross-entity cancels return
 * 'not_found' (same shape as the lookup actions — don't leak existence).
 */
export async function cancelJobAction(id: string): Promise<ActionResult<{ status: string }>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid job id');
    }
    const db = getDb();

    const [row] = await db
      .select({ status: agentJobs.status })
      .from(agentJobs)
      .where(and(eq(agentJobs.id, id), eq(agentJobs.entityId, session.entityId)));
    if (!row) return fail('not_found', 'Job not found');

    const current = row.status ?? 'pending';
    if (TERMINAL_STATUSES.has(current)) {
      return fail('already_terminal', `Job is already ${current}`);
    }

    // Recursive cascade: the target job + every non-terminal descendant.
    // entity_id is re-asserted on the UPDATE side too so a buggy CTE can
    // never escape the caller's workspace. The status filter spares
    // completed/failed/cancelled descendants — we don't rewrite history
    // for jobs that already finished before the cancel hit.
    await db.execute(sql`
      WITH RECURSIVE descendants AS (
        SELECT id FROM agent_jobs WHERE id = ${id}
        UNION ALL
        SELECT j.id
        FROM agent_jobs j
        INNER JOIN descendants d ON j.parent_job_id = d.id
      )
      UPDATE agent_jobs
      SET status = 'cancelled', updated_at = now()
      WHERE id IN (SELECT id FROM descendants)
        AND entity_id = ${session.entityId}
        AND status NOT IN ('completed', 'failed', 'cancelled')
    `);

    revalidatePath('/jobs');
    revalidatePath(`/jobs/${id}`);
    return ok({ status: 'cancelled' });
  } catch (err) {
    console.error('[cancelJobAction]', err);
    return fail('db_error', 'Failed to cancel job');
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

// Multi-instance brique: the entity can hold N connector rows of the same
// slug (Gmail perso + Gmail boulot, etc.). `listConnectorsAction` returns a
// flat `instances` array plus the static `catalog` of available types so the
// dashboard can render "Active Connectors" + "Marketplace" side by side.
export type ConnectorCatalogItem = {
  slug: string;
  label: string;
  authType: ConnectorAuthType;
  docsHint: string;
  credentialType: CredentialType | null;
};

export type ConnectorsListResponse = {
  instances: ConnectorRow[];
  catalog: ConnectorCatalogItem[];
};

export async function listConnectorsAction(): Promise<ActionResult<ConnectorsListResponse>> {
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

    // Map every connector row to a flat ConnectorRow — multi-instance: several
    // rows can share the same slug.
    const instances: ConnectorRow[] = rows.map((row) => {
      const cred = row.credentialId ? credById.get(row.credentialId) : undefined;
      const display = row.credentialId ? (credDisplayById.get(row.credentialId) ?? null) : null;
      return {
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
      };
    });

    const catalog: ConnectorCatalogItem[] = CONNECTOR_CATALOG.map((c) => ({
      slug: c.slug,
      label: c.label,
      authType: c.authType,
      docsHint: c.docsHint,
      credentialType: c.credentialType ?? null,
    }));

    return ok({ instances, catalog });
  } catch (err) {
    console.error('[listConnectorsAction]', err);
    return fail('db_error', 'Failed to load connectors');
  }
}

const SaveApiKeyConnectorSchema = z.object({
  slug: z.string().min(1).max(80),
  name: z.string().min(1, 'Name is required').max(120),
  apiKey: z.string().min(1, 'API key is required'),
});

/**
 * Multi-instance brique: this is now a pure INSERT — every call creates a new
 * connector instance for the (entity, slug) pair. To rotate the API key or
 * rename an existing instance, use `renameConnectorAction` / delete + recreate.
 */
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
    // Encrypt idempotently: if value is already encrypted (enc:v1: prefix), keep it.
    const encApiKey = isEncrypted(parsed.data.apiKey)
      ? parsed.data.apiKey
      : encrypt(parsed.data.apiKey);

    const [row] = await db
      .insert(connectors)
      .values({
        entityId: session.entityId,
        slug: parsed.data.slug,
        name: parsed.data.name,
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

// Multi-instance brique: one instance per row, several rows per slug allowed.
export type McpServerInstance = {
  id: string;
  slug: string;
  name: string;
  active: boolean;
  hasApiKey: boolean;
  apiKeyLast4: string | null;
  toolCount: number;
  createdAt: Date | null;
};

export type McpCatalogItem = {
  slug: string;
  label: string;
  description: string;
  docsHint: string;
  /**
   * Accepted API-key prefixes. Empty array = no prefix check (provider
   * has no canonical prefix or accepts many formats — Composio etc.).
   * Any-of match against the candidate API key.
   */
  keyPrefix: string[];
  /**
   * `null` means the catalog entry requires the user to paste a server URL
   * (per-account hosted MCP servers like Composio). The Add form renders an
   * extra URL input in that case.
   */
  serverUrl: string | null;
  /** Transport — drives which custom-input fields the form renders. */
  transport: 'http' | 'stdio';
  /**
   * Pre-filled command for non-custom stdio entries.
   * `undefined` for HTTP entries and the `custom-stdio-mcp` sentinel.
   */
  command?: string;
  /**
   * Pre-filled args for non-custom stdio entries, joined by newline for the
   * textarea in McpAddForm. `undefined` for HTTP and `custom-stdio-mcp`.
   * May contain placeholder strings like `'<root-directory>'` that the user
   * is expected to edit before connecting.
   */
  args?: string[];
  /**
   * Env var names the server expects — rendered as pre-labelled rows in the
   * Add form. `undefined` = no env vars required.
   */
  envVarNames?: string[];
  /** Marketplace badge status — `'pending'` renders a "Test pending" pill. */
  status: 'verified' | 'pending';
};

export type McpServersListResponse = {
  instances: McpServerInstance[];
  catalog: McpCatalogItem[];
};

/**
 * Return every mcp_servers row for the entity (multi-instance: several
 * per slug allowed) plus the static MCP_CATALOG for the marketplace.
 * Never returns the encrypted key.
 */
export async function listMcpServersAction(): Promise<ActionResult<McpServersListResponse>> {
  try {
    const session = await getSession();
    const db = getDb();
    const rows = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.entityId, session.entityId));

    const instances: McpServerInstance[] = rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      active: row.active ?? true,
      hasApiKey: !!row.apiKey,
      apiKeyLast4: row.apiKeyLast4 ?? null,
      toolCount: Array.isArray(row.availableTools) ? row.availableTools.length : 0,
      createdAt: row.createdAt,
    }));

    const catalog: McpCatalogItem[] = MCP_CATALOG.map((c) => ({
      slug: c.slug,
      label: c.label,
      description: c.description,
      docsHint: c.docsHint,
      keyPrefix: c.keyPrefix,
      serverUrl: c.serverUrl,
      transport: c.transport,
      command: c.command,
      args: c.args,
      envVarNames: c.envVarNames,
      status: c.status ?? 'verified',
    }));

    return ok({ instances, catalog });
  } catch (err) {
    console.error('[listMcpServersAction]', err);
    return fail('db_error', 'Failed to load MCP connectors');
  }
}

const CreateMcpServerSchema = z.object({
  slug: z.string().min(1).max(80),
  name: z.string().min(1, 'Name is required').max(120),
  /** Required for HTTP entries; optional for stdio (env vars take the secret role). */
  apiKey: z.string().max(2_000).optional(),
  /** Required when the catalog entry has `serverUrl: null` (user-supplied URL pattern). */
  url: z.string().url('Invalid URL').optional(),

  // ── Custom-only fields, validated only when slug is a custom-* sentinel. ──
  /** kebab-case slug used as the tool-name prefix at runtime. Must be unique
   *  per entity (validated at the action body level). */
  customSlug: z
    .string()
    .min(2)
    .max(30)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase letters, digits, dashes')
    .optional(),
  /** HTTP custom only — overrides the catalog placeholder. */
  customAuthScheme: z.enum(['header', 'query', 'bearer']).optional(),
  customAuthParamName: z.string().min(1).max(100).optional(),
  /** stdio custom only — what to spawn. */
  customCommand: z.string().min(1).max(200).optional(),
  customArgs: z.array(z.string().max(500)).max(20).optional(),
  /** stdio custom only — env vars merged on top of process.env. VALUES are
   *  encrypted before being persisted (the runner decrypts at job time). */
  customEnv: z.record(z.string(), z.string().max(2_000)).optional(),
});

/**
 * Connect an MCP catalog entry. Connect-and-verify against the live server
 * BEFORE persisting — a bad key fails loud here and writes no row, so the
 * dashboard never shows a dead connector. On success the encrypted key + the
 * discovered tool list are INSERTED (multi-instance: several rows per slug
 * allowed; to rotate a key, delete the instance and re-create).
 *
 * Catalog flexibility (Brique A v3):
 * - `catalog.serverUrl === null` → the user must supply `input.url`.
 * - `catalog.verifyToolName === null` → skip the extra verify call; the
 *   underlying `tools/list` (which fails on bad auth) is sufficient.
 * - `catalog.keyPrefix === []` → no prefix check (provider has no
 *   canonical prefix or accepts many formats — Composio etc.).
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

    const isCustomHttp = catalog.slug === 'custom-http-mcp';
    const isCustomStdio = catalog.slug === 'custom-stdio-mcp';

    // ── Resolve effective config: catalog defaults, overridden by user input
    //    for the two reserved "custom-*" sentinel slugs. ────────────────────────
    //
    // The persisted `mcp_servers.slug` becomes the user-typed `customSlug`
    // for customs (so tool name prefixes stay collision-free), or the catalog
    // slug otherwise. Substitution happens up-front so the rest of the action
    // doesn't branch repeatedly.
    let effectiveSlug = catalog.slug;
    let effectiveTransport: 'http' | 'stdio' = catalog.transport;
    let effectiveAuthScheme = catalog.authScheme;
    let effectiveAuthParamName: string = catalog.authParamName;

    if (isCustomHttp) {
      if (!parsed.data.customSlug) {
        return fail('validation_failed', 'Server slug is required for custom MCP');
      }
      if (!parsed.data.customAuthScheme) {
        return fail('validation_failed', 'Auth scheme is required for custom MCP');
      }
      effectiveSlug = parsed.data.customSlug;
      effectiveAuthScheme = parsed.data.customAuthScheme;
      // authParamName is meaningless for bearer (Authorization header is
      // hardcoded by the SDK). Keep a non-null placeholder for column-not-null
      // hygiene; the runtime ignores it.
      effectiveAuthParamName =
        parsed.data.customAuthScheme === 'bearer'
          ? 'Authorization'
          : (parsed.data.customAuthParamName ?? '');
      if (effectiveAuthScheme !== 'bearer' && !effectiveAuthParamName) {
        return fail(
          'validation_failed',
          `Auth param name is required for the "${effectiveAuthScheme}" scheme`,
        );
      }
    } else if (isCustomStdio) {
      if (!parsed.data.customSlug) {
        return fail('validation_failed', 'Server slug is required for custom MCP');
      }
      if (!parsed.data.customCommand) {
        return fail('validation_failed', 'Command is required for stdio MCP');
      }
      effectiveSlug = parsed.data.customSlug;
      effectiveTransport = 'stdio';
    }

    // ── Slug uniqueness check (for customs only — catalog slugs are allowed
    //    to repeat per multi-instance brique). Tool name prefixes use this
    //    slug, so duplicates would collide at the agent level. ─────────────────
    if (isCustomHttp || isCustomStdio) {
      const db = getDb();
      const existing = await db
        .select({ id: mcpServers.id })
        .from(mcpServers)
        .where(and(eq(mcpServers.entityId, session.entityId), eq(mcpServers.slug, effectiveSlug)));
      if (existing.length > 0) {
        return fail(
          'slug_taken',
          `Slug "${effectiveSlug}" is already used by another MCP server. Pick a different one.`,
        );
      }
    }

    // ── HTTP path: connect-and-verify over Streamable HTTP. ───────────────────
    if (effectiveTransport === 'http') {
      const apiKey = (parsed.data.apiKey ?? '').trim();
      if (!apiKey) return fail('validation_failed', 'API key is required');
      if (
        !isCustomHttp &&
        catalog.keyPrefix.length > 0 &&
        !catalog.keyPrefix.some((p) => apiKey.startsWith(p))
      ) {
        const expected =
          catalog.keyPrefix.length === 1
            ? `"${catalog.keyPrefix[0]}"`
            : `one of: ${catalog.keyPrefix.map((p) => `"${p}"`).join(', ')}`;
        return fail('validation_failed', `API key must start with ${expected}`);
      }
      const effectiveUrl = catalog.serverUrl ?? parsed.data.url ?? null;
      if (!effectiveUrl) {
        return fail('validation_failed', `${catalog.label} requires a server URL`);
      }

      let toolDescriptors: McpToolSummary[] = [];
      let conn: Awaited<ReturnType<typeof connectMcp>> | null = null;
      try {
        conn = await connectMcp({
          transport: 'http',
          url: effectiveUrl,
          apiKey,
          authScheme: effectiveAuthScheme,
          authParamName: effectiveAuthParamName,
        });
        if (catalog.verifyToolName && !isCustomHttp) {
          const verify = await conn.client.callTool({
            name: catalog.verifyToolName,
            arguments: {},
          });
          if (verify.isError === true) {
            return fail('mcp_connect_failed', `${catalog.label} rejected the API key.`);
          }
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
          name: parsed.data.name,
          slug: effectiveSlug,
          transport: 'http',
          url: effectiveUrl,
          apiKey: encApiKey,
          apiKeyLast4: last4(apiKey),
          authScheme: effectiveAuthScheme,
          authParamName: effectiveAuthParamName,
          availableTools: toolDescriptors,
          active: true,
        })
        .returning({ id: mcpServers.id });
      if (!row) return fail('db_error', 'Insert returned no row');
      revalidatePath('/mcp');
      return ok({ id: row.id });
    }

    // ── Stdio path: spawn-and-list. Env values are encrypted at rest because
    //    they typically carry secrets (GITHUB_TOKEN, etc.). The runner
    //    decrypts at job execution time before passing to StdioClientTransport.
    //
    // For pre-filled catalog entries (non-custom-stdio-mcp): command + args
    // come from the catalog. The user supplies only env vars (and edited args
    // via customArgs when they override the catalog defaults, e.g. to fill in
    // a <root-directory> placeholder).
    // For the custom-stdio-mcp sentinel: everything comes from user input.
    const command = isCustomStdio
      ? parsed.data.customCommand!
      : (catalog.command ?? parsed.data.customCommand!);
    const args = parsed.data.customArgs ?? catalog.args ?? [];
    const userEnv = parsed.data.customEnv ?? {};

    let stdioToolDescriptors: McpToolSummary[] = [];
    let stdioConn: Awaited<ReturnType<typeof connectMcp>> | null = null;
    try {
      stdioConn = await connectMcp({
        transport: 'stdio',
        command,
        args,
        env: userEnv,
      });
      stdioToolDescriptors = stdioConn.tools.map((t) => ({
        name: t.name,
        description: t.description ?? null,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(
        'mcp_connect_failed',
        `Could not start ${catalog.label} subprocess (${command}): ${msg}`,
      );
    } finally {
      if (stdioConn) await stdioConn.close().catch(() => {});
    }

    // Encrypt each env value individually so the runner can decrypt one at a
    // time without holding the whole map in plaintext memory longer than
    // necessary.
    const encEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(userEnv)) {
      encEnv[k] = encrypt(v);
    }

    const db = getDb();
    const [row] = await db
      .insert(mcpServers)
      .values({
        entityId: session.entityId,
        name: parsed.data.name,
        slug: effectiveSlug,
        transport: 'stdio',
        // url / apiKey / auth* not meaningful for stdio — leave null. The
        // runner branches on `transport` so these are never read in the
        // stdio path.
        url: null,
        apiKey: null,
        apiKeyLast4: null,
        authScheme: null,
        authParamName: null,
        command,
        args,
        envVars: encEnv,
        availableTools: stdioToolDescriptors,
        active: true,
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

/**
 * Multi-instance brique: rename an MCP server instance. Used by the /mcp
 * Active Servers list to let users disambiguate
 * (e.g. "Cogni Cortex" → "Cortex — perso").
 */
export async function renameMcpServerAction(
  mcpServerId: string,
  name: string,
): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(mcpServerId).success) {
      return fail('validation_failed', 'Invalid MCP server id');
    }
    const nameParsed = z.string().min(1, 'Name is required').max(120).safeParse(name);
    if (!nameParsed.success) {
      return fail('validation_failed', nameParsed.error.issues[0]?.message ?? 'Invalid name');
    }
    const db = getDb();
    const [existing] = await db
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(and(eq(mcpServers.id, mcpServerId), eq(mcpServers.entityId, session.entityId)));
    if (!existing) return fail('not_found', 'MCP connector not found');
    await db
      .update(mcpServers)
      .set({ name: nameParsed.data, updatedAt: new Date() })
      .where(eq(mcpServers.id, mcpServerId));
    revalidatePath('/mcp');
    return ok(undefined);
  } catch (err) {
    console.error('[renameMcpServerAction]', err);
    return fail('db_error', 'Failed to rename MCP server');
  }
}

/**
 * Rotate the API key on an existing MCP server.
 *
 * Symmetric with `updateConnectorApiKeyAction`: lets the user change a
 * compromised or expired key without deleting the row, which would
 * cascade-drop every `agent_mcp_servers` assignment.
 *
 * Validation flow matches `createMcpServerFromCatalogAction`:
 *   1. Catalog `keyPrefix` check (any-of) when the catalog declares one.
 *   2. Re-connect + `tools/list` round-trip so a wrong key fails loud
 *      BEFORE we persist — better than silent breakage on the next job.
 *      We refresh `available_tools` while we're at it: providers like
 *      Stripe may have added new endpoints since the original connect.
 *   3. Encrypt + update + revalidate.
 */
export async function updateMcpServerApiKeyAction(
  mcpServerId: string,
  newApiKey: string,
): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(mcpServerId).success) {
      return fail('validation_failed', 'Invalid MCP server id');
    }
    const keyParsed = z.string().min(1, 'API key is required').max(2_000).safeParse(newApiKey);
    if (!keyParsed.success) {
      return fail('validation_failed', keyParsed.error.issues[0]?.message ?? 'Invalid API key');
    }
    const apiKey = keyParsed.data.trim();

    const db = getDb();
    const [existing] = await db
      .select({
        id: mcpServers.id,
        slug: mcpServers.slug,
        url: mcpServers.url,
        authScheme: mcpServers.authScheme,
        authParamName: mcpServers.authParamName,
      })
      .from(mcpServers)
      .where(and(eq(mcpServers.id, mcpServerId), eq(mcpServers.entityId, session.entityId)));
    if (!existing) return fail('not_found', 'MCP connector not found');

    const catalog = MCP_CATALOG.find((e) => e.slug === existing.slug);
    // Catalog entry can be missing for legacy rows whose slug was deprecated;
    // skip the prefix check in that case rather than blocking rotation.
    if (catalog && catalog.keyPrefix.length > 0) {
      if (!catalog.keyPrefix.some((p) => apiKey.startsWith(p))) {
        const expected =
          catalog.keyPrefix.length === 1
            ? `"${catalog.keyPrefix[0]}"`
            : `one of: ${catalog.keyPrefix.map((p) => `"${p}"`).join(', ')}`;
        return fail('validation_failed', `API key must start with ${expected}`);
      }
    }

    if (!existing.url || !existing.authScheme || !existing.authParamName) {
      // Bad legacy row — bail rather than silently rotate a key on a
      // server we can't actually connect to. The user should delete and
      // recreate to fix the data.
      return fail('validation_failed', 'MCP server has incomplete configuration');
    }

    // Verify the new key by attempting a fresh connect. If verifyToolName
    // is set on the catalog, call it for an extra read-only sanity check
    // (same logic as create). Key rotation only makes sense for HTTP servers
    // (stdio uses env vars instead of an HTTP-injected key), and the action
    // is gated on existing.url / authScheme above so we're definitely HTTP
    // here.
    let toolDescriptors: McpToolSummary[] = [];
    let conn: Awaited<ReturnType<typeof connectMcp>> | null = null;
    try {
      conn = await connectMcp({
        transport: 'http',
        url: existing.url,
        apiKey,
        authScheme: existing.authScheme as 'header' | 'query' | 'bearer',
        authParamName: existing.authParamName,
      });
      const tools = await conn.client.listTools();
      toolDescriptors = (tools.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? null,
      }));
      if (catalog?.verifyToolName) {
        await conn.client.callTool({ name: catalog.verifyToolName, arguments: {} });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      return fail('mcp_connect_failed', `Couldn't verify the new key: ${msg}`);
    } finally {
      if (conn) await conn.close().catch(() => {});
    }

    const enc = isEncrypted(apiKey) ? apiKey : encrypt(apiKey);

    await db
      .update(mcpServers)
      .set({
        apiKey: enc,
        apiKeyLast4: last4(apiKey),
        availableTools: toolDescriptors,
        updatedAt: new Date(),
      })
      .where(eq(mcpServers.id, mcpServerId));

    revalidatePath('/mcp');
    return ok(undefined);
  } catch (err) {
    console.error('[updateMcpServerApiKeyAction]', err);
    return fail('db_error', 'Failed to rotate MCP API key');
  }
}

/**
 * Non-secret configuration of one MCP server, for prefilling the edit form.
 * Secrets (apiKey, env var VALUES) are NEVER included — only env var KEYS and
 * the masked apiKeyLast4. Mirrors the "plaintext never leaves the server"
 * rule used everywhere else (listMcpServersAction, McpServerInstance).
 */
export type McpServerConfig = {
  id: string;
  name: string;
  slug: string;
  transport: 'http' | 'stdio';
  url: string | null;
  authScheme: 'header' | 'query' | 'bearer' | null;
  authParamName: string | null;
  command: string | null;
  args: string[];
  /** Env var KEYS only — values stay encrypted on the server. */
  envKeys: string[];
  hasApiKey: boolean;
  apiKeyLast4: string | null;
};

/**
 * Read a single MCP server's structural config for the edit form. Entity-scoped.
 * Returns NO secrets — only field shapes and env var keys.
 */
export async function getMcpServerConfigAction(
  mcpServerId: string,
): Promise<ActionResult<McpServerConfig>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(mcpServerId).success) {
      return fail('validation_failed', 'Invalid MCP server id');
    }
    const db = getDb();
    const [row] = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.id, mcpServerId), eq(mcpServers.entityId, session.entityId)));
    if (!row) return fail('not_found', 'MCP connector not found');

    const envVars = (row.envVars ?? {}) as Record<string, string>;
    return ok({
      id: row.id,
      name: row.name,
      slug: row.slug,
      transport: row.transport as 'http' | 'stdio',
      url: row.url ?? null,
      authScheme: (row.authScheme ?? null) as 'header' | 'query' | 'bearer' | null,
      authParamName: row.authParamName ?? null,
      command: row.command ?? null,
      args: Array.isArray(row.args) ? (row.args as string[]) : [],
      envKeys: Object.keys(envVars),
      hasApiKey: !!row.apiKey,
      apiKeyLast4: row.apiKeyLast4 ?? null,
    });
  } catch (err) {
    console.error('[getMcpServerConfigAction]', err);
    return fail('db_error', 'Failed to load MCP server config');
  }
}

const UpdateMcpServerSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  // ── HTTP fields ──
  url: z.string().url('Invalid URL').optional(),
  authScheme: z.enum(['header', 'query', 'bearer']).optional(),
  authParamName: z.string().max(100).optional(),
  /** New secret — omit/blank to keep the existing stored key. */
  apiKey: z.string().max(2_000).optional(),
  // ── stdio fields ──
  command: z.string().min(1).max(200).optional(),
  args: z.array(z.string().max(500)).max(20).optional(),
  /**
   * Desired env var set. For each key: a non-empty value REPLACES the stored
   * one; an empty value KEEPS the existing encrypted value. Keys absent from
   * this map are DROPPED. Omit the whole field to keep env untouched.
   */
  env: z.record(z.string(), z.string().max(2_000)).optional(),
});

/**
 * Edit an existing MCP server's structural config (URL/auth for HTTP,
 * command/args/env for stdio). `slug` and `transport` are immutable — the slug
 * is the tool-name prefix (changing it would orphan agent assignments) and the
 * transport determines the whole shape.
 *
 * Mirrors createMcpServerFromCatalogAction: connect-and-verify with the NEW
 * config BEFORE persisting, so a broken edit fails loud and writes nothing.
 * Secrets follow the rotate-key contract: a blank secret field keeps the
 * existing encrypted value (the plaintext is decrypted only server-side, only
 * to re-verify the live connection).
 */
export async function updateMcpServerConfigAction(
  mcpServerId: string,
  raw: unknown,
): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(mcpServerId).success) {
      return fail('validation_failed', 'Invalid MCP server id');
    }
    const parsed = UpdateMcpServerSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }

    const db = getDb();
    const [existing] = await db
      .select()
      .from(mcpServers)
      .where(and(eq(mcpServers.id, mcpServerId), eq(mcpServers.entityId, session.entityId)));
    if (!existing) return fail('not_found', 'MCP connector not found');

    const catalog = MCP_CATALOG.find((e) => e.slug === existing.slug);

    // ── HTTP ──────────────────────────────────────────────────────────────────
    if (existing.transport === 'http') {
      const effectiveUrl = (parsed.data.url ?? existing.url ?? '').trim();
      if (!effectiveUrl) return fail('validation_failed', 'Server URL is required');
      const effectiveScheme = (parsed.data.authScheme ?? existing.authScheme ?? 'header') as
        | 'header'
        | 'query'
        | 'bearer';
      const effectiveParam =
        effectiveScheme === 'bearer'
          ? 'Authorization'
          : (parsed.data.authParamName ?? existing.authParamName ?? '').trim();
      if (effectiveScheme !== 'bearer' && !effectiveParam) {
        return fail(
          'validation_failed',
          `Auth param name is required for the "${effectiveScheme}" scheme`,
        );
      }

      // Resolve the key: a new key REPLACES; blank KEEPS the existing one
      // (decrypted server-side only, to re-verify the live connection).
      const newKey = (parsed.data.apiKey ?? '').trim();
      const newKeyProvided = newKey.length > 0;
      let apiKeyPlain: string;
      if (newKeyProvided) {
        if (
          catalog &&
          catalog.keyPrefix.length > 0 &&
          !catalog.keyPrefix.some((p) => newKey.startsWith(p))
        ) {
          const expected =
            catalog.keyPrefix.length === 1
              ? `"${catalog.keyPrefix[0]}"`
              : `one of: ${catalog.keyPrefix.map((p) => `"${p}"`).join(', ')}`;
          return fail('validation_failed', `API key must start with ${expected}`);
        }
        apiKeyPlain = newKey;
      } else {
        if (!existing.apiKey) {
          return fail('validation_failed', 'No stored API key — provide one to connect');
        }
        try {
          apiKeyPlain = decrypt(existing.apiKey);
        } catch {
          return fail('validation_failed', 'Stored API key is unreadable — re-enter it');
        }
      }

      let toolDescriptors: McpToolSummary[] = [];
      let conn: Awaited<ReturnType<typeof connectMcp>> | null = null;
      try {
        conn = await connectMcp({
          transport: 'http',
          url: effectiveUrl,
          apiKey: apiKeyPlain,
          authScheme: effectiveScheme,
          authParamName: effectiveParam,
        });
        toolDescriptors = conn.tools.map((t) => ({
          name: t.name,
          description: t.description ?? null,
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return fail('mcp_connect_failed', `Could not connect with the new config: ${msg}`);
      } finally {
        if (conn) await conn.close().catch(() => {});
      }

      await db
        .update(mcpServers)
        .set({
          name: parsed.data.name,
          url: effectiveUrl,
          authScheme: effectiveScheme,
          authParamName: effectiveParam,
          availableTools: toolDescriptors,
          ...(newKeyProvided
            ? { apiKey: encrypt(apiKeyPlain), apiKeyLast4: last4(apiKeyPlain) }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(mcpServers.id, mcpServerId));
      revalidatePath('/mcp');
      return ok(undefined);
    }

    // ── stdio ───────────────────────────────────────────────────────────────────
    const effectiveCommand = (parsed.data.command ?? existing.command ?? '').trim();
    if (!effectiveCommand) return fail('validation_failed', 'Command is required');
    const effectiveArgs =
      parsed.data.args ?? (Array.isArray(existing.args) ? (existing.args as string[]) : []);

    const existingEnc = (existing.envVars ?? {}) as Record<string, string>;
    const desired = parsed.data.env;
    const plaintextEnv: Record<string, string> = {}; // for connect-verify
    const encEnv: Record<string, string> = {}; // to persist
    const entries = desired
      ? Object.entries(desired)
      : Object.entries(existingEnc).map(([k]) => [k, ''] as [string, string]);
    for (const [k, v] of entries) {
      if (v && v.length > 0) {
        plaintextEnv[k] = v;
        encEnv[k] = encrypt(v);
      } else if (existingEnc[k] !== undefined) {
        // Keep the stored value — decrypt only to re-verify, keep ciphertext to persist.
        try {
          plaintextEnv[k] = decrypt(existingEnc[k]);
        } catch {
          return fail('validation_failed', `Stored value for "${k}" is unreadable — re-enter it`);
        }
        encEnv[k] = existingEnc[k];
      }
      // else: blank value with no stored value → treat as unset, skip.
    }

    let toolDescriptors: McpToolSummary[] = [];
    let conn: Awaited<ReturnType<typeof connectMcp>> | null = null;
    try {
      conn = await connectMcp({
        transport: 'stdio',
        command: effectiveCommand,
        args: effectiveArgs,
        env: plaintextEnv,
      });
      toolDescriptors = conn.tools.map((t) => ({
        name: t.name,
        description: t.description ?? null,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(
        'mcp_connect_failed',
        `Could not start the subprocess (${effectiveCommand}): ${msg}`,
      );
    } finally {
      if (conn) await conn.close().catch(() => {});
    }

    await db
      .update(mcpServers)
      .set({
        name: parsed.data.name,
        command: effectiveCommand,
        args: effectiveArgs,
        envVars: encEnv,
        availableTools: toolDescriptors,
        updatedAt: new Date(),
      })
      .where(eq(mcpServers.id, mcpServerId));
    revalidatePath('/mcp');
    return ok(undefined);
  } catch (err) {
    console.error('[updateMcpServerConfigAction]', err);
    return fail('db_error', 'Failed to update MCP server');
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
          and(eq(agentMcpServers.agentId, agentId), eq(agentMcpServers.mcpServerId, mcpServerId)),
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
 * Create a new OAuth connector instance bound to a credential.
 *
 * Called from the /connectors page auto-assignment block when the OAuth callback
 * returns ?connectorSlug=X&credentialId=Y. Multi-instance brique: this is now
 * a pure INSERT — every call creates a new connector instance for the slug.
 * The instance name defaults to the credential's name (set during OAuth
 * callback, typically the Google/Notion/Airtable account name) and can be
 * overridden via `name`, then later renamed via `renameConnectorAction`.
 *
 * Security:
 *   - credential ownership verified against session.userId
 *   - credentialType verified against catalog entry
 */
export async function createOrAssignOAuthConnectorAction(
  slug: string,
  credentialId: string,
  name?: string,
): Promise<ActionResult<{ connectorId: string }>> {
  try {
    const session = await getSession();
    if (!z.string().min(1).max(80).safeParse(slug).success) {
      return fail('validation_failed', 'Invalid connector slug');
    }
    if (!z.string().guid().safeParse(credentialId).success) {
      return fail('validation_failed', 'Invalid credential id');
    }
    if (name !== undefined && !z.string().min(1).max(120).safeParse(name).success) {
      return fail('validation_failed', 'Invalid connector name');
    }

    const catalogEntry = CONNECTOR_CATALOG.find((c) => c.slug === slug);
    if (!catalogEntry) return fail('validation_failed', 'Unknown connector slug');
    if (catalogEntry.authType !== 'oauth2') {
      return fail('invalid_auth_type', 'Only OAuth2 connectors support credential assignment');
    }

    const db = getDb();

    // Verify credential ownership + type
    const [existingCred] = await db
      .select({
        id: credentials.id,
        ownerUserId: credentials.ownerUserId,
        type: credentials.type,
        name: credentials.name,
      })
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

    // Multi-instance: pure INSERT, no lookup-and-update. The user can have
    // multiple connectors of the same slug (e.g. Gmail perso + Gmail boulot).
    const instanceName = name ?? existingCred.name ?? catalogEntry.label;
    const [row] = await db
      .insert(connectors)
      .values({
        entityId: session.entityId,
        slug,
        name: instanceName,
        authType: 'oauth2',
        credentialId,
        active: true,
      })
      .returning({ id: connectors.id });
    if (!row) return fail('db_error', 'Insert returned no row');

    revalidatePath('/connectors');
    return ok({ connectorId: row.id });
  } catch (err) {
    console.error('[createOrAssignOAuthConnectorAction]', err);
    const detail = err instanceof Error ? err.message : String(err);
    return fail('db_error', `Failed to assign credential: ${detail}`);
  }
}

/**
 * Multi-instance brique: rename a connector instance. Used by the
 * /connectors Active Connectors list to let users disambiguate
 * (e.g. "Gmail" → "Gmail — perso").
 */
export async function renameConnectorAction(
  connectorId: string,
  name: string,
): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(connectorId).success) {
      return fail('validation_failed', 'Invalid connector id');
    }
    const nameParsed = z.string().min(1, 'Name is required').max(120).safeParse(name);
    if (!nameParsed.success) {
      return fail('validation_failed', nameParsed.error.issues[0]?.message ?? 'Invalid name');
    }
    const db = getDb();
    const [existing] = await db
      .select({ id: connectors.id })
      .from(connectors)
      .where(and(eq(connectors.id, connectorId), eq(connectors.entityId, session.entityId)));
    if (!existing) return fail('not_found', 'Connector not found');
    await db
      .update(connectors)
      .set({ name: nameParsed.data, updatedAt: new Date() })
      .where(eq(connectors.id, connectorId));
    revalidatePath('/connectors');
    return ok(undefined);
  } catch (err) {
    console.error('[renameConnectorAction]', err);
    return fail('db_error', 'Failed to rename connector');
  }
}

/**
 * Rotate the API key on an existing api_key connector.
 *
 * Before this action existed the only way to change a key was
 * delete + recreate, which dropped every row in
 * `agent_connector_assignments` for that connector — the user had to
 * re-tick the checkboxes on every affected agent. By keeping the same
 * connector row we preserve all assignments transparently.
 *
 * Scope kept narrow on purpose:
 *   - Only api_key connectors. OAuth credentials live in the
 *     `credentials` table and rotate through their own flows.
 *   - Only the apiKey field is touched. baseUrl / authType / active
 *     are not exposed here — different concerns, different briques.
 */
export async function updateConnectorApiKeyAction(
  connectorId: string,
  newApiKey: string,
): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(connectorId).success) {
      return fail('validation_failed', 'Invalid connector id');
    }
    const keyParsed = z.string().min(1, 'API key is required').max(2_000).safeParse(newApiKey);
    if (!keyParsed.success) {
      return fail('validation_failed', keyParsed.error.issues[0]?.message ?? 'Invalid API key');
    }

    const db = getDb();
    const [existing] = await db
      .select({ id: connectors.id, authType: connectors.authType })
      .from(connectors)
      .where(and(eq(connectors.id, connectorId), eq(connectors.entityId, session.entityId)));
    if (!existing) return fail('not_found', 'Connector not found');
    if (existing.authType !== 'api_key') {
      return fail(
        'validation_failed',
        `Connector uses ${existing.authType ?? 'unknown'} auth — key rotation only applies to api_key connectors.`,
      );
    }

    // Encrypt idempotently: a raw value gets encrypted, an already-encrypted
    // value passes through unchanged (matches saveApiKeyConnectorAction).
    const enc = isEncrypted(keyParsed.data) ? keyParsed.data : encrypt(keyParsed.data);

    await db
      .update(connectors)
      .set({ apiKey: enc, updatedAt: new Date() })
      .where(eq(connectors.id, connectorId));
    revalidatePath('/connectors');
    return ok(undefined);
  } catch (err) {
    console.error('[updateConnectorApiKeyAction]', err);
    return fail('db_error', 'Failed to rotate API key');
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

// ─── Agent Approval Rule Actions ─────────────────────────────────────────────
//
// approval_rules is the runtime gate used by executeTool (_matchApprovalRule).
// Each row: (entityId, agentId, toolName, action ∈ 'auto_approve'|'require_approval'|'block').
// No rule → default is auto_approve (execute without gating).
//
// agents.requiresApproval (text[]) is a legacy column that is NOT read by the
// runner gate — the runner exclusively uses approval_rules rows. It can be
// treated as dead / not surfaced in UI.
// agentSkillAssignments.approvalOverrides (jsonb) is similarly unused by the
// current gate — the gate only reads approval_rules rows.

export type ApprovalRuleUiRow = {
  id: string;
  toolName: string;
  action: 'auto_approve' | 'require_approval' | 'block';
};

/**
 * List all approval_rules rows scoped to this agent (entity-owned check).
 * Returns only agent-scoped rows (agentId = agentId), not entity-wide wildcards.
 */
export async function listAgentApprovalRulesAction(
  agentId: string,
): Promise<ActionResult<ApprovalRuleUiRow[]>> {
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

    const rows = await db
      .select({ id: approvalRules.id, toolName: approvalRules.toolName, action: approvalRules.action })
      .from(approvalRules)
      .where(
        and(
          eq(approvalRules.entityId, session.entityId),
          eq(approvalRules.agentId, agentId),
        ),
      );

    return ok(
      rows.map((r) => ({
        id: r.id,
        toolName: r.toolName,
        action: (r.action ?? 'auto_approve') as ApprovalRuleUiRow['action'],
      })),
    );
  } catch (err) {
    console.error('[listAgentApprovalRulesAction]', err);
    return fail('db_error', 'Failed to load approval rules');
  }
}

const SetApprovalRuleSchema = z.object({
  agentId: z.string().guid(),
  toolName: z.string().min(1).max(200),
  // null = delete the rule (revert to default auto_approve)
  action: z.enum(['auto_approve', 'require_approval', 'block']).nullable(),
});

/**
 * Upsert or delete one approval_rules row for (entity, agent, toolName).
 * action=null → DELETE the row (reverts to runtime default: auto_approve).
 * action='auto_approve' → also deletes (no rule needed; default is already auto_approve).
 * action='require_approval'|'block' → upsert.
 *
 * Ownership checked: agent must belong to the active entity.
 */
export async function setAgentApprovalRuleAction(raw: unknown): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = SetApprovalRuleSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const { agentId, toolName, action } = parsed.data;
    const db = getDb();

    // Verify agent ownership
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.entityId, session.entityId)));
    if (!agent) return fail('not_found', 'Agent not found');

    if (action === null || action === 'auto_approve') {
      // DELETE: no rule needed for the default behaviour
      await db
        .delete(approvalRules)
        .where(
          and(
            eq(approvalRules.entityId, session.entityId),
            eq(approvalRules.agentId, agentId),
            eq(approvalRules.toolName, toolName),
          ),
        );
    } else {
      // UPSERT (insert or update the existing row)
      const existing = await db
        .select({ id: approvalRules.id })
        .from(approvalRules)
        .where(
          and(
            eq(approvalRules.entityId, session.entityId),
            eq(approvalRules.agentId, agentId),
            eq(approvalRules.toolName, toolName),
          ),
        )
        .limit(1);

      if (existing.length > 0 && existing[0]) {
        await db
          .update(approvalRules)
          .set({ action, updatedAt: new Date() })
          .where(eq(approvalRules.id, existing[0].id));
      } else {
        await db.insert(approvalRules).values({
          entityId: session.entityId,
          agentId,
          toolName,
          action,
        });
      }
    }

    revalidatePath(`/agents/${agentId}/edit`);
    return ok(undefined);
  } catch (err) {
    console.error('[setAgentApprovalRuleAction]', err);
    return fail('db_error', 'Failed to save approval rule');
  }
}

// ─── Skill Actions ────────────────────────────────────────────────────────────

export type InstalledScript = { path: string; language: string };

export type SkillRow = {
  id: string;
  name: string;
  slug: string;
  /** True when this is a built-in/system skill (slug ∈ systemSkillSlugs) — the
   *  fixed catalog shown in the Library tab. False for user-authored skills,
   *  which live in the "My skills" tab. */
  isSystem: boolean;
  content: string;
  defaultContent: string | null;
  contentOverridden: boolean;
  description: string | null;
  active: boolean;
  requiredBuiltins: string[];
  /** Community-install metadata (open Agent Skills / SKILL.md format).
   *  isCommunity=false and null source/scripts for system + custom skills. */
  isCommunity: boolean;
  source: string | null;
  installedScripts: InstalledScript[] | null;
  assignmentCount: number;
  /** Each agent currently assigned to this skill. Sized by assignmentCount
   *  but capped at the SQL layer at 8 names — the UI only renders an avatar
   *  stack of the first few before collapsing to "+N". */
  assignedAgents: Array<{ id: string; name: string; slug: string; avatarUrl: string | null }>;
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
        isCommunity: agentSkills.isCommunity,
        source: agentSkills.source,
        installedScripts: agentSkills.installedScripts,
        createdAt: agentSkills.createdAt,
        updatedAt: agentSkills.updatedAt,
      })
      .from(agentSkills)
      // System skills are seeded under the oldest entity but are install-wide:
      // surface them alongside the user's own skills (by canonical slug) so
      // they're visible even when the session entity differs from the seed
      // owner (e.g. a LAN-mode signup). Custom skills stay entity-scoped.
      .where(
        or(eq(agentSkills.entityId, session.entityId), inArray(agentSkills.slug, systemSkillSlugs)),
      )
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

    // Fetch the agent identities for the avatar stack. One join, returned as
    // an array of {skillId, agent...} rows that we pivot client-side. Cap at
    // 8 names per skill so the query stays bounded even for skills used by
    // every agent in a large workspace.
    const assignedAgentRows = await db
      .select({
        skillId: agentSkillAssignments.skillId,
        agentId: agents.id,
        agentName: agents.name,
        agentSlug: agents.slug,
        avatarUrl: agents.avatarUrl,
      })
      .from(agentSkillAssignments)
      .innerJoin(agents, eq(agents.id, agentSkillAssignments.agentId))
      .where(
        and(
          eq(agentSkillAssignments.entityId, session.entityId),
          inArray(
            agentSkillAssignments.skillId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .orderBy(agents.name);

    const assignedBySkill = new Map<
      string,
      Array<{ id: string; name: string; slug: string; avatarUrl: string | null }>
    >();
    for (const a of assignedAgentRows) {
      const list = assignedBySkill.get(a.skillId) ?? [];
      if (list.length < 8) {
        list.push({ id: a.agentId, name: a.agentName, slug: a.agentSlug, avatarUrl: a.avatarUrl });
        assignedBySkill.set(a.skillId, list);
      }
    }

    return ok(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        isSystem: systemSkillSlugs.includes(r.slug),
        content: r.content,
        defaultContent: r.defaultContent,
        contentOverridden: r.contentOverridden ?? false,
        description: r.description,
        active: r.active ?? true,
        requiredBuiltins: (r.requiredBuiltins as string[] | null) ?? [],
        isCommunity: r.isCommunity ?? false,
        source: r.source,
        installedScripts: (r.installedScripts as InstalledScript[] | null) ?? null,
        assignmentCount: tallyMap.get(r.id) ?? 0,
        assignedAgents: assignedBySkill.get(r.id) ?? [],
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
    const result = await createSkillRepo(db, session.entityId, {
      slug: parsed.data.slug,
      name: parsed.data.name,
      content: parsed.data.content,
      description: parsed.data.description ?? null,
    });
    if ('error' in result) {
      return fail('conflict', 'A skill with this slug already exists');
    }
    revalidatePath('/skills');
    return ok({ id: result.id });
  } catch (err: unknown) {
    console.error('[createSkillAction]', err);
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

const InstallCommunitySkillSchema = z.object({
  source: z.string().min(1).max(2048),
});

export type CommunitySkillInstallResult = {
  slug: string;
  name: string;
  description: string;
  source: string;
  installedScripts: InstalledScript[];
  fileCount: number;
  reinstalled: boolean;
};

/**
 * Install a community skill (open Agent Skills / SKILL.md format) from a GitHub
 * URL, "owner/repo", or a skills.sh path. Calls the runner's
 * POST /api/skills/install and awaits the result synchronously. Never throws to
 * the client — network/runner errors are returned as {ok:false, message}.
 */
export async function installCommunitySkillAction(
  source: string,
): Promise<ActionResult<CommunitySkillInstallResult>> {
  try {
    const session = await getSession();
    const parsed = InstallCommunitySkillSchema.safeParse({ source });
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    if (!env.WORKER_SECRET) {
      console.error('[installCommunitySkillAction] WORKER_SECRET missing');
      return fail('config_error', 'Runner secret not configured');
    }
    let res: Response;
    try {
      res = await fetch(`${env.RUNNER_URL}/api/skills/install`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.WORKER_SECRET}`,
        },
        body: JSON.stringify({ source: parsed.data.source, entityId: session.entityId }),
      });
    } catch (fetchErr) {
      console.error('[installCommunitySkillAction] fetch failed:', fetchErr);
      return fail('network_error', 'Could not reach the runner — is it running?');
    }
    const body = (await res.json()) as
      | { ok: true; skill: CommunitySkillInstallResult }
      | { ok: false; error: string; message: string };
    if (!body.ok) {
      return fail(body.error, body.message);
    }
    revalidatePath('/skills');
    return ok(body.skill);
  } catch (err) {
    console.error('[installCommunitySkillAction]', err);
    return fail('unexpected_error', 'An unexpected error occurred');
  }
}

/**
 * Uninstall a community skill by slug via the runner's POST
 * /api/skills/uninstall, then revalidate the skills route.
 */
export async function uninstallCommunitySkillAction(slug: string): Promise<ActionResult<void>> {
  try {
    if (!z.string().min(1).safeParse(slug).success) {
      return fail('validation_failed', 'Invalid skill slug');
    }
    if (!env.WORKER_SECRET) {
      console.error('[uninstallCommunitySkillAction] WORKER_SECRET missing');
      return fail('config_error', 'Runner secret not configured');
    }
    let res: Response;
    try {
      res = await fetch(`${env.RUNNER_URL}/api/skills/uninstall`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.WORKER_SECRET}`,
        },
        body: JSON.stringify({ slug }),
      });
    } catch (fetchErr) {
      console.error('[uninstallCommunitySkillAction] fetch failed:', fetchErr);
      return fail('network_error', 'Could not reach the runner — is it running?');
    }
    const body = (await res.json()) as { ok: boolean; error?: string; message?: string };
    if (!body.ok) {
      return fail(body.error ?? 'uninstall_failed', body.message ?? 'Uninstall failed');
    }
    revalidatePath('/skills');
    return ok(undefined);
  } catch (err) {
    console.error('[uninstallCommunitySkillAction]', err);
    return fail('unexpected_error', 'An unexpected error occurred');
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
    const result = await assignSkillRepo(db, session.entityId, parsed.data, systemSkillSlugs);
    if ('error' in result) {
      if (result.error === 'skill_not_found') return fail('not_found', 'Skill not found');
      if (result.error === 'agent_not_found') return fail('not_found', 'Agent not found');
      // already_assigned → idempotent success (mirrors original behaviour)
      revalidatePath('/skills');
      return ok(undefined);
    }
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
      return fail('not_applicable', 'No default available — this is a user-created skill');
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
        isCommunity: agentSkills.isCommunity,
        source: agentSkills.source,
        installedScripts: agentSkills.installedScripts,
        createdAt: agentSkills.createdAt,
        updatedAt: agentSkills.updatedAt,
      })
      .from(agentSkills)
      // Visible if it's the user's own skill or an install-wide system skill
      // (read-only for non-owners; edit/delete stay entity-scoped below).
      .where(
        and(
          eq(agentSkills.id, id),
          or(
            eq(agentSkills.entityId, session.entityId),
            inArray(agentSkills.slug, systemSkillSlugs),
          ),
        ),
      );
    if (!row) return fail('not_found', 'Skill not found');

    return ok({
      id: row.id,
      name: row.name,
      slug: row.slug,
      isSystem: systemSkillSlugs.includes(row.slug),
      content: row.content,
      defaultContent: row.defaultContent,
      contentOverridden: row.contentOverridden ?? false,
      description: row.description,
      active: row.active ?? true,
      requiredBuiltins: (row.requiredBuiltins as string[] | null) ?? [],
      isCommunity: row.isCommunity ?? false,
      source: row.source,
      installedScripts: (row.installedScripts as InstalledScript[] | null) ?? null,
      assignmentCount: 0,
      // The skill-detail view doesn't render the avatar stack; cheaper to
      // return [] here than to pay the join. List callers use listSkillsAction.
      assignedAgents: [],
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

/**
 * Weekly job activity for the rolling 12-week window, bucketed by status.
 * Feeds the `WeeklyActivityChart` on /stats — a stacked bar of completed /
 * failed / cancelled / awaiting jobs per ISO week.
 *
 * Why 12 weeks: enough to see a quarterly trend without overwhelming the
 * x-axis. Empty weeks are still emitted as zero rows so the axis stays
 * regular (skip a week and the chart looks like the user dropped a tooth).
 *
 * Status buckets collapsed to user-meaningful slices:
 *   - `completed`: successful runs
 *   - `failed`: errored / orphan-reset / stale-pending-abandoned
 *   - `cancelled`: user explicitly stopped
 *   - `awaiting`: still in flight (awaiting_approval OR awaiting_delegation)
 *   - `pending`: never picked up by a worker (rare once the recovery
 *     cron is healthy; surfaced as its own bucket so debug is easy)
 *   - `processing` is folded into `awaiting` for display purposes — both
 *     mean "in flight" from the user's point of view and rarely linger
 *     long enough to matter for a weekly view.
 */
export type WeeklyActivityRow = {
  /** ISO date string YYYY-MM-DD pointing at the Monday of the week. */
  week: string;
  completed: number;
  failed: number;
  cancelled: number;
  awaiting: number;
  pending: number;
};

export async function getWeeklyActivityAction(): Promise<ActionResult<WeeklyActivityRow[]>> {
  try {
    const session = await getSession();
    const db = getDb();

    // Single grouped query — pivot client-side. Last 12 weeks bounded by
    // created_at to keep the index `idx_agent_jobs_entity_created`
    // efficient even when the workspace has hundreds of thousands of jobs.
    const rows = await db
      .select({
        week: sql<string>`to_char(date_trunc('week', ${agentJobs.createdAt}), 'YYYY-MM-DD')`,
        status: agentJobs.status,
        count: sql<string>`count(*)`,
      })
      .from(agentJobs)
      .where(
        and(
          eq(agentJobs.entityId, session.entityId),
          sql`${agentJobs.createdAt} > now() - interval '12 weeks'`,
        ),
      )
      .groupBy(sql`date_trunc('week', ${agentJobs.createdAt})`, agentJobs.status);

    // Build the contiguous bucket list (12 oldest-to-newest weeks) so empty
    // weeks render as zero columns instead of disappearing. Postgres uses
    // ISO weeks starting Monday — mirror that here.
    const buckets = new Map<string, WeeklyActivityRow>();
    const now = new Date();
    // Snap to Monday at 00:00 UTC for the current week.
    const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dayOfWeek = monday.getUTCDay(); // 0 = Sunday
    const daysSinceMonday = (dayOfWeek + 6) % 7;
    monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
    for (let i = 11; i >= 0; i--) {
      const d = new Date(monday);
      d.setUTCDate(d.getUTCDate() - i * 7);
      const iso = d.toISOString().slice(0, 10);
      buckets.set(iso, {
        week: iso,
        completed: 0,
        failed: 0,
        cancelled: 0,
        awaiting: 0,
        pending: 0,
      });
    }

    for (const r of rows) {
      // `to_char(date_trunc(...), 'YYYY-MM-DD')` returns a string for the
      // start-of-week date — match it against the pre-computed buckets.
      const bucket = buckets.get(r.week);
      if (!bucket) continue; // older than 12 weeks, ignore
      const n = Number(r.count);
      const status = r.status ?? '';
      if (status === 'completed') bucket.completed += n;
      else if (status === 'failed') bucket.failed += n;
      else if (status === 'cancelled') bucket.cancelled += n;
      else if (status === 'pending') bucket.pending += n;
      else bucket.awaiting += n; // processing + awaiting_approval + awaiting_delegation
    }

    return ok(Array.from(buckets.values()));
  } catch (err) {
    console.error('[getWeeklyActivityAction]', err);
    return fail('db_error', 'Failed to load weekly activity');
  }
}

/**
 * Active jobs grouped by agent — feeds the live "Agents at work" panel on
 * the /stats page (refreshed every 5s by ActiveAgentsPanel).
 *
 * Returns one row per agent that currently has at least one job in a
 * non-terminal state. Agents with zero active work are NOT in the result
 * (the UI renders an "All agents idle" empty state instead).
 *
 * Status buckets:
 *   - `processing`: actively running an LLM turn
 *   - `awaiting`: awaiting_approval OR awaiting_delegation (paused, waiting
 *     for a human or a child job to finish)
 *   - `pending`: claimed but not yet picked up by the executor cron
 */
export type ActiveAgentRow = {
  agentId: string;
  agentName: string;
  agentSlug: string;
  avatarUrl: string | null;
  processing: number;
  awaiting: number;
  pending: number;
  total: number;
};

export async function getActiveJobsByAgentAction(): Promise<ActionResult<ActiveAgentRow[]>> {
  try {
    const session = await getSession();
    const db = getDb();

    const rows = await db
      .select({
        agentId: agentJobs.agentId,
        agentName: agents.name,
        agentSlug: agents.slug,
        avatarUrl: agents.avatarUrl,
        status: agentJobs.status,
        count: sql<string>`count(*)`,
      })
      .from(agentJobs)
      .innerJoin(agents, eq(agents.id, agentJobs.agentId))
      .where(
        and(
          eq(agentJobs.entityId, session.entityId),
          // SQL `IN (...)` via Drizzle — same set the runner considers
          // "in flight" (apps/runner/src/job/execute.ts terminal handling).
          sql`${agentJobs.status} IN ('pending', 'processing', 'awaiting_approval', 'awaiting_delegation')`,
        ),
      )
      .groupBy(agentJobs.agentId, agents.name, agents.slug, agents.avatarUrl, agentJobs.status);

    // Pivot: collapse status rows into one row per agent.
    const byAgent = new Map<string, ActiveAgentRow>();
    for (const r of rows) {
      if (!r.agentId || !r.agentName || !r.agentSlug) continue;
      const existing: ActiveAgentRow = byAgent.get(r.agentId) ?? {
        agentId: r.agentId,
        agentName: r.agentName,
        agentSlug: r.agentSlug,
        avatarUrl: r.avatarUrl ?? null,
        processing: 0,
        awaiting: 0,
        pending: 0,
        total: 0,
      };
      const n = Number(r.count);
      const s = r.status ?? '';
      if (s === 'processing') existing.processing += n;
      else if (s === 'awaiting_approval' || s === 'awaiting_delegation') existing.awaiting += n;
      else if (s === 'pending') existing.pending += n;
      existing.total += n;
      byAgent.set(r.agentId, existing);
    }

    // Sort: busiest agent first, then alphabetic for stable ordering when
    // counts tie. Matches user expectation of "what's hottest right now".
    const out = Array.from(byAgent.values()).sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      return a.agentName.localeCompare(b.agentName);
    });

    return ok(out);
  } catch (err) {
    console.error('[getActiveJobsByAgentAction]', err);
    return fail('db_error', 'Failed to load active jobs');
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
  notifyOnSuccess: boolean;
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
        notifyOnSuccess: agentSchedules.notifyOnSuccess,
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
        notifyOnSuccess: r.notifyOnSuccess ?? false,
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
  notifyOnSuccess: z.boolean().optional().default(false),
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
        notifyOnSuccess: parsed.data.notifyOnSuccess,
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
  notifyOnSuccess: z.boolean().optional().default(false),
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
        notifyOnSuccess: parsed.data.notifyOnSuccess,
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

/**
 * Run an automation immediately, out-of-band of its CRON schedule.
 *
 * Mirrors the cron launch (apps/runner/src/cron/run-schedules.ts): inserts an
 * agent_jobs row with channel 'cron' (so it behaves exactly like a scheduled
 * fire — same Job-context, same chatId resolution) and wakes the runner via the
 * same /api/worker ping as sendTaskAction. Deliberately does NOT touch the
 * schedule's lastRun/nextRun — a manual run must not shift the planning.
 */
export async function runScheduleNowAction(
  scheduleId: string,
): Promise<ActionResult<{ jobId: string }>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(scheduleId).success) {
      return fail('validation_failed', 'Invalid schedule id');
    }
    const db = getDb();
    const [schedule] = await db
      .select({
        agentId: agentSchedules.agentId,
        task: agentSchedules.task,
        chatId: agentSchedules.chatId,
        notifyOnSuccess: agentSchedules.notifyOnSuccess,
        agentChatId: agents.lastSeenChatIdTelegram,
      })
      .from(agentSchedules)
      .leftJoin(agents, eq(agents.id, agentSchedules.agentId))
      .where(and(eq(agentSchedules.id, scheduleId), eq(agentSchedules.entityId, session.entityId)))
      .limit(1);
    if (!schedule) return fail('not_found', 'Schedule not found');
    if (!schedule.task) {
      return fail('validation_failed', 'This automation has no task to run.');
    }

    // Mirror the cron tick: only carry a delivery target when the schedule opted
    // into a success confirmation, so a manual run notifies exactly like a fired
    // one (and stays silent when the schedule is silent).
    const resolvedChatId = schedule.notifyOnSuccess
      ? (schedule.chatId ?? schedule.agentChatId ?? null)
      : null;

    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: session.entityId,
        agentId: schedule.agentId,
        status: 'pending',
        channel: 'cron',
        task: schedule.task,
        messages: [{ role: 'user', content: schedule.task }],
        ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
      })
      .returning({ id: agentJobs.id });
    if (!job) return fail('db_error', 'Failed to create job');

    // Wake the runner (same fire-and-forget ping as sendTaskAction).
    if (!env.WORKER_SECRET) {
      console.error('[runScheduleNowAction] WORKER_SECRET missing — cannot ping runner');
    } else {
      void fetch(`${env.RUNNER_URL}/api/worker`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.WORKER_SECRET}`,
        },
        body: JSON.stringify({ jobId: job.id }),
      }).catch((err: unknown) => {
        console.error('[runScheduleNowAction] runner ping failed:', err);
      });
    }

    // NOTE: lastRun / nextRun are intentionally left untouched — a manual run is
    // out-of-band and must not reschedule the cron.
    revalidatePath('/automations');
    revalidatePath('/jobs');
    return ok({ jobId: job.id });
  } catch (err) {
    console.error('[runScheduleNowAction]', err);
    return fail('db_error', 'Failed to run schedule now');
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
  isActive: boolean;
  /** True when an apiKey is stored. The actual key NEVER leaves the server. */
  hasApiKey: boolean;
  /**
   * Last 4 chars of the stored apiKey, for masked display in the edit form.
   * Null when the apiKey is empty. The full key NEVER leaves the server.
   */
  apiKeyLast4: string | null;
  /**
   * Number of active agents in this entity that reference this key via
   * `agents.llm_key_id`. Surfaced in the /llm-providers row so the user sees
   * blast radius before deactivating or deleting a key.
   */
  agentCount: number;
};

// baseUrl is optional, accepts empty string (transformed to null) or a valid URL.
const optionalBaseUrl = z
  .string()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : null))
  .pipe(z.string().url().nullable().or(z.null()));

// An LLM provider key is now JUST credentials — provider + API key + base URL +
// active. The model is chosen per-agent; capability comes from the code catalog.
const CreateLlmKeySchema = z.object({
  provider: z.enum(PROVIDER_VALUES),
  baseUrl: optionalBaseUrl,
  apiKey: z.string().optional(),
  nickname: z.string().max(120).nullish(),
  isActive: z.boolean().default(true),
});

const UpdateLlmKeySchema = z.object({
  id: z.string().guid(),
  provider: z.enum(PROVIDER_VALUES),
  baseUrl: optionalBaseUrl,
  // apiKey absent → keep existing. Empty string also means "keep existing".
  apiKey: z.string().optional(),
  nickname: z.string().max(120).nullish(),
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
        isActive: entityLlmKeys.isActive,
        hasApiKey: sql<boolean>`(${entityLlmKeys.apiKey} <> '')`,
        apiKeyLast4: entityLlmKeys.apiKeyLast4,
      })
      .from(entityLlmKeys)
      .where(eq(entityLlmKeys.entityId, session.entityId))
      .orderBy(desc(entityLlmKeys.createdAt));

    // Side query: count ACTIVE agents per llm_key_id in this entity.
    // Inactive agents are excluded — they can't run jobs, so they don't
    // count toward the "is this key in use" signal. Two roundtrips rather
    // than one LEFT JOIN + GROUP BY keeps the column shape above unchanged
    // and the count math out of the row mapping.
    const agentCounts = await db
      .select({
        llmKeyId: agents.llmKeyId,
        n: sql<string>`count(*)`,
      })
      .from(agents)
      .where(and(eq(agents.entityId, session.entityId), eq(agents.active, true)))
      .groupBy(agents.llmKeyId);

    const countByKey = new Map<string, number>();
    for (const c of agentCounts) {
      if (c.llmKeyId) countByKey.set(c.llmKeyId, Number(c.n));
    }

    return ok(
      rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        baseUrl: r.baseUrl,
        nickname: r.nickname,
        isActive: r.isActive,
        hasApiKey: Boolean(r.hasApiKey),
        apiKeyLast4: r.apiKeyLast4 ? r.apiKeyLast4 : null,
        agentCount: countByKey.get(r.id) ?? 0,
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

    // One key per provider per entity — a single key serves any number of
    // models across agents, so duplicates add nothing but confusion.
    const [dup] = await db
      .select({ id: entityLlmKeys.id })
      .from(entityLlmKeys)
      .where(
        and(
          eq(entityLlmKeys.entityId, session.entityId),
          eq(entityLlmKeys.provider, parsed.data.provider),
        ),
      )
      .limit(1);
    if (dup) {
      return fail(
        'provider_exists',
        'This provider is already configured — edit the existing one.',
      );
    }

    const plaintextKey = parsed.data.apiKey ?? '';
    const [row] = await db
      .insert(entityLlmKeys)
      .values({
        entityId: session.entityId,
        provider: parsed.data.provider,
        apiKey: encrypt(plaintextKey),
        apiKeyLast4: last4(plaintextKey),
        baseUrl: parsed.data.baseUrl,
        nickname: parsed.data.nickname ?? null,
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
    const { id, provider, baseUrl, apiKey, nickname, isActive } = parsed.data;
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
      nickname: nickname ?? null,
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

/** Toggle a provider key active/inactive inline (the card switch). */
export async function setLlmKeyActiveAction(
  id: string,
  active: boolean,
): Promise<ActionResult<void>> {
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
    await db
      .update(entityLlmKeys)
      .set({ isActive: active, updatedAt: new Date() })
      .where(eq(entityLlmKeys.id, id));
    revalidatePath('/llm-providers');
    return ok(undefined);
  } catch (err) {
    console.error('[setLlmKeyActiveAction]', err);
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

// ─── ROOT agent actions (Wave 2b — V4 ROOT agent, 2026-05-29) ─────────────────

/**
 * Read the current ROOT agent designation + grants for the active workspace.
 * Falls back to DEFAULT_ROOT_GRANTS when no grants have been saved yet.
 */
export async function getRootConfigAction(): Promise<
  ActionResult<{ rootAgentId: string | null; grants: RootGrants }>
> {
  try {
    const session = await getSession();
    const db = getDb();
    const [row] = await db
      .select({ rootAgentId: entities.rootAgentId, rootGrants: entities.rootGrants })
      .from(entities)
      .where(eq(entities.id, session.entityId));
    if (!row) return fail('not_found', 'Workspace not found');
    return ok({
      rootAgentId: row.rootAgentId ?? null,
      grants: parseRootGrants(row.rootGrants),
    });
  } catch (err) {
    console.error('[getRootConfigAction]', err);
    return fail('db_error', 'Failed to load ROOT agent config');
  }
}

const SetRootGrantsSchema = z.object({
  grants: z.object({
    createAgent: z.boolean(),
    createSkill: z.boolean(),
    updateSkill: z.boolean(),
    assignSkill: z.boolean(),
    createMcp: z.boolean(),
    createConnector: z.boolean(),
    autonomy: z.enum(['propose_confirm', 'destructive_gate', 'fully_autonomous'] as const),
  }),
});

/**
 * Configure the powers (grants + autonomy) of the active workspace's ROOT agent.
 *
 * The ROOT itself is NOT chosen here — it is the entity's "origin orchestrator"
 * (the first orchestrator created), designated automatically by createAgentRepo.
 * This action only tunes what that ROOT may do.
 *
 * Side effects:
 *   1. Updates entities.rootGrants (rootAgentId is left as-is — structural).
 *   2. Clears all existing meta-tool approval_rules for this entity.
 *   3. If autonomy is 'propose_confirm': inserts require_approval rules for each
 *      enabled meta-tool.
 *      - 'destructive_gate' inserts require_approval only for destructive
 *        meta-tools; none exist in the MVT toolset yet.
 *      - 'fully_autonomous' inserts nothing — meta-tools execute freely.
 *
 * Fails with 'not_found' when no ROOT exists yet (no orchestrator created).
 */
export async function setRootAgentAction(raw: unknown): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    const parsed = SetRootGrantsSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const { grants } = parsed.data;
    const db = getDb();

    // Membership check — caller must be a member of the active entity.
    const [member] = await db
      .select({ role: entityMembers.role })
      .from(entityMembers)
      .where(
        and(eq(entityMembers.userId, session.userId), eq(entityMembers.entityId, session.entityId)),
      );
    if (!member) return fail('not_found', 'Workspace not found');

    // The ROOT is the entity's origin orchestrator, set automatically. We only
    // tune its grants — so read it, and refuse if none exists yet.
    const [ent] = await db
      .select({ rootAgentId: entities.rootAgentId })
      .from(entities)
      .where(eq(entities.id, session.entityId));
    const rootAgentId = ent?.rootAgentId ?? null;
    if (!rootAgentId) {
      return fail('not_found', 'No ROOT agent yet — create an orchestrator first');
    }

    // Persist rootGrants on the entity (rootAgentId is structural — left as-is).
    // Cast grants to unknown so Drizzle accepts it as JSONB without type friction.
    await db
      .update(entities)
      .set({
        rootGrants: grants as unknown as (typeof entities.$inferInsert)['rootGrants'],
        updatedAt: new Date(),
      })
      .where(eq(entities.id, session.entityId));

    // ── Sync approval_rules for meta-tools ────────────────────────────────────
    // Step 1: clear any existing meta-tool rules for this entity (covers both
    // the previous ROOT agent's rules and the current one).
    await db
      .delete(approvalRules)
      .where(
        and(
          eq(approvalRules.entityId, session.entityId),
          inArray(approvalRules.toolName, META_TOOL_NAMES as unknown as string[]),
        ),
      );

    // Step 2: insert new rules according to autonomy level.
    if (grants.autonomy === 'propose_confirm') {
      // Each enabled meta-tool requires explicit user approval before execution.
      const tools = enabledMetaTools(grants as RootGrants);
      if (tools.length > 0) {
        await db.insert(approvalRules).values(
          tools.map((toolName) => ({
            entityId: session.entityId,
            agentId: rootAgentId,
            toolName,
            action: 'require_approval' as const,
          })),
        );
      }
    }
    // destructive_gate inserts require_approval only for destructive meta-tools;
    // none exist in the MVT toolset yet.
    // fully_autonomous: no approval rules — all meta-tools execute without gating.

    revalidatePath('/settings');
    return ok(undefined);
  } catch (err) {
    console.error('[setRootAgentAction]', err);
    return fail('db_error', 'Failed to save ROOT agent config');
  }
}

// ─── In-app chat (V4 — conversation-first) ────────────────────────────────────
// A conversation is NOT a job. Turns live in `chat_messages`, grouped under a
// `conversations` row (the sidebar entries). Pure conversation never creates an
// agent_jobs row. The runner (/api/chat) is the single writer of messages; it
// persists both turns + bumps the conversation, and returns the reply.
// Targets the entity's ROOT agent.

export type ConversationView = {
  id: string;
  title: string;
  preview: string;
  updatedAt: Date | null;
};
export type ChatMessageView = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  jobId: string | null;
};

/** A dispatched action job's live state, for the in-chat dispatch card. */
export type ChatJobStatus = {
  status: string;
  result: string | null;
  children: { agentName: string; status: string }[];
};

/** Resolve the entity's ROOT agent (id + name), or null when none is designated. */
async function resolveRoot(
  db: ReturnType<typeof getDb>,
  entityId: string,
): Promise<{ rootAgentId: string | null; rootName: string | null }> {
  const [entity] = await db
    .select({ rootAgentId: entities.rootAgentId })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  const rootAgentId = entity?.rootAgentId ?? null;
  if (!rootAgentId) return { rootAgentId: null, rootName: null };
  const [root] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.id, rootAgentId), eq(agents.entityId, entityId)))
    .limit(1);
  return { rootAgentId, rootName: root?.name ?? null };
}

export async function listConversationsAction(): Promise<
  ActionResult<{
    rootAgentId: string | null;
    rootName: string | null;
    conversations: ConversationView[];
  }>
> {
  try {
    const session = await getSession();
    const db = getDb();
    const { rootAgentId, rootName } = await resolveRoot(db, session.entityId);
    if (!rootAgentId) return ok({ rootAgentId: null, rootName: null, conversations: [] });

    const rows = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        updatedAt: conversations.updatedAt,
      })
      .from(conversations)
      .where(
        and(eq(conversations.entityId, session.entityId), eq(conversations.agentId, rootAgentId)),
      )
      .orderBy(desc(conversations.updatedAt))
      .limit(200);

    // Per-conversation preview = the most recent message. One extra query over
    // the listed conversations; take the first (newest) message per conversation.
    const convIds = rows.map((r) => r.id);
    const previewByConv = new Map<string, string>();
    if (convIds.length > 0) {
      const msgs = await db
        .select({ conversationId: chatMessages.conversationId, content: chatMessages.content })
        .from(chatMessages)
        .where(inArray(chatMessages.conversationId, convIds))
        .orderBy(desc(chatMessages.createdAt))
        .limit(1000);
      for (const m of msgs) {
        if (m.conversationId && !previewByConv.has(m.conversationId)) {
          previewByConv.set(m.conversationId, m.content);
        }
      }
    }

    const list: ConversationView[] = rows.map((r) => ({
      id: r.id,
      title: r.title,
      preview: previewByConv.get(r.id) ?? '',
      updatedAt: r.updatedAt,
    }));
    return ok({ rootAgentId, rootName, conversations: list });
  } catch (err) {
    console.error('[listConversationsAction]', err);
    return fail('db_error', 'Failed to load conversations');
  }
}

export async function createConversationAction(): Promise<ActionResult<{ id: string }>> {
  try {
    const session = await getSession();
    const db = getDb();
    const { rootAgentId } = await resolveRoot(db, session.entityId);
    if (!rootAgentId) return fail('no_root_agent', 'Designate a ROOT agent in Settings first.');

    const [row] = await db
      .insert(conversations)
      .values({ entityId: session.entityId, agentId: rootAgentId, title: '' })
      .returning({ id: conversations.id });
    if (!row) return fail('db_error', 'Failed to create conversation');
    revalidatePath('/chat');
    return ok({ id: row.id });
  } catch (err) {
    console.error('[createConversationAction]', err);
    return fail('db_error', 'Failed to create conversation');
  }
}

export async function deleteConversationAction(id: string): Promise<ActionResult<void>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(id).success) {
      return fail('validation_failed', 'Invalid conversation id');
    }
    const db = getDb();
    await db
      .delete(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.entityId, session.entityId)));
    revalidatePath('/chat');
    return ok(undefined);
  } catch (err) {
    console.error('[deleteConversationAction]', err);
    return fail('db_error', 'Failed to delete conversation');
  }
}

export async function listChatAction(
  conversationId: string,
): Promise<ActionResult<{ messages: ChatMessageView[] }>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(conversationId).success) {
      return fail('validation_failed', 'Invalid conversation id');
    }
    const db = getDb();
    // Verify the conversation belongs to this entity before reading its messages.
    const [conv] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(eq(conversations.id, conversationId), eq(conversations.entityId, session.entityId)),
      )
      .limit(1);
    if (!conv) return fail('not_found', 'Conversation not found');

    const rows = await db
      .select({
        id: chatMessages.id,
        role: chatMessages.role,
        content: chatMessages.content,
        jobId: chatMessages.jobId,
      })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(chatMessages.createdAt)
      .limit(500);

    const messages: ChatMessageView[] = rows.map((r) => ({
      id: r.id,
      role: r.role as 'user' | 'assistant',
      content: r.content,
      jobId: r.jobId,
    }));
    return ok({ messages });
  } catch (err) {
    console.error('[listChatAction]', err);
    return fail('db_error', 'Failed to load chat');
  }
}

const SendChatMessageSchema = z.object({
  conversationId: z.string().guid(),
  message: z.string().min(1, 'Message is empty').max(10_000),
});

export async function sendChatMessageAction(
  raw: unknown,
): Promise<ActionResult<{ reply: string }>> {
  try {
    const session = await getSession();
    const parsed = SendChatMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return fail('validation_failed', parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const db = getDb();
    const { rootAgentId } = await resolveRoot(db, session.entityId);
    if (!rootAgentId) return fail('no_root_agent', 'Designate a ROOT agent in Settings first.');

    if (!env.WORKER_SECRET) {
      console.error('[sendChatMessageAction] WORKER_SECRET missing — cannot reach runner');
      return fail('runner_unreachable', 'Chat backend not configured');
    }

    // The runner generates the reply AND persists both turns. Synchronous: we
    // await the reply so the UI renders it immediately. No job is created.
    let res: Response;
    try {
      res = await fetch(`${env.RUNNER_URL}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.WORKER_SECRET}`,
        },
        body: JSON.stringify({
          entityId: session.entityId,
          agentId: rootAgentId,
          conversationId: parsed.data.conversationId,
          message: parsed.data.message,
        }),
      });
    } catch (err) {
      console.error('[sendChatMessageAction] runner unreachable:', err);
      return fail('runner_unreachable', 'Could not reach the chat backend');
    }

    const data = (await res.json().catch(() => null)) as {
      reply?: string;
      error?: string;
    } | null;
    // An empty reply is NOT a failure: when the agent escalates via run_task it
    // may write no acknowledgment text (the dispatch card + job result carry the
    // info, and the UI refetches messages to render them). Only an HTTP error
    // (e.g. the runner's `empty_reply` glitch → 400) is a real failure.
    if (!res.ok) {
      return fail('chat_failed', data?.error ?? 'The agent did not reply');
    }
    revalidatePath('/chat');
    return ok({ reply: data?.reply ?? '' });
  } catch (err) {
    console.error('[sendChatMessageAction]', err);
    return fail('db_error', 'Failed to send message');
  }
}

export async function getChatJobStatusAction(jobId: string): Promise<ActionResult<ChatJobStatus>> {
  try {
    const session = await getSession();
    if (!z.string().guid().safeParse(jobId).success) {
      return fail('validation_failed', 'Invalid job id');
    }
    const db = getDb();
    const [job] = await db
      .select({ status: agentJobs.status, result: agentJobs.result })
      .from(agentJobs)
      .where(and(eq(agentJobs.id, jobId), eq(agentJobs.entityId, session.entityId)))
      .limit(1);
    if (!job) return fail('not_found', 'Job not found');

    // Delegated sub-agents (children) = the "DISPATCHED TO N AGENTS" rows.
    const childRows = await db
      .select({
        agentName: agents.name,
        agentSlug: agents.slug,
        status: agentJobs.status,
      })
      .from(agentJobs)
      .leftJoin(agents, eq(agents.id, agentJobs.agentId))
      .where(eq(agentJobs.parentJobId, jobId))
      .orderBy(agentJobs.createdAt);

    const children = childRows.map((r) => ({
      agentName: r.agentName ?? r.agentSlug ?? 'agent',
      status: r.status ?? 'pending',
    }));
    return ok({ status: job.status ?? 'pending', result: job.result, children });
  } catch (err) {
    console.error('[getChatJobStatusAction]', err);
    return fail('db_error', 'Failed to load job status');
  }
}
