// reflection/run-reflection.ts — the core Tier-1 reflection pass.
//
// Given a just-completed job, load the agent + its assigned skills, resolve the
// agent's LLM client, render a compacted transcript, and run a tight loop where
// the reflection model may call create_skill / update_skill (scoped to THIS
// agent, written with provenance created_by='agent'). The loop stops as soon as
// the model produces no tool call or the turn cap is reached — a no-op pass is
// the common, correct outcome.
//
// Fail-closed: any error is the caller's concern (maybeRunReflection wraps this
// in a catch). This function never throws into the job path — it's invoked
// fire-and-forget after the job is already terminal.

import {
  eq,
  and,
  or,
  ne,
  ilike,
  agents,
  agentSkills,
  entities,
  createSkillRepo,
  updateSkillRepo,
  assignSkillRepo,
  type AnyDrizzleDb,
  type AgentJobRow,
} from '@nodal-agents/db';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { systemSkillSlugs } from '@nodal-agents/catalog';
// SKILL-002: the SAME linter the create_skill / update_skill tools run. This
// loop wrote through createSkillRepo / updateSkillRepo directly and skipped it —
// and reflection is the one writer whose content is authored by a model with no
// human in the loop, so it is the path that needed the check most.
import { lintSkillContent } from '@nodal-agents/tools';
import { resolveAgentLlmClient } from '../job/resolve-llm.ts';
import { buildReflectionSystemPrompt } from './prompt.ts';

// Per tool-result cap inside the reflection transcript. The agent loop already
// caps tool outputs at 50K for ITS context; for the cheap reflection pass we
// compact much harder (~2000 chars/result) — the model needs the SHAPE of what
// happened, not every byte of a scraped page.
const MAX_REFLECTION_TOOL_RESULT_CHARS = 2000;

const REFLECTION_TRACE = '[reflection]';

// ─── Reflection tool input schemas ─────────────────────────────────────────────
// Mirror create_skill / update_skill, minimal. Defined locally (not imported
// from the meta-ops tools) so the reflection path owns its provenance write and
// stays decoupled from the ROOT-gating meta-tool wiring.

const CreateSkillArgs = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens only.')
    .min(1),
  name: z.string().min(1),
  content: z.string().min(1),
  description: z.string().optional(),
});

const UpdateSkillArgs = z.object({
  skillSlug: z.string().min(1),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  content: z.string().min(1).optional(),
  active: z.boolean().optional(),
});

const SkillViewArgs = z.object({
  slug: z.string().min(1),
});

interface ReflectionResult {
  /** How the pass ended — for the trace log; not user-facing. */
  outcome: 'no-op' | 'created' | 'patched' | 'mixed' | 'skipped';
  created: number;
  patched: number;
  turns: number;
}

/** Truncate an oversized tool-result string with an explicit marker. */
function compactToolResult(value: string): string {
  if (value.length <= MAX_REFLECTION_TOOL_RESULT_CHARS) return value;
  return (
    value.slice(0, MAX_REFLECTION_TOOL_RESULT_CHARS) +
    `\n[... ${value.length - MAX_REFLECTION_TOOL_RESULT_CHARS} chars elided ...]`
  );
}

/**
 * Render a job's transcript into a single compacted user message for the
 * reflection model. We flatten roles to readable text and hard-cap each
 * tool-result body. The original `messages` JSONB is the AI-SDK ModelMessage[]
 * shape persisted by completeJob.
 */
