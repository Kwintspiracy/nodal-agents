// activity-runs-action.test.ts — la vue Activity compte des RUNS (#134).
//
// Ce que ce fichier prouve, sur une vraie base (PGlite) et sur les lignes que
// les actions rendent vraiment (invariant #5), pas sur des appels comptés :
//
//   1. un run = une ligne, ses appels comptés, quel que soit le nombre d'appels ;
//   2. les appels d'un run NE SONT PAS chargés avec la liste — la sortie d'un
//      outil n'apparaît nulle part dans ce que la liste rend ;
//   3. dépliée, la suite d'un run entrelace outils et modèles DANS L'ORDRE DU
//      TEMPS, et seulement les siens ;
//   4. la pagination des appels d'un run est interne à ce run ;
//   5. d'où vient la demande est LU (canal + provenance), jamais tapé.
//
// Mutations vérifiées avant d'écrire la suite (chacune rend ce fichier rouge) :
//   — `inTimeOrder` trié en ordre décroissant → test 3 rouge ;
//   — `listActivityRunsAction` embarquant les appels de chaque run → test 2
//     rouge (la sortie d'outil se retrouve dans la liste) ;
//   — le compte des appels lu sur `tool_calls` seul → test 1 rouge.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, toolCalls, llmCalls } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ set: () => {}, get: () => null, delete: () => {} }),
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

/**
 * L'instant de référence des runs écrits ici : une heure DEVANT l'horloge.
 *
 * `seedMinimal` crée un job daté de `now()`, et la liste rend du plus récent au
 * plus ancien. Une date en dur aurait fait basculer l'ordre attendu le jour où
 * l'horloge la dépasse — ce qui ne se serait vu qu'un matin, en CI, loin d'ici.
 */
const T0 = new Date(Date.now() + 60 * 60 * 1000);
const at = (secondes: number): Date => new Date(T0.getTime() + secondes * 1000);

/** La sortie d'outil qui ne doit JAMAIS apparaître dans la liste des runs. */
const SORTIE_OUTIL = 'marqueur-sortie-outil-qui-ne-doit-pas-voyager';

let chatRunId: string;
let cronRunId: string;
/** Le run dont deux appels portent LA MÊME date, à la milliseconde. */
let exAequoRunId: string;
// Deux ids choisis, pas tirés au sort : c'est l'id qui tranche une égalité de
// date, donc le test doit savoir lequel passe devant.
const ID_OUTIL_EX_AEQUO = '11111111-1111-4111-8111-aaaaaaaaaaaa';
const ID_MODELE_EX_AEQUO = '99999999-9999-4999-8999-ffffffffffff';

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  // Run A — une demande du chat, quatre appels entrelacés : modèle, outil,
  // modèle, outil. Écrits DANS LE DÉSORDRE exprès : si l'action rendait les
  // lignes dans l'ordre d'insertion, le test 3 le verrait.
  const [chat] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      conversationId: null,
      task: 'Résumer la veille de la semaine et la poster',
      status: 'completed',
      totalDurationMs: 4200,
      totalCostUsd: 0.0123,
      createdAt: at(0),
    })
    .returning({ id: agentJobs.id });
  chatRunId = chat!.id;

  await testDb.insert(toolCalls).values([
    {
      entityId: seed.entityId,
      jobId: chatRunId,
      toolName: 'notion_search',
      toolInput: { query: 'veille' },
      toolOutput: SORTIE_OUTIL,
      durationMs: 320,
      turn: 1,
      createdAt: at(20),
    },
    {
      entityId: seed.entityId,
      jobId: chatRunId,
      toolName: 'send_telegram',
      toolInput: { text: 'ok' },
      toolOutput: 'sent',
      durationMs: 110,
      turn: 2,
      createdAt: at(40),
    },
  ]);

  await testDb.insert(llmCalls).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      jobId: chatRunId,
      source: 'job',
      provider: 'openrouter',
      modelEffective: 'glm-5.3',
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: 0.008,
      durationMs: 900,
      turn: 1,
      createdAt: at(10),
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      jobId: chatRunId,
      source: 'job',
      provider: 'openrouter',
      modelEffective: 'glm-5.3',
      inputTokens: 1500,
      outputTokens: 120,
      costUsd: 0.0043,
      durationMs: 700,
      turn: 2,
      createdAt: at(30),
    },
  ]);

  // Run B — une routine, avec sa provenance, et 60 appels d'outil pour que sa
  // pagination interne ait quelque chose à couper.
  const [cron] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'cron',
      task: 'Veille quotidienne',
      status: 'processing',
      triggerContext: {
        type: 'cron',
        scheduleName: 'Veille AcmeCorp',
        prevRunAt: null,
      },
      createdAt: at(100),
    })
    .returning({ id: agentJobs.id });
  cronRunId = cron!.id;

  await testDb.insert(toolCalls).values(
    Array.from({ length: 60 }, (_, i) => ({
      entityId: seed.entityId,
      jobId: cronRunId,
      toolName: 'http_request',
      toolInput: { url: `https://example.test/${i}` },
      toolOutput: `page ${i}`,
      durationMs: 10,
      turn: 1,
      createdAt: at(200 + i),
    })),
  );

  // Run C — deux appels ÉCRITS À LA MÊME MILLISECONDE, un d'outil et un de
  // modèle. C'est le cas que les autres runs ne peuvent pas poser : leurs
  // dates sont toutes distinctes, donc le départage d'une égalité n'y est
  // jamais exercé, et l'ordre y resterait stable même sans départage. Daté
  // AVANT les deux autres pour ne pas déplacer ce que la pagination attend.
  const [exAequo] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      task: 'Deux appels dans la même milliseconde',
      status: 'completed',
      createdAt: at(-1000),
    })
    .returning({ id: agentJobs.id });
  exAequoRunId = exAequo!.id;

  const MEME_INSTANT = at(-900);
  await testDb.insert(toolCalls).values({
    id: ID_OUTIL_EX_AEQUO,
    entityId: seed.entityId,
    jobId: exAequoRunId,
    toolName: 'ex_aequo_tool',
    toolInput: {},
    toolOutput: 'ok',
    turn: 1,
    createdAt: MEME_INSTANT,
  });
  await testDb.insert(llmCalls).values({
    id: ID_MODELE_EX_AEQUO,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId: exAequoRunId,
    source: 'job',
    provider: 'openrouter',
    modelEffective: 'ex-aequo-model',
    turn: 1,
    createdAt: MEME_INSTANT,
  });
});

