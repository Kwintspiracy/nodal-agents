// call-sink.test.ts — the llm_calls sink (étape D): real pglite rows, real
// assertions (invariant 5) — effective model, failover flag, cost fallback,
// tools hash, and the never-throw contract.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { llmCalls, eq, type AnyDrizzleDb } from '@nodal-agents/db';
import { buildLlmCallObservation } from '@nodal-agents/llm';
import { makeLlmCallSink, hashToolNames } from '../../llm/call-sink.ts';

let db: AnyDrizzleDb;
let seed: { entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db as unknown as AnyDrizzleDb;
  seed = await seedMinimal(res.db);
});

const flush = () => new Promise((r) => setTimeout(r, 50));

describe('makeLlmCallSink', () => {
  it('writes a full row: reported model wins, failover from chainIndex, provider cost kept', async () => {
    const sink = makeLlmCallSink(db, {
      source: 'job',
      entityId: seed.entityId,
      agentId: seed.agentId,
      getJobId: () => seed.jobId,
      getTurn: () => 7,
    });
    sink(
      buildLlmCallObservation({
        kind: 'generateText',
        provider: 'openrouter',
        modelConfigured: 'deepseek/deepseek-v4-pro',
        reasoningEffort: 'medium',
        callArgs: { toolChoice: 'auto', tools: { b_tool: {}, a_tool: {} } },
        result: {
          usage: { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 300 },
          providerMetadata: { openrouter: { usage: { cost: 0.004 } } },
          response: { modelId: 'deepseek/deepseek-v4-pro:free' },
        },
        error: null,
        durationMs: 3000,
        meta: { keyId: null, modelRequested: 'deepseek/deepseek-v4-pro', chainIndex: 2 },
      }),
    );
    await flush();

    const rows = await db.select().from(llmCalls).where(eq(llmCalls.jobId, seed.jobId));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.source).toBe('job');
    expect(row.turn).toBe(7);
    expect(row.modelRequested).toBe('deepseek/deepseek-v4-pro');
    expect(row.modelEffective).toBe('deepseek/deepseek-v4-pro:free'); // reported wins
    expect(row.provider).toBe('openrouter');
    expect(row.reasoningEffort).toBe('medium');
    expect(row.toolChoice).toBe('auto');
    expect(row.toolNames).toEqual(['b_tool', 'a_tool']);
    expect(row.toolsHash).toBe(hashToolNames(['a_tool', 'b_tool'])); // sorted → order-insensitive
    expect(row.inputTokens).toBe(1000);
    expect(row.outputTokens).toBe(200);
    expect(row.cachedTokens).toBe(300);
    // OpenRouter reports no cache-write metadata — NULL in the row, never 0.
    expect(row.cacheCreationTokens).toBeNull();
    expect(row.costUsd).toBeCloseTo(0.004, 6);
    expect(row.failover).toBe(true); // chainIndex 2 > 0
    expect(row.error).toBeNull();
  });

  it('persists Anthropic cache WRITES from providerMetadata into cache_creation_tokens', async () => {
    const sink = makeLlmCallSink(db, {
      source: 'cron',
      entityId: seed.entityId,
      agentId: seed.agentId,
    });
    sink(
      buildLlmCallObservation({
        kind: 'generateText',
        provider: 'anthropic',
        modelConfigured: 'claude-sonnet-5',
        reasoningEffort: null,
        callArgs: {},
        result: {
          usage: { inputTokens: 20500, outputTokens: 50, cachedInputTokens: 0 },
          providerMetadata: { anthropic: { cacheCreationInputTokens: 20000 } },
        },
        error: null,
        durationMs: 700,
        meta: {},
      }),
    );
    await flush();

    const rows = await db.select().from(llmCalls).where(eq(llmCalls.provider, 'anthropic'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inputTokens).toBe(20500);
    expect(rows[0]!.cachedTokens).toBe(0);
    expect(rows[0]!.cacheCreationTokens).toBe(20000);
  });

  it('writes the ERROR attempt too (the failed primary of a failover pair)', async () => {
    const sink = makeLlmCallSink(db, { source: 'chat', entityId: seed.entityId });
    sink(
      buildLlmCallObservation({
        kind: 'generateText',
        provider: 'openrouter',
        modelConfigured: 'z-ai/glm-5.2',
        reasoningEffort: null,
        callArgs: {},
        result: null,
        error: new Error('Too Many Requests'),
        durationMs: 12_000,
        meta: { chainIndex: 0 },
      }),
    );
    await flush();

    const rows = await db.select().from(llmCalls).where(eq(llmCalls.source, 'chat'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error).toBe('Error: Too Many Requests');
    expect(rows[0]!.failover).toBe(false);
    expect(rows[0]!.modelEffective).toBe('z-ai/glm-5.2'); // configured — nothing reported
    expect(rows[0]!.costUsd).toBeNull(); // no usage, no estimate, never 0-guessed
  });

  it('unknown-pricing estimate stays NULL, not a misleading 0', async () => {
    const sink = makeLlmCallSink(db, { source: 'curator', entityId: seed.entityId });
    sink(
      buildLlmCallObservation({
        kind: 'generateObject',
        provider: 'lm-studio',
        modelConfigured: 'totally-local-model',
        reasoningEffort: null,
        callArgs: {},
        result: { usage: { inputTokens: 50, outputTokens: 10 } },
        error: null,
        durationMs: 100,
        meta: {},
      }),
    );
    await flush();
    const rows = await db.select().from(llmCalls).where(eq(llmCalls.source, 'curator'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.costUsd).toBeNull();
    expect(rows[0]!.inputTokens).toBe(50);
  });
});
