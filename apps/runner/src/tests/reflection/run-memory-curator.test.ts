// run-memory-curator.test.ts — Tier-2 MEMORY curator LLM pass (runMemoryCuration).
//
// All assertions on REAL DB rows (agent_memory) + the outcome strings fed back
// to the LLM (never just call counts — CLAUDE.md invariant 5). The curation
// model is mocked via the same createLlmClient interception pattern as
// apps/runner/src/tests/curator/curator.test.ts (which drives set_importance
// through the cron wrapper); here we call runMemoryCuration directly so each
// tool-call error path can be scripted and asserted precisely.
//
// Coverage:
//   1. set_importance on an agent fact → DB importance changes, rescored=1
//   2. edit_memory distills a fact → DB fact text changes, edited=1
//   3. archive_memory → DB archived=true, archived=1
//   4. set_importance refuses source='manual' → outcome string, rescored=0, DB untouched
//   5. set_importance refuses importance_locked=true → outcome string, rescored=0, DB untouched
//   6. set_importance with an out-of-range importance (forged input) → invalid_input, rescored=0
//   7. any tool on a nonexistent id → "not found" outcome, counts=0
//   8. no-op pass (LLM makes no tool call) → {edited:0,archived:0,rescored:0,turns:1}, DB untouched
//   9. renderCandidates: the system prompt embeds access_count= and the RE-SCORE instruction

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText, type ModelMessage } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentMemory, eq } from '@nodal-agents/db';
import type { RunnerDeps } from '../../deps.ts';
import { runMemoryCuration } from '../../reflection/run-memory-curator.ts';

// ── createLlmClient interception (same pattern as curator.test.ts) ─────────────
const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let _active: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => _active,
    setActiveLlmClient: (c: RunnerDeps['llmClient'] | null) => {
      _active = c;
    },
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('run-memory-curator.test: no active LLM client set');
      return active;
    },
  };
});

// ── Scripted mock LLM (calque curator.test.ts) ──────────────────────────────────
type ScriptedTurn = {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
};

/** One captured generateText call — lets tests inspect what the runner sent. */
interface CapturedCall {
  system?: string;
  messages: ModelMessage[];
}

function makeScriptedClient(turns: ScriptedTurn[]): {
  client: RunnerDeps['llmClient'];
  calls: CapturedCall[];
} {
  let i = 0;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const t = turns[i] ?? turns[turns.length - 1] ?? {};
      i += 1;
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
      > = [];
      if (t.text) content.push({ type: 'text', text: t.text });
      for (const tc of t.toolCalls ?? [])
        content.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args),
        });
      const isTools = (t.toolCalls?.length ?? 0) > 0;
      return {
        content,
        finishReason: isTools
          ? { unified: 'tool-calls' as const, raw: 'tool-calls' }
          : { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });

  const calls: CapturedCall[] = [];
  const client: RunnerDeps['llmClient'] = {
    config: { provider: 'anthropic', model: 'mock' },
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) => {
      calls.push({
        system: typeof args.system === 'string' ? args.system : undefined,
        messages: [...(args.messages ?? [])] as ModelMessage[],
      });
      return generateText({ ...args, model } as Parameters<typeof generateText>[0]) as ReturnType<
        RunnerDeps['llmClient']['generateText']
      >;
    },
    streamText: () => {
      throw new Error('streamText not supported in mock');
    },
    generateObject: () => {
      throw new Error('generateObject not supported in mock');
    },
  };
  return { client, calls };
}

/** Find the tool-result value for a given toolCallId inside a captured call's messages. */
function findToolOutcome(calls: CapturedCall[], toolCallId: string): string | undefined {
  for (const call of calls) {
    for (const msg of call.messages) {
      if (msg.role !== 'tool') continue;
      const content = msg.content as Array<{
        type: string;
        toolCallId?: string;
        output?: { type: string; value: string };
      }>;
      for (const part of content) {
        if (part.type === 'tool-result' && part.toolCallId === toolCallId) {
          return part.output?.value;
        }
      }
    }
  }
  return undefined;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

async function insertFact(o: {
  fact: string;
  source: 'agent' | 'reflection' | 'manual';
  importance: number;
  accessCount?: number;
  importanceLocked?: boolean;
}): Promise<string> {
  const [row] = await db
    .insert(agentMemory)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      fact: o.fact,
      source: o.source,
      importance: o.importance,
      accessCount: o.accessCount ?? 0,
      archived: false,
      importanceLocked: o.importanceLocked ?? false,
    })
    .returning({ id: agentMemory.id });
  return row!.id as string;
}

