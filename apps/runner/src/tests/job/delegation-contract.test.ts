// delegation-contract.test.ts — issue #107, the delegation contract.
//
// Replays the real incident (job f1852d35 / sub-job 538b8d53, 2026-09-15): a
// delegated Researcher emitted a reasoning block and a bare
// `return_result{status:'success'}`, produced NO text, and was finalized
// `completed` with an empty result. The parent read "(no output)" as an answer
// and told the user "recherche lancée, je te renvoie la synthèse" — a promise
// for a result that had already failed to exist.
//
// The contract now mirrors Hermes (`tools/delegate_tool.py:2064-2078`):
// the sub-agent's final text IS the deliverable, an empty one is a FAILURE, and
// the parent receives a typed record rather than a string it has to interpret.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentJobs, agents, jobDeliveries, toolCalls } from '@nodal-agents/db';
import { completeJob } from '../../job/state.ts';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { resumeDelegated, DELEGATION_FAILED_MARKER } from '@nodal-agents/orchestration';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { delegationRecordFromOutcome, executeJob } from '../../job/execute.ts';

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
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      const active = getActiveLlmClient();
      if (!active) throw new Error('delegation-contract.test: no active LLM client set');
      return active;
    },
  };
});

type MockTurn = {
  text?: string;
  reasoning?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
};

function makeMockLlmClient(responses: MockTurn[]): RunnerDeps['llmClient'] {
  let callIndex = 0;
  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'reasoning'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
      > = [];
      if (response.reasoning) content.push({ type: 'reasoning', text: response.reasoning });
      if (response.text) content.push({ type: 'text', text: response.text });
      for (const tc of response.toolCalls ?? []) {
        content.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args),
        });
      }
      const isToolCalls = (response.toolCalls?.length ?? 0) > 0;
      return {
        content,
        finishReason: isToolCalls
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
  return {
    config: { provider: 'anthropic', model: 'mock' } as RunnerDeps['llmClient']['config'],
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) =>
      generateText({ ...args, model: mockModel } as Parameters<
        typeof generateText
      >[0]) as ReturnType<RunnerDeps['llmClient']['generateText']>,
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

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: true })
    .where(eq(agents.id, seed.agentId));
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

async function insertJob(values: Record<string, unknown>): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      task: 'Fais une recherche sur la longueur de Planck',
      status: 'pending',
      messages: [],
      chainCount: 0,
      ...values,
    } as never)
    .returning({ id: agentJobs.id });
  return row!.id;
}

