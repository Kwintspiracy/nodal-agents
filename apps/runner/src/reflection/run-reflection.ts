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
  ilike,
  agents,
  agentSkills,
  agentSkillAssignments,
  createSkillRepo,
  updateSkillRepo,
  type AnyDrizzleDb,
  type AgentJobRow,
} from '@nodal-agents/db';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
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

/** Render the agent's assigned skills as a compact slug/name/description block. */
function renderSkillsBlock(
  skills: ReadonlyArray<{ slug: string; name: string; description: string | null }>,
): string {
  if (skills.length === 0) return '(none assigned yet)';
  return skills
    .map((s) => `- ${s.slug} — ${s.name}${s.description ? `: ${s.description}` : ''}`)
    .join('\n');
}

/**
 * Run the reflection pass for one completed job. Assumes the caller
 * (maybeRunReflection) has already verified all gates. `maxTurns` bounds the
 * reflection loop itself.
 */
export async function runReflection(
  db: AnyDrizzleDb,
  job: AgentJobRow,
  maxTurns: number,
): Promise<ReflectionResult> {
  if (!job.agentId || !job.entityId) return { outcome: 'skipped', created: 0, patched: 0, turns: 0 };
  const entityId = job.entityId;
  const agentId = job.agentId;

  // ── Load agent ────────────────────────────────────────────────────────────
  const [agentRow] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!agentRow || !agentRow.active) {
    return { outcome: 'skipped', created: 0, patched: 0, turns: 0 };
  }

  // ── Load the agent's currently-assigned skills ────────────────────────────
  const assignedSkills = await db
    .select({
      slug: agentSkills.slug,
      name: agentSkills.name,
      description: agentSkills.description,
    })
    .from(agentSkillAssignments)
    .innerJoin(agentSkills, eq(agentSkills.id, agentSkillAssignments.skillId))
    .where(eq(agentSkillAssignments.agentId, agentId));

  // ── Resolve the agent's LLM client (same path as the work loop) ───────────
  const resolved = await resolveAgentLlmClient(db, {
    llmKeyId: agentRow.llmKeyId,
    fallbackChain: agentRow.fallbackChain ?? null,
    model: agentRow.model ?? '',
  });
  if (!resolved.ok) {
    console.warn(`${REFLECTION_TRACE} no LLM for agent ${agentRow.slug}: ${resolved.reason}`);
    return { outcome: 'skipped', created: 0, patched: 0, turns: 0 };
  }
  const llmClient = resolved.client;

  // ── Build the prompt + transcript ─────────────────────────────────────────
  const systemPrompt = buildReflectionSystemPrompt(agentRow.name, renderSkillsBlock(assignedSkills));
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
    create_skill: {
      description:
        'Author a NEW durable skill for this agent. slug is lowercase alphanumeric + hyphens. ' +
        'Use only when the lesson does not fit an existing skill.',
      inputSchema: CreateSkillArgs,
    },
    update_skill: {
      description:
        'Patch an EXISTING skill of this agent (identify by slug or name). Prefer this over ' +
        'creating a near-duplicate. Provide at least one field to change.',
      inputSchema: UpdateSkillArgs,
    },
  };

  let created = 0;
  let patched = 0;
  let turns = 0;

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
      if (tc.toolName === 'create_skill') {
        const parsed = CreateSkillArgs.safeParse(tc.input);
        if (!parsed.success) {
          outcomeText = `error: invalid_input: ${parsed.error.message}`;
        } else {
          const res = await createSkillRepo(db, entityId, {
            slug: parsed.data.slug,
            name: parsed.data.name,
            content: parsed.data.content,
            description: parsed.data.description,
            createdBy: 'agent',
          });
          if ('error' in res) {
            outcomeText = `error: slug "${parsed.data.slug}" already taken`;
          } else {
            created += 1;
            outcomeText = `created skill ${parsed.data.slug}`;
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
  return { outcome, created, patched, turns };
}
