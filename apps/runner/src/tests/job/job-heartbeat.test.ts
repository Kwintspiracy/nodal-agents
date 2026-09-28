// job-heartbeat.test.ts — un job tenu par un runner vivant ne franchit jamais
// la fenêtre du faucheur, quoi qu'il fasse (#565).
//
// L'incident (28/09/2026) : une chaîne d'appels d'outil de ~25 s chacun. Le
// runner battait par ACTIVITÉ, à 60 s ; aucun appel ne durait assez pour
// déclencher son battement, et `reclaim-jobs` a déclaré mort un job qui
// tournait. La forme générale : un battement par job, de la prise au lâcher.
//
// Ce qui se prouve ici, sur la vraie boucle du job, la vraie base et les deux
// VRAIS faucheurs appelés toutes les 10 s d'une horloge simulée :
//
//   - une chaîne de six appels d'outil de 59 s, sur deux tours ;
//   - un job qui ne fait ni appel modèle ni appel d'outil (sa préparation dure
//     quatre minutes) ;
//   - un parent qui attend un enfant délégué, lui-même en chaîne d'outils ;
//   - un job du runtime CLI, préparation lente puis tour de dix minutes ;
//
// aucun n'est fauché, chacun finit `completed`, et le battement est rendu à
// la fin du run. Puis le mécanisme seul : un job tenu et immobile reste frais,
// un job lâché vieillit, une reprise imbriquée ne lâche pas le battement de
// celle qui l'a appelée, et un job qui n'est plus `processing` n'est pas
// rajeuni.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  inArray,
  agentJobs,
  agents,
  agentAssignments,
  agentWorkspaces,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import type { JobId } from '@nodal-agents/orchestration';
import type * as OrchestrationModule from '@nodal-agents/orchestration';
import type * as ProviderModule from '../../cli-runtime/provider.ts';
import type { CliTurnResult } from '../../cli-runtime/provider.ts';
import type { RunnerDeps } from '../../deps.ts';
import { executeJob } from '../../job/execute.ts';
import type { ExecuteJobResult } from '../../job/execute.ts';
import { holdJobHeartbeat, heldJobIds, RUNNER_HEARTBEAT_MS } from '../../job/heartbeat.ts';
import { reclaimJobsOfDeadRunners, RUNNER_LIVENESS_WINDOW_MS } from '../../cron/reclaim-jobs.ts';
import { resetOrphanedJobs } from '../../cron/reset-orphans.ts';

const { client, preparation, tourCli } = vi.hoisted(() => ({
  client: { current: null as RunnerDeps['llmClient'] | null },
  /** Combien de temps (horloge simulée) la construction du prompt prend. */
  preparation: { ms: 0 },
  /** Combien de temps (horloge simulée) le tour de la CLI prend. */
  tourCli: { ms: 0 },
}));

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      if (!client.current) throw new Error('job-heartbeat.test: no LLM client set');
      return client.current;
    },
  };
});

// La préparation du run : ni appel modèle, ni appel d'outil. Le prompt réel
// est gardé ; seule sa durée est pilotée.
vi.mock('@nodal-agents/orchestration', async (importOriginal) => {
  const actual = await importOriginal<typeof OrchestrationModule>();
  return {
    ...actual,
    buildSystemPrompt: async (...args: Parameters<typeof actual.buildSystemPrompt>) => {
      if (preparation.ms > 0) await new Promise((r) => setTimeout(r, preparation.ms));
      return actual.buildSystemPrompt(...args);
    },
  };
});

vi.mock('../../cli-runtime/provider.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderModule>();
  return {
    ...actual,
    resolveRuntime: (runtime: string) =>
      runtime === 'claude-code'
        ? {
            provider: 'claude',
            toolLabel: 'cli:fake',
            run: async (): Promise<CliTurnResult> => {
              await new Promise((r) => setTimeout(r, tourCli.ms));
              return {
                sessionId: 'sess-fake',
                finalText: 'fait',
                isError: false,
                errorDetail: null,
                usage: null,
                modelUsage: null,
                costUsd: null,
                numTurns: 1,
                durationMs: tourCli.ms,
                exitCode: 0,
                timedOut: false,
                rateLimit: null,
                permissionDenials: 0,
                unknownEventTypes: [],
              } as unknown as CliTurnResult;
            },
          }
        : null,
  };
});

/** Un appel d'outil de 59 s : sous le battement d'une seconde. */
const APPEL_MS = RUNNER_HEARTBEAT_MS - 1_000;
/** Le pas de l'horloge simulée, et du passage des faucheurs. */
const PAS_MS = 10_000;

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

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  preparation.ms = 0;
  tourCli.ms = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

