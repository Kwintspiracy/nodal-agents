// reflection/run-memory-curator.ts — Tier-2 MEMORY curator: bounded LLM pass.
//
// The memory analog of run-curator.ts (skill consolidation). Loads an entity's
// non-archived durable facts and runs a tight loop where the curation model may:
//   - edit_memory:     write the merged text when consolidating near-duplicates.
//   - archive_memory:  soft-archive a redundant/obsolete fact.
//   - set_importance:  re-score a fact's importance (1-5) from REAL usage
//                      (access_count) + relevance — the agent's initial
//                      importance is a one-shot guess; usage is the proven signal.
//
// What the pass may change is what it was SHOWN, in full (#1144). Every
// candidate is rendered whole, up to a character budget; a fact that does not
// fit is left out of the pass, and the tools refuse any id that was not shown.
// Every change goes through `mutateMemory`, with the version the pass read: a
// fact changed since (by the owner, by an agent) is refused, the owner's marks
// (written or pinned by the owner) are honoured, and the previous state is
// kept, so any change of the pass can be put back from the Memory page.
// A no-op pass is the common, correct outcome on a clean pool. Fail-closed:
// errors propagate to runCuratorTick.

import { agentMemory, eq, and, agents, type AnyDrizzleDb } from '@nodal-agents/db';
import { mutateMemory, type MemoryChange, type MutateMemoryResult } from '@nodal-agents/memory';
import type { ModelMessage } from 'ai';
import { assertTurnToolCallBudget } from '@nodal-agents/orchestration';
import { z } from 'zod';
import { resolveAgentLlmClient } from '../job/resolve-llm.ts';
import { makeLlmCallSink } from '../llm/call-sink.ts';

const TRACE = '[memory-curator]';

// Cap how many facts we load into one pass, and how many characters of them
// the pass is shown. Every candidate is shown WHOLE: a fact that would not fit
// in the budget is left out of this pass (and cannot be changed by it), never
// cut to an excerpt. 64,000 characters is the size the pass had before, with
// 200 candidates of about 320 characters each.
const MAX_CANDIDATES = 200;
export const MEMORY_CURATOR_CANDIDATE_CHARS = 64_000;

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
  return `You are the MEMORY CURATOR for this entity. Your job is to keep the durable-fact memory DENSE and NON-REDUNDANT, so the limited injection budget is spent on signal.

CANDIDATE FACTS (id, source, importance, access_count, length, protected, then the WHOLE text):
${candidateList}

ACTIONS:
1. MERGE near-duplicates — when several facts say the same thing, edit_memory ONE of them to a consolidated wording that keeps everything each of them says, then archive_memory the others.
2. ARCHIVE the clearly obsolete or contradictory.
3. RE-SCORE importance — a fact's initial importance is just the authoring agent's one-shot estimate. access_count is PROVEN usage, and it is more reliable than that estimate. Call set_importance to RAISE the importance of a durable fact that is accessed often (it clearly matters), and to LOWER the importance of a fact that has never been used despite being around a while (it probably doesn't). Give a short reason.

HARD RULES:
- A fact marked protected=owner (written by the owner) or protected=pinned (pinned by the owner) is the owner's: the tools REFUSE any change to it — do NOT attempt it, and do not retry a refused call.
- Only the facts listed above can be changed, and only from their text as shown.
- Archiving is reversible, and every change keeps the previous text; never invent or fabricate facts.
- When a fact is already a clean statement, LEAVE IT. A no-op pass is correct and common on a tidy pool.
- Do NOT merge facts that are merely related but distinct — only true duplicates.
- Do NOT re-score every fact out of habit — only when access_count clearly disagrees with the current importance.`;
}

interface Candidate {
  id: string;
  fact: string;
  source: string | null;
  importance: number | null;
  importanceLocked: boolean;
  accessCount: number | null;
  version: number;
}

function protectedMark(f: Candidate): string {
  if (f.source === 'manual') return 'owner';
  if (f.importanceLocked) return 'pinned';
  return 'no';
}

/**
 * The candidates the pass is shown, each WHOLE, within the character budget.
 * A fact that does not fit is not shown, and so cannot be changed this pass.
 */
function selectShown(facts: readonly Candidate[]): Candidate[] {
  const shown: Candidate[] = [];
  let used = 0;
  for (const f of facts) {
    if (used + f.fact.length > MEMORY_CURATOR_CANDIDATE_CHARS) continue;
    shown.push(f);
    used += f.fact.length;
  }
  return shown;
}

/** Each fact exactly as stored, its lines indented under its header line. */
function renderCandidates(facts: readonly Candidate[]): string {
  if (facts.length === 0) return '(none)';
  return facts
    .map(
      (f) =>
        `- id=${f.id} source=${f.source ?? 'agent'} importance=${f.importance ?? 3} access_count=${f.accessCount ?? 0} len=${f.fact.length} protected=${protectedMark(f)}\n    ${f.fact.replace(/\r?\n/g, '\n    ')}`,
    )
    .join('\n');
}

