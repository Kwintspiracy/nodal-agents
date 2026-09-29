// turn-one-tool-choice.test.ts — the model decides whether to call a tool, on
// every turn, for every model (#600).
//
// Turn 1 used to force `tool_choice: 'required'` for an orchestrator and for a
// worker holding more than the always-on tools, unless the model's catalog
// entry said `forcedToolChoice: false`. Every degenerate turn on record was one
// of those forced turns (xiaomi/mimo-v2.6-pro: 64, 307 and 546 tool calls in a
// single response, and one cut at 65,536 output tokens); the same model on
// 'auto' never produced one. The mechanism is gone, not extended.
//
// Proven here on the REAL path: executeJob, a real test database, the REAL
// LLM client built from the agent's key (no createLlmClient mock), and the
// HTTP body read at the fetch boundary — what the provider actually receives.
// Several catalog models, formerly forced and formerly not, and both roles
// that used to be forced.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { _setMasterKeyForTests, encrypt } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agents,
  agentSkills,
  agentSkillAssignments,
  entityLlmKeys,
} from '@nodal-agents/db';
import { ALWAYS_ON_TOOLS, createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import { executeJob } from '../../job/execute.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let openrouterKeyId: string;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
  const [key] = await db
    .insert(entityLlmKeys)
    .values({
      entityId: seed.entityId,
      provider: 'openrouter',
      apiKey: encrypt('or-test-key'),
      baseUrl: null,
      nickname: 'OpenRouter (test)',
      isActive: true,
    })
    .returning();
  if (!key) throw new Error('failed to seed the openrouter key');
  openrouterKeyId = key.id;
});

// Provider calls leave through packages/llm's own transport (#608), not the
// global fetch. Routed back to it here, so the stub below is still the fetch
// boundary and nothing leaves the machine.
vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Stub the network: every chat completion is recorded as the provider would
 * receive it, and answered with a plain text reply (streamed as SSE or as one
 * JSON body, whichever the client asked for).
 */
function captureProviderBodies(): Array<Record<string, unknown>> {
  const bodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/chat/completions')) {
        throw new Error(`turn-one-tool-choice.test: unexpected fetch ${url}`);
      }
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      bodies.push(body);
      const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
      if (body['stream'] === true) {
        const chunks = [
          { id: 'c', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' } }] },
          { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
        ];
        const sse =
          chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(
        JSON.stringify({
          id: 'c',
          choices: [{ message: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
          usage,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  return bodies;
}

function makeDeps(): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  return {
    db: db as RunnerDeps['db'],
    // Never read at runtime: the job resolves its client from the agent's key.
    llmClient: undefined as unknown as RunnerDeps['llmClient'],
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

async function runFirstTurn(opts: {
  model: string;
  role: 'orchestrator' | 'agent';
}): Promise<{ bodies: Array<Record<string, unknown>> }> {
  const [agent] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: `Agent ${opts.model}`,
      slug: `agent-${randomUUID().slice(0, 8)}`,
      personality: 'You are a test agent.',
      role: opts.role,
      llmKeyId: openrouterKeyId,
      model: opts.model,
    })
    .returning();
  if (!agent) throw new Error('failed to seed the agent');
  if (opts.role === 'agent') {
    // A skill that brings a tool beyond the always-on set: the worker that
    // turn 1 used to force ("has adapter tools" counted exactly that).
    const [skill] = await db
      .insert(agentSkills)
      .values({
        entityId: seed.entityId,
        name: `Commands ${agent.slug}`,
        slug: `commands-${agent.slug}`,
        content: 'run commands',
        requiredBuiltins: ['run_command'],
      })
      .returning();
    if (!skill) throw new Error('failed to seed the skill');
    await db
      .insert(agentSkillAssignments)
      .values({ entityId: seed.entityId, agentId: agent.id, skillId: skill.id });
  }
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: agent.id,
      channel: 'api',
      task: 'What is 2 + 2?',
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning();
  if (!job) throw new Error('failed to seed the job');

  const bodies = captureProviderBodies();
  await executeJob(job.id as JobId, makeDeps());
  return { bodies };
}

// Two models the catalog used to force on turn 1 (the one of the incident, and
// a GPT one — the family the forcing was written for), and one it never forced.
const MODELS = ['xiaomi/mimo-v2.6-pro', 'openai/gpt-5.6-sol', 'z-ai/glm-5.3'] as const;

describe('turn 1 leaves the tool choice to the model @cap:choisir-modele/moteur', () => {
  for (const model of MODELS) {
    it(`orchestrator on ${model}: every request, turn 1 included, carries tool_choice 'auto'`, async () => {
      const { bodies } = await runFirstTurn({ model, role: 'orchestrator' });

      expect(bodies.length).toBeGreaterThan(0);
      const first = bodies[0]!;
      expect(first['model']).toBe(model);
      // Tools are offered, so the choice is the model's to make.
      expect(Array.isArray(first['tools']) && (first['tools'] as unknown[]).length).toBeGreaterThan(
        0,
      );
      expect(bodies.map((b) => b['tool_choice'])).toEqual(bodies.map(() => 'auto'));
    });

    it(`worker holding more than the always-on tools on ${model}: turn 1 carries tool_choice 'auto'`, async () => {
      const { bodies } = await runFirstTurn({ model, role: 'agent' });

      expect(bodies.length).toBeGreaterThan(0);
      const first = bodies[0]!;
      expect(first['model']).toBe(model);
      const offered = (first['tools'] as Array<{ function: { name: string } }>).map(
        (t) => t.function.name,
      );
      // The scenario that used to force: tools beyond the always-on set.
      expect(offered.some((n) => !(ALWAYS_ON_TOOLS as readonly string[]).includes(n))).toBe(true);
      expect(bodies.map((b) => b['tool_choice'])).toEqual(bodies.map(() => 'auto'));
    });
  }
});
