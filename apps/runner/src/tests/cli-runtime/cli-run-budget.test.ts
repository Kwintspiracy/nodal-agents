// cli-run-budget.test.ts — un tour de CLI de code ne part pas sur un run qui a déjà dépensé son plafond.
//
// Le budget de run de l'espace borne le RUN, tout l'arbre de délégation (revue
// de #836, P1). Un délégué sur le runtime claude-code ou codex n'appelle pas le
// modèle par la boucle de Nodal : son chemin (cli-runtime/run-job.ts) lit le
// même budget avant de lancer la CLI. Ces cas lisent la ligne du job et les
// lignes `cli_runs` (un tour lancé en écrit toujours une), jamais un compteur.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs, agentWorkspaces, cliRuns, entities, eq } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { CliTurnResult } from '../../cli-runtime/provider.ts';
import type * as ProviderModule from '../../cli-runtime/provider.ts';
import type * as OrchestrationModule from '@nodal-agents/orchestration';

const fakeRun = vi.fn<(opts: Record<string, unknown>) => Promise<CliTurnResult>>();

vi.mock('../../cli-runtime/provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderModule>();
  return {
    ...actual,
    resolveRuntime: (runtime: string) =>
      runtime === 'fake-claude'
        ? {
            provider: 'claude',
            run: (opts: Record<string, unknown>) => fakeRun(opts),
            toolLabel: 'cli:fake',
          }
        : null,
  };
});

vi.mock('@nodal-agents/orchestration', async (importOriginal) => {
  const actual = await importOriginal<typeof OrchestrationModule>();
  return { ...actual, buildSystemPrompt: async () => 'system prompt (test)' };
});

import { runCliRuntimeJob } from '../../cli-runtime/run-job.ts';
import type { CliRuntimeAgentRow } from '../../cli-runtime/run-job.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let root: string;
let row: CliRuntimeAgentRow;

const greenTurn = (): CliTurnResult =>
  ({
    sessionId: 'sess-fake',
    finalText: 'fait',
    isError: false,
    errorDetail: null,
    usage: null,
    modelUsage: null,
    costUsd: null,
    numTurns: 1,
    durationMs: 5,
    exitCode: 0,
    timedOut: false,
    rateLimit: null,
    permissionDenials: 0,
    unknownEventTypes: [],
  }) as unknown as CliTurnResult;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  const [a] = await db.select().from(agents).where(eq(agents.id, seed.agentId));
  if (!a) throw new Error('seed agent missing');
  row = {
    id: a.id as CliRuntimeAgentRow['id'],
    name: a.name,
    slug: a.slug,
    role: 'agent',
    personality: a.personality ?? '',
    entityId: seed.entityId as CliRuntimeAgentRow['entityId'],
    model: 'test-model',
    active: true,
    orchestratorMode: null,
    memoryTokenBudget: 4000,
    runtime: 'fake-claude',
    cliPermissions: null,
    cliDefaults: null,
  };
  await db.update(entities).set({ maxRunCostUsd: 2 }).where(eq(entities.id, seed.entityId));
});

beforeEach(async () => {
  fakeRun.mockReset();
  fakeRun.mockResolvedValue(greenTurn());
  root = await mkdtemp(join(tmpdir(), 'nodal-run-budget-'));
  await db.delete(agentWorkspaces).where(eq(agentWorkspaces.agentId, seed.agentId));
  await db.insert(agentWorkspaces).values({ agentId: seed.agentId, label: 'ws', path: root });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Une tête qui a déjà dépensé `headUsd`, et son délégué sur le runtime CLI. */
async function delegatedCliJob(headUsd: number): Promise<string> {
  const [head] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      task: 'orchestrate',
      status: 'processing',
      totalCostUsd: headUsd,
    })
    .returning({ id: agentJobs.id });
  const [child] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      task: 'go',
      status: 'processing',
      parentJobId: head!.id,
    })
    .returning({ id: agentJobs.id });
  return child!.id;
}

async function run(jobId: string) {
  return runCliRuntimeJob({
    db: db as unknown as AnyDrizzleDb,
    jobId,
    job: {
      entityId: seed.entityId,
      chatId: null,
      channel: 'dashboard',
      conversationId: null,
      task: 'go',
      triggerContext: null,
    },
    agentRow: row,
    workspaces: [{ label: 'ws', path: root }],
    claimGeneration: 0,
  });
}

describe('the run budget on the CLI runtime path @cap:voir-le-cout/moteur', () => {
  it('a delegated CLI job of a run that already spent its cap fails cost_budget_exceeded, and no CLI turn starts', async () => {
    const jobId = await delegatedCliJob(2.5);
    const result = await run(jobId);
    expect(result).toEqual({ status: 'failed', error: 'cost_budget_exceeded' });
    const [job] = await db
      .select({ status: agentJobs.status, error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(job).toEqual({ status: 'failed', error: 'cost_budget_exceeded' });
    expect(
      await db.select({ id: cliRuns.id }).from(cliRuns).where(eq(cliRuns.jobId, jobId)),
    ).toEqual([]);
  });

  it('under the cap, the same delegated CLI job runs its turn', async () => {
    const jobId = await delegatedCliJob(1.5);
    await run(jobId);
    const turns = await db.select({ id: cliRuns.id }).from(cliRuns).where(eq(cliRuns.jobId, jobId));
    expect(turns).toHaveLength(1);
    const [job] = await db
      .select({ error: agentJobs.error })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(job?.error).toBeNull();
  });
});
