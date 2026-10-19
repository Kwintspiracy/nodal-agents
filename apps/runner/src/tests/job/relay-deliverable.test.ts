// relay-deliverable.test.ts — un parent qui relaie ses enfants montre ce qu'ils
// ont LIVRÉ, verdicts compris (issue #646).
//
// Job 5ee022d7 (30/09/2026) : le root relaie un relecteur ; son résultat — ce que
// lisent la page Runs et l'appelant MCP — ne porte que la dernière phrase de
// l'enfant, « je raccourcis chaque constat… », écrite au tour qui a suivi un
// `review_verdict` refusé. Le verdict enregistré n'était lu par personne sur ce
// chemin. Et un relecteur qui n'avait livré QUE son verdict (résultat NULL)
// s'affichait « no deliverable » : un faux rouge.
//
// Ces cas passent par les vraies écritures terminales (`completeJob`, `failJob`)
// et par la vraie garde « livrable vide » d'`executeJob` : ils lisent la colonne
// `agent_jobs.result` que la page Runs, le fil et l'appelant MCP lisent.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, agentJobs, agents, toolCalls } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { JobId } from '@nodal-agents/orchestration';
import { completeJob, failJob } from '../../job/state.ts';
import { executeJob } from '../../job/execute.ts';
import type { RunnerDeps } from '../../deps.ts';

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
      if (!active) throw new Error('relay-deliverable.test: no active LLM client set');
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

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let reviewerId: string;
let reviewerSlug: string;
let leadId: string;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
  await db
    .update(agents)
    .set({ role: 'agent', systemAgent: true })
    .where(eq(agents.id, seed.agentId));
  const suffix = Date.now().toString(36);
  const [reviewer] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Reviewer A',
      slug: `reviewer-a-${suffix}`,
      personality: 'p',
      role: 'agent',
    })
    .returning();
  reviewerId = reviewer!.id;
  reviewerSlug = reviewer!.slug;
  const [lead] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Lead',
      slug: `lead-${suffix}`,
      personality: 'p',
      role: 'agent',
    })
    .returning();
  leadId = lead!.id;
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

let clock = Date.parse('2026-09-30T10:00:00Z');

async function insertJob(values: Record<string, unknown>): Promise<string> {
  clock += 1000;
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      task: 'fais relire la PR #639',
      status: 'pending',
      messages: [],
      chainCount: 0,
      createdAt: new Date(clock),
      ...values,
    } as never)
    .returning({ id: agentJobs.id });
  return row!.id;
}

async function resultOf(jobId: string): Promise<{ status: string | null; result: string | null }> {
  const [row] = await db
    .select({ status: agentJobs.status, result: agentJobs.result })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return row!;
}

/** La sortie EXACTE que `review_verdict` écrit dans `tool_calls` quand il a validé. */
const VERDICT = {
  ok: true,
  verdict: 'request_changes',
  summary: 'Passe 1 de relecture de la PR #639.',
  findings: [
    {
      file: 'packages/db/src/repos/approval-cards.ts',
      line: 74,
      issue: 'La carte est réécrite sans garde de statut.',
      severity: 'blocker',
    },
    {
      file: 'apps/web/src/lib/actions.ts',
      issue: 'Le libellé reste en anglais.',
      severity: 'minor',
    },
  ],
  counts: { blocker: 1, major: 0, minor: 1 },
};

async function recordVerdict(jobId: string, output: unknown): Promise<void> {
  await db.insert(toolCalls).values({
    entityId: seed.entityId,
    jobId,
    toolName: 'review_verdict',
    toolInput: {},
    toolOutput: JSON.stringify(output),
    turn: 1,
  } as never);
}

/** Le bloc que la compilation pose pour le verdict ci-dessus, champ par champ. */
function verdictBlock(jobId: string): string {
  return [
    `[review_verdict] verdict: request_changes · author: ${reviewerSlug} · job: ${jobId}`,
    'summary: Passe 1 de relecture de la PR #639.',
    'findings:',
    '- blocker · packages/db/src/repos/approval-cards.ts:74 · La carte est réécrite sans garde de statut.',
    '- minor · apps/web/src/lib/actions.ts · Le libellé reste en anglais.',
  ].join('\n');
}

const NARRATION =
  'Le champ `issue` est plafonné à 1000 caractères — je raccourcis chaque constat en conservant les preuves, puis j’émets le verdict.';

