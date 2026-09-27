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
import { eq, agentJobs, agents } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { JobId } from '@nodal-agents/orchestration';
import type { RunnerDeps } from '../../deps.ts';
import { executeJob } from '../../job/execute.ts';
import {
  reclaimJobsOfDeadRunners,
  MAX_RESTART_RESUMES,
  RESTART_RESUME_LIMIT_CODE,
  RUNNER_LIVENESS_WINDOW_MS,
} from '../../cron/reclaim-jobs.ts';

const { client } = vi.hoisted(() => ({
  client: { current: null as RunnerDeps['llmClient'] | null },
}));

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
type Tour = { outil: string } | { fin: string } | 'meurt';

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
              toolName: 'list_models',
              input: '{}',
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

function deps(llm: RunnerDeps['llmClient']): RunnerDeps {
  client.current = llm;
  const registry = createToolRegistry();
  registerBuiltins(registry);
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
