// tool-loading.test.ts — a job sends the schemas of its eager tools, then of the
// tools it loads, and can call every tool of its whitelist at every turn (#612).
//
// Proven on the REAL path: executeJob, a real test database, the REAL LLM
// client built from the agent's key, and the HTTP body read at the fetch
// boundary — what the provider actually receives. The model is scripted: each
// request is answered with the next scripted reply (tool calls or text).
//
// What is proven, for more than the ticket's scenario:
//   - the first request carries the eager schemas and `load_tools`, and NOT a
//     deferred tool the job holds; the prompt names that tool in its index;
//   - after `load_tools`, the next request carries its schema, appended AFTER
//     the list sent before (the prefix does not move);
//   - a direct call to a deferred tool of the whitelist runs — builtin
//     (`list_schedules`) and meta-tool (`create_schedule`, a DB row) — and its
//     schema is sent from then on;
//   - a tool outside the whitelist stays refused, directly and via load_tools;
//   - for an orchestrator and a worker, on two models.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { _setMasterKeyForTests, encrypt } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, agents, agentSchedules, entities, entityLlmKeys, eq } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import { executeJob } from '../../job/execute.ts';

let db: TestDb;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  const result = await spinUpTestDb();
  db = result.db;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type ScriptedCall = { name: string; args: Record<string, unknown> };
type ScriptedReply = { calls: ScriptedCall[] } | { text: string };
type Body = {
  model: string;
  stream?: boolean;
  tools?: Array<{ function: { name: string } }>;
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
};

/**
 * Stub the network: every chat completion is recorded as the provider receives
 * it, and answered with the next scripted reply (then "Done." once the script
 * is spent), streamed as SSE or as one JSON body, whichever was asked.
 */
function scriptProvider(script: ScriptedReply[]): Body[] {
  const bodies: Body[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/chat/completions')) {
        throw new Error(`tool-loading.test: unexpected fetch ${url}`);
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

/**
 * One workspace, one agent, one job, run to its end against the script.
 * `root` makes the agent the workspace's root, with the schedule grant and a
 * fully autonomous workspace (no approval card on create_schedule).
 */
async function runJob(opts: {
  model: string;
  role: 'orchestrator' | 'agent';
  root?: boolean;
  /** The replies, or a function of the agent's slug that returns them. */
  script: ScriptedReply[] | ((agentSlug: string) => ScriptedReply[]);
}): Promise<{ bodies: Body[]; jobId: string; entityId: string }> {
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
        rootGrants: { manageSchedules: true, autonomy: 'fully_autonomous' },
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

  const bodies = scriptProvider(
    typeof opts.script === 'function' ? opts.script(agent.slug) : opts.script,
  );
  await executeJob(job.id as JobId, makeDeps());
  return { bodies, jobId: job.id, entityId: seed.entityId };
}

const offered = (b: Body): string[] => (b.tools ?? []).map((t) => t.function.name);
const systemOf = (b: Body): string => {
  const sys = b.messages.find((m) => m.role === 'system');
  return typeof sys?.content === 'string' ? sys.content : JSON.stringify(sys?.content ?? '');
};
/** Every tool result the request carries, as text. */
const toolResults = (b: Body): string[] =>
  b.messages
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));

/** The last tool result of the request, parsed: what the tool returned. */
const lastResult = (b: Body): unknown => JSON.parse(toolResults(b).at(-1) ?? 'null');

async function jobRow(jobId: string) {
  const [row] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId));
  if (!row) throw new Error('job row vanished');
  return row;
}

const MODELS = ['openai/gpt-5.6-sol', 'xiaomi/mimo-v2.6-pro'] as const;
const ROLES = ['orchestrator', 'agent'] as const;

