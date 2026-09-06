// checkpoint-cli-runtime.test.ts — le harnais de code prend-il RÉELLEMENT son
// instantané avant d'écrire ? (P11, plan « De la maquette au produit »)
//
// Le chemin CLI ne traverse jamais `executeTool` : le filet du seam ne s'y
// déclenche pas, et l'agent qui écrit le plus travaillait sans état d'avant.
//
// Ce fichier attaque le CÂBLAGE, pas la fonction. La ligne `job_checkpoints`
// est relue DEPUIS L'INTÉRIEUR du faux `run` : ce qui est prouvé n'est pas
// qu'une photo existe à la fin du tour, c'est qu'elle existait AVANT que la CLI
// touche au disque. Le sha inscrit est comparé à celui du magasin réel.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  agentJobs,
  agentWorkspaces,
  cliRuns,
  codeProjects,
  jobCheckpoints,
  jobDeliverableVerificationState,
  toolCalls,
  workspaceLocks,
  and,
  eq,
} from '@nodal-agents/db';
import { listCheckpoints } from '@nodal-agents/checkpoints';
import type { CliTurnResult } from '../../cli-runtime/provider.ts';
import type { ClaudeTurnEvent } from '../../cli-runtime/claude-turn.ts';
import type * as ProviderModule from '../../cli-runtime/provider.ts';
import type * as OrchestrationModule from '@nodal-agents/orchestration';

const fakeRun = vi.fn<(opts: unknown) => Promise<CliTurnResult>>();

