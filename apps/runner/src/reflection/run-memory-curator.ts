// reflection/run-memory-curator.ts — Tier-2 MEMORY curator: bounded LLM pass.
//
// The memory analog of run-curator.ts (skill consolidation). Loads an entity's
// non-archived durable facts and runs a tight loop where the curation model may:
//   - edit_memory:     distill an oversized/blobby fact to its key statement, or
//                      write the merged text when consolidating near-duplicates.
//   - archive_memory:  soft-archive a redundant/obsolete agent-authored fact.
//   - set_importance:  re-score a fact's importance (1-5) from REAL usage
//                      (access_count) + relevance — the agent's initial
//                      importance is a one-shot guess; usage is the proven signal.
//
// Provenance-guarded: all three tools refuse source='manual' (user-entered facts)
// via the repo helpers. Archiving is reversible. A no-op pass is the common,
// correct outcome on a clean pool. Fail-closed: errors propagate to runCuratorTick.

import { agentMemory, eq, and, agents, type AnyDrizzleDb } from '@nodal-agents/db';
import {
  archiveAgentMemory,
  updateAgentMemoryFact,
  updateAgentMemoryImportance,
} from '@nodal-agents/memory';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { resolveAgentLlmClient } from '../job/resolve-llm.ts';
import { makeLlmCallSink } from '../llm/call-sink.ts';

const TRACE = '[memory-curator]';

// Facts at or below this length are healthy atomic statements — never flagged as
// oversized in the prompt. Above it, the model is nudged to distill.
const HEALTHY_FACT_CHARS = 280;
// Cap how many facts we load into one pass (keeps the prompt bounded).
const MAX_CANDIDATES = 200;

const EditMemoryArgs = z.object({
  memoryId: z.string().uuid('memoryId must be a valid UUID.'),
  fact: z.string().min(1).max(2000),
});
const ArchiveMemoryArgs = z.object({
  memoryId: z.string().uuid('memoryId must be a valid UUID.'),
});
const SetImportanceArgs = z.object({
  memoryId: z.string().uuid('memoryId must be a valid UUID.'),
  importance: z.number().int().min(1).max(5),
  reason: z.string().min(1).max(200),
});

export interface MemoryCurationResult {
  edited: number;
  archived: number;
  rescored: number;
  turns: number;
}

function buildSystemPrompt(candidateList: string): string {
  return `You are the MEMORY CURATOR for this entity. Your job is to keep the durable-fact memory SMALL, DENSE, and NON-REDUNDANT, so the limited injection budget is spent on signal.

CANDIDATE FACTS (id, source, importance, access_count, length, text):
${candidateList}

WHAT A GOOD FACT IS: ONE short, durable statement (a preference, an ID, a convention, a learned rule) — typically under ${HEALTHY_FACT_CHARS} characters. NOT a document, a raw dump, or a session log.

ACTIONS:
1. DISTILL oversized facts — if a fact is a big blob (a pasted workflow/JSON, a long log, a transcript), call edit_memory to replace it with just the key statement + a pointer to where the artifact actually lives (e.g. "... saved in workspace file workflows/X.json"). Keep the SIGNAL, drop the bulk.
2. MERGE near-duplicates — when several facts say the same thing, edit_memory ONE of them to the best consolidated wording, then archive_memory the others.
3. ARCHIVE the clearly obsolete or contradictory.
4. RE-SCORE importance — a fact's initial importance is just the authoring agent's one-shot estimate. access_count is PROVEN usage, and it is more reliable than that estimate. Call set_importance to RAISE the importance of a durable fact that is accessed often (it clearly matters), and to LOWER the importance of a fact that has never been used despite being around a while (it probably doesn't). Give a short reason.

HARD RULES:
- You may ONLY edit/archive/re-score AGENT-authored facts. The tools REFUSE source='manual' (user-entered) — do NOT attempt them, and do not retry a refused call.
- Archiving is the maximum action — it is reversible; never invent or fabricate facts.
- When a fact is already a clean short statement, LEAVE IT. A no-op pass is correct and common on a tidy pool.
- Do NOT merge facts that are merely related but distinct — only true duplicates.
- Do NOT re-score every fact out of habit — only when access_count clearly disagrees with the current importance.`;
}

function renderCandidates(
  facts: ReadonlyArray<{
    id: string;
    fact: string;
    source: string | null;
    importance: number | null;
    accessCount: number | null;
  }>,
): string {
  if (facts.length === 0) return '(none)';
  return facts
    .map((f) => {
      const len = f.fact.length;
      const oversized = len > HEALTHY_FACT_CHARS ? ' OVERSIZED' : '';
      const text = len > 200 ? `${f.fact.slice(0, 200)}…` : f.fact;
      return `- id=${f.id} source=${f.source ?? 'agent'} importance=${f.importance ?? 3} access_count=${f.accessCount ?? 0} len=${len}${oversized}\n    ${text.replace(/\s+/g, ' ')}`;
    })
    .join('\n');
}

/**
 * Run the LLM memory-curation pass for one entity. Resolves the LLM client like
 * the skill curator (entity's agents, optional reflectionModel override). Skips
 * silently when no client resolves. Returns counts.
 */