describe('la compilation des enfants lit ce qu’ils ont LIVRÉ (#646) @cap:organiser-equipe/moteur', () => {
  it('un relecteur qui n’a livré QUE son verdict n’est pas « no deliverable »', async () => {
    const parentId = await insertJob({ channel: 'api', status: 'processing' });
    const childId = await insertJob({
      channel: 'internal',
      agentId: reviewerId,
      parentJobId: parentId,
      status: 'completed',
      result: null,
    });
    await recordVerdict(childId, VERDICT);

    await completeJob(db, parentId, '', ['assign_reviewer_a'], undefined, [
      { role: 'user', content: 'fais relire la PR #639' },
    ]);

    const row = await resultOf(parentId);
    expect(row.result).toBe(`## Reviewer A\n${verdictBlock(childId)}`);
    expect(row.result).not.toContain('no deliverable');
  });

  it('un relecteur dont le dernier texte est une ligne de narration : le relais montre son verdict', async () => {
    // La forme exacte de 5ee022d7 : la narration écrite après le refus, puis le
    // verdict accepté. La narration reste (le « dernier texte vs dernier texte
    // substantiel » de #646 n'est pas tranché ici) ; le verdict n'est plus perdu.
    const parentId = await insertJob({ channel: 'api', status: 'processing' });
    const childId = await insertJob({
      channel: 'internal',
      agentId: reviewerId,
      parentJobId: parentId,
      status: 'completed',
      result: NARRATION,
    });
    await recordVerdict(childId, { ok: false, error: 'too_big' });
    await recordVerdict(childId, VERDICT);

    await completeJob(db, parentId, '', ['assign_reviewer_a'], undefined, [
      { role: 'user', content: 'fais relire la PR #639' },
    ]);

    expect((await resultOf(parentId)).result).toBe(
      `## Reviewer A\n${NARRATION}\n\n${verdictBlock(childId)}`,
    );
  });

  it('root → Lead → Reviewer A : le relais du root porte le verdict de Reviewer A, attribué à Reviewer A', async () => {
    const rootId = await insertJob({ channel: 'api', status: 'processing' });
    const leadJob = await insertJob({
      channel: 'internal',
      agentId: leadId,
      parentJobId: rootId,
      status: 'completed',
      result: 'Changements demandés, 1 bloquant.',
    });
    const reviewerJob = await insertJob({
      channel: 'internal',
      agentId: reviewerId,
      parentJobId: leadJob,
      status: 'completed',
      result: 'Verdict émis.',
    });
    await recordVerdict(reviewerJob, VERDICT);

    await completeJob(db, rootId, '', ['assign_lead'], undefined, [
      { role: 'user', content: 'fais relire la PR #639' },
    ]);

    expect((await resultOf(rootId)).result).toBe(
      `## Lead\nChangements demandés, 1 bloquant.\n\n${verdictBlock(reviewerJob)}`,
    );
  });

  it('un enfant qui n’est pas une revue : la section est inchangée, octet pour octet', async () => {
    const parentId = await insertJob({ channel: 'api', status: 'processing' });
    await insertJob({
      channel: 'internal',
      parentJobId: parentId,
      status: 'completed',
      result: '  Longueur de Planck : 1.616255e-35 m.\n',
    });
    await insertJob({
      channel: 'internal',
      parentJobId: parentId,
      status: 'failed',
      error: 'empty_deliverable',
    });

    await completeJob(db, parentId, '', ['assign_researcher'], undefined, [
      { role: 'user', content: 'recherche' },
    ]);

    expect((await resultOf(parentId)).result).toBe(
      '## Test Agent\nLongueur de Planck : 1.616255e-35 m.\n\n---\n\n## Test Agent [failed]\nempty_deliverable',
    );
  });

  it('le chemin d’échec compile les mêmes livrables (failJob)', async () => {
    const parentId = await insertJob({ channel: 'api', status: 'processing' });
    const childId = await insertJob({
      channel: 'internal',
      agentId: reviewerId,
      parentJobId: parentId,
      status: 'completed',
      result: null,
    });
    await recordVerdict(childId, VERDICT);

    await failJob(db, parentId, 'chain_limit_exceeded');

    const row = await resultOf(parentId);
    expect(row.status).toBe('failed');
    expect(row.result).toBe(`## Reviewer A\n${verdictBlock(childId)}`);
  });
});

describe('la garde « livrable vide » lit le même livrable (#646) @cap:organiser-equipe/moteur', () => {
  it('un parent dont l’enfant n’a livré qu’un verdict termine, et son résultat porte ce verdict', async () => {
    // Avant : la garde ne lisait que la colonne `result` des enfants — NULL ici —
    // et échouait le parent en `empty_deliverable` alors que le verdict existait.
    const parentId = await insertJob({
      channel: 'api',
      messages: [{ role: 'user', content: 'fais relire la PR #639' }],
    });
    const childId = await insertJob({
      channel: 'internal',
      agentId: reviewerId,
      parentJobId: parentId,
      status: 'completed',
      result: null,
    });
    await recordVerdict(childId, VERDICT);

    const deps = makeDeps(
      makeMockLlmClient([
        {
          reasoning: 'le relecteur a livré son verdict',
          toolCalls: [
            { toolCallId: 'rr-1', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]),
    );

    const outcome = await executeJob(parentId as JobId, deps);

    expect(outcome.status).toBe('completed');
    const row = await resultOf(parentId);
    expect(row.status).toBe('completed');
    expect(row.result).toBe(`## Reviewer A\n${verdictBlock(childId)}`);
  });
});
