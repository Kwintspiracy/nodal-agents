// tool-loading-harness.ts — the real path of a job against a scripted provider,
// shared by the tool-loading suites (#612).
//
// executeJob, a real test database, the REAL LLM client built from the agent's
// OpenRouter key, and `fetch` stubbed at the network boundary: every request is
// recorded as the provider receives it and answered with the next scripted
// reply. A script spans every run of a job (a suspension and its resume read
// the same list of replies).
//
// Since #609 provider calls leave through `providerFetch` (packages/llm/src/
// transport.ts), not the global fetch: every suite using this harness routes
// it back to `globalThis.fetch` with its own `vi.mock` (hoisted per test file),
// or the stub is never called and the real network can be reached.

import { vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { encrypt } from '@nodal-agents/secrets';
import { seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, agents, entities, entityLlmKeys, eq } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

export type ScriptedCall = { name: string; args: Record<string, unknown> };
export type ScriptedReply = { calls: ScriptedCall[] } | { text: string };
export type Body = {
  model: string;
  stream?: boolean;
  tools?: Array<{ function: { name: string } }>;
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
};

export const testEnv: RunnerEnv = {
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

/**
 * Stub the network: every chat completion is recorded as the provider receives
 * it, and answered with the next scripted reply (then "Done." once the script
 * is spent), streamed as SSE or as one JSON body, whichever was asked.
 */
export function scriptProvider(script: ScriptedReply[]): Body[] {
  const bodies: Body[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/chat/completions')) {
        throw new Error(`tool-loading harness: unexpected fetch ${url}`);
      }
      const body = JSON.parse(init?.body as string) as Body;
      bodies.push(body);
      const reply = script[bodies.length - 1] ?? { text: 'Done.' };
      const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
      const toolCalls =
        'calls' in reply
          ? reply.calls.map((c, i) => ({
              index: i,
              id: `call_${bodies.length}_${i}`,
              type: 'function',
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            }))
          : undefined;
      const finish = toolCalls ? 'tool_calls' : 'stop';
      if (body.stream === true) {
        const delta = toolCalls
          ? { role: 'assistant', tool_calls: toolCalls }
          : { role: 'assistant', content: (reply as { text: string }).text };
        const chunks = [
          { id: 'c', choices: [{ index: 0, delta }] },
          { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage },
        ];
        const sse =
          chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      const message = toolCalls
        ? {
            role: 'assistant',
            content: null,
            tool_calls: toolCalls.map(({ index: _i, ...rest }) => rest),
          }
        : { role: 'assistant', content: (reply as { text: string }).text };
      return new Response(
        JSON.stringify({ id: 'c', choices: [{ message, finish_reason: finish }], usage }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  return bodies;
}

export function makeDeps(db: TestDb): RunnerDeps {
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

/**
 * One workspace, one agent, one pending job. `root` makes the agent the
 * workspace's root with the schedule grant; `autonomy` is the workspace's
 * level (fully autonomous by default: no approval card on create_schedule).
 */
export async function seedJob(
  db: TestDb,
  opts: {
    model: string;
    role: 'orchestrator' | 'agent';
    root?: boolean;
    autonomy?: 'fully_autonomous' | 'propose_confirm';
  },
): Promise<{ jobId: string; entityId: string; agentId: string; agentSlug: string; keyId: string }> {
  const seed = await seedMinimal(db);
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
  const [agent] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: `Agent ${randomUUID().slice(0, 6)}`,
      slug: `agent-${randomUUID().slice(0, 8)}`,
      personality: 'You are a test agent.',
      role: opts.role,
      llmKeyId: key.id,
      model: opts.model,
    })
    .returning();
  if (!agent) throw new Error('failed to seed the agent');
  if (opts.root) {
    await db
      .update(entities)
      .set({
        rootAgentId: agent.id,
        rootGrants: { manageSchedules: true, autonomy: opts.autonomy ?? 'fully_autonomous' },
      })
      .where(eq(entities.id, seed.entityId));
  }
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: agent.id,
      channel: 'api',
      task: 'Do the thing.',
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning();
  if (!job) throw new Error('failed to seed the job');
  return {
    jobId: job.id,
    entityId: seed.entityId,
    agentId: agent.id,
    agentSlug: agent.slug,
    keyId: key.id,
  };
}

/** The schemas a request carries, in order. */
export const offered = (b: Body): string[] => (b.tools ?? []).map((t) => t.function.name);

export const systemOf = (b: Body): string => {
  const sys = b.messages.find((m) => m.role === 'system');
  return typeof sys?.content === 'string' ? sys.content : JSON.stringify(sys?.content ?? '');
};

/** Every tool result the request carries, as text. */
export const toolResults = (b: Body): string[] =>
  b.messages
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));

/** The last tool result of the request, parsed: what the tool returned. */
export const lastResult = (b: Body): unknown => JSON.parse(toolResults(b).at(-1) ?? 'null');

/** The text of the request's last message. */
export const lastMessageText = (b: Body): string => {
  const c = b.messages.at(-1)?.content;
  return typeof c === 'string' ? c : JSON.stringify(c ?? '');
};

export async function jobRow(db: TestDb, jobId: string) {
  const [row] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId));
  if (!row) throw new Error('job row vanished');
  return row;
}
