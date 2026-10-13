// restart-resume.test.ts — un job `processing` survit à un redémarrage du
// runner et reprend à son dernier tour sauvegardé (#443, « long runs » 4).
//
// Ce qui se prouve, sur la vraie boucle du job et la vraie base : le job meurt
// pendant son tour 5 (l'appel au modèle ne revient jamais, le battement
// s'arrête), le faucheur le remet en `pending` à son tour 4 sauvegardé, le
// runner le reprend, et il finit au tour 9 — les quatre tours d'avant intacts,
// une seule trace de reprise. Et la borne : un job qui a épuisé ses reprises
// échoue avec son code, au lieu de reprendre sans fin.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  and,
  eq,
  sql,
  agentJobs,
  agents,
  agentWorkspaces,
  approvalRequests,
  toolCalls,
} from '@nodal-agents/db';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createToolRegistry,
  registerBuiltins,
  executeTool as executeToolReel,
} from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import { executeJob } from '../../job/execute.ts';
import { saveCheckpoint as saveCheckpointReel } from '../../job/state.ts';
import {
  reclaimJobsOfDeadRunners,
  MAX_RESTART_RESUMES,
  RESTART_RESUME_LIMIT_CODE,
  RESTART_AFTER_SIDE_EFFECT_CODE,
  RUNTIME_NOT_RESUMABLE_CODE,
  RUNNER_LIVENESS_WINDOW_MS,
} from '../../cron/reclaim-jobs.ts';

const { client } = vi.hoisted(() => ({
  client: { current: null as RunnerDeps['llmClient'] | null },
}));

/**
 * La mort du runner APRÈS les outils d'un tour et AVANT sa sauvegarde : la
 * sauvegarde du tour nommé ne revient jamais (#443, revue Codex passe 1).
 */
const { mortALaSauvegarde } = vi.hoisted(() => ({
  mortALaSauvegarde: { tour: null as number | null, relacher: () => {} },
}));

vi.mock('../../job/state.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../job/state.ts')>();
  return {
    ...actual,
    saveCheckpoint: async (...args: Parameters<typeof actual.saveCheckpoint>) => {
      if (mortALaSauvegarde.tour !== null && args[2].turn === mortALaSauvegarde.tour) {
        return new Promise<void>((_, reject) => {
          mortALaSauvegarde.relacher = () => reject(new Error('the runner is gone'));
        });
      }
      return actual.saveCheckpoint(...args);
    },
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      if (!client.current) throw new Error('restart-resume.test: no LLM client set');
      return client.current;
    },
  };
});

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

/** Un tour du modèle : un appel d'outil (un tour qui continue) ou le mot de la fin. */
type Tour =
  | { outil: string; nom?: string; entree?: Record<string, unknown> }
  | { fin: string }
  | 'meurt';

/**
 * Un modèle scripté, tour par tour. `'meurt'` : l'appel ne revient jamais —
 * c'est le runner qui meurt pendant ce tour. `relacher` rend la main au run
 * abandonné à la fin du test, pour qu'il ne survive pas au fichier.
 */
function modele(tours: Tour[]): { llm: RunnerDeps['llmClient']; relacher: () => void } {
  let i = 0;
  let relacher: () => void = () => {};
  const suspendu = new Promise<never>((_, reject) => {
    relacher = () => reject(new Error('the runner that held this call is gone'));
  });
  suspendu.catch(() => {});
  const mock = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const tour = tours[i - 1]!;
      const usage = {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      };
      if (typeof tour === 'object' && 'outil' in tour) {
        return {
          content: [
            {
              type: 'tool-call' as const,
              toolCallId: tour.outil,
              toolName: tour.nom ?? 'list_models',
              input: JSON.stringify(tour.entree ?? {}),
            },
          ],
          finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      }
      const fin = tour as { fin: string };
      return {
        content: [
          { type: 'text' as const, text: fin.fin },
          {
            type: 'tool-call' as const,
            toolCallId: 'rr-fin',
            toolName: 'return_result',
            input: JSON.stringify({ status: 'success' }),
          },
        ],
        finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
        usage,
        warnings: [],
      };
    },
  });
  const llm = {
    config: { provider: 'anthropic', model: 'mock' },
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args: Record<string, unknown>) => {
      const tour = tours[i];
      i += 1;
      if (tour === 'meurt') return suspendu;
      return generateText({ ...args, model: mock } as unknown as Parameters<
        typeof generateText
      >[0]);
    },
    streamText: () => {
      throw new Error('not used');
    },
    generateObject: () => {
      throw new Error('not used');
    },
  } as unknown as RunnerDeps['llmClient'];
  return { llm, relacher };
}