function renderTranscript(task: string, messages: readonly ModelMessage[]): string {
  const lines: string[] = [`TASK: ${task}`, '', 'TRANSCRIPT:'];
  for (const msg of messages) {
    const role = msg.role;
    if (typeof msg.content === 'string') {
      if (msg.content.trim().length > 0) lines.push(`[${role}] ${compactToolResult(msg.content)}`);
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part.type === 'text') {
        if (part.text.trim().length > 0) lines.push(`[${role}] ${compactToolResult(part.text)}`);
      } else if (part.type === 'tool-call') {
        lines.push(`[${role} → ${part.toolName}] ${compactToolResult(JSON.stringify(part.input))}`);
      } else if (part.type === 'tool-result') {
        // ToolResultOutput is a discriminated union (text | json | error-text |
        // error-json | content | execution-denied). Render text-ish variants
        // directly; serialise the rest.
        const o = part.output;
        const out =
          o.type === 'text' || o.type === 'error-text'
            ? o.value
            : o.type === 'json' || o.type === 'error-json'
              ? JSON.stringify(o.value ?? null)
              : JSON.stringify(o);
        lines.push(`[tool-result ${part.toolName}] ${compactToolResult(out)}`);
      } else if (part.type === 'reasoning') {
        if (part.text.trim().length > 0)
          lines.push(`[${role} reasoning] ${compactToolResult(part.text)}`);
      }
    }
  }
  return lines.join('\n');
}

/**
 * Render the ENTITY-WIDE skill library, provenance-marked so the model knows
 * which skills it may patch ([agent]) vs which already govern an area and must
 * not be duplicated ([user]/[system]).
 */
function renderSkillsBlock(
  skills: ReadonlyArray<{
    slug: string;
    name: string;
    description: string | null;
    createdBy: string;
  }>,
): string {
  if (skills.length === 0) return '(library is empty)';
  return skills
    .map((s) => {
      const mark =
        s.createdBy === 'agent' ? '[agent]' : s.createdBy === 'user' ? '[user]' : '[system]';
      return `- ${mark} ${s.slug} — ${s.name}${s.description ? `: ${s.description}` : ''}`;
    })
    .join('\n');
}

/**
 * Run the reflection pass for one completed job. Assumes the caller
 * (maybeRunReflection) has already verified all gates. `maxTurns` bounds the
 * reflection loop itself.
 *
 * `reflectionModel` — when set, overrides the model used for this pass while
 * keeping the agent's LLM key. Unset ⇒ uses the agent's configured model
 * (current behavior, byte-for-byte identical).
 */
