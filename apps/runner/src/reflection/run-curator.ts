// reflection/run-curator.ts — Tier-2 CURATOR: bounded LLM consolidation pass.
//
// Given an entity, loads its agent-created ACTIVE skills, resolves an LLM
// client (from the entity's root agent or any active agent with a key), and
// runs a tight loop where the consolidation model may:
//   - create_skill: author a new umbrella skill (created_by='agent')
//   - archive_skill: soft-archive a narrow agent-authored skill (provenance-
//                    guarded: refuses user/system skills via archiveAgentSkill)
//
// The loop stops as soon as the model produces no tool call OR the turn cap is
// reached. A no-op pass is the correct and common outcome.
//
// Fail-closed: any error propagates to the caller (runCuratorTick wraps in try/catch).
//
// Use REFLECTION_MODEL (env) to point the consolidation pass at a dedicated
// cheap/reliable model (e.g. an OpenRouter key that serves many models) without
// touching the agent's primary key budget. Unset ⇒ inherits the agent's model.

import {
  eq,
  and,
  agents,
  agentSkills,
  type AnyDrizzleDb,
  createSkillRepo,
  archiveAgentSkill,
} from '@nodal-agents/db';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { systemSkillSlugs } from '@nodal-agents/catalog';
// SKILL-002: same linter as the create_skill tool — the curator writes
// consolidated content authored by a model, with no human in the loop.
import { lintSkillContent } from '@nodal-agents/tools';
import { resolveAgentLlmClient } from '../job/resolve-llm.ts';
import { makeLlmCallSink } from '../llm/call-sink.ts';

const CURATOR_TRACE = '[curator]';

// ─── Tool schemas ────────────────────────────────────────────────────────────

const CreateSkillArgs = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens only.')
    .min(1),
  name: z.string().min(1),
  content: z.string().min(1),
  description: z.string().optional(),
});