function deps(
  llm: RunnerDeps['llmClient'],
  remplacer?: (registry: ReturnType<typeof createToolRegistry>) => void,
): RunnerDeps {
  client.current = llm;
  const registry = createToolRegistry();
  registerBuiltins(registry);
  remplacer?.(registry);
  return {
    db: db as RunnerDeps['db'],
    llmClient: llm,
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

async function row(jobId: string) {
  const [r] = await db
    .select({
      status: agentJobs.status,
      turn: agentJobs.turn,
      error: agentJobs.error,
      result: agentJobs.result,
      messages: agentJobs.messages,
      resumedFromTurn: agentJobs.resumedFromTurn,
      restartResumes: agentJobs.restartResumes,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return r!;
}

/** Les ids d'appels d'outil que la transcription porte, dans l'ordre. */
function appelsDans(messages: unknown): string[] {
  const ids: string[] = [];
  for (const m of (messages ?? []) as Array<{ role?: string; content?: unknown }>) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const p of m.content as Array<{ type?: string; toolCallId?: string }>) {
      if (p.type === 'tool-result' && p.toolCallId) ids.push(p.toolCallId);
    }
  }
  return ids;
}

const TACHE = 'Fais le long travail';

describe('un job survit à un redémarrage du runner (#443) @cap:organiser-equipe/moteur', () => {
  it('mort au tour 5, repris à son tour 4 sauvegardé, fini au tour 9, les tours d’avant intacts', async () => {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal',
        task: TACHE,
        status: 'pending',
        messages: [{ role: 'user', content: TACHE }],
      })
      .returning({ id: agentJobs.id });
    const jobId = job!.id;
    const avertissements: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      avertissements.push(a.map(String).join(' '));
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Premier runner : quatre tours complets, puis il meurt pendant le cinquième.
    const avant = modele([
      { outil: 't1' },
      { outil: 't2' },
      { outil: 't3' },
      { outil: 't4' },
      'meurt',
    ]);
    const abandonne = executeJob(jobId as JobId, deps(avant.llm)).catch(() => undefined);
    const limite = Date.now() + 15_000;
    while ((await row(jobId)).turn !== 4 && Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 100));
    const aLaMort = await row(jobId);
    expect(aLaMort.status).toBe('processing');
    expect(aLaMort.turn).toBe(4);

    // Plus de battement : le runner qui revient voit un job que personne ne tient.
    await db
      .update(agentJobs)
      .set({ updatedAt: new Date(Date.now() - RUNNER_LIVENESS_WINDOW_MS - 60_000) })
      .where(eq(agentJobs.id, jobId));
    const reprise = await reclaimJobsOfDeadRunners(db);
    expect(reprise.resumedJobIds).toContain(jobId);
    const reprisLigne = await row(jobId);
    expect(reprisLigne).toMatchObject({ status: 'pending', resumedFromTurn: 4, restartResumes: 1 });

    // Le runner revenu reprend le job : tours 5 à 8, puis la fin au tour 9.
    const apres = modele([
      { outil: 't5' },
      { outil: 't6' },
      { outil: 't7' },
      { outil: 't8' },
      { fin: 'Travail terminé.' },
    ]);
    const outcome = await executeJob(jobId as JobId, deps(apres.llm));

    avant.relacher();
    await abandonne;
    warn.mockRestore();
    err.mockRestore();

    expect(outcome.status).toBe('completed');
    const fin = await row(jobId);
    expect(fin.status).toBe('completed');
    expect(fin.turn).toBe(9);
    expect(fin.resumedFromTurn).toBe(4);
    // Les tours 1 à 4 sont là, intacts et dans l'ordre, puis ceux d'après.
    const appels = appelsDans(fin.messages);
    expect(appels.slice(0, 4)).toEqual(['t1', 't2', 't3', 't4']);
    expect(appels).toEqual(expect.arrayContaining(['t5', 't6', 't7', 't8']));
    expect(appels.filter((a) => a === 't1')).toHaveLength(1);
    // La tâche n'a pas été rejouée : un seul message utilisateur égal à elle.
    const taches = (fin.messages as Array<{ role: string; content: unknown }>).filter(
      (m) => m.role === 'user' && m.content === TACHE,
    );
    expect(taches).toHaveLength(1);
    // Une seule trace de reprise.
    expect(avertissements.filter((l) => l.includes('resumed_after_restart'))).toHaveLength(1);
  }, 60_000);

  it('un job qui a épuisé ses reprises échoue avec son code, au lieu de reprendre sans fin', async () => {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal',
        task: TACHE,
        status: 'processing',
        turn: 3,
        restartResumes: MAX_RESTART_RESUMES,
        messages: [{ role: 'user', content: TACHE }],
        updatedAt: new Date(Date.now() - RUNNER_LIVENESS_WINDOW_MS - 60_000),
      })
      .returning({ id: agentJobs.id });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const reprise = await reclaimJobsOfDeadRunners(db).finally(() => warn.mockRestore());

    expect(reprise.resumedJobIds).not.toContain(job!.id);
    const r = await row(job!.id);
    expect(r.status).toBe('failed');
    expect(r.error).toBe(RESTART_RESUME_LIMIT_CODE);
    expect(r.result ?? '').toContain(
      `already resumed ${String(MAX_RESTART_RESUMES)} times after a restart`,
    );
  });

  it('un job mort avant son premier tour sauvegardé n’a pas de point de reprise : il échoue', async () => {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal',
        task: TACHE,
        status: 'processing',
        turn: 0,
        messages: [{ role: 'user', content: TACHE }],
        updatedAt: new Date(Date.now() - RUNNER_LIVENESS_WINDOW_MS - 60_000),
      })
      .returning({ id: agentJobs.id });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await reclaimJobsOfDeadRunners(db).finally(() => warn.mockRestore());

    const r = await row(job!.id);
    expect(r).toMatchObject({ status: 'failed', error: 'runner_restarted', resumedFromTurn: null });
  });
});

