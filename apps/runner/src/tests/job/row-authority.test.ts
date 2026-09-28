// row-authority.test.ts — la ligne du job fait autorité sur le droit d'agir (#566).
//
// L'incident (28/09/2026) : le faucheur a marqué un job `failed` ; sa boucle,
// qui ne relisait sa ligne qu'avant un tour et autour de l'appel modèle, a
// continué huit minutes et envoyé vingt messages de plus. Elle ne réagissait
// qu'à `cancelled`, et jamais entre deux appels d'outil du même tour.
//
// Ce qui se prouve, sur la vraie boucle et la vraie base : un autre écrivain
// change la ligne PENDANT l'appel d'outil A ; l'appel B du même tour ne
// s'exécute jamais (la liste de ce qui a réellement tourné, et les lignes
// `tool_calls`), la boucle s'arrête, et le statut posé par l'autre écrivain
// reste celui de la ligne. Pour :
//
//   - une annulation (Stop) entre deux appels série ;
//   - un fauchage (`failed`, runner_restarted) entre deux appels série ;
//   - une reprise par un AUTRE run (le faucheur remet `pending`, un autre run
//     prend le job : la ligne redit `processing`, mais plus pour celui-ci) ;
//   - la pré-passe parallèle, entre deux vagues ;
//   - une délégation demandée après l'annulation, dans le même tour ;
//   - le run REPRIS d'un parent après sa délégation (une nouvelle prise).
//
// Et ses ÉCRITURES (revue Codex de #575, passe 1) : aucune écriture du run sur
// sa ligne n'atterrit hors de sa prise. Un outil qui rend « approbation
// requise » pendant que le job est fauché ou annulé ne le fait jamais passer
// `awaiting_approval` ; une re-suspension à la reprise non plus ; le point de
// reprise de fin de tour n'écrase pas la transcription d'un autre run.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { and, eq, agentJobs, agents, agentAssignments, toolCalls } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient, LLMCallCancelledError } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { approvalRequests } from '@nodal-agents/db';
import type { JobId } from '@nodal-agents/orchestration';
import type * as OrchestrationModule from '@nodal-agents/orchestration';
import type * as NotifyModule from '../../approvals/notify.ts';
import type { RunnerDeps } from '../../deps.ts';
import { executeJob } from '../../job/execute.ts';
import { claimJob, readJobAuthority } from '../../job/state.ts';

const { client, pendant } = vi.hoisted(() => ({
  client: { current: null as RunnerDeps['llmClient'] | null },
  /** L'autre écrivain, branché à deux moments sans vérification juste avant. */
  pendant: {
    /** Pendant que la porte d'approbation d'un outil crée sa demande. */
    laDemande: null as null | ((jobId: string) => Promise<void>),
    /** Pendant la préparation du run (construction du prompt). */
    laPreparation: null as null | (() => Promise<void>),
  },
}));

vi.mock('../../approvals/notify.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof NotifyModule>();
  return {
    ...actual,
    notifyApprovalCreated: async (...args: Parameters<typeof actual.notifyApprovalCreated>) => {
      await pendant.laDemande?.(String(args[1].jobId));
    },
  };
});