describe('listActivityRunsAction @cap:suivre-execution/moteur', () => {
  it('rend UNE ligne par run, avec le nombre de ses appels (outils ET modèles)', async () => {
    const { listActivityRunsAction } = await import('../actions.ts');
    const r = await listActivityRunsAction({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Le job de `seedMinimal` n'a aucun appel : il est là, et à zéro.
    const ids = r.data.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);

    const chat = r.data.items.find((i) => i.id === chatRunId);
    const cron = r.data.items.find((i) => i.id === cronRunId);
    expect(chat, 'le run du chat manque dans la liste').toBeDefined();
    // 2 appels d'outil + 2 appels de modèle : un compte des DEUX tables.
    expect(chat!.callCount).toBe(4);
    expect(cron!.callCount).toBe(60);
    expect(r.data.items.find((i) => i.id === seed.jobId)!.callCount).toBe(0);
  });

  it('dit d’où vient la demande, lu sur le canal et la provenance', async () => {
    const { listActivityRunsAction } = await import('../actions.ts');
    const r = await listActivityRunsAction({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const chat = r.data.items.find((i) => i.id === chatRunId)!;
    const cron = r.data.items.find((i) => i.id === cronRunId)!;
    expect(chat.origin).toEqual({ label: 'Dashboard', detail: null });
    expect(cron.origin).toEqual({ label: 'Automation', detail: 'Veille AcmeCorp' });
  });

  it('ne charge AUCUN appel avec la liste', async () => {
    const { listActivityRunsAction } = await import('../actions.ts');
    const r = await listActivityRunsAction({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // La preuve est dans ce que la liste rend : la sortie d'un outil du run
    // n'est nulle part dedans. Une liste qui embarquerait ses appels la
    // porterait forcément.
    expect(JSON.stringify(r.data)).not.toContain(SORTIE_OUTIL);
    expect(JSON.stringify(r.data)).not.toContain('notion_search');
    // Et ce qu'elle rend d'un run, ce sont ses sept éléments, pas ses appels.
    const chat = r.data.items.find((i) => i.id === chatRunId)!;
    expect(Object.keys(chat)).not.toContain('calls');
    expect(chat.task).toContain('veille');
    expect(chat.status).toBe('completed');
    expect(chat.durationMs).toBe(4200);
    expect(chat.costUsd).toBeCloseTo(0.0123, 5);
  });

  it('pagine des RUNS : une page de 2 ne rend que deux runs, la suivante le troisième', async () => {
    const { listActivityRunsAction } = await import('../actions.ts');
    const p1 = await listActivityRunsAction({ page: 1, pageSize: 2 });
    const p2 = await listActivityRunsAction({ page: 2, pageSize: 2 });
    expect(p1.ok && p2.ok).toBe(true);
    if (!p1.ok || !p2.ok) return;

    expect(p1.data.items).toHaveLength(2);
    expect(p1.data.hasMore).toBe(true);
    // Le plus récent d'abord : la routine, puis le run du chat.
    expect(p1.data.items[0]!.id).toBe(cronRunId);
    expect(p1.data.items[1]!.id).toBe(chatRunId);
    expect(p2.data.items.map((i) => i.id)).not.toContain(cronRunId);
    expect(p2.data.hasMore).toBe(false);
  });

  it('le filtre par outil garde les RUNS qui ont appelé cet outil, une fois chacun', async () => {
    const { listActivityRunsAction } = await import('../actions.ts');
    const r = await listActivityRunsAction({ toolName: 'http_request' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 60 appels du même outil dans le même run : UNE ligne, pas soixante.
    expect(r.data.items.map((i) => i.id)).toEqual([cronRunId]);
  });
});

describe('listRunCallsAction @cap:suivre-execution/moteur', () => {
  it('rend les appels d’UN run, outils et modèles ENTRELACÉS dans l’ordre du temps', async () => {
    const { listRunCallsAction } = await import('../actions.ts');
    const r = await listRunCallsAction({ jobId: chatRunId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.data.total).toBe(4);
    // Écrits modèles d'abord puis outils ; rendus dans l'ordre des horloges.
    expect(r.data.items.map((c) => c.kind)).toEqual(['model', 'tool', 'model', 'tool']);
    const dates = r.data.items.map((c) => new Date(c.createdAt!).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => a - b));

    const premier = r.data.items[0]!;
    expect(premier.kind === 'model' && premier.model).toBe('glm-5.3');
    const second = r.data.items[1]!;
    expect(second.kind === 'tool' && second.step.toolName).toBe('notion_search');
    // L'appel porte ce que le bloc du chat sait montrer : sa sortie, son issue.
    expect(second.kind === 'tool' && second.step.outputText).toBe(SORTIE_OUTIL);
    expect(second.kind === 'tool' && second.step.outcome).toBe('success');
  });

  it('à date ÉGALE, l’id tranche : l’ordre ne change pas d’un chargement à l’autre', async () => {
    const { listRunCallsAction } = await import('../actions.ts');
    // Deux fois la même lecture : deux appels de la même milliseconde ne
    // doivent pas échanger leur place selon ce que la base a rendu en premier.
    const un = await listRunCallsAction({ jobId: exAequoRunId });
    const deux = await listRunCallsAction({ jobId: exAequoRunId });
    expect(un.ok && deux.ok).toBe(true);
    if (!un.ok || !deux.ok) return;

    expect(un.data.items).toHaveLength(2);
    expect(new Date(un.data.items[0]!.createdAt!).getTime()).toBe(
      new Date(un.data.items[1]!.createdAt!).getTime(),
    );
    // Le plus petit id passe devant — ici l'appel d'outil.
    expect(un.data.items.map((c) => c.id)).toEqual([ID_OUTIL_EX_AEQUO, ID_MODELE_EX_AEQUO]);
    expect(un.data.items.map((c) => c.kind)).toEqual(['tool', 'model']);
    expect(deux.data.items.map((c) => c.id)).toEqual(un.data.items.map((c) => c.id));
  });

  it('ne rend que les appels de CE run', async () => {
    const { listRunCallsAction } = await import('../actions.ts');
    const r = await listRunCallsAction({ jobId: cronRunId, pageSize: 200 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.items).toHaveLength(60);
    expect(JSON.stringify(r.data.items)).not.toContain(SORTIE_OUTIL);
  });

  it('pagine DANS un run : 50 appels, puis les dix suivants', async () => {
    const { listRunCallsAction } = await import('../actions.ts');
    const p1 = await listRunCallsAction({ jobId: cronRunId, page: 1, pageSize: 50 });
    const p2 = await listRunCallsAction({ jobId: cronRunId, page: 2, pageSize: 50 });
    expect(p1.ok && p2.ok).toBe(true);
    if (!p1.ok || !p2.ok) return;

    expect(p1.data.items).toHaveLength(50);
    expect(p1.data.hasMore).toBe(true);
    expect(p1.data.total).toBe(60);
    expect(p2.data.items).toHaveLength(10);
    expect(p2.data.hasMore).toBe(false);
    // Deux pages, aucun appel en double, et la suite du temps.
    const ids = [...p1.data.items, ...p2.data.items].map((c) => c.id);
    expect(new Set(ids).size).toBe(60);
    const dates = [...p1.data.items, ...p2.data.items].map((c) => new Date(c.createdAt!).getTime());
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
  });

  it('refuse un run qui n’est pas de cette entité', async () => {
    const { listRunCallsAction } = await import('../actions.ts');
    const r = await listRunCallsAction({ jobId: '11111111-1111-4111-8111-111111111111' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });
});