type Tour =
  | { outils: Array<{ id: string; nom: string; entree?: Record<string, unknown> }> }
  | 'fin';

/** Un modèle scripté, tour par tour ; `'fin'` rend `return_result`. */
function modele(tours: Tour[]): RunnerDeps['llmClient'] {
  let i = 0;
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  };
  const mock = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const tour = tours[i] ?? 'fin';
      i += 1;
      if (tour === 'fin') {
        return {
          content: [
            { type: 'text' as const, text: 'Terminé.' },
            {
              type: 'tool-call' as const,
              toolCallId: `rr-${String(i)}`,
              toolName: 'return_result',
              input: JSON.stringify({ status: 'success' }),
            },
          ],
          finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
          usage,
          warnings: [],
        };
      }
      return {
        content: tour.outils.map((o) => ({
          type: 'tool-call' as const,
          toolCallId: o.id,
          toolName: o.nom,
          input: JSON.stringify(o.entree ?? {}),
        })),
        finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
        usage,
        warnings: [],
      };
    },
  });
  return {
    config: { provider: 'anthropic', model: 'mock' },
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args: Record<string, unknown>) =>
      generateText({ ...args, model: mock } as unknown as Parameters<typeof generateText>[0]),
    streamText: () => {
      throw new Error('not used');
    },
    generateObject: () => {
      throw new Error('not used');
    },
  } as unknown as RunnerDeps['llmClient'];
}

/** `save_memory` (toujours là, écriture : chemin SÉRIE) qui dure 59 s. */
function deps(llm: RunnerDeps['llmClient']): RunnerDeps {
  client.current = llm;
  const registry = createToolRegistry();
  registerBuiltins(registry);
  const vrai = registry.get('save_memory')!;
  registry.register({
    ...vrai,
    execute: async () => {
      await new Promise((r) => setTimeout(r, APPEL_MS));
      return { saved: true };
    },
  });
  return {
    db: db as RunnerDeps['db'],
    llmClient: llm,
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

function chaine(prefixe: string, n: number): Tour {
  return {
    outils: Array.from({ length: n }, (_v, k) => ({
      id: `${prefixe}-${String(k)}`,
      nom: 'save_memory',
      entree: { fact: `fait ${prefixe} ${String(k)}`, category: 'context', importance: 2 },
    })),
  };
}

async function nouveauJob(agentId: string): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId,
      channel: 'api',
      task: 'le long travail',
      status: 'pending',
      messages: [],
    })
    .returning({ id: agentJobs.id });
  return job!.id;
}

interface Passage {
  issue: ExecuteJobResult;
  /** Ce que les faucheurs ont fait, tous passages confondus. */
  fauches: number;
  repris: string[];
  /** Le plus vieux battement observé sur une ligne `processing`, en ms. */
  plusVieux: number;
  /** Combien de temps simulé le run a duré. */
  dureeMs: number;
}

/** Laisse les entrées-sorties RÉELLES en cours (la base) aboutir. */
async function laisserLaBaseRepondre(): Promise<void> {
  for (let k = 0; k < 5; k += 1) await new Promise((r) => setImmediate(r));
}

/**
 * Fait tourner le run en avançant l'horloge par pas de 10 s ; à chaque pas,
 * les DEUX faucheurs passent, et l'âge du battement de chaque ligne
 * `processing` surveillée est relevé. Borné en temps RÉEL (`performance`
 * n'est pas simulé) : sous une suite chargée, l'horloge simulée peut courir
 * plus vite que la base, ce qui rend le test plus sévère, jamais plus lâche.
 */
async function tourneSousLesFaucheurs(
  run: Promise<ExecuteJobResult>,
  surveilles: () => Promise<string[]>,
  maxReelMs = 50_000,
): Promise<Passage> {
  let issue: ExecuteJobResult | undefined;
  let erreur: unknown;
  let fini = false;
  run.then(
    (r) => {
      issue = r;
      fini = true;
    },
    (e: unknown) => {
      erreur = e;
      fini = true;
    },
  );
  const avertir = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const tracer = vi.spyOn(console, 'error').mockImplementation(() => {});
  const debut = Date.now();
  const debutReel = performance.now();
  let fauches = 0;
  const repris: string[] = [];
  let plusVieux = 0;
  try {
    while (!fini && performance.now() - debutReel < maxReelMs) {
      await laisserLaBaseRepondre();
      await vi.advanceTimersByTimeAsync(PAS_MS);
      const ids = await surveilles();
      if (ids.length > 0) {
        const lignes = await db
          .select({ status: agentJobs.status, updatedAt: agentJobs.updatedAt })
          .from(agentJobs)
          .where(inArray(agentJobs.id, ids));
        for (const l of lignes) {
          if (l.status !== 'processing' || !l.updatedAt) continue;
          plusVieux = Math.max(plusVieux, Date.now() - l.updatedAt.getTime());
        }
      }
      const r = await reclaimJobsOfDeadRunners(db);
      fauches += r.reclaimed;
      repris.push(...r.resumedJobIds);
      fauches += await resetOrphanedJobs(db);
    }
  } finally {
    avertir.mockRestore();
    tracer.mockRestore();
  }
  if (erreur) throw erreur;
  if (!issue) throw new Error(`run still going after ${String(maxReelMs)} ms of real time`);
  return { issue, fauches, repris, plusVieux, dureeMs: Date.now() - debut };
}