async function loadFact(id: string) {
  const [row] = await db.select().from(agentMemory).where(eq(agentMemory.id, id));
  return row;
}

// ── 1. set_importance — happy path ──────────────────────────────────────────────
describe('runMemoryCuration — set_importance re-scores a real DB row', () => {
  it('changes importance in DB and returns rescored=1', async () => {
    await db.delete(agentMemory);
    const factId = await insertFact({
      fact: 'often-used agent fact',
      source: 'agent',
      importance: 2,
      accessCount: 20,
    });

    const { client } = makeScriptedClient([
      {
        toolCalls: [
          {
            toolCallId: 't1',
            toolName: 'set_importance',
            args: { memoryId: factId, importance: 5, reason: 'frequently accessed' },
          },
        ],
      },
      {}, // turn 2: no-op → stop
    ]);
    setActiveLlmClient(client);

    const result = await runMemoryCuration(db, seed.entityId, 3);

    expect(result).toEqual({ edited: 0, archived: 0, rescored: 1, turns: 2 });
    const row = await loadFact(factId);
    expect(row?.importance).toBe(5);
  });
});

// ── 2. edit_memory — distill ─────────────────────────────────────────────────────
describe('runMemoryCuration — edit_memory distills a real DB row', () => {
  it('replaces the fact text in DB and returns edited=1', async () => {
    await db.delete(agentMemory);
    const factId = await insertFact({
      fact: 'X'.repeat(2000),
      source: 'agent',
      importance: 4,
    });
    const distilled = 'Distilled: workflow saved in workspace file workflows/x.json.';

    const { client } = makeScriptedClient([
      {
        toolCalls: [
          {
            toolCallId: 't1',
            toolName: 'edit_memory',
            args: { memoryId: factId, fact: distilled },
          },
        ],
      },
      {},
    ]);
    setActiveLlmClient(client);

    const result = await runMemoryCuration(db, seed.entityId, 3);

    expect(result).toEqual({ edited: 1, archived: 0, rescored: 0, turns: 2 });
    const row = await loadFact(factId);
    expect(row?.fact).toBe(distilled);
  });
});

// ── 3. archive_memory ─────────────────────────────────────────────────────────────
describe('runMemoryCuration — archive_memory soft-archives a real DB row', () => {
  it('sets archived=true in DB and returns archived=1', async () => {
    await db.delete(agentMemory);
    const factId = await insertFact({
      fact: 'obsolete agent fact',
      source: 'agent',
      importance: 2,
    });

    const { client } = makeScriptedClient([
      { toolCalls: [{ toolCallId: 't1', toolName: 'archive_memory', args: { memoryId: factId } }] },
      {},
    ]);
    setActiveLlmClient(client);

    const result = await runMemoryCuration(db, seed.entityId, 3);

    expect(result).toEqual({ edited: 0, archived: 1, rescored: 0, turns: 2 });
    const row = await loadFact(factId);
    expect(row?.archived).toBe(true);
  });
});