vi.mock('@nodal-agents/orchestration', async (importOriginal) => {
  const actual = await importOriginal<typeof OrchestrationModule>();
  return {
    ...actual,
    buildSystemPrompt: async (...args: Parameters<typeof actual.buildSystemPrompt>) => {
      await pendant.laPreparation?.();
      return actual.buildSystemPrompt(...args);
    },
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      if (!client.current) throw new Error('row-authority.test: no LLM client set');
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

let warn: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  err = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  err.mockRestore();
  delete process.env['LLM_TOOL_CONCURRENCY'];
  delete process.env['NODALAI_APPROVAL_GRACE_MS'];
  pendant.laDemande = null;
  pendant.laPreparation = null;
});

type Appel = { id: string; nom: string; entree: Record<string, unknown> };
type Tour = Appel[] | 'fin';

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
      const appels: Appel[] =
        tour === 'fin'
          ? [{ id: `rr-${String(i)}`, nom: 'return_result', entree: { status: 'success' } }]
          : tour;
      return {
        content: [
          ...(tour === 'fin' ? [{ type: 'text' as const, text: 'Terminé.' }] : []),
          ...appels.map((a) => ({
            type: 'tool-call' as const,
            toolCallId: a.id,
            toolName: a.nom,
            input: JSON.stringify(a.entree),
          })),
        ],
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

/**
 * `save_memory` (écriture : chemin série) et `web_search` (lecture : pré-passe
 * parallèle), remplacés : chacun note ce qui a RÉELLEMENT tourné, et l'appel
 * dont le texte vaut `pendant` exécute l'écriture de l'autre écrivain.
 */
function deps(
  llm: RunnerDeps['llmClient'],
  ceQuiATourne: string[],
  pendant: (cle: string) => Promise<void>,
): RunnerDeps {
  client.current = llm;
  const registry = createToolRegistry();
  registerBuiltins(registry);
  const memoire = registry.get('save_memory')!;
  registry.register({
    ...memoire,
    execute: async (input: unknown) => {
      const cle = String((input as { fact?: unknown }).fact);
      ceQuiATourne.push(cle);
      await pendant(cle);
      return { saved: true };
    },
  });
  const recherche = registry.get('web_search')!;
  registry.register({
    ...recherche,
    execute: async (input: unknown) => {
      const cle = String((input as { query?: unknown }).query);
      ceQuiATourne.push(cle);
      await pendant(cle);
      return { results: [] };
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

const memoire = (id: string, fact: string): Appel => ({
  id,
  nom: 'save_memory',
  entree: { fact, category: 'context', importance: 2 },
});
const recherche = (id: string, query: string): Appel => ({
  id,
  nom: 'web_search',
  entree: { query },
});

async function nouveauJob(agentId = seed.agentId): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId,
      channel: 'api',
      task: 'deux gestes',
      status: 'pending',
      messages: [],
    })
    .returning({ id: agentJobs.id });
  return job!.id;
}

async function ligne(jobId: string) {
  const [r] = await db
    .select({
      status: agentJobs.status,
      error: agentJobs.error,
      result: agentJobs.result,
      messages: agentJobs.messages,
    })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  return r!;
}

/** Les appels d'outil dont l'exécution a commencé, d'après l'audit. */
async function appelsAudites(jobId: string, nom: string): Promise<string[]> {
  const rows = await db
    .select({ id: toolCalls.toolCallId, started: toolCalls.executionStarted })
    .from(toolCalls)
    .where(and(eq(toolCalls.jobId, jobId), eq(toolCalls.toolName, nom)));
  return rows.filter((r) => r.started !== false).map((r) => r.id ?? '');
}

/** Chaque appel d'outil de la transcription a son résultat. */
function appelsSansResultat(messages: unknown): string[] {
  const demandes: string[] = [];
  const rendus = new Set<string>();
  for (const m of (messages ?? []) as Array<{ role?: string; content?: unknown }>) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as Array<{ type?: string; toolCallId?: string }>) {
      if (m.role === 'assistant' && p.type === 'tool-call' && p.toolCallId)
        demandes.push(p.toolCallId);
      if (m.role === 'tool' && p.type === 'tool-result' && p.toolCallId) rendus.add(p.toolCallId);
    }
  }
  return demandes.filter((d) => !rendus.has(d));
}

describe('la ligne du job fait autorité avant chaque effet (#566) @cap:suivre-execution/moteur', () => {
  it('Stop pendant l’appel A : l’appel B du même tour ne tourne pas, le job finit `cancelled`', async () => {
    const jobId = await nouveauJob();
    const ceQuiATourne: string[] = [];
    const issue = await executeJob(
      jobId as JobId,
      deps(modele([[memoire('a', 'A'), memoire('b', 'B')], 'fin']), ceQuiATourne, async (cle) => {
        if (cle === 'A') {
          await db.update(agentJobs).set({ status: 'cancelled' }).where(eq(agentJobs.id, jobId));
        }
      }),
    );

    expect(ceQuiATourne).toEqual(['A']);
    expect(await appelsAudites(jobId, 'save_memory')).toEqual(['a']);
    expect(issue.status).toBe('cancelled');
    const r = await ligne(jobId);
    expect(r.status).toBe('cancelled');
    // Le travail fait est gardé, et la transcription reste une transcription :
    // B, jamais exécuté, a un résultat qui le dit.
    expect(appelsSansResultat(r.messages)).toEqual([]);
  });

  it('fauché pendant l’appel A : B ne tourne pas, et `failed` / runner_restarted reste la ligne', async () => {
    const jobId = await nouveauJob();
    const ceQuiATourne: string[] = [];
    const issue = await executeJob(
      jobId as JobId,
      deps(modele([[memoire('a', 'A'), memoire('b', 'B')], 'fin']), ceQuiATourne, async (cle) => {
        if (cle === 'A') {
          await db
            .update(agentJobs)
            .set({ status: 'failed', error: 'runner_restarted', result: 'posé par le faucheur' })
            .where(eq(agentJobs.id, jobId));
        }
      }),
    );

    expect(ceQuiATourne).toEqual(['A']);
    expect(await appelsAudites(jobId, 'save_memory')).toEqual(['a']);
    expect(issue.status).toBe('already_handled');
    const r = await ligne(jobId);
    expect({ status: r.status, error: r.error, result: r.result }).toEqual({
      status: 'failed',
      error: 'runner_restarted',
      result: 'posé par le faucheur',
    });
  });

  it('repris par un AUTRE run pendant A (`pending` puis nouvelle prise) : B ne tourne pas, rien n’est réécrit', async () => {
    const jobId = await nouveauJob();
    const ceQuiATourne: string[] = [];
    const lAutre = [{ role: 'user', content: 'la transcription de l’autre run' }];
    const issue = await executeJob(
      jobId as JobId,
      deps(modele([[memoire('a', 'A'), memoire('b', 'B')], 'fin']), ceQuiATourne, async (cle) => {
        if (cle !== 'A') return;
        await db
          .update(agentJobs)
          .set({ status: 'pending', messages: lAutre })
          .where(eq(agentJobs.id, jobId));
        expect(await claimJob(db, jobId)).not.toBeNull();
      }),
    );

    expect(ceQuiATourne).toEqual(['A']);
    expect(issue.status).toBe('already_handled');
    const r = await ligne(jobId);
    expect(r.status).toBe('processing');
    expect(r.messages).toEqual(lAutre);
  });

  it('pré-passe parallèle : annulé pendant la première vague, la seconde ne part pas', async () => {
    process.env['LLM_TOOL_CONCURRENCY'] = '1';
    const jobId = await nouveauJob();
    const ceQuiATourne: string[] = [];
    const issue = await executeJob(
      jobId as JobId,
      deps(
        modele([[recherche('r1', 'R1'), recherche('r2', 'R2'), recherche('r3', 'R3')], 'fin']),
        ceQuiATourne,
        async (cle) => {
          if (cle === 'R1') {
            await db.update(agentJobs).set({ status: 'cancelled' }).where(eq(agentJobs.id, jobId));
          }
        },
      ),
    );

    expect(ceQuiATourne).toEqual(['R1']);
    expect(await appelsAudites(jobId, 'web_search')).toEqual(['r1']);
    expect(issue.status).toBe('cancelled');
    const r = await ligne(jobId);
    expect(r.status).toBe('cancelled');
    expect(appelsSansResultat(r.messages)).toEqual([]);
  });

  describe('délégation', () => {
    let parentId: string;
    let assign: string;
    beforeAll(async () => {
      const ts = String(Date.now());
      const [parent] = await db
        .insert(agents)
        .values({
          entityId: seed.entityId,
          name: 'Parent autorité',
          slug: `parent-auth-${ts}`,
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
          name: 'Enfant autorité',
          slug: `enfant-auth-${ts}`,
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
      parentId = parent!.id;
      assign = `assign_${enfant!.slug.replace(/-/g, '_')}`;
    });

    const enfantsDe = async (jobId: string) =>
      db.select({ id: agentJobs.id }).from(agentJobs).where(eq(agentJobs.parentJobId, jobId));

    it('annulé pendant A, la délégation demandée dans le même tour n’est jamais créée', async () => {
      const jobId = await nouveauJob(parentId);
      const ceQuiATourne: string[] = [];
      const issue = await executeJob(
        jobId as JobId,
        deps(
          modele([
            [
              { id: 'd', nom: assign, entree: { task: 'travaille' } },
              memoire('a', 'A'), // exécuté AVANT la délégation (outils non-assign d'abord)
            ],
            'fin',
          ]),
          ceQuiATourne,
          async (cle) => {
            if (cle === 'A') {
              await db
                .update(agentJobs)
                .set({ status: 'cancelled' })
                .where(eq(agentJobs.id, jobId));
            }
          },
        ),
      );

      expect(ceQuiATourne).toEqual(['A']);
      expect(await enfantsDe(jobId)).toEqual([]);
      expect(issue.status).toBe('cancelled');
      const r = await ligne(jobId);
      expect(r.status).toBe('cancelled');
      expect(appelsSansResultat(r.messages)).toEqual([]);
    });

    it('le run REPRIS après la délégation (nouvelle prise) : fauché pendant A, B ne tourne pas', async () => {
      const jobId = await nouveauJob(parentId);
      const ceQuiATourne: string[] = [];
      const issue = await executeJob(
        jobId as JobId,
        deps(
          modele([
            [{ id: 'd', nom: assign, entree: { task: 'travaille' } }],
            'fin', // l'enfant rend la main
            [memoire('a', 'A'), memoire('b', 'B')], // le parent, repris
            'fin',
          ]),
          ceQuiATourne,
          async (cle) => {
            if (cle === 'A') {
              await db
                .update(agentJobs)
                .set({ status: 'failed', error: 'runner_restarted' })
                .where(eq(agentJobs.id, jobId));
            }
          },
        ),
      );

      expect(await enfantsDe(jobId)).toHaveLength(1);
      expect(ceQuiATourne).toEqual(['A']);
      expect(issue.status).toBe('already_handled');
      expect((await ligne(jobId)).status).toBe('failed');
      expect((await ligne(jobId)).error).toBe('runner_restarted');
    });
  });
});

describe('aucune écriture du run hors de sa prise (#566, revue Codex passe 1) @cap:suivre-execution/moteur', () => {
  /** `save_memory` soumis à approbation : la porte crée une demande et rend la main. */
  function depsSousApprobation(llm: RunnerDeps['llmClient']): RunnerDeps {
    const d = deps(llm, [], async () => {});
    d.registry.register({ ...d.registry.get('save_memory')!, defaultApproval: 'require_approval' });
    return d;
  }
  const demandeApprobation = (id: string): Appel => ({
    id,
    nom: 'save_memory',
    entree: { fact: 'à approuver', category: 'context', importance: 2, purpose: 'garder ce fait' },
  });

  it('fauché pendant la porte d’approbation : la ligne reste `failed`, jamais `awaiting_approval`', async () => {
    process.env['NODALAI_APPROVAL_GRACE_MS'] = '0';
    const jobId = await nouveauJob();
    pendant.laDemande = async (id) => {
      await db
        .update(agentJobs)
        .set({ status: 'failed', error: 'runner_restarted', result: 'posé par le faucheur' })
        .where(eq(agentJobs.id, id));
    };

    const issue = await executeJob(
      jobId as JobId,
      depsSousApprobation(modele([[demandeApprobation('g')], 'fin'])),
    );

    const r = await ligne(jobId);
    expect({ status: r.status, error: r.error, result: r.result }).toEqual({
      status: 'failed',
      error: 'runner_restarted',
      result: 'posé par le faucheur',
    });
    // Le point de reprise n'a pas atterri non plus : la transcription est celle d'avant.
    expect(r.messages).toEqual([]);
    expect(issue.status).toBe('already_handled');
  });

  it('annulé pendant la porte d’approbation : la ligne reste `cancelled`, la transcription est gardée', async () => {
    process.env['NODALAI_APPROVAL_GRACE_MS'] = '0';
    const jobId = await nouveauJob();
    pendant.laDemande = async (id) => {
      await db.update(agentJobs).set({ status: 'cancelled' }).where(eq(agentJobs.id, id));
    };

    const issue = await executeJob(
      jobId as JobId,
      depsSousApprobation(modele([[demandeApprobation('g')], 'fin'])),
    );

    expect(issue.status).toBe('cancelled');
    const r = await ligne(jobId);
    expect(r.status).toBe('cancelled');
    expect(appelsSansResultat(r.messages)).toEqual([]);
    expect((r.messages as unknown[]).length).toBeGreaterThan(0);
  });

  it('re-suspension à la reprise (une demande encore en attente) après un fauchage : `failed` reste', async () => {
    const jobId = await nouveauJob();
    await db.insert(approvalRequests).values({
      entityId: seed.entityId,
      jobId,
      agentId: seed.agentId,
      toolName: 'save_memory',
      toolInput: { fact: 'x' },
      status: 'pending',
    });
    pendant.laPreparation = async () => {
      await db
        .update(agentJobs)
        .set({ status: 'failed', error: 'runner_restarted' })
        .where(eq(agentJobs.id, jobId));
    };

    const issue = await executeJob(
      jobId as JobId,
      deps(modele(['fin']), [], async () => {}),
    );

    const r = await ligne(jobId);
    expect({ status: r.status, error: r.error }).toEqual({
      status: 'failed',
      error: 'runner_restarted',
    });
    expect(issue.status).toBe('already_handled');
  });

  it('repris par un autre run pendant le dernier appel du tour : le point de reprise n’écrase pas sa transcription', async () => {
    const jobId = await nouveauJob();
    const lAutre = [{ role: 'user', content: 'la transcription de l’autre run' }];
    const issue = await executeJob(
      jobId as JobId,
      deps(modele([[memoire('a', 'A')], 'fin']), [], async () => {
        await db
          .update(agentJobs)
          .set({ status: 'pending', messages: lAutre })
          .where(eq(agentJobs.id, jobId));
        expect(await claimJob(db, jobId)).not.toBeNull();
      }),
    );

    expect(issue.status).toBe('already_handled');
    const r = await ligne(jobId);
    expect(r.status).toBe('processing');
    expect(r.messages).toEqual(lAutre);
  });
});

// Revue de #575, passe 2 : le guetteur de l'appel au modèle avalait ses
// lectures ratées (`.catch(() => {})`) — une ligne illisible valait
// autorisation (faux vert, invariant #4). Même règle que le runtime CLI
// (#572) : chaque lecture ratée est dite, et à la cinquième d'affilée l'appel
// est coupé et le run échoue avec `job_row_unreadable`.
describe('une ligne illisible pendant l’appel au modèle arrête le run (#566) @cap:suivre-execution/moteur', () => {
  it('cinq lectures ratées d’affilée : l’appel est coupé, le job échoue `job_row_unreadable`', async () => {
    const jobId = await nouveauJob();
    let lecturesCassees = false;
    let lecturesRatees = 0;
    const d = deps(modele(['fin']), [], async () => {});
    // La base casse ses lectures pendant l'appel, et seulement elles.
    const vraieDb = d.db;
    d.db = new Proxy(vraieDb, {
      get(cible, cle, recepteur) {
        if (cle === 'select' && lecturesCassees) {
          return () => {
            lecturesRatees += 1;
            const echec = Promise.reject(new Error('connection terminated unexpectedly'));
            echec.catch(() => {});
            const chaine: Record<string, unknown> = {};
            for (const m of ['from', 'where', 'limit', 'orderBy', 'leftJoin', 'innerJoin'])
              chaine[m] = () => chaine;
            chaine['then'] = (ok: unknown, ko: unknown) =>
              echec.then(ok as never, ko as (e: unknown) => unknown);
            return chaine;
          };
        }
        return Reflect.get(cible, cle, recepteur) as unknown;
      },
    });
    // Un modèle qui écrit sans fin, jusqu'à ce qu'on coupe l'appel.
    d.llmClient = {
      ...d.llmClient,
      // Le signal d'arrêt voyage dans les OPTIONS de l'appel (second argument).
      generateText: (_requete: unknown, options: { abortSignal?: AbortSignal }) => {
        lecturesCassees = true;
        return new Promise((_ok, ko) => {
          options.abortSignal?.addEventListener('abort', () => {
            lecturesCassees = false;
            ko(new LLMCallCancelledError('mock', 'mock', ''));
          });
        });
      },
    } as unknown as RunnerDeps['llmClient'];
    client.current = d.llmClient;

    const issue = await executeJob(jobId as JobId, d);

    expect(lecturesRatees).toBe(5);
    expect(issue).toMatchObject({ status: 'failed', error: 'job_row_unreadable' });
    const r = await ligne(jobId);
    expect({ status: r.status, error: r.error }).toEqual({
      status: 'failed',
      error: 'job_row_unreadable',
    });
    // Chaque lecture ratée est DITE.
    const dites = warn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('JOB_ROW_UNREADABLE'),
    );
    expect(dites).toHaveLength(5);
  }, 40_000);
});

// Revue Codex de #575, passe 3 : l'exécution d'un appel APPROUVÉ se posait
// sans la prise du run. Repris pendant l'outil, le job l'exécutait deux fois,
// ou en perdait le résultat. Elle est désormais RÉSERVÉE par le run qui tient
// la prise, et sa fin consignée avec son résultat.
describe('un appel approuvé ne tourne qu’une fois quand le job change de run (#566) @cap:approuver-une-action/moteur', () => {
  const FAIT = 'LONG';

  async function jobAvecAppelApprouve(): Promise<{ jobId: string; demandeId: string }> {
    const entree = { fact: FAIT, category: 'context', importance: 2, purpose: 'garder ce fait' };
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'api',
        task: 'garde ce fait',
        status: 'pending',
        turn: 1,
        messages: [
          { role: 'user', content: 'garde ce fait' },
          {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolCallId: 'ap-1', toolName: 'save_memory', input: entree },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'ap-1',
                toolName: 'save_memory',
                output: { type: 'text', value: '[AWAITING_APPROVAL] tool_call_id=ap-1' },
              },
            ],
          },
        ],
      })
      .returning({ id: agentJobs.id });
    const [demande] = await db
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: job!.id,
        agentId: seed.agentId,
        toolName: 'save_memory',
        toolInput: entree,
        toolCallId: 'ap-1',
        status: 'approved',
      })
      .returning({ id: approvalRequests.id });
    return { jobId: job!.id, demandeId: demande!.id };
  }

  /** L'outil approuvé : sa PREMIÈRE exécution reste dedans jusqu'à `relacher`. */
  function outilLong() {
    let relacher!: () => void;
    const bloque = new Promise<void>((r) => (relacher = r));
    let entre!: () => void;
    const dedans = new Promise<void>((r) => (entre = r));
    let premiere = true;
    const pendant = async (cle: string) => {
      if (cle !== FAIT || !premiere) return;
      premiere = false;
      entre();
      await bloque;
    };
    return { relacher, dedans, pendant };
  }

  const resultatDe = (messages: unknown, id: string): string =>
    JSON.stringify(
      ((messages ?? []) as Array<{ role: string; content: unknown }>)
        .filter((m) => m.role === 'tool' && Array.isArray(m.content))
        .flatMap((m) => m.content as Array<{ toolCallId?: string; output?: unknown }>)
        .find((p) => p.toolCallId === id)?.output ?? null,
    );

  async function demande(id: string) {
    const [r] = await db
      .select({
        executedAt: approvalRequests.executedAt,
        executionClaim: approvalRequests.executionClaim,
        executionOutput: approvalRequests.executionOutput,
      })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, id));
    return r!;
  }

  it('repris PENDANT l’outil : il ne tourne qu’une fois, et le run suivant dit au modèle que l’issue est inconnue', async () => {
    const { jobId, demandeId } = await jobAvecAppelApprouve();
    const ceQuiATourne: string[] = [];
    const outil = outilLong();
    const d = deps(modele(['fin']), ceQuiATourne, outil.pendant);

    const runA = executeJob(jobId as JobId, d);
    await outil.dedans;
    // Le faucheur remet le job en file ; le run B le prend pendant que A est dans l'outil.
    await db.update(agentJobs).set({ status: 'pending' }).where(eq(agentJobs.id, jobId));
    const issueB = await executeJob(jobId as JobId, d);
    outil.relacher();
    const issueA = await runA;

    expect(ceQuiATourne).toEqual([FAIT]);
    expect(issueB.status).toBe('completed');
    expect(issueA.status).toBe('already_handled');
    const r = await ligne(jobId);
    expect(r.status).toBe('completed');
    expect(resultatDe(r.messages, 'ap-1')).toContain('approved_call_outcome_unknown');
    const q = await demande(demandeId);
    expect(q.executedAt).not.toBeNull();
    expect(JSON.stringify(q.executionOutput)).toContain('approved_call_outcome_unknown');
  });

  it('repris APRÈS l’outil : le résultat consigné par le premier run est repris, sans seconde exécution', async () => {
    const { jobId, demandeId } = await jobAvecAppelApprouve();
    const ceQuiATourne: string[] = [];
    const outil = outilLong();
    const d = deps(modele(['fin']), ceQuiATourne, outil.pendant);

    const runA = executeJob(jobId as JobId, d);
    await outil.dedans;
    // Le faucheur remet le job en file pendant l'outil ; A finit ensuite.
    await db.update(agentJobs).set({ status: 'pending' }).where(eq(agentJobs.id, jobId));
    outil.relacher();
    const issueA = await runA;
    const issueB = await executeJob(jobId as JobId, d);

    expect(ceQuiATourne).toEqual([FAIT]);
    expect(issueA.status).toBe('already_handled');
    expect(issueB.status).toBe('completed');
    const r = await ligne(jobId);
    expect(r.status).toBe('completed');
    // Le VRAI résultat de l'appel, pas le marqueur ni « inconnu ».
    expect(resultatDe(r.messages, 'ap-1')).toContain('saved');
    const q = await demande(demandeId);
    expect(JSON.stringify(q.executionOutput)).toContain('saved');
  });
});

describe('readJobAuthority (#566) @cap:suivre-execution/moteur', () => {
  it('à soi tant que `processing` sous sa prise ; perdu sur tout autre statut ou une autre prise', async () => {
    const jobId = await nouveauJob();
    const prise = await claimJob(db, jobId);
    expect(prise).not.toBeNull();
    expect(await readJobAuthority(db, jobId, prise!)).toEqual({ kind: 'owned' });

    for (const status of [
      'cancelled',
      'failed',
      'completed',
      'pending',
      'awaiting_approval',
    ] as const) {
      await db.update(agentJobs).set({ status }).where(eq(agentJobs.id, jobId));
      expect(await readJobAuthority(db, jobId, prise!)).toEqual({
        kind: 'lost',
        status,
        ownClaim: true,
      });
    }

    await db.update(agentJobs).set({ status: 'pending' }).where(eq(agentJobs.id, jobId));
    const autre = await claimJob(db, jobId);
    expect(autre).toBe(prise! + 1);
    expect(await readJobAuthority(db, jobId, prise!)).toEqual({
      kind: 'lost',
      status: 'processing',
      ownClaim: false,
    });
    expect(await readJobAuthority(db, jobId, autre!)).toEqual({ kind: 'owned' });
  });
});