async function statut(jobId: string) {
  const [r] = await db
    .select({ status: agentJobs.status, error: agentJobs.error })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return r!;
}

describe('un job tenu par un runner vivant n’est jamais fauché (#565) @cap:organiser-equipe/moteur', () => {
  it('six appels d’outil de 59 s sur deux tours : jamais fauché, fini `completed`', async () => {
    const jobId = await nouveauJob(seed.agentId);
    const run = executeJob(jobId as JobId, deps(modele([chaine('a', 3), chaine('b', 3), 'fin'])));

    const p = await tourneSousLesFaucheurs(run, async () => [jobId]);

    expect(p.dureeMs).toBeGreaterThan(6 * APPEL_MS);
    expect({ fauches: p.fauches, repris: p.repris }).toEqual({ fauches: 0, repris: [] });
    expect(p.plusVieux).toBeLessThan(RUNNER_LIVENESS_WINDOW_MS);
    expect(p.issue.status).toBe('completed');
    expect(await statut(jobId)).toEqual({ status: 'completed', error: null });
    expect(heldJobIds()).not.toContain(jobId);
  });

  it('ni appel modèle ni appel d’outil pendant quatre minutes (préparation) : jamais fauché', async () => {
    preparation.ms = 4 * 60_000;
    const jobId = await nouveauJob(seed.agentId);
    const run = executeJob(jobId as JobId, deps(modele(['fin'])));

    const p = await tourneSousLesFaucheurs(run, async () => [jobId]);

    expect(p.dureeMs).toBeGreaterThanOrEqual(preparation.ms);
    expect({ fauches: p.fauches, repris: p.repris }).toEqual({ fauches: 0, repris: [] });
    expect(p.plusVieux).toBeLessThan(RUNNER_LIVENESS_WINDOW_MS);
    expect(await statut(jobId)).toEqual({ status: 'completed', error: null });
    expect(heldJobIds()).not.toContain(jobId);
  });

  it('un parent attend son enfant délégué, qui enchaîne des outils de 59 s : aucun des deux fauché', async () => {
    const ts = String(Date.now());
    const [parent] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Parent battement',
        slug: `parent-hb-${ts}`,
        personality: 'orchestrateur',
        llmKeyId: seed.llmKeyId,
        role: 'orchestrator',
        orchestratorMode: 'router',
        systemAgent: true,
      })
      .returning({ id: agents.id });
    const [enfant] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Enfant battement',
        slug: `enfant-hb-${ts}`,
        personality: 'travailleur',
        llmKeyId: seed.llmKeyId,
        role: 'agent',
        systemAgent: true,
      })
      .returning({ id: agents.id, slug: agents.slug });
    await db.insert(agentAssignments).values({
      orchestratorId: parent!.id,
      subAgentId: enfant!.id,
      entityId: seed.entityId,
    });
    const assign = `assign_${enfant!.slug.replace(/-/g, '_')}`;

    const parentJobId = await nouveauJob(parent!.id);
    const run = executeJob(
      parentJobId as JobId,
      deps(
        modele([
          { outils: [{ id: 'deleg', nom: assign, entree: { task: 'travaille longtemps' } }] },
          chaine('enfant', 4),
          'fin', // l'enfant rend la main
          'fin', // le parent aussi
        ]),
      ),
    );

    const arbre = async () => {
      const enfants = await db
        .select({ id: agentJobs.id })
        .from(agentJobs)
        .where(eq(agentJobs.parentJobId, parentJobId));
      return [parentJobId, ...enfants.map((e) => e.id)];
    };
    const p = await tourneSousLesFaucheurs(run, arbre);

    const ids = await arbre();
    expect(ids).toHaveLength(2);
    expect(p.dureeMs).toBeGreaterThan(4 * APPEL_MS);
    expect({ fauches: p.fauches, repris: p.repris }).toEqual({ fauches: 0, repris: [] });
    expect(p.plusVieux).toBeLessThan(RUNNER_LIVENESS_WINDOW_MS);
    expect(p.issue.status).toBe('completed');
    for (const id of ids) expect(await statut(id)).toEqual({ status: 'completed', error: null });
    for (const id of ids) expect(heldJobIds()).not.toContain(id);
  });

  it('un job du runtime CLI, trois minutes de préparation puis dix de tour : jamais fauché', async () => {
    preparation.ms = 3 * 60_000;
    tourCli.ms = 10 * 60_000;
    const dossier = mkdtempSync(join(tmpdir(), 'hb-cli-'));
    const [cli] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'CLI battement',
        slug: `cli-hb-${String(Date.now())}`,
        personality: 'cli',
        llmKeyId: seed.llmKeyId,
        role: 'agent',
        systemAgent: true,
        runtime: 'claude-code',
        cliPermissions: { mode: 'read' },
      })
      .returning({ id: agents.id });
    await db
      .insert(agentWorkspaces)
      .values({ agentId: cli!.id, label: 'Travail', path: dossier, position: 0 });

    const jobId = await nouveauJob(cli!.id);
    const run = executeJob(jobId as JobId, deps(modele([])));

    const p = await tourneSousLesFaucheurs(run, async () => [jobId]);

    expect(p.dureeMs).toBeGreaterThanOrEqual(preparation.ms + tourCli.ms);
    expect({ fauches: p.fauches, repris: p.repris }).toEqual({ fauches: 0, repris: [] });
    expect(p.plusVieux).toBeLessThan(RUNNER_LIVENESS_WINDOW_MS);
    expect(await statut(jobId)).toEqual({ status: 'completed', error: null });
    expect(heldJobIds()).not.toContain(jobId);
  });
});