// Revue Codex de #443, passe 1 : rejouer le tour interrompu REFAISAIT un effet
// déjà fait (un envoi, une écriture, une commande) que le point de reprise ne
// porte pas. La reprise n'est permise que si ce tour n'a fait que lire.
describe('la reprise ne refait jamais un effet (#443) @cap:organiser-equipe/moteur', () => {
  /** Le job fait quatre tours de lecture, puis un cinquième qui meurt avant sa sauvegarde. */
  async function mortApresLeTour5(
    tour5: Tour,
    tour1: Tour = { outil: 'a1' },
  ): Promise<{ jobId: string; relacher: () => void; abandonne: Promise<unknown> }> {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal',
        task: TACHE,
        status: 'pending',
        messages: [{ role: 'user', content: TACHE }],
      })
      .returning({ id: agentJobs.id });
    const jobId = job!.id;
    mortALaSauvegarde.tour = 5;
    const avant = modele([tour1, { outil: 'a2' }, { outil: 'a3' }, { outil: 'a4' }, tour5]);
    const abandonne = executeJob(jobId as JobId, deps(avant.llm)).catch(() => undefined);
    // Le tour 5 a exécuté ses outils : sa ligne `tool_calls` est écrite.
    const limite = Date.now() + 15_000;
    for (;;) {
      const [l] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(toolCalls)
        .where(and(eq(toolCalls.jobId, jobId), eq(toolCalls.turn, 5)));
      if ((l?.n ?? 0) > 0 || Date.now() > limite) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 100));
    expect((await row(jobId)).turn).toBe(4);
    await db
      .update(agentJobs)
      .set({ updatedAt: new Date(Date.now() - RUNNER_LIVENESS_WINDOW_MS - 60_000) })
      .where(eq(agentJobs.id, jobId));
    return {
      jobId,
      relacher: () => {
        mortALaSauvegarde.tour = null;
        mortALaSauvegarde.relacher();
        avant.relacher();
      },
      abandonne,
    };
  }

  it('un outil qui écrit, mort après l’effet et avant la sauvegarde : pas de reprise, l’effet existe une fois', async () => {
    const dossier = mkdtempSync(join(tmpdir(), 'restart-effect-'));
    const [ws] = await db
      .insert(agentWorkspaces)
      .values({ agentId: seed.agentId, label: 'Travail', path: dossier, position: 0 })
      .returning({ id: agentWorkspaces.id });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const mort = await mortApresLeTour5({
        outil: 'w5',
        nom: 'file_write',
        entree: { path: 'effet.txt', content: 'une fois' },
      });

      const reprise = await reclaimJobsOfDeadRunners(db);
      mort.relacher();
      await mort.abandonne;

      expect(reprise.resumedJobIds).not.toContain(mort.jobId);
      const r = await db
        .select({
          status: agentJobs.status,
          error: agentJobs.error,
          result: agentJobs.result,
          restartBlockedBy: agentJobs.restartBlockedBy,
          resumedFromTurn: agentJobs.resumedFromTurn,
        })
        .from(agentJobs)
        .where(eq(agentJobs.id, mort.jobId));
      expect(r[0]).toMatchObject({
        status: 'failed',
        error: RESTART_AFTER_SIDE_EFFECT_CODE,
        restartBlockedBy: ['file_write'],
        resumedFromTurn: null,
      });
      expect(r[0]!.result ?? '').toContain(
        'not resumed, the interrupted turn had already run: file_write',
      );
      // L'effet existe UNE fois : le fichier, et une seule exécution de l'outil.
      expect(readFileSync(join(dossier, 'effet.txt'), 'utf8')).toBe('une fois');
      const ecritures = await db
        .select({ id: toolCalls.id })
        .from(toolCalls)
        .where(and(eq(toolCalls.jobId, mort.jobId), eq(toolCalls.toolName, 'file_write')));
      expect(ecritures).toHaveLength(1);
    } finally {
      warn.mockRestore();
      err.mockRestore();
      await db.delete(agentWorkspaces).where(eq(agentWorkspaces.id, ws!.id));
    }
  }, 60_000);

  // Ce qui a été écrit AVANT le point de reprise ne compte pas : un tour 1
  // qui a écrit un fichier, sauvegardé depuis, ne bloque pas la reprise d'un
  // tour 5 qui n'a fait que lire. C'est l'ORDRE qui tranche (passe 3).
  it('une écriture d’un tour déjà sauvegardé ne bloque pas la reprise', async () => {
    const dossier = mkdtempSync(join(tmpdir(), 'restart-before-'));
    const [ws] = await db
      .insert(agentWorkspaces)
      .values({ agentId: seed.agentId, label: 'Travail', path: dossier, position: 0 })
      .returning({ id: agentWorkspaces.id });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const mort = await mortApresLeTour5(
        { outil: 'r5b' },
        { outil: 'w1', nom: 'file_write', entree: { path: 'avant.txt', content: 'tour 1' } },
      );

      const reprise = await reclaimJobsOfDeadRunners(db);

      expect(reprise.resumedJobIds).toContain(mort.jobId);
      expect(await row(mort.jobId)).toMatchObject({ status: 'pending', resumedFromTurn: 4 });
      mortALaSauvegarde.tour = null;
    } finally {
      warn.mockRestore();
      err.mockRestore();
      await db.delete(agentWorkspaces).where(eq(agentWorkspaces.id, ws!.id));
    }
  }, 60_000);

  it('un tour interrompu qui n’a fait que lire est repris', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const mort = await mortApresLeTour5({ outil: 'r5' });

      const reprise = await reclaimJobsOfDeadRunners(db);

      expect(reprise.resumedJobIds).toContain(mort.jobId);
      expect(await row(mort.jobId)).toMatchObject({ status: 'pending', resumedFromTurn: 4 });
      // Le runner abandonné n'est PAS relâché : un vrai runner mort ne revient
      // pas écrire, et le relâcher ici lui ferait échouer le job repris.
      mortALaSauvegarde.tour = null;
    } finally {
      warn.mockRestore();
      err.mockRestore();
    }
  }, 60_000);

  it('un runtime sans point de reprise Nodal échoue, et le dit par son code', async () => {
    const [cli] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Agent CLI',
        slug: `agent-cli-${Date.now()}`,
        personality: 'p',
        role: 'agent',
        active: true,
        runtime: 'claude-code',
      })
      .returning({ id: agents.id });
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: cli!.id,
        channel: 'internal',
        task: TACHE,
        status: 'processing',
        turn: 3,
        messages: [{ role: 'user', content: TACHE }],
        updatedAt: new Date(Date.now() - RUNNER_LIVENESS_WINDOW_MS - 60_000),
      })
      .returning({ id: agentJobs.id });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const reprise = await reclaimJobsOfDeadRunners(db).finally(() => warn.mockRestore());

    expect(reprise.resumedJobIds).not.toContain(job!.id);
    const r = await row(job!.id);
    expect(r).toMatchObject({ status: 'failed', error: RUNTIME_NOT_RESUMABLE_CODE });
    expect(r.result ?? '').toContain('runtime claude-code cannot resume');
  });
});

