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
import { agentMemory, agentMemoryVersions, eq } from '@nodal-agents/db';
import { mutateMemory } from '@nodal-agents/memory';
import type { RunnerDeps } from '../../deps.ts';
import {
  runMemoryCuration,
  MEMORY_CURATOR_CANDIDATE_CHARS,
} from '../../reflection/run-memory-curator.ts';

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

/**
 * `turns` is either a fixed script, or a function that writes each turn once it
 * has seen what the runner sent (the system prompt of that call) — and may act
 * on the database in between, like an owner editing a fact while the pass
 * thinks.
 */
type Script =
  | ScriptedTurn[]
  | ((i: number, call: CapturedCall) => ScriptedTurn | Promise<ScriptedTurn>);

function makeScriptedClient(turns: Script): {
  client: RunnerDeps['llmClient'];
  calls: CapturedCall[];
} {
  let i = 0;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const t =
        typeof turns === 'function'
          ? await turns(i, calls[calls.length - 1]!)
          : (turns[i] ?? turns[turns.length - 1] ?? {});
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
  it('refuses a source=manual fact: outcome says the owner wrote it, rescored stays 0', async () => {
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
    expect(outcome).toContain('was written by the owner');
    expect(outcome).toContain('only the owner changes it');
    const row = await loadFact(factId);
    expect(row?.importance).toBe(3); // untouched
  });

  it('refuses an importance_locked fact: outcome says the owner pinned it, rescored stays 0', async () => {
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
    expect(outcome).toContain('is pinned by the owner');
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

  it('refuses an id that was not shown (here: no such fact) and leaves counters at 0', async () => {
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
    expect(outcome).toContain('not among the facts shown to you');
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

// ── Per-turn tool-call budget (#564) ────────────────────────────────────────────
describe('runMemoryCuration — a turn over the per-turn tool-call budget runs none of its calls (#564) @cap:suivre-execution/moteur', () => {
  it('51 archive_memory calls in one turn: the pass is refused, the fact stays live', async () => {
    await db.delete(agentMemory);
    const factId = await insertFact({ fact: 'a fact to keep', source: 'agent', importance: 1 });

    const { client } = makeScriptedClient([
      {
        toolCalls: Array.from({ length: 51 }, (_, i) => ({
          toolCallId: `ob${i}`,
          toolName: 'archive_memory',
          args: { memoryId: factId },
        })),
      },
      {},
    ]);
    setActiveLlmClient(client);

    await expect(runMemoryCuration(db, seed.entityId, 3)).rejects.toThrow(
      'tool_call_limit_exceeded: 51 > 50',
    );
    const row = await loadFact(factId);
    expect(row?.archived).toBe(false);
  });
});

// ── A pass changes only what it was shown in full, keeps the previous text, and
//    leaves the owner's marks alone (#1144) ─────────────────────────────────────

async function versionsOf(id: string) {
  return db
    .select()
    .from(agentMemoryVersions)
    .where(eq(agentMemoryVersions.memoryId, id))
    .orderBy(agentMemoryVersions.version);
}

function rowState(r: Awaited<ReturnType<typeof loadFact>>) {
  return r
    ? {
        fact: r.fact,
        importance: r.importance,
        importanceLocked: r.importanceLocked,
        archived: r.archived,
        validTo: r.validTo,
        version: r.version,
      }
    : null;
}

describe('runMemoryCuration — a long fact is shown whole, and a rewrite of it can be undone (#1144) @cap:se-souvenir/moteur', () => {
  it('600 characters: the pass sees the whole text; after its edit the exact original is kept and comes back', async () => {
    await db.delete(agentMemoryVersions);
    await db.delete(agentMemory);
    const original =
      'Release checklist. '.repeat(30) + 'Decisive last line: the rollback window is 17 minutes.';
    expect(original.length).toBeGreaterThan(580);
    const factId = await insertFact({ fact: original, source: 'agent', importance: 4 });

    // The fake model asks for exactly what the old first instruction asked for:
    // distill the oversized fact to its key statement.
    const { client, calls } = makeScriptedClient([
      {
        toolCalls: [
          {
            toolCallId: 'd1',
            toolName: 'edit_memory',
            args: { memoryId: factId, fact: 'Release checklist: see the workspace file.' },
          },
        ],
      },
      {},
    ]);
    setActiveLlmClient(client);

    const result = await runMemoryCuration(db, seed.entityId, 3);

    const system = calls[0]?.system ?? '';
    expect(system).toContain(original);
    expect(system).not.toContain('OVERSIZED');
    expect(system).not.toMatch(/DISTILL/i);
    expect(result.edited).toBe(1);

    const versions = await versionsOf(factId);
    expect(versions.map((v) => [v.version, v.changedBy, v.action, v.fact])).toEqual([
      [1, 'curator', 'edit', original],
    ]);

    const back = await mutateMemory(db, {
      entityId: seed.entityId,
      memoryId: factId,
      readVersion: 2,
      actor: { kind: 'owner' },
      change: { kind: 'revert', versionId: versions[0]!.id },
    });
    expect(back.ok).toBe(true);
    expect((await loadFact(factId))?.fact).toBe(original);
  });

  it('a fact left out of the pass for size is not shown, and the pass cannot change it', async () => {
    await db.delete(agentMemoryVersions);
    await db.delete(agentMemory);
    const ids: string[] = [];
    const facts = new Map<string, string>();
    const count = Math.ceil(MEMORY_CURATOR_CANDIDATE_CHARS / 4800) + 1;
    for (let n = 0; n < count; n += 1) {
      const fact = (`Fact ${n}: ` + `${n} long procedure step. `.repeat(400)).slice(0, 4800);
      const id = await insertFact({ fact, source: 'agent', importance: 3 });
      ids.push(id);
      facts.set(id, fact);
    }

    let hidden: string | undefined;
    const { client, calls } = makeScriptedClient((i, call) => {
      if (i > 0) return {};
      hidden = ids.find((id) => !(call.system ?? '').includes(`id=${id}`));
      return {
        toolCalls: [
          { toolCallId: 'h1', toolName: 'edit_memory', args: { memoryId: hidden, fact: 'short' } },
          { toolCallId: 'h2', toolName: 'archive_memory', args: { memoryId: hidden } },
        ],
      };
    });
    setActiveLlmClient(client);

    const result = await runMemoryCuration(db, seed.entityId, 3);

    expect(hidden).toBeDefined();
    expect(calls[0]?.system ?? '').not.toContain(facts.get(hidden!)!);
    expect(result).toMatchObject({ edited: 0, archived: 0 });
    expect(findToolOutcome(calls, 'h1')).toContain('not among the facts shown to you');
    expect(findToolOutcome(calls, 'h2')).toContain('not among the facts shown to you');
    const row = await loadFact(hidden!);
    expect([row?.fact, row?.archived, row?.version]).toEqual([facts.get(hidden!), false, 1]);
  });
});

describe("runMemoryCuration — every curator tool leaves the owner's facts untouched (#1144) @cap:se-souvenir/moteur", () => {
  it('a pinned agent fact and an owner-written fact: edit, archive and re-score are refused, rows byte-identical', async () => {
    await db.delete(agentMemoryVersions);
    await db.delete(agentMemory);
    const pinned = await insertFact({
      fact: 'Invoices for this client go to the accounts address.',
      source: 'agent',
      importance: 5,
      importanceLocked: true,
    });
    const manual = await insertFact({
      fact: 'The operator is based in the head office.',
      source: 'manual',
      importance: 3,
    });
    const before = {
      pinned: rowState(await loadFact(pinned)),
      manual: rowState(await loadFact(manual)),
    };

    const toolCalls = [pinned, manual].flatMap((id, k) => [
      { toolCallId: `e${k}`, toolName: 'edit_memory', args: { memoryId: id, fact: 'merged' } },
      { toolCallId: `a${k}`, toolName: 'archive_memory', args: { memoryId: id } },
      {
        toolCallId: `s${k}`,
        toolName: 'set_importance',
        args: { memoryId: id, importance: 1, reason: 'never used' },
      },
    ]);
    const { client, calls } = makeScriptedClient([{ toolCalls }, {}]);
    setActiveLlmClient(client);

    const result = await runMemoryCuration(db, seed.entityId, 3);

    expect(result).toMatchObject({ edited: 0, archived: 0, rescored: 0 });
    for (const tc of toolCalls) {
      const outcome = findToolOutcome(calls, tc.toolCallId) ?? '';
      expect(outcome).toContain('only the owner changes it');
      expect(outcome).toContain('do not retry');
    }
    // The candidates say which facts are the owner's, so the model can skip them.
    expect(calls[0]?.system ?? '').toMatch(new RegExp(`id=${pinned}[^\\n]*protected=pinned`));
    expect(calls[0]?.system ?? '').toMatch(new RegExp(`id=${manual}[^\\n]*protected=owner`));
    expect(rowState(await loadFact(pinned))).toEqual(before.pinned);
    expect(rowState(await loadFact(manual))).toEqual(before.manual);
    expect(await versionsOf(pinned)).toEqual([]);
    expect(await versionsOf(manual)).toEqual([]);
  });
});

describe('runMemoryCuration — a fact the owner changed while the pass was thinking is not overwritten (#1144) @cap:se-souvenir/moteur', () => {
  it('the curator edit prepared on the version it read is refused; the owner text stays', async () => {
    await db.delete(agentMemoryVersions);
    await db.delete(agentMemory);
    const factId = await insertFact({
      fact: 'The weekly report goes out on Monday.',
      source: 'agent',
      importance: 3,
    });
    const ownerText = 'The weekly report goes out on Tuesday since the team moved.';

    const { client, calls } = makeScriptedClient(async (i) => {
      if (i > 0) return {};
      // The owner edits the fact between the pass's read and its tool call.
      const r = await mutateMemory(db, {
        entityId: seed.entityId,
        memoryId: factId,
        readVersion: 1,
        actor: { kind: 'owner' },
        change: { kind: 'edit', fact: ownerText },
      });
      expect(r.ok).toBe(true);
      return {
        toolCalls: [
          {
            toolCallId: 'x1',
            toolName: 'edit_memory',
            args: { memoryId: factId, fact: 'Weekly report: Monday.' },
          },
          { toolCallId: 'x2', toolName: 'archive_memory', args: { memoryId: factId } },
        ],
      };
    });
    setActiveLlmClient(client);

    const result = await runMemoryCuration(db, seed.entityId, 3);

    expect(result).toMatchObject({ edited: 0, archived: 0 });
    expect(findToolOutcome(calls, 'x1')).toContain('changed since it was read');
    expect(findToolOutcome(calls, 'x2')).toContain('changed since it was read');
    const row = await loadFact(factId);
    expect([row?.fact, row?.archived, row?.version]).toEqual([ownerText, false, 2]);
  });
});