describe('le battement d’un job, de la prise au lâcher (#565) @cap:organiser-equipe/moteur', () => {
  async function jobEn(status: 'processing' | 'awaiting_delegation' | 'cancelled') {
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'x',
        status,
        messages: [],
        updatedAt: new Date(),
      })
      .returning({ id: agentJobs.id });
    return job!.id;
  }
  const age = async (jobId: string) => {
    const [r] = await db
      .select({ updatedAt: agentJobs.updatedAt })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    return Date.now() - r!.updatedAt!.getTime();
  };

  it('tenu et immobile dix minutes : frais ; lâché : il vieillit', async () => {
    const jobId = await jobEn('processing');
    const lache = holdJobHeartbeat(db, jobId);
    for (let t = 0; t < 10 * 60_000; t += PAS_MS) {
      await vi.advanceTimersByTimeAsync(PAS_MS);
      expect(await age(jobId)).toBeLessThan(RUNNER_LIVENESS_WINDOW_MS);
    }
    lache();
    expect(heldJobIds()).not.toContain(jobId);
    await vi.advanceTimersByTimeAsync(RUNNER_LIVENESS_WINDOW_MS + PAS_MS);
    expect(await age(jobId)).toBeGreaterThan(RUNNER_LIVENESS_WINDOW_MS);
    const avertir = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await reclaimJobsOfDeadRunners(db).finally(() => avertir.mockRestore());
    expect(r.reclaimed).toBe(1);
    expect(await statut(jobId)).toEqual({ status: 'failed', error: 'runner_restarted' });
  });

  it('une reprise imbriquée qui rend la main ne lâche pas le battement de l’appelant', async () => {
    const jobId = await jobEn('processing');
    const exterieur = holdJobHeartbeat(db, jobId);
    const interieur = holdJobHeartbeat(db, jobId);
    interieur();
    interieur(); // deux fois : sans effet
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(await age(jobId)).toBeLessThan(RUNNER_LIVENESS_WINDOW_MS);
    expect(heldJobIds()).toContain(jobId);
    exterieur();
    expect(heldJobIds()).not.toContain(jobId);
  });

  it('un job qui n’est plus `processing` n’est pas rajeuni par le battement', async () => {
    const suspendu = await jobEn('awaiting_delegation');
    const annule = await jobEn('cancelled');
    const lacheS = holdJobHeartbeat(db, suspendu);
    const lacheA = holdJobHeartbeat(db, annule);
    await vi.advanceTimersByTimeAsync(3 * RUNNER_HEARTBEAT_MS + PAS_MS);
    expect(await age(suspendu)).toBeGreaterThanOrEqual(3 * RUNNER_HEARTBEAT_MS);
    expect(await age(annule)).toBeGreaterThanOrEqual(3 * RUNNER_HEARTBEAT_MS);
    lacheS();
    lacheA();
  });
});