// Revue Codex de #443, passe 2 : la ligne d'audit s'écrivait APRÈS l'outil. Une
// mort entre l'effet et cette ligne ne laissait aucune trace, et la reprise
// rejouait l'effet. Une MARQUE d'intention est écrite avant tout outil qui ne
// fait pas que lire ; le faucheur la voit.
describe('une mort entre l’effet et sa ligne d’audit ne rejoue pas l’effet (#443) @cap:organiser-equipe/moteur', () => {
  it('file_write fait son effet puis le runner meurt avant l’audit : pas de reprise, un seul effet', async () => {
    const dossier = mkdtempSync(join(tmpdir(), 'restart-audit-'));
    const [ws] = await db
      .insert(agentWorkspaces)
      .values({ agentId: seed.agentId, label: 'Travail', path: dossier, position: 0 })
      .returning({ id: agentWorkspaces.id });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const [job] = await db
        .insert(agentJobs)
        .values({
          entityId: seed.entityId,
          agentId: seed.agentId,
          channel: 'internal',
          task: TACHE,
          status: 'pending',
          messages: [{ role: 'user', content: TACHE }],
        })
        .returning({ id: agentJobs.id });
      const jobId = job!.id;
      const avant = modele([
        { outil: 'b1' },
        { outil: 'b2' },
        { outil: 'b3' },
        { outil: 'b4' },
        { outil: 'w5', nom: 'file_write', entree: { path: 'effet.txt', content: 'une fois' } },
      ]);
      // L'outil fait son VRAI effet, puis le runner meurt : rien ne revient,
      // ni le résultat, ni la ligne d'audit écrite après lui.
      void executeJob(
        jobId as JobId,
        deps(avant.llm, (registry) => {
          const vrai = registry.get('file_write')!;
          registry.register({
            ...vrai,
            execute: async (input: unknown, c: Parameters<typeof vrai.execute>[1]) => {
              await vrai.execute(input, c);
              return new Promise<never>(() => {});
            },
          });
        }),
      ).catch(() => undefined);
      const effet = join(dossier, 'effet.txt');
      const limite = Date.now() + 15_000;
      while (!existsSync(effet) && Date.now() < limite) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 100));
      await db
        .update(agentJobs)
        .set({ updatedAt: new Date(Date.now() - RUNNER_LIVENESS_WINDOW_MS - 60_000) })
        .where(eq(agentJobs.id, jobId));

      const reprise = await reclaimJobsOfDeadRunners(db);

      expect(reprise.resumedJobIds).not.toContain(jobId);
      const [r] = await db
        .select({
          status: agentJobs.status,
          error: agentJobs.error,
          restartBlockedBy: agentJobs.restartBlockedBy,
        })
        .from(agentJobs)
        .where(eq(agentJobs.id, jobId));
      expect(r).toEqual({
        status: 'failed',
        error: RESTART_AFTER_SIDE_EFFECT_CODE,
        restartBlockedBy: ['file_write'],
      });
      expect(readFileSync(effet, 'utf8')).toBe('une fois');
      // La marque : UNE ligne, écrite avant l'outil, sans sortie — « peut-être fait ».
      const marques = await db
        .select({ output: toolCalls.toolOutput, turn: toolCalls.turn })
        .from(toolCalls)
        .where(and(eq(toolCalls.jobId, jobId), eq(toolCalls.toolName, 'file_write')));
      expect(marques).toEqual([{ output: null, turn: 5 }]);
    } finally {
      warn.mockRestore();
      err.mockRestore();
      await db.delete(agentWorkspaces).where(eq(agentWorkspaces.id, ws!.id));
    }
  }, 60_000);
});