async function jobRow(jobId: string) {
  const [row] = await db
    .select({
      status: agentJobs.status,
      result: agentJobs.result,
      error: agentJobs.error,
      messages: agentJobs.messages,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return row!;
}

/** Flatten a persisted transcript to plain text so a nudge can be asserted on. */
function transcriptText(messages: unknown): string {
  return JSON.stringify(messages ?? []);
}

describe('delegated sub-job deliverable @cap:organiser-equipe/moteur', () => {
  it('nudges once then FAILS an internal sub-job that signals success with no text', async () => {
    const parentId = await insertJob({
      channel: 'telegram',
      status: 'awaiting_delegation',
      pendingDelegation: { toolUseId: 'assign-x', toolName: 'assign_researcher' },
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'assign-x',
              toolName: 'assign_researcher',
              input: { task: 'recherche' },
            },
          ],
        },
      ],
    });
    const childId = await insertJob({ channel: 'internal', parentJobId: parentId });

    // The incident turn, replayed verbatim: a reasoning block announcing the
    // delivery, then `return_result{status:'success'}` and nothing else.
    const deps = makeDeps(
      makeMockLlmClient([
        {
          reasoning: "I'll deliver via return_result and also send to Telegram",
          toolCalls: [
            { toolCallId: 'rr-1', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
        {
          reasoning: 'still nothing to say',
          toolCalls: [
            { toolCallId: 'rr-2', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );

    const outcome = await executeJob(childId as JobId, deps, testEnv);

    expect(outcome.status).toBe('failed');
    const row = await jobRow(childId);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('empty_deliverable');
    // The first signal was NOT accepted silently: the transcript carries the
    // one nudge asking for the deliverable, before the failure.
    expect(transcriptText(row.messages)).toContain('ta réponse écrite EST le livrable');
  });

  it('un livrable fait d’ESPACES n’est pas un livrable', async () => {
    // Revue Codex de la PR #108, constat 1 (bloquant). La garde du vide lit le
    // dernier texte d'assistant APRÈS `trim()`, mais le chemin « texte sans
    // outil » finalisait le succès sur un simple `if (textContent)` : trois
    // espaces passaient, et le parent recevait un `completed` visuellement vide,
    // sans rappel ni `empty_deliverable`. Le faux succès de l'incident, par une
    // autre porte.
    const parentId = await insertJob({
      channel: 'telegram',
      status: 'awaiting_delegation',
      pendingDelegation: { toolUseId: 'assign-x', toolName: 'assign_researcher' },
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'assign-x',
              toolName: 'assign_researcher',
              input: { task: 'recherche' },
            },
          ],
        },
      ],
    });
    const childId = await insertJob({ channel: 'internal', parentJobId: parentId });

    const deps = makeDeps(
      makeMockLlmClient([
        { text: '   \n  \t ' },
        { text: '   ' },
        { text: '   ' },
        { text: '   ' },
        { text: '   ' },
      ]),
    );

    const outcome = await executeJob(childId as JobId, deps, testEnv);

    expect(outcome.status).toBe('failed');
    const row = await jobRow(childId);
    expect(row.status).toBe('failed');
    // Le tour blanc retombe sur le chemin du tour VIDE : on redemande, puis on
    // échoue franchement. Ce qui compte ici : pas de `completed`, et pas
    // d'espaces stockés comme livrable.
    expect(row.error).toBe('no_tool_calls_no_text');
    expect(row.result ?? '').not.toMatch(/^\s+$/);
  });

  it('ACCEPTS the sub-job when the second turn writes the deliverable', async () => {
    const parentId = await insertJob({
      channel: 'telegram',
      status: 'awaiting_delegation',
      pendingDelegation: { toolUseId: 'assign-x', toolName: 'assign_researcher' },
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'assign-x',
              toolName: 'assign_researcher',
              input: { task: 'recherche' },
            },
          ],
        },
      ],
    });
    const childId = await insertJob({ channel: 'internal', parentJobId: parentId });

    const deliverable =
      'Planck length: 1.616255e-35 m, derived from ħ, G and c. Sources: NIST CODATA 2022.';
    const deps = makeDeps(
      makeMockLlmClient([
        {
          reasoning: 'done searching',
          toolCalls: [
            { toolCallId: 'rr-1', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
        {
          text: deliverable,
          toolCalls: [
            { toolCallId: 'rr-2', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );

    const outcome = await executeJob(childId as JobId, deps, testEnv);

    expect(outcome.status).toBe('completed');
    const row = await jobRow(childId);
    expect(row.status).toBe('completed');
    // The deliverable is the agent's own text, stored verbatim — not a signal.
    expect(row.result).toContain('1.616255e-35');
  });

  it('does NOT fail a resumed job whose deliverable was written in an EARLIER run', async () => {
    // A parent writes its answer, suspends into a delegation, and comes back in
    // a fresh run whose final turn is `return_result` alone. The deliverable is
    // already in the transcript — failing that job would be the guard lying.
    const written = 'Planck length: 1.616255e-35 m. Full note written to the vault.';
    const jobId = await insertJob({
      channel: 'api',
      messages: [
        { role: 'user', content: 'recherche' },
        { role: 'assistant', content: [{ type: 'text', text: written }] },
      ],
    });
    const deps = makeDeps(
      makeMockLlmClient([
        {
          toolCalls: [
            { toolCallId: 'rr-1', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('completed');
    const row = await jobRow(jobId);
    expect(row.status).toBe('completed');
    expect(row.result).toContain('1.616255e-35');
  });

  it('FAILS a head job on `api` that signals success with no text and no delivery', async () => {
    const jobId = await insertJob({ channel: 'api' });
    const deps = makeDeps(
      makeMockLlmClient([
        {
          reasoning: 'I consider this done',
          toolCalls: [
            { toolCallId: 'rr-1', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
        {
          reasoning: 'still done',
          toolCalls: [
            { toolCallId: 'rr-2', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('failed');
    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('empty_deliverable');
    // Never a completed row with nothing in it — the whole point of #107.
    expect(row.status).not.toBe('completed');
  });
});

describe('parent receives a typed delegation record @cap:organiser-equipe/moteur', () => {
  it('injects {status, summary, error, exit_reason, tools_used} for a completed child', async () => {
    const parentId = await insertJob({
      channel: 'telegram',
      status: 'awaiting_delegation',
      messages: [
        { role: 'user', content: 'recherche' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'assign-1',
              toolName: 'assign_researcher',
              input: { task: 'recherche' },
            },
          ],
        },
      ],
      pendingDelegation: { toolUseId: 'assign-1', toolName: 'assign_researcher' },
    });
    const childId = await insertJob({ channel: 'internal', parentJobId: parentId });

    await resumeDelegated(
      parentId as JobId,
      childId as JobId,
      {
        status: 'completed',
        summary: 'Planck length is 1.616255e-35 m.',
        error: null,
        exit_reason: 'return_result_success',
        tools_used: ['tavily_search', 'return_result'],
      },
      db,
    );

    const row = await jobRow(parentId);
    const last = (row.messages as Array<{ role: string; content: unknown[] }>).at(-1)!;
    const part = last.content[0] as { output: { type: string; value: string } };
    expect(last.role).toBe('tool');
    expect(part.output.type).toBe('text');
    const payload = JSON.parse(part.output.value) as Record<string, unknown>;
    expect(payload['status']).toBe('completed');
    expect(payload['summary']).toBe('Planck length is 1.616255e-35 m.');
    expect(payload['exit_reason']).toBe('return_result_success');
    expect(payload['tools_used']).toEqual(['tavily_search', 'return_result']);
  });

  it('injects an error-text record that forbids a waiting message for a failed child', async () => {
    const parentId = await insertJob({
      channel: 'telegram',
      status: 'awaiting_delegation',
      messages: [
        { role: 'user', content: 'recherche' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'assign-2',
              toolName: 'assign_researcher',
              input: { task: 'recherche' },
            },
          ],
        },
      ],
      pendingDelegation: { toolUseId: 'assign-2', toolName: 'assign_researcher' },
    });
    const childId = await insertJob({ channel: 'internal', parentJobId: parentId });

    await resumeDelegated(
      parentId as JobId,
      childId as JobId,
      {
        status: 'failed',
        summary: '',
        error: 'empty_deliverable',
        exit_reason: 'empty_deliverable',
        tools_used: ['tavily_search'],
      },
      db,
    );

    const row = await jobRow(parentId);
    const last = (row.messages as Array<{ role: string; content: unknown[] }>).at(-1)!;
    const part = last.content[0] as { output: { type: string; value: string } };
    expect(part.output.type).toBe('error-text');
    expect(part.output.value).toContain('"status": "failed"');
    expect(part.output.value).toContain('"error": "empty_deliverable"');
    // "(no output)" is gone: the parent is told the delegation delivered nothing
    // AND that announcing progress is not one of its options.
    expect(part.output.value).not.toContain('(no output)');
    expect(part.output.value).toContain('DO NOT tell the user the work is in progress');
  });

  // Les CLÉS du JSON que le parent reçoit SONT le contrat (#119, revue passe 2).
  // Les épingler fait rougir aussi bien un champ perdu en route qu'un champ
  // ajouté sans que personne l'ait décidé. `review_verdict` y figure depuis que
  // la PR #170 est entrée : ce n'est plus une clé tolérée, c'est le contrat.
  const CLES_DU_CONTRAT = [
    'error',
    'exit_reason',
    'hint',
    'review_verdict',
    'status',
    'summary',
    'tools_used',
  ];

  function clesDuContrat(payload: Record<string, unknown>): string[] {
    return Object.keys(payload).sort();
  }

  /** Le JSON d'un échec vit dans le texte d'erreur, entre le marqueur et la prose. */
  function payloadOfErrorText(value: string): Record<string, unknown> {
    return JSON.parse(value.slice(value.indexOf('{'), value.lastIndexOf('}') + 1)) as Record<
      string,
      unknown
    >;
  }

  async function seedParentAwaiting(toolUseId: string, toolName: string): Promise<string> {
    return insertJob({
      channel: 'api',
      status: 'awaiting_delegation',
      messages: [
        { role: 'user', content: 'une tâche' },
        {
          role: 'assistant',
          content: [{ type: 'tool-call', toolCallId: toolUseId, toolName, input: {} }],
        },
      ],
      pendingDelegation: { toolUseId, toolName },
    });
  }

  it('une délégation ordinaire porte les clés du contrat, hint à null', async () => {
    const parentId = await seedParentAwaiting('assign-k1', 'assign_researcher');
    const childId = await insertJob({ channel: 'internal', parentJobId: parentId });

    await resumeDelegated(
      parentId as JobId,
      childId as JobId,
      delegationRecordFromOutcome({
        status: 'completed',
        result: 'Longueur de Planck : 1.616255e-35 m.',
        toolsUsed: ['tavily_search', 'return_result'],
        exitReason: 'return_result_success',
      }),
      db,
    );

    const row = await jobRow(parentId);
    const last = (row.messages as Array<{ role: string; content: unknown[] }>).at(-1)!;
    const part = last.content[0] as { output: { type: string; value: string } };
    const payload = JSON.parse(part.output.value) as Record<string, unknown>;

    expect(clesDuContrat(payload)).toEqual(CLES_DU_CONTRAT);
    expect(payload['hint']).toBeNull();
    expect(payload['review_verdict']).toBeNull();
    expect(payload['status']).toBe('completed');
  });

  it('un refus du fournisseur fait voyager hint jusqu’au parent', async () => {
    const parentId = await seedParentAwaiting('assign-k2', 'assign_reviewer');
    const childId = await insertJob({ channel: 'internal', parentJobId: parentId });

    await resumeDelegated(
      parentId as JobId,
      childId as JobId,
      delegationRecordFromOutcome({
        status: 'failed',
        error: 'provider_rejected_request:openrouter/google/gemini-3.7-flash (http 400, turn 1)',
        result:
          '[stopped: provider rejected the request — openrouter/google/gemini-3.7-flash, http 400, turn 1]',
        toolsUsed: [],
        exitReason: 'provider_rejected_request',
        hint: 'switch_model',
      }),
      db,
    );

    const row = await jobRow(parentId);
    const last = (row.messages as Array<{ role: string; content: unknown[] }>).at(-1)!;
    const part = last.content[0] as { output: { type: string; value: string } };
    expect(part.output.type).toBe('error-text');
    const payload = payloadOfErrorText(part.output.value);

    expect(clesDuContrat(payload)).toEqual(CLES_DU_CONTRAT);
    // Le geste arrive au parent : c'est tout l'objet du champ.
    expect(payload['hint']).toBe('switch_model');
    expect(payload['exit_reason']).toBe('provider_rejected_request');
  });
});

describe('ce qu’un agent qui DÉLÈGUE livre @cap:organiser-equipe/moteur', () => {
  it('sa synthèse FINALE l’emporte sur la compilation de ses enfants', async () => {
    // Revue Codex de la PR #108, constat 4. `completeJob` remplissait `result`
    // avec la compilation des enfants AVANT de regarder le texte final de
    // l'agent : un sous-agent qui délègue une étape puis écrit sa synthèse
    // voyait sa synthèse perdue, et le grand-parent recevait les étapes. Le
    // contrat de cette PR dit l'inverse : le livrable d'un agent EST son texte.
    const jobId = await insertJob({ channel: 'internal', status: 'processing' });
    await insertJob({
      channel: 'internal',
      parentJobId: jobId,
      status: 'completed',
      result: "l'étape intermédiaire du worker",
    });

    await completeJob(db as never, jobId, '', [], { turn: 1, inputTokens: 0, outputTokens: 0 }, [
      { role: 'assistant', content: [{ type: 'text', text: 'MA SYNTHÈSE finale' }] },
    ] as never);

    const row = await jobRow(jobId);
    expect(row.result).toContain('MA SYNTHÈSE finale');
    expect(row.result).not.toContain("l'étape intermédiaire du worker");
  });

  it('un parent dont l’ENFANT a livré n’est pas un livrable vide', async () => {
    // Constat 5. Le résultat d'un enfant est un message d'OUTIL, pas un texte
    // d'assistant : la garde du vide ne le voyait pas, échouait en
    // `empty_deliverable`, et empêchait ainsi la compilation qui aurait rendu
    // ce contenu. Un faux vide sur du contenu qui existe.
    const parentId = await insertJob({ channel: 'api', status: 'pending' });
    await insertJob({
      channel: 'internal',
      parentJobId: parentId,
      status: 'completed',
      result: 'la longueur de Planck vaut 1,616 × 10⁻³⁵ m',
    });

    const deps = makeDeps(
      makeMockLlmClient([
        {
          toolCalls: [
            { toolCallId: 'rr-1', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );

    const outcome = await executeJob(parentId as JobId, deps, testEnv);

    expect(outcome.status).toBe('completed');
    const row = await jobRow(parentId);
    expect(row.status).toBe('completed');
    expect(row.result ?? '').toContain('1,616');
  });
});

describe('a parent cannot promise over a failed delegation @cap:organiser-equipe/moteur', () => {
  it('nudges the parent that sends a waiting message and then signals success', async () => {
    // Parent state exactly as `resumeDelegated` leaves it after a failed child.
    const parentId = await insertJob({
      channel: 'api',
      status: 'pending',
      messages: [
        { role: 'user', content: 'Fais une recherche sur la longueur de Planck' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'assign-3',
              toolName: 'assign_researcher',
              input: { task: 'recherche' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'assign-3',
              toolName: 'assign_researcher',
              output: {
                type: 'error-text',
                value: `${DELEGATION_FAILED_MARKER}
{"status":"failed"} delivered NOTHING`,
              },
            },
          ],
        },
      ],
    });

    const deps = makeDeps(
      makeMockLlmClient([
        {
          // The incident's parent turn: a promise, then a success signal.
          text: 'Recherche lancée sur la longueur de Planck, je te renvoie la synthèse dès que c’est prêt',
          toolCalls: [
            { toolCallId: 'rr-1', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
        {
          text: 'Recherche toujours en cours, je reviens vers toi',
          toolCalls: [
            { toolCallId: 'rr-2', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
        {
          text: 'Toujours rien',
          toolCalls: [
            { toolCallId: 'rr-3', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );

    const outcome = await executeJob(parentId as JobId, deps, testEnv);

    // Le runner ne juge plus si cette phrase est une promesse : il ne sait pas
    // le dire, et quatre passes de revue l'ont montré. Ce qu'il garantit, c'est
    // que l'utilisateur lit l'ÉCHEC sous la phrase — nommé, à l'endroit où il
    // regarde.
    expect(outcome.status).toBe('completed');
    const row = await jobRow(parentId);
    expect(row.result ?? '').toContain('assign_researcher');
    expect(row.result ?? '').toContain('no deliverable');
  });

  it('une délégation de SECOURS réussie efface l’échec de la première', async () => {
    // Revue Codex de la PR #108, constat 3. Le rappel dit au parent : refais-le,
    // ou confie-le à un autre spécialiste. Mais `assign_a` restait inscrit dans
    // les échecs non résolus même après que `assign_b` eut livré : le parent
    // faisait exactement ce qu'on lui demandait et finissait quand même en
    // échec. Un faux rouge sur du travail réellement fait.
    const parentId = await insertJob({
      channel: 'api',
      status: 'pending',
      messages: [
        { role: 'user', content: 'Fais une recherche sur la longueur de Planck' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'assign-a',
              toolName: 'assign_researcher',
              input: { task: 'recherche' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'assign-a',
              toolName: 'assign_researcher',
              output: {
                type: 'error-text',
                value: `${DELEGATION_FAILED_MARKER}
{"status":"failed"} delivered NOTHING`,
              },
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'assign-b',
              toolName: 'assign_analyst',
              input: { task: 'recherche' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'assign-b',
              toolName: 'assign_analyst',
              output: { type: 'text', value: 'la longueur de Planck vaut 1,616 × 10⁻³⁵ m' },
            },
          ],
        },
      ],
    });

    const deps = makeDeps(
      makeMockLlmClient([
        {
          text: "L'analyste a trouvé : la longueur de Planck vaut 1,616 × 10⁻³⁵ m.",
          toolCalls: [
            { toolCallId: 'rr-1', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );

    const outcome = await executeJob(parentId as JobId, deps, testEnv);

    expect(outcome.status).toBe('completed');
    const row = await jobRow(parentId);
    expect(row.status).toBe('completed');
    expect(row.result ?? '').toContain('1,616');
  });

  it('un parent qui DIT LA VÉRITÉ échoue AVEC sa raison, pas avec un code opaque', async () => {
    // Le rappel propose trois issues : refaire, confier à un autre, dire la
    // vérité. Seule la deuxième peut finir en SUCCÈS — une autre délégation a
    // livré. Les deux autres font échouer le job, et c'est juste : le travail
    // délégué n'a pas eu lieu. Ce que ce test garde, c'est que la troisième
    // reste PRATICABLE : la raison arrive jusqu'à l'utilisateur, sans rappel, au
    // lieu d'un `unresolved_tool_failure` muet.
    const parentId = await insertJob({
      channel: 'api',
      status: 'pending',
      messages: [
        { role: 'user', content: 'Fais une recherche sur la longueur de Planck' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'assign-z',
              toolName: 'assign_researcher',
              input: { task: 'recherche' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'assign-z',
              toolName: 'assign_researcher',
              output: {
                type: 'error-text',
                value: `${DELEGATION_FAILED_MARKER}
{"status":"failed"} delivered NOTHING`,
              },
            },
          ],
        },
      ],
    });

    const deps = makeDeps(
      makeMockLlmClient([
        {
          text: "Le spécialiste n'a rien rendu. Je n'ai donc pas la synthèse, et je préfère te le dire.",
          toolCalls: [
            {
              toolCallId: 'rr-1',
              toolName: 'return_result',
              args: {
                status: 'blocked',
                reason: "le spécialiste n'a rien produit ; rien à livrer",
              },
            },
          ],
        },
      ]),
    );

    const outcome = await executeJob(parentId as JobId, deps, testEnv);

    // La troisième issue du rappel — dire la vérité. Le job ÉCHOUE, et c'est
    // juste : le travail délégué n'a pas eu lieu. Ce qui compte, et ce que ce
    // test garde, c'est que la RAISON arrive jusqu'à l'utilisateur au lieu d'un
    // code opaque — et qu'aucun rappel n'ait été nécessaire pour l'obtenir.
    expect(outcome.status).toBe('failed');
    const row = await jobRow(parentId);
    expect(row.result ?? '').toContain("n'a rien produit");
    expect(row.error ?? '').not.toBe('unresolved_tool_failure');
  });

  it('sur un canal à OUTIL, l’échec part vers l’utilisateur, pas seulement en base', async () => {
    // Passe de contrôle de la forme réduite, constat 1 (bloquant). Le parent
    // ENVOIE son message avant la finalisation ; la ligne d'échec, elle, se pose
    // après, sur la ligne en base. Le destinataire ne la lisait donc jamais —
    // et « rien reçu sur Telegram » est précisément l'incident #107. Le harnais
    // prépare donc sa propre livraison, que `drainDeliveries` envoie.
    const parentId = await insertJob({
      channel: 'telegram',
      chatId: '4242',
      status: 'pending',
      messages: [
        { role: 'user', content: 'Fais une recherche sur la longueur de Planck' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'assign-t',
              toolName: 'assign_researcher',
              input: { task: 'recherche' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'assign-t',
              toolName: 'assign_researcher',
              output: {
                type: 'error-text',
                value: `${DELEGATION_FAILED_MARKER}\n{"status":"failed"} delivered NOTHING`,
              },
            },
          ],
        },
      ],
    });

    const deps = makeDeps(
      makeMockLlmClient([
        {
          toolCalls: [
            {
              toolCallId: 'send-9',
              toolName: 'telegram_send_message',
              args: { text: 'Recherche lancée, je te renvoie ça' },
            },
          ],
        },
        {
          toolCalls: [
            { toolCallId: 'rr-1', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
        { text: 'je te tiens au courant' },
        { text: 'toujours rien' },
      ]),
    );

    await executeJob(parentId as JobId, deps, testEnv);

    const livraisons = await db
      .select({ payload: jobDeliveries.payload, chatId: jobDeliveries.chatId })
      .from(jobDeliveries)
      .where(eq(jobDeliveries.jobId, parentId));
    expect(livraisons.length, 'aucune livraison préparée pour dire l’échec').toBeGreaterThan(0);
    expect(livraisons.map((l) => l.payload).join(' ')).toContain('assign_researcher');
    expect(livraisons.every((l) => l.chatId === '4242')).toBe(true);
  });

  it('la promesse rendue en TEXTE SEUL porte l’échec avec elle', async () => {
    // Revue Codex de la PR #108, constat 2 (bloquant). La garde vit dans la
    // branche `return_result`. Sur `api` et `dashboard`, un parent peut finir
    // son job par un simple texte : « Recherche lancée, je reviens vers toi »
    // finalisait alors un succès sans que rien n'ait été produit — exactement
    // l'incident #107, par la porte d'à côté.
    const parentId = await insertJob({
      channel: 'api',
      status: 'pending',
      messages: [
        { role: 'user', content: 'Fais une recherche sur la longueur de Planck' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'assign-9',
              toolName: 'assign_researcher',
              input: { task: 'recherche' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'assign-9',
              toolName: 'assign_researcher',
              output: {
                type: 'error-text',
                value: `${DELEGATION_FAILED_MARKER}
{"status":"failed"} delivered NOTHING`,
              },
            },
          ],
        },
      ],
    });

    const deps = makeDeps(
      makeMockLlmClient([
        { text: 'Recherche lancée, je te renvoie la synthèse dès que c’est prêt' },
        { text: 'Toujours en cours, je reviens vers toi' },
        { text: 'Encore un instant' },
      ]),
    );

    const outcome = await executeJob(parentId as JobId, deps, testEnv);

    // Même règle sur le chemin texte que sur `return_result` : le job finit, et
    // le résultat livré dit que le spécialiste n'a rien rendu.
    expect(outcome.status).toBe('completed');
    const row = await jobRow(parentId);
    expect(row.result ?? '').toContain('assign_researcher');
    expect(row.result ?? '').toContain('no deliverable');
  });
});

describe('a child with no deliverable is never "(no output)" @cap:organiser-equipe/moteur', () => {
  it('compiles a FAILURE into the parent result, not an empty-looking answer', async () => {
    const parentId = await insertJob({ channel: 'api', status: 'processing' });
    await insertJob({
      channel: 'internal',
      parentJobId: parentId,
      status: 'failed',
      error: 'empty_deliverable',
    });

    // The parent finishes without republishing: `completeJob` compiles its
    // children into the user-facing result.
    await completeJob(db, parentId, '', ['assign_researcher'], undefined, [
      { role: 'user', content: 'recherche' },
    ]);

    const row = await jobRow(parentId);
    expect(row.result).not.toContain('(no output)');
    expect(row.result).toContain('empty_deliverable');
  });

  it('marks a NON-failed child that produced nothing as a failed delegation', async () => {
    const parentId = await insertJob({ channel: 'api', status: 'processing' });
    await insertJob({ channel: 'internal', parentJobId: parentId, status: 'cancelled' });

    await completeJob(db, parentId, '', ['assign_researcher'], undefined, [
      { role: 'user', content: 'recherche' },
    ]);

    const row = await jobRow(parentId);
    expect(row.result).not.toContain('(no output)');
    expect(row.result).toContain('no deliverable');
  });
});

describe('a DEFERRED delegation is not a failure @cap:organiser-equipe/moteur', () => {
  it('lets the parent finish honestly after a deferred second handoff', async () => {
    // `buildDeferredToolResults` writes an error-text tool-result meaning
    // "another handoff took priority, call me again" — not a failure. Reading it
    // as one would refuse an honest success.
    const parentId = await insertJob({
      channel: 'api',
      messages: [
        { role: 'user', content: 'deux recherches' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'assign-d',
              toolName: 'assign_researcher',
              input: { task: 'recherche' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'assign-d',
              toolName: 'assign_researcher',
              output: {
                type: 'error-text',
                value: 'Deferred — another handoff in this turn took priority.',
              },
            },
          ],
        },
      ],
    });

    const deps = makeDeps(
      makeMockLlmClient([
        {
          text: 'Longueur de Planck : 1.616255e-35 m.',
          toolCalls: [
            { toolCallId: 'rr-1', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );

    const outcome = await executeJob(parentId as JobId, deps, testEnv);

    expect(outcome.status).toBe('completed');
    const row = await jobRow(parentId);
    expect(row.status).toBe('completed');
    expect(row.result).toContain('1.616255e-35');
  });
});

// ─── issue #124 — le verdict de revue arrive au parent ────────────────────────
//
// Observé le 16/09/2026 sur six revues : l'enfant relecteur enregistre son
// verdict par l'outil `review_verdict`, mais ne rend au parent que la phrase
// « je constate maintenant le verdict et je livre les constats » (job ebf1951a,
// 428 caractères pour un verdict qui portait 5 constats). Le parent, n'ayant
// pas de rapport, a redélégué la MÊME revue.

/** La sortie EXACTE que l'outil écrit dans `tool_calls` quand il a validé. */
const REVIEW_VERDICT_OUTPUT = {
  ok: true,
  verdict: 'request_changes',
  summary: 'Relu la PR : trois fichiers lus, la suite du paquet jouée, deux trous trouvés.',
  findings: [
    {
      file: 'packages/llm/src/retry.ts',
      line: 99,
      issue: 'Un 429 passager est classé en facturation et tue le job.',
      severity: 'blocker',
    },
    {
      file: 'apps/web/src/components/Thread.tsx',
      issue: 'Le libellé du bouton reste en anglais.',
      severity: 'minor',
    },
  ],
  counts: { blocker: 1, major: 0, minor: 1 },
};

/** La phrase que le modèle a rendue comme résultat, à la place du rapport. */
const PROSE_RESULT = 'J’ai couvert toutes les questions. Je constate maintenant le verdict.';

/**
 * Écrit une ligne `tool_calls` DANS LA FORME DE PRODUCTION : le runner passe par
 * `executeTool` (`packages/tools/src/execute.ts`), qui écrit
 * `toolOutput: JSON.stringify(output)` où `output` est la valeur rendue par
 * `execute()` de l'outil — pour `review_verdict`, `{ok, verdict, summary,
 * findings, counts}` — et `turn: ctx.turn`, le tour de la boucle du runner.
 */
async function recordToolCall(
  jobId: string,
  toolName: string,
  output: unknown,
  turn: number,
): Promise<void> {
  await db.insert(toolCalls).values({
    entityId: seed.entityId,
    jobId,
    toolName,
    toolInput: {},
    toolOutput: JSON.stringify(output),
    turn,
  } as never);
}

async function recordReviewVerdict(jobId: string, output: unknown, turn = 1): Promise<void> {
  await recordToolCall(jobId, 'review_verdict', output, turn);
}

async function seedParentAwaitingReview(toolUseId: string): Promise<string> {
  return insertJob({
    channel: 'api',
    status: 'awaiting_delegation',
    messages: [
      { role: 'user', content: 'fais relire la PR' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: toolUseId,
            toolName: 'assign_reviewer',
            input: { task: 'relis la PR' },
          },
        ],
      },
    ],
    pendingDelegation: { toolUseId, toolName: 'assign_reviewer' },
  });
}

function lastToolResultPayload(messages: unknown): Record<string, unknown> {
  const last = (messages as Array<{ role: string; content: unknown[] }>).at(-1)!;
  expect(last.role).toBe('tool');
  const part = last.content[0] as { output: { type: string; value: string } };
  return JSON.parse(part.output.value) as Record<string, unknown>;
}

describe('le verdict de revue voyage jusqu’au parent @cap:organiser-equipe/moteur', () => {
  it('le record que le parent lit porte verdict, résumé et constats', async () => {
    const parentId = await seedParentAwaitingReview('assign-rv-1');
    const childId = await insertJob({ channel: 'internal', parentJobId: parentId });
    await recordReviewVerdict(childId, REVIEW_VERDICT_OUTPUT);

    await resumeDelegated(
      parentId as JobId,
      childId as JobId,
      {
        status: 'completed',
        summary: PROSE_RESULT,
        error: null,
        exit_reason: 'return_result_success',
        tools_used: ['review_verdict', 'return_result'],
      },
      db,
    );

    const payload = lastToolResultPayload((await jobRow(parentId)).messages);
    const verdict = payload['review_verdict'] as Record<string, unknown>;
    expect(verdict).toBeTruthy();
    expect(verdict['verdict']).toBe('request_changes');
    expect(verdict['summary']).toBe(REVIEW_VERDICT_OUTPUT.summary);
    expect(verdict['findings']).toHaveLength(2);
    expect((verdict['findings'] as Array<Record<string, unknown>>)[0]?.['file']).toBe(
      'packages/llm/src/retry.ts',
    );
    expect((verdict['findings'] as Array<Record<string, unknown>>)[0]?.['severity']).toBe(
      'blocker',
    );
    expect(verdict['counts']).toEqual({ blocker: 1, major: 0, minor: 1 });
    // La phrase du modèle reste où elle était : elle n'est plus le livrable.
    expect(payload['summary']).toBe(PROSE_RESULT);
  });

  it('une délégation ordinaire est inchangée : review_verdict est null', async () => {
    const parentId = await seedParentAwaitingReview('assign-rv-2');
    const childId = await insertJob({ channel: 'internal', parentJobId: parentId });

    await resumeDelegated(
      parentId as JobId,
      childId as JobId,
      {
        status: 'completed',
        summary: 'Longueur de Planck : 1.616255e-35 m.',
        error: null,
        exit_reason: 'return_result_success',
        tools_used: ['tavily_search', 'return_result'],
      },
      db,
    );

    const payload = lastToolResultPayload((await jobRow(parentId)).messages);
    expect(payload['review_verdict']).toBeNull();
    expect(payload['summary']).toBe('Longueur de Planck : 1.616255e-35 m.');
    expect(payload['status']).toBe('completed');
  });

  it('la garde « aucun livrable » ne tue pas un job qui a enregistré un verdict', async () => {
    // Un relecteur dont le dernier tour est le verdict puis `return_result`, sans
    // un mot de texte : son livrable EXISTE, il est dans `tool_calls`.
    const jobId = await insertJob({ channel: 'api' });
    await recordReviewVerdict(jobId, REVIEW_VERDICT_OUTPUT);

    const deps = makeDeps(
      makeMockLlmClient([
        {
          reasoning: 'le verdict est posé',
          toolCalls: [
            { toolCallId: 'rr-v', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('completed');
    const row = await jobRow(jobId);
    expect(row.status).toBe('completed');
    expect(row.error).toBeFalsy();
    expect(transcriptText(row.messages)).not.toContain('empty_deliverable');
  });

  it('un verdict suivi d’un travail sans rapport ne tient plus lieu de livrable', async () => {
    // Revue de la PR #170, constat 1 : sans cette règle, un verdict posé au tour
    // 2 faisait passer pour livré un run qui a ensuite fait autre chose et n'a
    // rien écrit. Le dernier geste du job n'est pas le verdict : la garde tient.
    const jobId = await insertJob({ channel: 'api' });
    await recordReviewVerdict(jobId, REVIEW_VERDICT_OUTPUT, 2);
    await recordToolCall(jobId, 'tavily_search', { ok: true, results: [] }, 3);

    const deps = makeDeps(
      makeMockLlmClient([
        {
          reasoning: 'je considère que c’est fini',
          toolCalls: [
            { toolCallId: 'rr-o', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('failed');
    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('empty_deliverable');
  });

  it('une ligne de verdict illisible fait échouer le job par son code', async () => {
    // Elle ne remonte pas en exception nue : le job porte `review_verdict_malformed`.
    const jobId = await insertJob({ channel: 'api' });
    await recordReviewVerdict(jobId, { ok: true, verdict: 'request_changes' });

    const deps = makeDeps(
      makeMockLlmClient([
        {
          reasoning: 'le verdict est posé',
          toolCalls: [
            { toolCallId: 'rr-m', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );

    const outcome = await executeJob(jobId as JobId, deps, testEnv);

    expect(outcome.status).toBe('failed');
    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('review_verdict_malformed');
  });

  it('une ligne illisible ne laisse JAMAIS le parent suspendu', async () => {
    // Revue de la PR #170, constat 2 : l'exception sortait de `resumeDelegated`
    // avant la mise à jour du parent, qui restait `awaiting_delegation` avec un
    // appel d'outil sans réponse. Le parent doit repartir, et savoir pourquoi.
    const parentId = await seedParentAwaitingReview('assign-rv-3');
    const childId = await insertJob({ channel: 'internal', parentJobId: parentId });
    await recordReviewVerdict(childId, {
      ok: true,
      verdict: 'approve',
      findings: 'pas un tableau',
    });

    await resumeDelegated(
      parentId as JobId,
      childId as JobId,
      {
        status: 'completed',
        summary: PROSE_RESULT,
        error: null,
        exit_reason: 'return_result_success',
        tools_used: ['review_verdict', 'return_result'],
      },
      db,
    );

    const row = await jobRow(parentId);
    // Le parent est reparti : il n'attend plus une délégation qui ne viendra pas.
    expect(row.status).toBe('pending');
    const last = (row.messages as Array<{ role: string; content: unknown[] }>).at(-1)!;
    const part = last.content[0] as { output: { type: string; value: string } };
    expect(part.output.type).toBe('error-text');
    expect(part.output.value).toContain(DELEGATION_FAILED_MARKER);
    expect(part.output.value).toContain('review_verdict_malformed');
  });
});
