// prose-turn-is-final.test.ts — un tour de job qui finit en prose, sans appel
// d'outil, EST la réponse (#886). Aucune relance ne demande au modèle de relire
// son propre texte.
//
// La relance de #600 coûtait un second appel à chaque réponse finale, une
// question d'une ligne comprise, et mesurée sur un mois elle répétait des
// actions déjà faites (une revue envoyée deux fois, une demande d'impression
// recréée) bien plus souvent qu'elle n'en rattrapait une. Les gardes qui jugent
// un tour en prose lisent des faits (canal à outil, livrables déclarés, échecs
// non résolus, approbation en attente) : elles ont leurs propres tests.
//
// Prouvé ici sur le VRAI chemin : executeJob, une vraie base de test, le VRAI
// client LLM construit depuis la clé de l'agent, et les corps HTTP lus à la
// frontière du fetch, tels que le fournisseur les reçoit.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { _setMasterKeyForTests, encrypt } from '@nodal-agents/secrets';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentAssignments, agentJobs, agents, entityLlmKeys } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import { executeJob } from '../../job/execute.ts';

const MODEL = 'xiaomi/mimo-v2.6-pro';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let openrouterKeyId: string;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  ({ db } = await spinUpTestDb());
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

type Message = { role: string; content: unknown; tool_calls?: unknown };
type Body = Record<string, unknown> & { messages: Message[] };
type Reply = { text: string } | { toolCall: { name: string; args: Record<string, unknown> } };

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? (content as Array<{ text?: unknown }>)
          .map((p) => (typeof p.text === 'string' ? p.text : ''))
          .join('')
      : '';

/**
 * Le fournisseur simulé : chaque requête est gardée telle qu'il la reçoit, et
 * `answer` décide de la réponse en la lisant.
 */
function stubProvider(answer: (body: Body) => Reply): Body[] {
  const bodies: Body[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/chat/completions')) {
        throw new Error(`prose-turn-is-final.test: unexpected fetch ${url}`);
      }
      const body = JSON.parse(init?.body as string) as Body;
      bodies.push(body);
      const reply = answer(body);
      const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
      const toolCalls =
        'toolCall' in reply
          ? [
              {
                id: `call-${String(bodies.length)}`,
                type: 'function',
                function: {
                  name: reply.toolCall.name,
                  arguments: JSON.stringify(reply.toolCall.args),
                },
              },
            ]
          : null;
      const message =
        toolCalls !== null
          ? { role: 'assistant', content: null, tool_calls: toolCalls }
          : { role: 'assistant', content: (reply as { text: string }).text };
      const finish = toolCalls !== null ? 'tool_calls' : 'stop';
      if (body['stream'] === true) {
        const delta =
          toolCalls !== null
            ? { role: 'assistant', tool_calls: toolCalls.map((tc, index) => ({ index, ...tc })) }
            : message;
        const chunks = [
          { id: 'c', choices: [{ index: 0, delta }] },
          { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage },
        ];
        const sse =
          chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
        return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
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
    // Jamais lu : le job résout son client depuis la clé de l'agent.
    llmClient: undefined as unknown as RunnerDeps['llmClient'],
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

async function seedAgent(role: 'agent' | 'orchestrator', name: string): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [row] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name,
      slug: `${name.toLowerCase()}-${suffix}`,
      personality: `You are ${name}.`,
      role,
      ...(role === 'orchestrator' ? { orchestratorMode: 'router' } : {}),
      llmKeyId: openrouterKeyId,
      model: MODEL,
      active: true,
    } as never)
    .returning({ id: agents.id, slug: agents.slug });
  if (!row) throw new Error(`failed to seed ${name}`);
  return row.id;
}

/** Un orchestrateur et son sous-agent Dev-C ; rend l'orchestrateur et l'outil qui délègue. */
async function seedTeam(): Promise<{ orchestratorId: string; assignTool: string }> {
  const orchestratorId = await seedAgent('orchestrator', 'Lead');
  const devCId = await seedAgent('agent', 'DevC');
  const [devC] = await db.select({ slug: agents.slug }).from(agents).where(eq(agents.id, devCId));
  if (!devC) throw new Error('failed to read Dev-C');
  await db
    .insert(agentAssignments)
    .values({ orchestratorId, subAgentId: devCId, entityId: seed.entityId });
  return { orchestratorId, assignTool: `assign_${devC.slug.replace(/-/g, '_')}` };
}

async function createJob(agentId: string, task: string): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId,
      channel: 'api',
      task,
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning({ id: agentJobs.id });
  if (!job) throw new Error('failed to seed the job');
  return job.id;
}