// Même trou pour une APPROBATION : sa demande est posée avant sa ligne d'audit.
// Un job `processing` qui porte une demande en attente l'a posée pendant le
// tour interrompu (une demande d'un tour précédent l'aurait suspendu) : le
// rejouer reposerait la question, et deux « oui » feraient deux exécutions.
describe('une demande d’approbation en attente empêche la reprise (#443) @cap:organiser-equipe/moteur', () => {
  it('pas de reprise, et la demande est nommée dans le fait', async () => {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal',
        task: TACHE,
        status: 'processing',
        turn: 4,
        messages: [{ role: 'user', content: TACHE }],
        updatedAt: new Date(Date.now() - RUNNER_LIVENESS_WINDOW_MS - 60_000),
      })
      .returning({ id: agentJobs.id });
    await db.insert(approvalRequests).values({
      entityId: seed.entityId,
      jobId: job!.id,
      agentId: seed.agentId,
      toolName: 'run_command',
      toolInput: { command: 'npm publish' },
      status: 'pending',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const reprise = await reclaimJobsOfDeadRunners(db).finally(() => warn.mockRestore());

    expect(reprise.resumedJobIds).not.toContain(job!.id);
    const [r] = await db
      .select({
        status: agentJobs.status,
        error: agentJobs.error,
        blocked: agentJobs.restartBlockedBy,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, job!.id));
    expect(r).toEqual({
      status: 'failed',
      error: RESTART_AFTER_SIDE_EFFECT_CODE,
      blocked: ['run_command'],
    });
  });
});