export async function runMemoryCuration(
  db: AnyDrizzleDb,
  entityId: string,
  maxTurns: number,
  reflectionModel?: string,
): Promise<MemoryCurationResult> {
  const candidates = await db
    .select({
      id: agentMemory.id,
      fact: agentMemory.fact,
      source: agentMemory.source,
      importance: agentMemory.importance,
      accessCount: agentMemory.accessCount,
    })
    .from(agentMemory)
    .where(and(eq(agentMemory.entityId, entityId), eq(agentMemory.archived, false)))
    .limit(MAX_CANDIDATES);

  if (candidates.length === 0) return { edited: 0, archived: 0, rescored: 0, turns: 0 };

  // Resolve LLM client — root/any active agent's key, optional model override.
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

  let resolved: Awaited<ReturnType<typeof resolveAgentLlmClient>> | undefined;
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
      // étape D: memory-curator passes were invisible LLM consumers.
      makeLlmCallSink(db, { source: 'curator', entityId, agentId: ag.id }),
    );
    if (r.ok) {
      resolved = r;
      break;
    }
  }
  if (!resolved?.ok) {
    console.warn(`${TRACE} no LLM client for entity ${entityId}, skipping`);
    return { edited: 0, archived: 0, rescored: 0, turns: 0 };
  }
  const llmClient = resolved.client;

  const systemPrompt = buildSystemPrompt(renderCandidates(candidates));
  const messages: ModelMessage[] = [
    {
      role: 'user',
      content:
        'Review the candidate facts. Distill any oversized blobs, merge true duplicates, and archive the obsolete. If the pool is already clean, take no action.',
    },
  ];
  const tools: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
    edit_memory: {
      description:
        'Replace a fact with a distilled/merged version (keep the key statement, drop bulk). Provide the memory UUID and the new fact text. Refuses user-entered (manual) facts.',
      inputSchema: EditMemoryArgs,
    },
    archive_memory: {
      description:
        'Soft-archive a redundant/obsolete agent-authored fact (reversible). Provide the memory UUID. Refuses user-entered (manual) facts.',
      inputSchema: ArchiveMemoryArgs,
    },
    set_importance: {
      description:
        "Re-score a fact's importance (1-5) from REAL usage (access_count) + relevance. Raise for frequently-accessed durable facts; lower for never-used ones. Refuses user-entered (manual) facts.",
      inputSchema: SetImportanceArgs,
    },
  };

  let edited = 0;
  let archived = 0;
  let rescored = 0;
  let turns = 0;
  console.warn(`${TRACE} start`, { entityId, candidateCount: candidates.length });

  for (let turn = 0; turn < maxTurns; turn += 1) {
    turns = turn + 1;
    const response = await llmClient.generateText({
      system: systemPrompt,
      messages,
      tools,
      toolChoice: 'auto',
    });

    const toolCalls = response.toolCalls ?? [];
    if (toolCalls.length === 0) break;

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

    const resultParts: Array<{
      type: 'tool-result';
      toolCallId: string;
      toolName: string;
      output: { type: 'text'; value: string };
    }> = [];

    for (const tc of toolCalls) {
      let outcome: string;
      if (tc.toolName === 'edit_memory') {
        const parsed = EditMemoryArgs.safeParse(tc.input);
        if (!parsed.success) {
          outcome = `error: invalid_input: ${parsed.error.message}`;
        } else {
          const res = await updateAgentMemoryFact(
            db,
            entityId,
            parsed.data.memoryId,
            parsed.data.fact,
          );
          if ('error' in res) {
            outcome =
              res.error === 'not_agent_memory'
                ? `error: memory ${parsed.data.memoryId} is user-entered and cannot be edited by the curator.`
                : `error: memory ${parsed.data.memoryId} not found in this entity.`;
          } else {
            edited += 1;
            outcome = `edited memory ${parsed.data.memoryId}`;
          }
        }
      } else if (tc.toolName === 'archive_memory') {
        const parsed = ArchiveMemoryArgs.safeParse(tc.input);
        if (!parsed.success) {
          outcome = `error: invalid_input: ${parsed.error.message}`;
        } else {
          const res = await archiveAgentMemory(db, entityId, parsed.data.memoryId);
          if ('error' in res) {
            outcome =
              res.error === 'not_agent_memory'
                ? `error: memory ${parsed.data.memoryId} is user-entered and cannot be archived by the curator.`
                : `error: memory ${parsed.data.memoryId} not found in this entity.`;
          } else {
            archived += 1;
            outcome = `archived memory ${parsed.data.memoryId}`;
          }
        }
      } else if (tc.toolName === 'set_importance') {
        const parsed = SetImportanceArgs.safeParse(tc.input);
        if (!parsed.success) {
          outcome = `error: invalid_input: ${parsed.error.message}`;
        } else {
          const res = await updateAgentMemoryImportance(
            db,
            entityId,
            parsed.data.memoryId,
            parsed.data.importance,
          );
          if ('error' in res) {
            outcome =
              res.error === 'not_agent_memory'
                ? `error: memory ${parsed.data.memoryId} is user-entered and cannot be re-scored by the curator.`
                : res.error === 'invalid_importance'
                  ? `error: importance must be an integer 1-5.`
                  : res.error === 'importance_locked'
                    ? `error: memory ${parsed.data.memoryId} importance is user-locked and cannot be re-scored.`
                    : `error: memory ${parsed.data.memoryId} not found in this entity.`;
          } else {
            rescored += 1;
            outcome = `set importance of memory ${parsed.data.memoryId} to ${parsed.data.importance} (${parsed.data.reason})`;
          }
        }
      } else {
        outcome = `error: unknown tool ${tc.toolName}`;
      }
      resultParts.push({
        type: 'tool-result',
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        output: { type: 'text', value: outcome },
      });
    }
    messages.push({ role: 'tool', content: resultParts } as ModelMessage);
  }

  console.warn(`${TRACE} done`, { entityId, edited, archived, rescored, turns });
  return { edited, archived, rescored, turns };
}