describe('a job reads the schemas it needs and keeps its whole whitelist @cap:assigner-outils/moteur', () => {
  for (const model of MODELS) {
    for (const role of ROLES) {
      it(`${role} on ${model}: eager schemas first, a loaded schema appended after load_tools`, async () => {
        const { bodies, jobId } = await runJob({
          model,
          role,
          script: [
            { calls: [{ name: 'load_tools', args: { names: ['list_schedules'] } }] },
            { calls: [{ name: 'list_schedules', args: {} }] },
          ],
        });

        expect(bodies.length).toBeGreaterThanOrEqual(3);
        const [first, second, third] = bodies as [Body, Body, Body];

        // Turn 1: the eager schemas and the loader — not the deferred tool.
        expect(offered(first)).toContain('return_result');
        expect(offered(first)).toContain('load_tools');
        expect(offered(first)).not.toContain('list_schedules');
        // …which the prompt names in its index, in place of the old list.
        expect(systemOf(first)).toContain('## Tools on demand');
        expect(systemOf(first)).toContain('- `list_schedules`: ');
        expect(systemOf(first)).not.toContain('## Built-in capabilities');

        // Turn 2: the loaded schema is appended; what was sent before is untouched.
        expect(offered(second)).toEqual([...offered(first), 'list_schedules']);
        expect(lastResult(second)).toMatchObject({ loaded: ['list_schedules'], notHeld: [] });

        // Turn 3: the call ran and returned its real output.
        const listed = toolResults(third).at(-1) ?? '';
        expect(listed).toContain('"schedules"');
        expect(listed).not.toMatch(/unavailable|not available/i);
        expect(offered(third)).toEqual(offered(second));

        // The whole whitelist is still recorded for the job, loader included.
        const row = await jobRow(jobId);
        expect(row.systemPromptTools).toEqual(
          expect.arrayContaining(['list_schedules', 'load_tools', 'return_result']),
        );
        expect(row.error ?? '').not.toMatch(/whitelist_violation/);
      });
    }
  }

  it('a direct call to a deferred tool of the whitelist runs, without load_tools first', async () => {
    const { bodies, jobId } = await runJob({
      model: 'xiaomi/mimo-v2.6-pro',
      role: 'orchestrator',
      script: [{ calls: [{ name: 'list_schedules', args: {} }] }],
    });

    const [first, second] = bodies as [Body, Body];
    expect(offered(first)).not.toContain('list_schedules');
    const result = toolResults(second).at(-1) ?? '';
    expect(result).toContain('"schedules"');
    expect(result).not.toMatch(/unavailable|not available/i);
    // Called once, sent from then on: the transcript names it.
    expect(offered(second)).toEqual([...offered(first), 'list_schedules']);
    expect((await jobRow(jobId)).error ?? '').not.toMatch(/whitelist_violation/);
  });

  it("the root's first direct create_schedule, a deferred meta-tool, creates the schedule", async () => {
    const { bodies, jobId, entityId } = await runJob({
      model: 'openai/gpt-5.6-sol',
      role: 'orchestrator',
      root: true,
      script: (agentSlug) => [
        {
          calls: [
            {
              name: 'create_schedule',
              args: {
                agentSlug,
                name: 'Morning digest',
                atTimes: ['09:00'],
                task: 'Send the morning digest.',
                purpose: 'The owner asked for a daily digest at 9.',
              },
            },
          ],
        },
      ],
    });

    const [first] = bodies as [Body];
    expect(offered(first)).not.toContain('create_schedule');
    expect(systemOf(first)).toContain('- `create_schedule`: ');

    const row = await jobRow(jobId);
    expect(row.error ?? '').not.toMatch(/whitelist_violation/);
    const schedules = await db
      .select()
      .from(agentSchedules)
      .where(eq(agentSchedules.entityId, entityId));
    expect(schedules.map((s) => s.name)).toEqual(['Morning digest']);
  });

  it('a direct call with guessed arguments gets a readable tool error, and the schema from then on', async () => {
    const { bodies, jobId, entityId } = await runJob({
      model: 'openai/gpt-5.6-sol',
      role: 'orchestrator',
      root: true,
      script: [{ calls: [{ name: 'create_schedule', args: { when: 'tomorrow' } }] }],
    });

    const [first, second] = bodies as [Body, Body];
    expect(offered(first)).not.toContain('create_schedule');
    // The call reached the tool, which said what is wrong with its input…
    const result = toolResults(second).at(-1) ?? '';
    expect(result).toContain('invalid_input');
    expect(result).toContain('agentSlug');
    expect(result).not.toContain('is not available to you');
    // …and the model now reads the schema it lacked.
    expect(offered(second)).toEqual([...offered(first), 'create_schedule']);
    expect((await jobRow(jobId)).error ?? '').not.toMatch(/whitelist_violation/);
    const schedules = await db
      .select()
      .from(agentSchedules)
      .where(eq(agentSchedules.entityId, entityId));
    expect(schedules).toEqual([]);
  });

  it('a tool outside the whitelist stays refused, called directly or through load_tools', async () => {
    const { bodies, jobId } = await runJob({
      model: 'openai/gpt-5.6-sol',
      role: 'orchestrator',
      script: [
        { calls: [{ name: 'load_tools', args: { names: ['run_command'] } }] },
        { calls: [{ name: 'run_command', args: { command: 'echo hi' } }] },
      ],
    });

    const [first, second, third] = bodies as [Body, Body, Body];
    expect(systemOf(first)).not.toContain('`run_command`');
    // load_tools loads nothing it does not hold…
    expect(lastResult(second)).toMatchObject({ loaded: [], notHeld: ['run_command'] });
    expect(offered(second)).toEqual(offered(first));
    // …and the direct call is answered as unavailable, never run.
    expect(toolResults(third).at(-1) ?? '').toContain(
      'The tool \\"run_command\\" is not available to you.',
    );
    expect(offered(third)).not.toContain('run_command');
    // Never run, never offered for approval either.
    const row = await jobRow(jobId);
    expect(row.status).not.toBe('awaiting_approval');
  });
});