async function jobRow(id: string) {
  const [row] = await db
    .select({
      status: agentJobs.status,
      result: agentJobs.result,
      toolsUsed: agentJobs.toolsUsed,
      inputTokens: agentJobs.inputTokens,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, id));
  if (!row) throw new Error(`job ${id} not found`);
  return row;
}

const lastUserText = (b: Body): string =>
  textOf([...b.messages].reverse().find((m) => m.role === 'user')?.content);

describe('a prose turn of a job is its answer, in ONE request @cap:parler-a-un-agent/moteur', () => {
  it('a one-line knowledge question: the job completes with the answer, and the model received exactly one request', async () => {
    const agentId = await seedAgent('agent', 'Helper');
    const task = 'What is the capital of Australia?';
    const jobId = await createJob(agentId, task);
    const bodies = stubProvider(() => ({ text: 'Canberra.' }));

    const outcome = await executeJob(jobId as JobId, makeDeps());

    expect(outcome.status).toBe('completed');
    const row = await jobRow(jobId);
    expect(row.status).toBe('completed');
    expect(row.result).toBe('Canberra.');
    // The ONE request is the turn itself: the system prompt, the task, the
    // job's tools. Nothing asked the model to re-read its answer.
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.messages[0]?.role).toBe('system');
    expect(lastUserText(bodies[0]!)).toContain(task);
    expect(bodies[0]?.['tool_choice']).toBe('auto');
    expect(JSON.stringify(bodies)).not.toContain('Re-read your previous reply');
    // Billed once: the turn's 10 input tokens, no second call on top.
    expect(row.inputTokens).toBe(10);
  });

  it('an orchestrator answering in prose: the same, one request, no sub-agent started', async () => {
    const { orchestratorId } = await seedTeam();
    const jobId = await createJob(orchestratorId, 'What is 2 + 2?');
    const bodies = stubProvider(() => ({ text: '4.' }));

    const outcome = await executeJob(jobId as JobId, makeDeps());

    expect(outcome.status).toBe('completed');
    const row = await jobRow(jobId);
    expect(row.result).toBe('4.');
    expect(bodies).toHaveLength(1);
    const children = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.parentJobId, jobId));
    expect(children).toEqual([]);
  });

  it('a delegation done, then reported in prose: delegated ONCE, and the report is the answer', async () => {
    // The repeat #886 measured: a root reporting a finished delegation was
    // made to delegate the same work again. Without the re-read, the report
    // ends the run.
    const { orchestratorId, assignTool } = await seedTeam();
    const task = 'Rewrite the parser module in TypeScript.';
    const jobId = await createJob(orchestratorId, task);
    const bodies = stubProvider((body) => {
      const offered = ((body['tools'] as Array<{ function: { name: string } }>) ?? []).map(
        (t) => t.function.name,
      );
      // The child: it does the work and answers.
      if (!offered.includes(assignTool)) return { text: 'Parser rewritten in TypeScript.' };
      // The root: it delegates, then reports once the child's result is in.
      const delegated = body.messages.some((m) => m.role === 'tool');
      return delegated
        ? { text: 'Dev-C rewrote the parser in TypeScript.' }
        : { toolCall: { name: assignTool, args: { task } } };
    });

    const outcome = await executeJob(jobId as JobId, makeDeps());

    expect(outcome.status).toBe('completed');
    const children = await db
      .select({ task: agentJobs.task, result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.parentJobId, jobId));
    expect(children).toHaveLength(1);
    expect(children[0]?.task).toContain(task);
    expect(children[0]?.result).toBe('Parser rewritten in TypeScript.');
    const row = await jobRow(jobId);
    expect(row.result).toBe('Dev-C rewrote the parser in TypeScript.');
    expect(row.toolsUsed).toContain(assignTool);
    // Three requests, each a real turn with its system prompt: the root's
    // delegating turn, the child's turn, the root's report.
    expect(bodies).toHaveLength(3);
    for (const b of bodies) expect(b.messages[0]?.role).toBe('system');
  });

  it('KNOWN LIMIT, now visible in the run: an announcement with no call ends completed with the announcement', async () => {
    // What the 13 "real misses" of #886 become without the re-read: the run
    // ends on the reply, and the reply says what it did not do. No reading of
    // the text decides in its place (invariants #2 and #4).
    const { orchestratorId } = await seedTeam();
    const jobId = await createJob(orchestratorId, 'Rewrite the tokenizer.');
    const bodies = stubProvider(() => ({ text: "I'll delegate the tokenizer to Dev-C." }));

    const outcome = await executeJob(jobId as JobId, makeDeps());

    expect(outcome.status).toBe('completed');
    const row = await jobRow(jobId);
    expect(row.result).toBe("I'll delegate the tokenizer to Dev-C.");
    expect(row.toolsUsed ?? '').not.toContain('assign_');
    expect(bodies).toHaveLength(1);
  });
});