// Revue Codex de #443, passe 3 : le REJEU d'un appel approuvé écrit sa marque
// au tour déjà sauvegardé. Le faucheur, qui comptait par numéro de tour
// (turn > sauvegardé), ne la voyait pas : il reprenait le job, et la requête
// toujours « approuvée, non exécutée » était exécutée une seconde fois. Il
// compte désormais par ORDRE d'écriture, depuis le point de reprise.
describe('une marque posée après le point de reprise, quel que soit son tour (#443) @cap:organiser-equipe/moteur', () => {
  it('tour 5 suspendu sur run_command, approuvé, rejoué, mort avant executed_at : pas de reprise', async () => {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal',
        task: TACHE,
        status: 'pending',
        turn: 5,
        messages: [{ role: 'user', content: TACHE }],
      })
      .returning({ id: agentJobs.id });
    const jobId = job!.id;
    // Le tour 5, suspendu sur son approbation, est SAUVEGARDÉ : c'est le point
    // de reprise (la vraie sauvegarde, qui pose l'ordre qu'elle couvre).
    await saveCheckpointReel(db as never, jobId, {
      messages: [{ role: 'user', content: TACHE }],
      turn: 5,
      chainCount: 0,
      toolsUsed: [],
    });
    await db.insert(approvalRequests).values({
      entityId: seed.entityId,
      jobId,
      agentId: seed.agentId,
      toolName: 'run_command',
      toolInput: { command: 'npm publish' },
      status: 'approved',
    });
    // Le rejeu : le job repart, écrit la marque de run_command AU TOUR 5, fait
    // l'effet, et le runner meurt avant de poser executed_at.
    await db.insert(toolCalls).values({
      entityId: seed.entityId,
      jobId,
      toolName: 'run_command',
      riskLevel: 'destructive',
      toolInput: { command: 'npm publish' },
      toolOutput: null,
      turn: 5,
    });
    await db
      .update(agentJobs)
      .set({
        status: 'processing',
        updatedAt: new Date(Date.now() - RUNNER_LIVENESS_WINDOW_MS - 60_000),
      })
      .where(eq(agentJobs.id, jobId));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const reprise = await reclaimJobsOfDeadRunners(db).finally(() => warn.mockRestore());

    expect(reprise.resumedJobIds).not.toContain(jobId);
    const [r] = await db
      .select({
        status: agentJobs.status,
        error: agentJobs.error,
        blocked: agentJobs.restartBlockedBy,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(r).toEqual({
      status: 'failed',
      error: RESTART_AFTER_SIDE_EFFECT_CODE,
      blocked: ['run_command'],
    });
  });
});

