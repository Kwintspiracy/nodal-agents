// intent-cli-runtime.test.ts — la CINQUIÈME surface d'écriture (plan
// « Vérifier & Corriger », T17 / D8) : le runtime CLI écrit sans jamais
// traverser executeTool, donc l'intention de mutation se pose dans
// run-job.ts (et son jumeau run-chat.ts) entre la prise des verrous et le
// spawn. Ce fichier attaque le CÂBLAGE : le binding est injecté (aucun CLI
// réel), et toutes les assertions sont des lignes relues en base.

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
  codeProjects,
  conversations,
  jobDeliverableVerificationState,
  workspaceLocks,
  eq,
} from '@nodal-agents/db';
import { projectKey, normalizePath } from '@nodal-agents/shared';
import type { CliTurnResult } from '../../cli-runtime/provider.ts';
import type * as ProviderModule from '../../cli-runtime/provider.ts';
import type * as OrchestrationModule from '@nodal-agents/orchestration';

// Le binding est INJECTÉ par le tableau des runtimes : `fake-cli` rend un
// binding dont `run` est ce spy — c'est le seul point où un CLI serait lancé.
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

// Le prompt n'est pas ce qu'on teste : l'assemblage réel lit une dizaine de
// tables et n'apporte rien à la preuve du câblage.
vi.mock('@nodal-agents/orchestration', async (importOriginal) => {
  const actual = await importOriginal<typeof OrchestrationModule>();
  return { ...actual, buildSystemPrompt: async () => 'system prompt (test)' };
});

import { runCliRuntimeJob } from '../../cli-runtime/run-job.ts';
import type { CliRuntimeAgentRow } from '../../cli-runtime/run-job.ts';
import { runCliRuntimeChatTurn } from '../../cli-runtime/run-chat.ts';

let db: TestDb;
let pg: { exec(sql: string): Promise<unknown> };
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let root: string;
let alpha: string;
let beta: string;
let baseAgent: CliRuntimeAgentRow;

const keyOf = (p: string): string => projectKey(normalizePath(p));

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
  pg = spun.pg;
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
  root = await mkdtemp(join(tmpdir(), 'nodal-intent-cli-'));
  alpha = join(root, 'alpha');
  beta = join(root, 'beta');
  await mkdir(alpha, { recursive: true });
  await mkdir(beta, { recursive: true });
  // Chaque dossier porte un manifeste : c'est LUI le projet.
  await writeFile(join(alpha, 'package.json'), '{}');
  await writeFile(join(beta, 'package.json'), '{}');
  await db.delete(workspaceLocks);
  await db.delete(jobDeliverableVerificationState);
  await db.delete(codeProjects);
  await db.delete(agentWorkspaces).where(eq(agentWorkspaces.agentId, seed.agentId));
});