export async function runReflection(
  db: AnyDrizzleDb,
  job: AgentJobRow,
  maxTurns: number,
  maxNewSkills: number,
  reflectionModel?: string,
): Promise<ReflectionResult> {
  if (!job.agentId || !job.entityId)
    return { outcome: 'skipped', created: 0, patched: 0, turns: 0 };
  const entityId = job.entityId;
  const agentId = job.agentId;

  // ── Load agent ────────────────────────────────────────────────────────────
  const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agentRow || !agentRow.active) {
    return { outcome: 'skipped', created: 0, patched: 0, turns: 0 };
  }

  // ── Load entity skill_assignment_mode ─────────────────────────────────────
  // Determines whether agent-authored skills are auto-assigned to the authoring
  // agent ('auto') or queued for owner approval ('approval', the safe default).
  const [entityRow] = await db
    .select({ skillAssignmentMode: entities.skillAssignmentMode })
    .from(entities)
    .where(eq(entities.id, entityId))
    .limit(1);
  const skillAssignmentMode: 'auto' | 'approval' = entityRow?.skillAssignmentMode ?? 'approval';

  // ── Load the ENTITY-WIDE skill library (cross-agent) ──────────────────────
  // The reflection sees ALL of the workspace's skills, not just this agent's
  // assigned ones, so it can PATCH a skill another agent authored instead of
  // forking a near-duplicate (the cross-agent convergence fix). Archived skills
  // are excluded — dormant, shouldn't invite re-creation. Provenance is carried
  // through so the prompt marks which are patchable ([agent]) vs protected.
  const librarySkills = await db
    .select({
      slug: agentSkills.slug,
      name: agentSkills.name,
      description: agentSkills.description,
      createdBy: agentSkills.createdBy,
    })
    .from(agentSkills)
    .where(and(eq(agentSkills.entityId, entityId), ne(agentSkills.state, 'archived')));

  // ── Resolve the agent's LLM client (same path as the work loop) ───────────
  // When reflectionModel is set, keep the agent's key but override the model so
  // the housekeeping pass runs on a known-good model (e.g. an OpenRouter key
  // pointing at a cheap/reliable model) instead of the agent's own model.
  // When unset, args are byte-for-byte the pre-override behavior.
  const resolved = await resolveAgentLlmClient(
    db,
    // reasoningEffort follows the agent on BOTH branches (décision 2026-07-20):
    // on REFLECTION_MODEL it is translated per that model's own control.
    reflectionModel !== undefined
      ? {
          llmKeyId: agentRow.llmKeyId,
          fallbackChain: null,
          model: reflectionModel,
          reasoningEffort: agentRow.reasoningEffort ?? null,
        }
      : {
          llmKeyId: agentRow.llmKeyId,
          fallbackChain: agentRow.fallbackChain ?? null,
          model: agentRow.model ?? '',
          reasoningEffort: agentRow.reasoningEffort ?? null,
        },
  );
  if (!resolved.ok) {
    console.warn(`${REFLECTION_TRACE} no LLM for agent ${agentRow.slug}: ${resolved.reason}`);
    return { outcome: 'skipped', created: 0, patched: 0, turns: 0 };
  }
  const llmClient = resolved.client;

  // ── Build the prompt + transcript ─────────────────────────────────────────
  const systemPrompt = buildReflectionSystemPrompt(agentRow.name, renderSkillsBlock(librarySkills));
  const transcriptMsgs: ModelMessage[] = Array.isArray(job.messages)
    ? (job.messages as ModelMessage[])
    : [];
  const messages: ModelMessage[] = [
    { role: 'user', content: renderTranscript(job.task, transcriptMsgs) },
  ];

  // ── Tools: ONLY create_skill + update_skill, scoped to this agent ─────────
  // Same AI-SDK shape the work loop hands to generateText: name → {description,
  // inputSchema}. We execute the calls ourselves against the repos with
  // provenance created_by='agent' (and patch_count bump on update).
  const tools: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
    skill_view: {
      description:
        'Read the full content of an existing skill in this workspace (by slug). Use it to ' +
        'inspect a candidate umbrella before patching it.',
      inputSchema: SkillViewArgs,
    },
    update_skill: {
      description:
        'PATCH an existing AGENT-authored skill (by slug) — your DEFAULT action. Extend its ' +
        'content with a new labeled section, add a pitfall, or broaden it. Prefer this over ' +
        'creating a near-duplicate, INCLUDING patching a skill another agent authored.',
      inputSchema: UpdateSkillArgs,
    },
    create_skill: {
      description:
        'Author a NEW class-level umbrella skill. LAST RESORT — only when no existing skill ' +
        'covers the class. slug is lowercase alphanumeric + hyphens; the name must be ' +
        'class-level, not a one-session/tool-specific artifact.',
      inputSchema: CreateSkillArgs,
    },
  };

  let created = 0;
  let patched = 0;
  let turns = 0;

  // Observability: the pass fired (gates + throttle already passed upstream).
  // Lets the runner log distinguish "ran → no-op" from "never ran".
  console.warn(`${REFLECTION_TRACE} start`, { agentSlug: agentRow.slug, jobId: job.id });

  for (let turn = 0; turn < maxTurns; turn += 1) {
    turns = turn + 1;
    const response = await llmClient.generateText({
      system: systemPrompt,
      messages,
      tools,
      // Never force a tool call: a no-op pass (no tool call) is a valid, common
      // and desired outcome — forcing would manufacture junk skills.
      toolChoice: 'auto',
    });

    const toolCalls = response.toolCalls ?? [];
    if (toolCalls.length === 0) break; // model chose to do nothing → stop.

    // Record the assistant turn so a follow-up turn sees its own calls.
    const assistantParts: Array<
      | { type: 'text'; text: string }
      | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
    > = [];
    if (response.text) assistantParts.push({ type: 'text', text: response.text });
    for (const tc of toolCalls) {
      assistantParts.push({
        type: 'tool-call',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        input: tc.input,
      });
    }
    messages.push({ role: 'assistant', content: assistantParts } as ModelMessage);

    // Execute each call against the repos (provenance = agent) and feed a
    // tool-result back so the model can decide whether to do more or stop.
    const resultParts: Array<{
      type: 'tool-result';
      toolCallId: string;
      toolName: string;
      output: { type: 'text'; value: string };
    }> = [];
    for (const tc of toolCalls) {
      let outcomeText: string;
      if (tc.toolName === 'skill_view') {
        const parsed = SkillViewArgs.safeParse(tc.input);
        if (!parsed.success) {
          outcomeText = `error: invalid_input: ${parsed.error.message}`;
        } else {
          const [row] = await db
            .select({ name: agentSkills.name, content: agentSkills.content })
            .from(agentSkills)
            .where(and(eq(agentSkills.entityId, entityId), eq(agentSkills.slug, parsed.data.slug)))
            .limit(1);
          outcomeText = row
            ? `# ${row.name}\n\n${compactToolResult(row.content)}`
            : `error: skill "${parsed.data.slug}" not found`;
        }
      } else if (tc.toolName === 'create_skill') {
        const parsed = CreateSkillArgs.safeParse(tc.input);
        if (!parsed.success) {
          outcomeText = `error: invalid_input: ${parsed.error.message}`;
        } else if (created >= maxNewSkills) {
          // Hard per-pass cap: once the model has created its budget of new
          // umbrellas, steer remaining lessons into patches of existing skills.
          outcomeText = `error: new-skill cap (${maxNewSkills}) reached for this pass — PATCH an existing skill with update_skill instead of creating another.`;
        } else {
          // SKILL-002: lint BEFORE writing, exactly as the create_skill tool
          // does. Fail loud into the model's own outcome text so it can fix the
          // content on the next turn, rather than dropping the lesson.
          const lint = await lintSkillContent(db, entityId, parsed.data.content);
          if (!lint.ok) {
            outcomeText = `error: ${lint.error}`;
            continue;
          }
          // P2b (F-6 follow-up): refuse a slug reserved by the system
          // catalog — the reflection model must not be able to shadow a
          // system skill with an agent-authored one sharing its slug.
          const res = await createSkillRepo(
            db,
            entityId,
            {
              slug: parsed.data.slug,
              name: parsed.data.name,
              content: parsed.data.content,
              description: parsed.data.description,
              createdBy: 'agent',
              createdByAgentId: agentId,
            },
            systemSkillSlugs,
          );
          if ('error' in res) {
            outcomeText =
              res.error === 'slug_reserved'
                ? `error: slug "${parsed.data.slug}" is a reserved system skill slug — choose a different slug`
                : `error: slug "${parsed.data.slug}" already taken`;
          } else {
            created += 1;
            // Auto-assign the new skill to the authoring agent when mode='auto'.
            // On failure (agent_not_found / already_assigned), log and continue —
            // the skill exists and the entity owner can always assign manually.
            if (skillAssignmentMode === 'auto') {
              const assignRes = await assignSkillRepo(
                db,
                entityId,
                { skillId: res.id, agentId },
                [],
              );
              if ('error' in assignRes && assignRes.error !== 'already_assigned') {
                console.warn(`${REFLECTION_TRACE} auto-assign failed`, {
                  slug: parsed.data.slug,
                  error: assignRes.error,
                });
              }
              outcomeText = `created skill ${parsed.data.slug} (auto-assigned to agent)`;
              console.warn(`${REFLECTION_TRACE} auto-assigned ${parsed.data.slug}`);
            } else {
              outcomeText = `created skill ${parsed.data.slug} (pending approval)`;
              console.warn(`${REFLECTION_TRACE} ${parsed.data.slug} pending approval`);
            }
          }
        }
      } else if (tc.toolName === 'update_skill') {
        const parsed = UpdateSkillArgs.safeParse(tc.input);
        if (!parsed.success) {
          outcomeText = `error: invalid_input: ${parsed.error.message}`;
        } else if (
          parsed.data.name === undefined &&
          parsed.data.description === undefined &&
          parsed.data.content === undefined &&
          parsed.data.active === undefined
        ) {
          outcomeText = 'error: nothing to update';
        } else {
          // Resolve slug OR name → skill (id + provenance) within this entity
          // (mirrors the update_skill meta-tool's resolution). We fetch
          // created_by so we can SANDBOX the patch to agent-owned skills.
          const [skillRow] = await db
            .select({ id: agentSkills.id, createdBy: agentSkills.createdBy })
            .from(agentSkills)
            .where(
              and(
                eq(agentSkills.entityId, entityId),
                or(
                  eq(agentSkills.slug, parsed.data.skillSlug),
                  ilike(agentSkills.name, parsed.data.skillSlug),
                ),
              ),
            )
            .limit(1);
          if (!skillRow) {
            outcomeText = `error: skill "${parsed.data.skillSlug}" not found`;
          } else if (skillRow.createdBy !== 'agent') {
            // Provenance sandbox (Phase A invariant): reflection may ONLY patch
            // skills it authored itself. Patching a user/system skill would flip
            // its provenance and make it curator-eligible — the user's authored
            // skill could then be archived by the Phase C curator. Refuse and
            // steer the model to author a new agent skill instead.
            outcomeText = `error: skill "${parsed.data.skillSlug}" is user/system-owned and cannot be modified by reflection — use create_skill to author a new agent skill instead.`;
          } else {
            // SKILL-002: a PATCH replaces the content wholesale, so it can
            // introduce exactly what the linter exists to refuse. Same check as
            // the update_skill tool, on the same code path.
            // Guarded: a patch may change only the name or the active flag, in
            // which case there is no new content to lint.
            if (parsed.data.content !== undefined) {
              const patchLint = await lintSkillContent(db, entityId, parsed.data.content);
              if (!patchLint.ok) {
                outcomeText = `error: ${patchLint.error}`;
                continue;
              }
            }
            // Agent-owned skill: bump patch_count atomically. created_by is
            // already 'agent' and a patch NEVER changes a skill's provenance.
            const res = await updateSkillRepo(db, entityId, skillRow.id, {
              name: parsed.data.name,
              description: parsed.data.description,
              content: parsed.data.content,
              active: parsed.data.active,
              createdBy: 'agent',
            });
            if ('error' in res) {
              outcomeText = `error: skill "${parsed.data.skillSlug}" not found`;
            } else {
              patched += 1;
              outcomeText = `patched skill ${parsed.data.skillSlug}`;
            }
          }
        }
      } else {
        outcomeText = `error: unknown tool ${tc.toolName}`;
      }
      resultParts.push({
        type: 'tool-result',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        output: { type: 'text', value: outcomeText },
      });
    }
    messages.push({ role: 'tool', content: resultParts } as ModelMessage);
  }

  const outcome: ReflectionResult['outcome'] =
    created > 0 && patched > 0
      ? 'mixed'
      : created > 0
        ? 'created'
        : patched > 0
          ? 'patched'
          : 'no-op';
  // Observability: the pass completed — what (if anything) it changed.
  console.warn(`${REFLECTION_TRACE} done`, {
    jobId: job.id,
    agentSlug: agentRow.slug,
    outcome,
    created,
    patched,
    turns,
  });
  return { outcome, created, patched, turns };
}
