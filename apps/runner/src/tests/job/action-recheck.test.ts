// action-recheck.test.ts — un tour qui ANNONCE une action sans l'appeler est
// relu, dans la boucle de job comme dans le chat (#600).
//
// Sans forçage du tool_choice, un orchestrateur peut répondre « Je délègue la
// réécriture à Dev-C. » sans appeler l'outil : le job finissait `completed`,
// sans outil utilisé, sur un travail jamais lancé (revue de la PR #604). Le
// forçage du tour 1 bouchait ce trou au tour 1 seulement.
//
// Prouvé ici sur le VRAI chemin : executeJob, une vraie base de test, le VRAI
// client LLM construit depuis la clé de l'agent, et les corps HTTP lus à la
// frontière du fetch. La relance y est reconnue à son dernier message, la
// consigne partagée.

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
import { ACTION_RECHECK } from '../../llm/action-recheck.ts';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

type Body = Record<string, unknown> & { messages?: Array<{ role: string; content: unknown }> };

const isRecheck = (body: Body): boolean => {
  const last = body.messages?.[body.messages.length - 1];
  return last?.role === 'user' && last.content === ACTION_RECHECK;
};

/**
 * Le fournisseur simulé. Chaque tour répond `turnText` ; la PREMIÈRE relance
 * répond par `recheck` (un appel d'outil, ou un texte sans appel), les
 * suivantes n'appellent rien. Tous les corps sont gardés, tels que le
 * fournisseur les reçoit.
 */
function stubProvider(opts: {
  turnText: string;
  recheck: { toolCall: { name: string; args: Record<string, unknown> } } | { text: string };
  /** Joué pendant la relance, avant qu'elle ne réponde. */
  duringRecheck?: () => Promise<void>;
}): Body[] {
  const bodies: Body[] = [];
  let rechecks = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('/chat/completions')) {
        throw new Error(`action-recheck.test: unexpected fetch ${url}`);
      }
      const body = JSON.parse(init?.body as string) as Body;
      bodies.push(body);
      const firstRecheck = isRecheck(body) && rechecks++ === 0;
      if (firstRecheck && opts.duringRecheck) await opts.duringRecheck();
      const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
      const message =
        firstRecheck && 'toolCall' in opts.recheck
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: `call-recheck-${String(bodies.length)}`,
                  type: 'function',
                  function: {
                    name: opts.recheck.toolCall.name,
                    arguments: JSON.stringify(opts.recheck.toolCall.args),
                  },
                },
              ],
            }
          : {
              role: 'assistant',
              content: firstRecheck && 'text' in opts.recheck ? opts.recheck.text : opts.turnText,
            };
      const finish = 'tool_calls' in message ? 'tool_calls' : 'stop';
      if (body['stream'] === true) {
        const chunks = [
          { id: 'c', choices: [{ index: 0, delta: message }] },
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

/** Un orchestrateur et son sous-agent Dev-C ; rend l'orchestrateur et l'outil qui délègue. */
async function seedTeam(): Promise<{ orchestratorId: string; assignTool: string }> {
  const suffix = randomUUID().slice(0, 8);
  const [orchestrator] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Lead',
      slug: `lead-${suffix}`,
      personality: 'You lead the team.',
      role: 'orchestrator',
      orchestratorMode: 'router',
      llmKeyId: openrouterKeyId,
      model: MODEL,
    } as never)
    .returning({ id: agents.id });
  const [devC] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Dev-C',
      slug: `dev-c-${suffix}`,
      personality: 'You rewrite code.',
      role: 'agent',
      llmKeyId: openrouterKeyId,
      model: MODEL,
      active: true,
    } as never)
    .returning({ id: agents.id, slug: agents.slug });
  if (!orchestrator || !devC) throw new Error('failed to seed the team');
  await db
    .insert(agentAssignments)
    .values({ orchestratorId: orchestrator.id, subAgentId: devC.id, entityId: seed.entityId });
  return { orchestratorId: orchestrator.id, assignTool: `assign_${devC.slug.replace(/-/g, '_')}` };
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