afterEach(async () => {
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

const statesOf = (jobId: string) =>
  db
    .select({
      canonicalKey: jobDeliverableVerificationState.canonicalKey,
      dirtyGeneration: jobDeliverableVerificationState.dirtyGeneration,
      verifiedGeneration: jobDeliverableVerificationState.verifiedGeneration,
      decisionStatus: jobDeliverableVerificationState.decisionStatus,
    })
    .from(jobDeliverableVerificationState)
    .where(eq(jobDeliverableVerificationState.jobId, jobId));

const locksHeld = () => db.select({ path: workspaceLocks.workspacePath }).from(workspaceLocks);

const jobStatus = async (jobId: string): Promise<string | null> => {
  const [row] = await db
    .select({ status: agentJobs.status })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return row?.status ?? null;
};

describe('run-job : l’intention AVANT binding.run', () => {
  it('write : le binding LÈVE, la ligne d’état existe quand même (dirty 1, verified NULL) et les verrous sont rendus', async () => {
    const jobId = await newJob();
    fakeRun.mockRejectedValueOnce(new Error('binding exploded'));

    await expect(runJob(jobId, 'write', [alpha])).rejects.toThrow('binding exploded');

    expect(fakeRun).toHaveBeenCalledTimes(1);
    const rows = await statesOf(jobId);
    expect(rows).toEqual([
      {
        canonicalKey: keyOf(alpha),
        dirtyGeneration: 1,
        verifiedGeneration: null,
        decisionStatus: 'dirty',
      },
    ]);
    expect(await locksHeld()).toEqual([]);
  });

  it('read : aucune intention, aucune ligne code_projects', async () => {
    const jobId = await newJob();
    fakeRun.mockResolvedValueOnce(greenTurn());

    const outcome = await runJob(jobId, 'read', [alpha]);

    expect(outcome.status).toBe('completed');
    expect(await statesOf(jobId)).toEqual([]);
    expect(await db.select().from(codeProjects)).toEqual([]);
  });

  it('tous les dossiers attachés : deux workspaces ⇒ deux lignes, clés croissantes', async () => {
    const jobId = await newJob();
    fakeRun.mockResolvedValueOnce(greenTurn());

    const outcome = await runJob(jobId, 'write', [beta, alpha]);

    expect(outcome.status).toBe('completed');
    const keys = (await statesOf(jobId)).map((r) => r.canonicalKey);
    expect(keys.length).toBe(2);
    expect([...keys].sort()).toEqual([keyOf(alpha), keyOf(beta)].sort());
    expect(await locksHeld()).toEqual([]);
  });

  it('échec d’intention ⇒ le CLI ne démarre pas, le job reste non terminal, les verrous sont rendus', async () => {
    const jobId = await newJob();
    fakeRun.mockResolvedValueOnce(greenTurn());
    // La table d'état retirée sous les pieds du helper : un échec RÉEL, pas
    // un mock — c'est le seam de run-job qui doit refuser le spawn.
    await pg.exec('ALTER TABLE job_deliverable_verification_state RENAME TO jdvs_hidden_t17;');
    try {
      await expect(runJob(jobId, 'write', [alpha])).rejects.toThrow(/^verification_intent_failed:/);
    } finally {
      await pg.exec('ALTER TABLE jdvs_hidden_t17 RENAME TO job_deliverable_verification_state;');
    }
    expect(fakeRun).not.toHaveBeenCalled();
    expect(await jobStatus(jobId)).toBe('processing');
    expect(await locksHeld()).toEqual([]);
  });

  it('job déjà terminal (annulé) ⇒ le CLI ne démarre pas', async () => {
    const jobId = await newJob();
    await db.update(agentJobs).set({ status: 'cancelled' }).where(eq(agentJobs.id, jobId));
    fakeRun.mockResolvedValueOnce(greenTurn());

    await expect(runJob(jobId, 'write', [alpha])).rejects.toThrow(
      'verification_intent_failed:intent_already_terminal',
    );
    expect(fakeRun).not.toHaveBeenCalled();
    expect(await statesOf(jobId)).toEqual([]);
    expect(await locksHeld()).toEqual([]);
  });
});

describe('run-chat : le jumeau, sans jobId', () => {
  it('pas de jobId ⇒ aucune ligne, code journalisé, et le tour va quand même jusqu’à binding.run', async () => {
    await db.insert(agentWorkspaces).values({
      agentId: seed.agentId,
      label: 'alpha',
      path: alpha,
      position: 0,
    });
    // Depuis P6, le tour charge le contexte de sa CONVERSATION avant d'appeler
    // le CLI : il lui faut donc une vraie ligne. `conv-t17` n'en était pas un —
    // il ne l'a jamais été, l'ancien chemin ne le lisait simplement jamais sur
    // la branche en erreur.
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, origin: 'user' })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('insert conversation');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Un tour en erreur : le test s'arrête après le binding, sans écrire de
    // message de chat (pas de conversation à mettre à jour ici).
    fakeRun.mockResolvedValueOnce({ ...greenTurn(), isError: true, errorDetail: 'stop' });
    try {
      const result = await runCliRuntimeChatTurn({
        db: db as unknown as Parameters<typeof runCliRuntimeChatTurn>[0]['db'],
        entityId: seed.entityId,
        agentRow: baseAgent,
        conversationId: conv.id,
        message: 'écris',
      });
      expect(result.ok).toBe(false);
      expect(fakeRun).toHaveBeenCalledTimes(1);
      const logged = warn.mock.calls.map((c) => c.map(String).join(' '));
      expect(logged.some((l) => l.includes('VERIFICATION_NO_JOB_CONTEXT surface=cliRuntime'))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
    expect(await db.select().from(jobDeliverableVerificationState)).toEqual([]);
    expect(await locksHeld()).toEqual([]);
  });
});

describe('run-job : le REGISTRE des projets, APRÈS binding.run (revue passe 27)', () => {
  /** `alpha` déclaré comme projet ENREGISTRÉ (P5) : c'est à lui qu'un tour réussi se rattache. */
  async function alphaEnregistre(): Promise<string> {
    const [row] = await db
      .insert(codeProjects)
      .values({
        entityId: seed.entityId,
        projectPath: normalizePath(alpha),
        projectKey: keyOf(alpha),
        displayName: 'Alpha',
        agentId: seed.agentId,
        registeredAt: new Date(),
        registeredFrom: 'spaces',
      })
      .returning({ id: codeProjects.id });
    if (!row) throw new Error('insert projet');
    return row.id;
  }
  const projetDuJob = async (jobId: string): Promise<string | null> => {
    const [row] = await db
      .select({ projectId: agentJobs.projectId })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    return row?.projectId ?? null;
  };

  it('un tour RÉUSSI dans un projet enregistré rattache le job', async () => {
    const projetId = await alphaEnregistre();
    const jobId = await newJob();
    fakeRun.mockResolvedValueOnce(greenTurn());

    const outcome = await runJob(jobId, 'write', [alpha]);

    expect(outcome.status).toBe('completed');
    expect(await projetDuJob(jobId)).toBe(projetId);
  });

  it('le binding LÈVE : rien n’a été produit, le job ne porte aucun projet', async () => {
    await alphaEnregistre();
    const jobId = await newJob();
    fakeRun.mockRejectedValueOnce(new Error('binding exploded'));

    await expect(runJob(jobId, 'write', [alpha])).rejects.toThrow('binding exploded');
    expect(await projetDuJob(jobId)).toBeNull();
  });

  it('un tour en ERREUR ne rattache pas non plus', async () => {
    await alphaEnregistre();
    const jobId = await newJob();
    fakeRun.mockResolvedValueOnce({ ...greenTurn(), isError: true, errorDetail: 'stop' });

    const outcome = await runJob(jobId, 'write', [alpha]);

    expect(outcome.status).not.toBe('completed');
    expect(await projetDuJob(jobId)).toBeNull();
  });

  it('en mode read, un tour réussi ne rattache rien : rien n’a été écrit', async () => {
    await alphaEnregistre();
    const jobId = await newJob();
    fakeRun.mockResolvedValueOnce(greenTurn());

    await runJob(jobId, 'read', [alpha]);

    expect(await projetDuJob(jobId)).toBeNull();
  });
});