const ArchiveSkillArgs = z.object({
  skillId: z.string().uuid('skillId must be a valid UUID.'),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CuratorConsolidationResult {
  created: number;
  archived: number;
  turns: number;
}

// ─── System prompt ───────────────────────────────────────────────────────────

function buildCuratorSystemPrompt(candidateList: string): string {
  return `You are the SKILL CURATOR for this entity. Your job is to keep the agent-created skill library small and discoverable.

CANDIDATE SKILLS (agent-authored, currently active):
${candidateList}

TASK — UMBRELLA CONSOLIDATION:
Review the candidate list for narrow, overlapping skills that would be better served by a single broader "umbrella" skill. When you find a genuine cluster:
1. Call create_skill to author the umbrella skill (merged content, broader name).
2. Call archive_skill for each narrow skill the umbrella replaces.

HARD RULES:
- You may ONLY create umbrella skills (created_by='agent' is applied automatically).
- You may ONLY archive agent-authored skills. The archive_skill tool will refuse non-agent skills — do NOT attempt to archive user- or system-authored skills.
- Archiving is the maximum destructive action. Never delete. All archives are recoverable by the user.
- Do NOT consolidate unrelated skills — a no-op pass is correct and common when the library is already clean.
- Do NOT manufacture skills that do not represent genuine distilled lessons.
- Keep umbrella names specific enough to be actionable, not vague ("General Tasks" is bad).

You will be told if archive_skill refuses a skill (provenance violation). Do not retry refused archives.`;
}

/** Render the candidate skills as a numbered list for the system prompt. */
function renderCandidateList(
  skills: ReadonlyArray<{
    id: string;
    slug: string;
    name: string;
    description: string | null;
    lastUsedAt: Date | null;
    patchCount: number;
  }>,
): string {
  if (skills.length === 0) return '(none)';
  return skills
    .map(
      (s, i) =>
        `${i + 1}. id=${s.id} slug=${s.slug} name="${s.name}"` +
        (s.description ? ` — ${s.description}` : '') +
        ` [used: ${s.lastUsedAt ? s.lastUsedAt.toISOString() : 'never'}, patches: ${s.patchCount}]`,
    )
    .join('\n');
}

// ─── runCuratorConsolidation ─────────────────────────────────────────────────

/**
 * Run the LLM consolidation pass for one entity.
 *
 * Resolves the LLM client from the entity's root agent or any active agent
 * with a configured key. If no client can be resolved, skips silently.
 *
 * `reflectionModel` — when set, keeps the agent's LLM key but overrides the
 * model string so the consolidation pass runs on a chosen model (e.g. a
 * cheap/reliable model via an OpenRouter key). Unset ⇒ uses the agent's own
 * model (current behavior, byte-for-byte identical).
 */
export async function runCuratorConsolidation(
  db: AnyDrizzleDb,
  entityId: string,
  maxTurns: number,
  reflectionModel?: string,
): Promise<CuratorConsolidationResult> {
  // ── Load agent-created ACTIVE skills ────────────────────────────────────────
  const candidateSkills = await db
    .select({
      id: agentSkills.id,
      slug: agentSkills.slug,
      name: agentSkills.name,
      description: agentSkills.description,
      lastUsedAt: agentSkills.lastUsedAt,
      patchCount: agentSkills.patchCount,
    })
    .from(agentSkills)
    .where(
      and(
        eq(agentSkills.entityId, entityId),
        eq(agentSkills.createdBy, 'agent'),
        eq(agentSkills.state, 'active'),
      ),
    );

  if (candidateSkills.length === 0) {
    return { created: 0, archived: 0, turns: 0 };
  }

  // ── Resolve LLM client: root agent first, then any active agent with a key ──
  // When reflectionModel is set, keep the agent's key but override the model so
  // the consolidation pass runs on a dedicated cheap/reliable model (e.g. an
  // OpenRouter key serving many models). When unset, args are byte-for-byte the
  // pre-override behavior.
  const agentRows = await db
    .select({
      id: agents.id,
      llmKeyId: agents.llmKeyId,
      fallbackChain: agents.fallbackChain,
      model: agents.model,
      reasoningEffort: agents.reasoningEffort,
    })
    .from(agents)
    .where(and(eq(agents.entityId, entityId), eq(agents.active, true)));

  if (agentRows.length === 0) {
    console.warn(`${CURATOR_TRACE} no active agents for entity ${entityId}, skipping`);
    return { created: 0, archived: 0, turns: 0 };
  }

  let resolvedClient: Awaited<ReturnType<typeof resolveAgentLlmClient>> | undefined;
  for (const ag of agentRows) {
    const r = await resolveAgentLlmClient(
      db,
      reflectionModel !== undefined
        ? {
            llmKeyId: ag.llmKeyId,
            fallbackChain: null,
            model: reflectionModel,
            reasoningEffort: ag.reasoningEffort ?? null,
          }
        : {
            llmKeyId: ag.llmKeyId,
            fallbackChain:
              (ag.fallbackChain as readonly { keyId: string; model: string }[] | null) ?? null,
            model: ag.model ?? '',
            reasoningEffort: ag.reasoningEffort ?? null,
          },
      undefined,
      // étape D: curator passes were invisible LLM consumers.
      makeLlmCallSink(db, { source: 'curator', entityId, agentId: ag.id }),
    );
    if (r.ok) {
      resolvedClient = r;
      break;
    }
  }

  if (!resolvedClient?.ok) {
    console.warn(`${CURATOR_TRACE} no LLM client for entity ${entityId}, skipping`);
    return { created: 0, archived: 0, turns: 0 };
  }
  const llmClient = resolvedClient.client;

  // ── Build prompt ──────────────────────────────────────────────────────────
  const systemPrompt = buildCuratorSystemPrompt(renderCandidateList(candidateSkills));

  // Single user message to open the conversation.
  const messages: ModelMessage[] = [
    {
      role: 'user',
      content:
        'Please review the candidate skill list and consolidate any overlapping or redundant agent-authored skills into umbrellas. Archive the narrow ones that are now redundant. If the library is already clean, take no action.',
    },
  ];

  const tools: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
    create_skill: {
      description:
        'Create a new UMBRELLA skill that replaces a cluster of narrow overlapping agent-authored skills. slug is lowercase alphanumeric + hyphens.',
      inputSchema: CreateSkillArgs,
    },
    archive_skill: {
      description:
        'Soft-archive a narrow agent-authored skill that is now redundant (replaced by an umbrella). Provide the skill UUID. Refuses non-agent skills — do NOT attempt to archive user- or system-authored skills.',
      inputSchema: ArchiveSkillArgs,
    },
  };

  let created = 0;
  let archived = 0;
  let turns = 0;

  console.warn(`${CURATOR_TRACE} start`, { entityId, candidateCount: candidateSkills.length });

  for (let turn = 0; turn < maxTurns; turn += 1) {
    turns = turn + 1;
    const response = await llmClient.generateText({
      system: systemPrompt,
      messages,
      tools,
      toolChoice: 'auto',
    });

    const toolCalls = response.toolCalls ?? [];
    if (toolCalls.length === 0) break; // no-op pass → stop

    // Record assistant turn
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

    // Execute tool calls
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
          // Known limitation (tracked in the feature backlog): in 'auto' mode
          // the consolidated skill does not inherit the archived skills'
          // assignments, so consolidation can strip capability until the
          // owner re-assigns it.
          // SKILL-002: lint before writing, as create_skill does.
          const lint = await lintSkillContent(db, entityId, parsed.data.content);
          if (!lint.ok) {
            outcomeText = `error: ${lint.error}`;
            continue;
          }
          // P2b (F-6 follow-up): refuse a slug reserved by the system
          // catalog — the curator must not shadow a system skill.
          const res = await createSkillRepo(
            db,
            entityId,
            {
              slug: parsed.data.slug,
              name: parsed.data.name,
              content: parsed.data.content,
              description: parsed.data.description,
              createdBy: 'agent',
              createdByAgentId: null,
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
            outcomeText = `created umbrella skill "${parsed.data.slug}"`;
          }
        }
      } else if (tc.toolName === 'archive_skill') {
        const parsed = ArchiveSkillArgs.safeParse(tc.input);
        if (!parsed.success) {
          outcomeText = `error: invalid_input: ${parsed.error.message}`;
        } else {
          const res = await archiveAgentSkill(db, entityId, parsed.data.skillId);
          if ('error' in res) {
            if (res.error === 'not_agent_skill') {
              // Provenance violation — steer the model away
              outcomeText = `error: skill ${parsed.data.skillId} is user/system-owned and cannot be archived by the curator. Only agent-authored skills may be archived.`;
            } else {
              outcomeText = `error: skill ${parsed.data.skillId} not found in this entity`;
            }
          } else {
            archived += 1;
            outcomeText = `archived skill ${parsed.data.skillId}`;
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

  console.warn(`${CURATOR_TRACE} done`, { entityId, created, archived, turns });
  return { created, archived, turns };
}