describe('a prose turn that announced an action is re-read @cap:organiser-equipe/moteur', () => {
  it('announced delegation: the re-read calls the tool, the delegation happens, the job is not completed empty', async () => {
    const { orchestratorId, assignTool } = await seedTeam();
    const task = 'Rewrite the parser module in TypeScript.';
    const jobId = await createJob(orchestratorId, task);
    const bodies = stubProvider({
      turnText: "I'll delegate the rewrite to Dev-C.",
      recheck: {
        toolCall: { name: assignTool, args: { task: 'Rewrite the parser module in TypeScript.' } },
      },
    });

    const outcome = await executeJob(jobId as JobId, makeDeps());

    // The re-read: short and local (no system prompt, no history), the job's
    // tools offered, left to the model.
    const recheck = bodies.find(isRecheck);
    expect(recheck, 'the prose turn was re-read').toBeDefined();
    expect(recheck?.messages).toEqual([
      { role: 'user', content: task },
      { role: 'assistant', content: "I'll delegate the rewrite to Dev-C." },
      { role: 'user', content: ACTION_RECHECK },
    ]);
    expect(recheck?.['tool_choice']).toBe('auto');
    const offered = (recheck?.['tools'] as Array<{ function: { name: string } }>).map(
      (t) => t.function.name,
    );
    expect(offered).toContain(assignTool);

    // The delegation took place: a child job for Dev-C ran (inline here), and
    // the parent's run records the tool it used. Before the re-read, this job
    // ended `completed` on the announcing prose with no tool used.
    const children = await db
      .select({ task: agentJobs.task })
      .from(agentJobs)
      .where(eq(agentJobs.parentJobId, jobId));
    expect(children).toHaveLength(1);
    expect(children[0]?.task).toContain('Rewrite the parser module in TypeScript.');
    const [parent] = await db
      .select({ toolsUsed: agentJobs.toolsUsed, messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(outcome.status).not.toBe('failed');
    expect(parent?.toolsUsed).toContain(assignTool);
    // The announcing text and the call that does it, in ONE assistant turn.
    const assistant = (parent?.messages as Array<{ role: string; content: unknown }>).find(
      (m) => m.role === 'assistant',
    );
    expect(assistant?.content).toEqual([
      { type: 'text', text: "I'll delegate the rewrite to Dev-C." },
      expect.objectContaining({ type: 'tool-call', toolName: assignTool }),
    ]);
  });

  it('a real answer in prose: the re-read calls nothing, the job completes with that answer', async () => {
    const { orchestratorId } = await seedTeam();
    const jobId = await createJob(orchestratorId, 'What is 2 + 2?');
    const bodies = stubProvider({
      turnText: '4.',
      // What the re-read writes is never the answer.
      recheck: { text: 'No action was promised.' },
    });

    const outcome = await executeJob(jobId as JobId, makeDeps());

    expect(bodies.filter(isRecheck)).toHaveLength(1);
    expect(outcome.status).toBe('completed');
    const [row] = await db
      .select({ status: agentJobs.status, result: agentJobs.result })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(row?.status).toBe('completed');
    expect(row?.result).toBe('4.');
    const children = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.parentJobId, jobId));
    expect(children).toHaveLength(0);
  });

  it('a Stop that lands during the re-read: the tool it asks for never runs', async () => {
    const { orchestratorId, assignTool } = await seedTeam();
    const jobId = await createJob(orchestratorId, 'Rewrite the lexer.');
    stubProvider({
      turnText: "I'll delegate the lexer to Dev-C.",
      recheck: { toolCall: { name: assignTool, args: { task: 'Rewrite the lexer.' } } },
      // The owner presses Stop while the re-read is being answered.
      duringRecheck: async () => {
        await db.update(agentJobs).set({ status: 'cancelled' }).where(eq(agentJobs.id, jobId));
      },
    });

    await executeJob(jobId as JobId, makeDeps());

    const children = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.parentJobId, jobId));
    expect(children).toHaveLength(0);
    const [row] = await db
      .select({ status: agentJobs.status, toolsUsed: agentJobs.toolsUsed })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(row?.status).toBe('cancelled');
    expect(row?.toolsUsed ?? '').not.toContain(assignTool);
  });
});