/** What the model is told when a change is refused: the reason, and what to do. */
function refusalOutcome(res: Extract<MutateMemoryResult, { ok: false }>): string {
  switch (res.reason) {
    case 'owner_protected':
      return `error: ${res.detail} Leave it as it is; do not retry.`;
    case 'stale':
      return `error: memory changed since it was read in this pass (${res.detail}) Leave it for a later pass; do not retry.`;
    default:
      return `error: ${res.reason}: ${res.detail}`;
  }
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
  const loaded: Candidate[] = await db
    .select({
      id: agentMemory.id,
      fact: agentMemory.fact,
      source: agentMemory.source,
      importance: agentMemory.importance,
      importanceLocked: agentMemory.importanceLocked,
      accessCount: agentMemory.accessCount,
      version: agentMemory.version,
    })
    .from(agentMemory)
    .where(and(eq(agentMemory.entityId, entityId), eq(agentMemory.archived, false)))
    .limit(MAX_CANDIDATES);
  const candidates = selectShown(loaded);

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
            entityId,
            llmKeyId: ag.llmKeyId,
            fallbackChain: null,
            model: reflectionModel,
            reasoningEffort: ag.reasoningEffort ?? null,
          }
        : {
            entityId,
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
        'Review the candidate facts. Merge true duplicates, archive the obsolete, and re-score where usage disagrees. If the pool is already clean, take no action.',
    },
  ];
  const tools: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
    edit_memory: {
      description:
        'Replace the text of a fact listed above with a consolidated wording, when merging true duplicates (keep everything each of them says). Provide the memory UUID and the new fact text. The previous text is kept. Refuses facts the owner wrote or pinned.',
      inputSchema: EditMemoryArgs,
    },
    archive_memory: {
      description:
        'Soft-archive a redundant/obsolete fact listed above (reversible). Provide the memory UUID. Refuses facts the owner wrote or pinned.',
      inputSchema: ArchiveMemoryArgs,
    },
    set_importance: {
      description:
        'Re-score the importance (1-5) of a fact listed above from REAL usage (access_count) + relevance. Raise for frequently-accessed durable facts; lower for never-used ones. Refuses facts the owner wrote or pinned.',
      inputSchema: SetImportanceArgs,
    },
  };

  // What the pass read: the version of each fact it was shown. A change is
  // applied to that version only; after a change of its own, the pass knows
  // the new text (it wrote it) and the new version is what it read.
  const readVersions = new Map(candidates.map((c) => [c.id, c.version]));

  async function change(
    memoryId: string,
    what: MemoryChange,
    reason: string | undefined,
  ): Promise<MutateMemoryResult | string> {
    const readVersion = readVersions.get(memoryId);
    if (readVersion === undefined) {
      return `error: memory ${memoryId} is not among the facts shown to you in this pass; only those can be changed.`;
    }
    const res = await mutateMemory(db, {
      entityId,
      memoryId,
      readVersion,
      actor: { kind: 'curator' },
      change: what,
      ...(reason !== undefined ? { reason } : {}),
    });
    if (res.ok) readVersions.set(memoryId, res.memory.version);
    return res;
  }

  let edited = 0;
  let archived = 0;
  let rescored = 0;
  let turns = 0;
  console.warn(`${TRACE} start`, {
    entityId,
    candidateCount: candidates.length,
    // Facts left out of this pass because they would not fit whole.
    notShown: loaded.length - candidates.length,
  });

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
    // Invariant #8 (#564): a turn over the per-turn tool-call budget is refused
    // whole, before any of its calls runs. The pass throws; its caller logs it.
    assertTurnToolCallBudget(toolCalls.length);

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
          const res = await change(
            parsed.data.memoryId,
            { kind: 'edit', fact: parsed.data.fact },
            undefined,
          );
          if (typeof res === 'string') outcome = res;
          else if (!res.ok) outcome = refusalOutcome(res);
          else {
            edited += 1;
            outcome = `edited memory ${parsed.data.memoryId}`;
          }
        }
      } else if (tc.toolName === 'archive_memory') {
        const parsed = ArchiveMemoryArgs.safeParse(tc.input);
        if (!parsed.success) {
          outcome = `error: invalid_input: ${parsed.error.message}`;
        } else {
          const res = await change(parsed.data.memoryId, { kind: 'archive' }, undefined);
          if (typeof res === 'string') outcome = res;
          else if (!res.ok) outcome = refusalOutcome(res);
          else {
            archived += 1;
            outcome = `archived memory ${parsed.data.memoryId}`;
          }
        }
      } else if (tc.toolName === 'set_importance') {
        const parsed = SetImportanceArgs.safeParse(tc.input);
        if (!parsed.success) {
          outcome = `error: invalid_input: ${parsed.error.message}`;
        } else {
          const res = await change(
            parsed.data.memoryId,
            { kind: 'rescore', importance: parsed.data.importance },
            parsed.data.reason,
          );
          if (typeof res === 'string') outcome = res;
          else if (!res.ok) outcome = refusalOutcome(res);
          else {
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