vi.mock('../../cli-runtime/provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderModule>();
  return {
    ...actual,
    resolveRuntime: (runtime: string) =>
      runtime === 'fake-cli'
        ? { provider: 'claude', run: (opts: unknown) => fakeRun(opts), toolLabel: 'cli:fake' }
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
let store: string;
let alpha: string;
let beta: string;
let baseAgent: CliRuntimeAgentRow;
const storeAvant = process.env['NODALAI_CHECKPOINTS_ROOT'];

const greenTurn = (): CliTurnResult =>
  ({
    sessionId: 'sess-fake',
    finalText: 'done',
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
  const spun = await spinUpTestDb();
  db = spun.db;
  seed = await seedMinimal(db);
  const [row] = await db.select().from(agents).where(eq(agents.id, seed.agentId));
  if (!row) throw new Error('seed agent missing');
  baseAgent = {
    id: row.id as CliRuntimeAgentRow['id'],
    name: row.name,
    slug: row.slug,
    role: 'agent',
    personality: row.personality ?? '',
    entityId: seed.entityId as CliRuntimeAgentRow['entityId'],
    model: 'test-model',
    active: true,
    orchestratorMode: null,
    memoryTokenBudget: 4000,
    runtime: 'fake-cli',
    cliPermissions: { mode: 'write' },
    cliDefaults: null,
  };
});

beforeEach(async () => {
  fakeRun.mockReset();
  root = await mkdtemp(join(tmpdir(), 'nodal-cp-cli-'));
  store = join(root, 'checkpoints');
  process.env['NODALAI_CHECKPOINTS_ROOT'] = store;
  alpha = join(root, 'alpha');
  beta = join(root, 'beta');
  await mkdir(alpha, { recursive: true });
  await mkdir(beta, { recursive: true });
  await writeFile(join(alpha, 'code.txt'), 'avant alpha\n');
  await writeFile(join(beta, 'code.txt'), 'avant beta\n');
  await db.delete(workspaceLocks);
  await db.delete(jobCheckpoints);
  await db.delete(cliRuns);
  await db.delete(jobDeliverableVerificationState);
  await db.delete(codeProjects);
  await db.delete(agentWorkspaces).where(eq(agentWorkspaces.agentId, seed.agentId));
});

afterEach(async () => {
  if (storeAvant === undefined) delete process.env['NODALAI_CHECKPOINTS_ROOT'];
  else process.env['NODALAI_CHECKPOINTS_ROOT'] = storeAvant;
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

async function newJob(): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'écris quelque chose',
      status: 'processing',
    })
    .returning({ id: agentJobs.id });
  if (!job) throw new Error('job insert failed');
  return job.id;
}

function runJob(jobId: string, mode: 'read' | 'write', workspaces: string[]) {
  return runCliRuntimeJob({
    db: db as unknown as Parameters<typeof runCliRuntimeJob>[0]['db'],
    jobId,
    job: {
      entityId: seed.entityId,
      chatId: null,
      channel: 'api',
      conversationId: null,
      task: 'go',
      triggerContext: null,
    },
    agentRow: { ...baseAgent, cliPermissions: { mode } },
    workspaces: workspaces.map((path, i) => ({ label: `ws${i}`, path })),
  });
}

const rowsOf = (jobId: string) =>
  db
    .select({
      turn: jobCheckpoints.turn,
      workspace: jobCheckpoints.workspace,
      sha: jobCheckpoints.sha,
    })
    .from(jobCheckpoints)
    .where(eq(jobCheckpoints.jobId, jobId));

describe('run-job : l’instantané AVANT binding.run (P11)', () => {
  it('write : chaque dossier a DÉJÀ sa ligne quand la CLI démarre, avec le sha du magasin', async () => {
    const jobId = await newJob();
    // Relu DEPUIS le faux `run` : après coup, une ligne posée trop tard aurait
    // exactement la même apparence.
    let vuPendantLeTour: Array<{ turn: number; workspace: string; sha: string }> = [];
    fakeRun.mockImplementationOnce(async () => {
      vuPendantLeTour = await rowsOf(jobId);
      return greenTurn();
    });

    const outcome = await runJob(jobId, 'write', [alpha, beta]);
    expect(outcome.status).toBe('completed');

    expect(vuPendantLeTour.map((r) => r.workspace).sort()).toEqual([alpha, beta].sort());
    // Premier tour du job : aucune ligne cli_runs avant lui.
    expect(vuPendantLeTour.map((r) => r.turn)).toEqual([1, 1]);

    for (const w of [alpha, beta]) {
      const cps = await listCheckpoints(store, w);
      expect(cps.length, `${w} n'a pas été photographié`).toBeGreaterThan(0);
      const ligne = vuPendantLeTour.find((r) => r.workspace === w);
      expect(ligne!.sha, `${w} : la ligne ne pointe pas l'instantané réellement pris`).toBe(
        cps[0]!.sha,
      );
    }
  });

  it('le numéro de tour suit les tours DÉJÀ joués (cli_runs)', async () => {
    const jobId = await newJob();
    fakeRun.mockResolvedValue(greenTurn());

    await runJob(jobId, 'write', [alpha]);
    // Le premier tour a écrit sa ligne cli_runs : le suivant est le tour 2.
    // L'arbre n'a pas bougé (la fausse CLI n'écrit rien), donc `snapshot` rend
    // null — et la ligne doit tout de même porter le sha de l'instantané EXISTANT.
    await writeFile(join(alpha, 'code.txt'), 'après le tour 1\n');
    await runJob(jobId, 'write', [alpha]);
    await runJob(jobId, 'write', [alpha]);

    const rows = await rowsOf(jobId);
    expect(rows.map((r) => r.turn).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    const t2 = rows.find((r) => r.turn === 2)!;
    const t3 = rows.find((r) => r.turn === 3)!;
    expect(t3.sha, 'un tour sur un arbre inchangé doit porter le sha existant').toBe(t2.sha);
  });

  it('read : aucune ligne, aucun instantané — un tour qui ne peut pas écrire n’a pas besoin de filet', async () => {
    const jobId = await newJob();
    fakeRun.mockResolvedValueOnce(greenTurn());

    const outcome = await runJob(jobId, 'read', [alpha]);
    expect(outcome.status).toBe('completed');
    expect(await rowsOf(jobId)).toEqual([]);
    expect(await listCheckpoints(store, alpha)).toEqual([]);
  });

  it('un instantané qui ÉCHOUE refuse le tour et rend les verrous', async () => {
    // Le contrat entier, repris du seam : un filet qui échoue en silence est
    // pire que pas de filet. Magasin rendu inutilisable — un chemin dont le
    // parent est un FICHIER.
    const bloque = join(root, 'fichier-pas-dossier');
    await writeFile(bloque, 'je ne suis pas un dossier');
    process.env['NODALAI_CHECKPOINTS_ROOT'] = join(bloque, 'checkpoints');

    const jobId = await newJob();
    fakeRun.mockResolvedValue(greenTurn());

    await expect(runJob(jobId, 'write', [alpha])).rejects.toThrow(/checkpoint_failed/);

    // La CLI n'a rien reçu : le refus est AVANT le spawn.
    expect(fakeRun.mock.calls).toEqual([]);
    expect(await rowsOf(jobId)).toEqual([]);
    expect(
      await db.select({ path: workspaceLocks.workspacePath }).from(workspaceLocks),
      'les verrous sont restés pris après un refus',
    ).toEqual([]);
  });
});

describe('run-job : la ligne d’audit du harnais porte le tour de son instantané (passe 42)', () => {
  it('une écriture du harnais a le MÊME `turn` que la ligne job_checkpoints — sinon la route ne retrouve jamais l’état d’avant', async () => {
    const jobId = await newJob();
    fakeRun.mockImplementationOnce(async (opts: unknown) => {
      const { onEvent } = opts as { onEvent: (e: ClaudeTurnEvent) => void };
      onEvent({
        kind: 'tool_use',
        toolUseId: 'tu-p42',
        toolName: 'Write',
        input: { file_path: `${alpha}/src/a.ts` },
      });
      onEvent({ kind: 'tool_result', toolUseId: 'tu-p42', output: 'ok' });
      return greenTurn();
    });

    const outcome = await runJob(jobId, 'write', [alpha]);
    expect(outcome.status).toBe('completed');

    const [audit] = await db
      .select({ turn: toolCalls.turn, toolName: toolCalls.toolName })
      .from(toolCalls)
      .where(and(eq(toolCalls.jobId, jobId), eq(toolCalls.toolCallId, 'tu-p42')));
    expect(audit?.toolName).toBe('cli:Write');
    const [cp] = await rowsOf(jobId);
    expect(cp?.turn).toBe(1);
    expect(audit?.turn, 'la ligne d’audit ne porte pas le tour de l’instantané').toBe(cp!.turn);
  });
});