// Revue Codex de #443, passe 4 : le faucheur comptait TOUTE ligne non-read
// postérieure au point de reprise, y compris celles que la porte écrit pour un
// appel REFUSÉ, qui n'a jamais tourné (règle block, refus déjà prononcé,
// purpose manquant). Le job échouait en disant que l'outil « had already
// run » : c'était faux. Seule la marque posée juste avant \`tool.execute\`
// (\`execution_started\`) compte.
describe('un appel refusé par la porte n’est pas un effet (#443) @cap:organiser-equipe/moteur', () => {
  it('run_command bloqué par une règle, enregistré après le point de reprise, puis mort : reprise', async () => {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal',
        task: TACHE,
        status: 'pending',
        turn: 4,
        messages: [{ role: 'user', content: TACHE }],
      })
      .returning({ id: agentJobs.id });
    const jobId = job!.id;
    await saveCheckpointReel(db as never, jobId, {
      messages: [{ role: 'user', content: TACHE }],
      turn: 4,
      chainCount: 0,
      toolsUsed: [],
    });
    // La VRAIE porte refuse l'appel et écrit sa ligne : l'outil ne tourne pas.
    const registry = createToolRegistry();
    registerBuiltins(registry);
    const refus = await executeToolReel(
      registry.get('run_command')!,
      { command: 'echo hi', purpose: 'dire bonjour' },
      {
        jobId,
        agentId: seed.agentId,
        entityId: seed.entityId,
        db: db as never,
        jobChatId: null,
        turn: 5,
      },
      {
        approvalRules: [
          {
            id: 'bloque',
            toolName: 'run_command',
            action: 'block',
            agentId: seed.agentId,
            entityId: seed.entityId,
          },
        ],
        onApprovalRequired: async () => {},
      },
    );
    expect(refus.outcome).toBe('error');
    await db
      .update(agentJobs)
      .set({
        status: 'processing',
        updatedAt: new Date(Date.now() - RUNNER_LIVENESS_WINDOW_MS - 60_000),
      })
      .where(eq(agentJobs.id, jobId));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const reprise = await reclaimJobsOfDeadRunners(db).finally(() => warn.mockRestore());

    expect(reprise.resumedJobIds).toContain(jobId);
    const r = await row(jobId);
    expect(r).toMatchObject({ status: 'pending', resumedFromTurn: 4 });
    expect(r.result ?? '').not.toContain('had already run');
  });
});

// Revue Codex passe 3 de #660 : une question d'un serveur MCP en attente
// n'est pas un effet. La compter comme une demande d'approbation faisait
// échouer en `restart_after_side_effect` un job qui pouvait reprendre ; ce que
// l'appel MCP a fait se lit, lui, à sa propre marque (tool_calls).
describe('une question d’un serveur en attente n’empêche pas la reprise @cap:organiser-equipe/moteur', () => {
  it('le job reprend à son tour sauvegardé, et la question meurt avec l’appel', async () => {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'internal',
        task: TACHE,
        status: 'processing',
        turn: 4,
        messages: [{ role: 'user', content: TACHE }],
        updatedAt: new Date(Date.now() - RUNNER_LIVENESS_WINDOW_MS - 60_000),
      })
      .returning({ id: agentJobs.id });
    const [question] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: job!.id,
        agentId: seed.agentId,
        toolName: 'printer__order',
        toolInput: { server: 'printer', message: 'How?', requestedSchema: { type: 'object' } },
        kind: 'elicitation',
        status: 'pending',
        executedAt: new Date(),
      })
      .returning({ id: approvalRequests.id });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const reprise = await reclaimJobsOfDeadRunners(db).finally(() => warn.mockRestore());

    expect(reprise.resumedJobIds).toContain(job!.id);
    expect(await row(job!.id)).toMatchObject({ status: 'pending', resumedFromTurn: 4 });
    const [q] = await db
      .select({ status: approvalRequests.status, resolvedBy: approvalRequests.resolvedBy })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, question!.id));
    expect(q).toEqual({ status: 'expired', resolvedBy: 'system:runner_restarted' });
  });
});
