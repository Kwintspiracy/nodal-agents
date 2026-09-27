// max-depth-no-delegation.test.ts — a job at the maximum delegation depth is
// given no way to delegate, and is told so (#473, Codex review pass 3).
//
// Both guards refused a delegation at the maximum depth (assign_* in
// execute.ts, create_task in task-tools.ts), yet the prompt still announced
// "TWO ways to delegate" and the tools were still sent. Case: Reviewer at
// depth 3, with Worker as its child. One rule, remainingDelegationHops, now
// decides the whitelist AND the team block. Asserted on the real LLM request.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import { agentJobs, agents, agentAssignments } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import type { JobId } from '@nodal-agents/orchestration';
import { DEFAULT_LIMITS } from '@nodal-agents/orchestration';

const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let active: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => active,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      active = c;
    },
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('max-depth-no-delegation.test: no active LLM client');
      return active;
    },
  };
});

interface Captured {
  system: string;
  tools: Array<{ name: string; description?: string }>;
}

function scriptedClient(
  calls: Array<Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>>,
  captured: Captured[],
): RunnerDeps['llmClient'] {
  let i = 0;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async (options) => {
      const prompt = options.prompt as Array<{ role: string; content: unknown }>;
      captured.push({
        system: prompt
          .filter((m) => m.role === 'system')
          .map((m) => String(m.content))
          .join('\n'),
        tools: ((options.tools ?? []) as Array<{ name: string; description?: string }>).map(
          (t) => ({ name: t.name, description: t.description }),
        ),
      });
      const step = calls[i] ?? calls[calls.length - 1]!;
      i++;
      return {
        content: step.map((c) => ({
          type: 'tool-call' as const,
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          input: JSON.stringify(c.args),
        })),
        finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return {
    config: { provider: 'anthropic', model: 'mock' },
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) =>
      generateText({ ...args, model } as Parameters<typeof generateText>[0]) as ReturnType<
        RunnerDeps['llmClient']['generateText']
      >,
    streamText: () => {
      throw new Error('streamText not supported in mock');
    },
    generateObject: () => {
      throw new Error('generateObject not supported in mock');
    },
  };
}

const testEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'mock',
  LLM_API_KEY: 'test-key',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'local-trust',
  WORKER_SECRET: 'test-secret',
  BEARER_TOKEN: undefined,
  PORT: 3099,
  BIND: '127.0.0.1',
  APP_URL: 'http://localhost:3099',
  NODE_ENV: 'test',
  REFLECTION_ENABLED: 'false',
  REFLECTION_MAX_PER_HOUR: 6,
  REFLECTION_MAX_TURNS: 3,
  CURATOR_STALE_DAYS: 30,
  CURATOR_ARCHIVE_DAYS: 90,
  CURATOR_MIN_SKILLS: 5,
  CURATOR_INTERVAL_DAYS: 7,
  CURATOR_MAX_TURNS: 4,
  CURATOR_MEMORY_STALE_DAYS: 60,
  CURATOR_MEMORY_IMPORTANCE_MAX: 2,
  CURATOR_MEMORY_MIN: 8,
  MEMORY_CURATION_ENABLED: '',
  RETENTION_DAYS: 0,
  SKILL_UPDATE_CHECK_INTERVAL_HOURS: 24,
  SKILL_UPDATE_CHECK_BATCH_SIZE: 10,
  NODALAI_APPROVAL_GRACE_MS: 0,
};

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let childSlug: string;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  await db
    .update(agents)
    .set({ role: 'orchestrator', orchestratorMode: 'router', systemAgent: true })
    .where(eq(agents.id, seed.agentId));
  const [child] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Worker',
      slug: `worker-${Date.now()}`,
      personality: 'I do the work.',
      llmKeyId: seed.llmKeyId,
      role: 'agent',
      systemAgent: true,
    })
    .returning();
  childSlug = child!.slug;
  await db
    .insert(agentAssignments)
    .values({ orchestratorId: seed.agentId, subAgentId: child!.id, entityId: seed.entityId });
});

function makeDeps(llmClient: RunnerDeps['llmClient']): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  setActiveLlmClient(llmClient);
  return {
    db: db as RunnerDeps['db'],
    llmClient,
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

describe('a job at the maximum delegation depth cannot delegate, and is told so (#473) @cap:organiser-equipe/moteur', () => {
  async function runAt(depth: number): Promise<Captured> {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'review this',
        status: 'pending',
        messages: [],
        chainCount: 0,
        delegationDepth: depth,
      })
      .returning();
    const captured: Captured[] = [];
    const client = scriptedClient(
      [[{ toolCallId: `tc-rr-${depth}`, toolName: 'return_result', args: { status: 'success' } }]],
      captured,
    );
    await executeJob(job!.id as JobId, makeDeps(client), testEnv);
    return captured[0]!;
  }

  it('at depth 3: no assign_*, no create_task, no "ways to delegate"; the team is listed as facts', async () => {
    const call = await runAt(DEFAULT_LIMITS.maxDelegationDepth);
    const names = call.tools.map((t) => t.name);
    expect(names.some((n) => n.startsWith('assign_'))).toBe(false);
    expect(names).not.toContain('create_task');
    expect(call.system).not.toContain('ways to delegate');
    // Codex review of #473, pass 4: no delegation ORDER anywhere in the prompt
    // at this depth — the team block's footer said "delegate to it".
    // Every ORDER to hand work to an agent is forbidden; descriptions that
    // merely mention delegated work (the identity line, verify-before-done,
    // the code_task skill that drives a coding CLI) are not orders.
    const ORDERS: RegExp[] = [
      /\bdelegate (?:it|to it|them|to them)\b/i,
      /\bwhen you delegate\b/i,
      /ways to delegate/i,
      /\bdelegate to (?:a|an|the|that|this|another) (?:agent|teammate|specialist)\b/i,
      /reach it through/i,
      /goes only to an agent/i,
      /hand (?:it|the work) to (?:a|an|another) (?:agent|teammate|specialist)/i,
    ];
    const orders = ORDERS.filter((re) => re.test(call.system)).map(String);
    expect(orders, orders.join(' | ')).toEqual([]);
    expect(call.system).toContain('return_result');
    expect(call.system).toContain('maximum delegation depth');
    expect(call.system).toContain('**Worker**');
  });

  it('below the limit, the same orchestrator still gets both delegation routes', async () => {
    const call = await runAt(DEFAULT_LIMITS.maxDelegationDepth - 1);
    const names = call.tools.map((t) => t.name);
    expect(names).toContain(`assign_${childSlug.replace(/-/g, '_')}`);
    expect(names).toContain('create_task');
    expect(call.system).toContain('ways to delegate');
    // The patterns above do match a prompt that orders delegation: not vacuous.
    expect(call.system).toMatch(/delegate to it/);
    expect(call.system).toMatch(/when you delegate/i);
  });
});