// ── 4-7. Error paths — correct outcome string, counter NOT incremented, DB untouched ──
describe('runMemoryCuration — set_importance error paths never re-try silently', () => {
  it('refuses a source=manual fact: outcome names it user-entered, rescored stays 0', async () => {
    await db.delete(agentMemory);
    const factId = await insertFact({ fact: 'user fact', source: 'manual', importance: 3 });

    const { client, calls } = makeScriptedClient([
      {
        toolCalls: [
          {
            toolCallId: 't1',
            toolName: 'set_importance',
            args: { memoryId: factId, importance: 5, reason: 'x' },
          },
        ],
      },
      {},
    ]);
    setActiveLlmClient(client);

    const result = await runMemoryCuration(db, seed.entityId, 3);

    expect(result.rescored).toBe(0);
    const outcome = findToolOutcome(calls, 't1');
    expect(outcome).toContain('user-entered');
    expect(outcome).toContain('cannot be re-scored');
    const row = await loadFact(factId);
    expect(row?.importance).toBe(3); // untouched
  });

  it('refuses an importance_locked fact: outcome names it user-locked, rescored stays 0', async () => {
    await db.delete(agentMemory);
    const factId = await insertFact({
      fact: 'user-pinned agent fact',
      source: 'agent',
      importance: 4,
      importanceLocked: true,
    });

    const { client, calls } = makeScriptedClient([
      {
        toolCalls: [
          {
            toolCallId: 't1',
            toolName: 'set_importance',
            args: { memoryId: factId, importance: 1, reason: 'x' },
          },
        ],
      },
      {},
    ]);
    setActiveLlmClient(client);

    const result = await runMemoryCuration(db, seed.entityId, 3);

    expect(result.rescored).toBe(0);
    const outcome = findToolOutcome(calls, 't1');
    expect(outcome).toContain('user-locked');
    const row = await loadFact(factId);
    expect(row?.importance).toBe(4); // untouched
  });

  it('rejects an out-of-range importance (forged tool input) as invalid_input, rescored stays 0', async () => {
    await db.delete(agentMemory);
    const factId = await insertFact({ fact: 'agent fact', source: 'agent', importance: 3 });

    const { client, calls } = makeScriptedClient([
      {
        // A forged/hallucinated importance outside the 1-5 schema range.
        toolCalls: [
          {
            toolCallId: 't1',
            toolName: 'set_importance',
            args: { memoryId: factId, importance: 9, reason: 'x' },
          },
        ],
      },
      {},
    ]);
    setActiveLlmClient(client);

    const result = await runMemoryCuration(db, seed.entityId, 3);

    expect(result.rescored).toBe(0);
    const outcome = findToolOutcome(calls, 't1');
    expect(outcome).toContain('error: invalid_input');
    const row = await loadFact(factId);
    expect(row?.importance).toBe(3); // untouched
  });

  it('reports "not found" for a nonexistent memory id and leaves counters at 0', async () => {
    await db.delete(agentMemory);
    // Need at least one candidate for the pass to run at all.
    await insertFact({ fact: 'unrelated agent fact', source: 'agent', importance: 3 });

    // Syntactically valid v4 UUID (passes the tool's zod .uuid() check) that
    // matches no row — exercises the repo-level "not found" branch, not the
    // schema-validation branch.
    const missingId = '11111111-1111-4111-8111-111111111111';
    const { client, calls } = makeScriptedClient([
      {
        toolCalls: [
          {
            toolCallId: 't1',
            toolName: 'set_importance',
            args: { memoryId: missingId, importance: 5, reason: 'x' },
          },
        ],
      },
      {},
    ]);
    setActiveLlmClient(client);

    const result = await runMemoryCuration(db, seed.entityId, 3);

    expect(result).toEqual({ edited: 0, archived: 0, rescored: 0, turns: 2 });
    const outcome = findToolOutcome(calls, 't1');
    expect(outcome).toContain('not found');
  });
});

// ── 8. No-op pass ────────────────────────────────────────────────────────────────
describe('runMemoryCuration — no-op pass', () => {
  it('stops on the first turn with zero tool calls and touches nothing', async () => {
    await db.delete(agentMemory);
    const factId = await insertFact({ fact: 'clean short fact', source: 'agent', importance: 3 });

    const { client } = makeScriptedClient([{}]); // no tool calls at all
    setActiveLlmClient(client);

    const result = await runMemoryCuration(db, seed.entityId, 3);

    expect(result).toEqual({ edited: 0, archived: 0, rescored: 0, turns: 1 });
    const row = await loadFact(factId);
    expect(row?.fact).toBe('clean short fact');
    expect(row?.archived).toBe(false);
    expect(row?.importance).toBe(3);
  });
});

// ── 9. renderCandidates — system prompt shape ───────────────────────────────────
describe('runMemoryCuration — candidate rendering', () => {
  it('embeds access_count= per candidate and the RE-SCORE instruction in the system prompt', async () => {
    await db.delete(agentMemory);
    await insertFact({ fact: 'a candidate fact', source: 'agent', importance: 3, accessCount: 7 });

    const { client, calls } = makeScriptedClient([{}]);
    setActiveLlmClient(client);

    await runMemoryCuration(db, seed.entityId, 3);

    expect(calls.length).toBeGreaterThanOrEqual(1);
    const system = calls[0]?.system ?? '';
    expect(system).toContain('access_count=7');
    expect(system).toContain('RE-SCORE');
  });
});
