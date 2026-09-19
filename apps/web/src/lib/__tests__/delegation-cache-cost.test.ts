// delegation-cache-cost.test.ts — #54, contre une VRAIE base.
//
// Le ticket décrit trois appels d'Alfred, aux heures exactes que ce fichier
// sème : 14:19:15, puis 14:52:57 (33 minutes après, le temps que le délégué
// travaille), puis 14:53:06 (9 secondes après). À la reprise le cache du
// fournisseur avait expiré et 35 000 jetons sont repassés au tarif plein.
//
// Ce fichier rejoue les JETONS et les HEURES du ticket, qui y sont écrits, et
// NON ses montants en dollars : le ticket ne nomme pas son modèle, et ses
// 0,0399 $ pour 35 k jetons d'entrée désignent un modèle bien moins cher que
// `claude-opus-5`. Les `cost_usd` semés ici sont donc ceux de `claude-opus-5`
// au catalogue (5 / 25 / 0,5 / 6,25 $ par million), pour que la facture du run
// et le surcoût de la reprise se comparent sur la même grille — mélanger les
// deux ferait dire au test un rapport qui ne veut rien dire.
//
// CE QUE CE FICHIER PROUVE — et pourquoi la version pure ne suffit pas :
//   1. Les colonnes existent et remontent. La page d'un run lit `llm_calls`
//      par une requête qui, jusqu'à cette PR, ne sélectionnait ni le job, ni
//      le fournisseur, ni la date : la règle ne pouvait rien voir. Seul un
//      aller-retour en base le prouve.
//   2. Le chiffre rendu est celui du ticket : UNE reprise, 35 200 jetons.
//   3. Les appels du DÉLÉGUÉ ne fabriquent pas de reprise fantôme, alors
//      qu'ils sont dans la même lecture que ceux du parent (la page agrège le
//      job ET sa descendance).
//   4. Trois appels rapprochés sur le même job ne perdent rien.
//
// Mutations vérifiées :
//   - `jobId` retiré du `select` de `getSpaceConversationAction` → le point 2
//     rougit (plus aucune reprise) ;
//   - `createdAt` retiré du même `select` → le point 2 rougit ;
//   - le groupement par job retiré de `cacheLostOnResume` → le point 3 rougit
//     (l'appel du délégué se glisse entre deux appels du parent).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, llmCalls } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** Le run d'Alfred du ticket : trois appels, une délégation au milieu. */
let alfredJobId = '';
/** Un run sans délégation : trois appels en une minute, rien de perdu. */
let serreJobId = '';

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
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
      userId: seed?.userId ?? 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

const actions = () => import('../actions.ts');

/** Les trois heures du ticket #54, à la seconde. */
const TOUR_1 = new Date('2026-08-21T14:19:15Z');
const TOUR_2 = new Date('2026-08-21T14:52:57Z');
const TOUR_3 = new Date('2026-08-21T14:53:06Z');

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  const [alfred] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      task: 'Prépare la note et fais-la relire',
      status: 'completed',
      createdAt: TOUR_1,
      completedAt: TOUR_3,
    })
    .returning();
  alfredJobId = alfred!.id;

  // La DÉLÉGATION : c'est elle qui fait durer 33 minutes l'écart entre le tour
  // 1 et le tour 2 du parent.
  const [delegue] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'internal',
      task: 'Relis la note',
      status: 'completed',
      parentJobId: alfredJobId,
      createdAt: new Date('2026-08-21T14:19:40Z'),
      completedAt: TOUR_2,
    })
    .returning();

  await testDb.insert(llmCalls).values([
    // Tour 1 — le préfixe est mis en cache, rien n'est relu.
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      jobId: alfredJobId,
      source: 'job',
      turn: 1,
      modelEffective: 'claude-opus-5',
      provider: 'anthropic',
      inputTokens: 35_200,
      outputTokens: 420,
      cachedTokens: 0,
      cacheCreationTokens: 35_200,
      // 35 200 jetons écrits en cache × 6,25 $/M + 420 en sortie × 25 $/M.
      costUsd: 0.2305,
      durationMs: 8_100,
      createdAt: TOUR_1,
    },
    // Tour 2 — 33 minutes plus tard, le cache a expiré : rien n'est relu, tout
    // est refacturé, et le préfixe est remis en cache.
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      jobId: alfredJobId,
      source: 'job',
      turn: 2,
      modelEffective: 'claude-opus-5',
      provider: 'anthropic',
      inputTokens: 35_400,
      outputTokens: 310,
      cachedTokens: 0,
      cacheCreationTokens: 35_400,
      // 35 400 écrits × 6,25 $/M + 310 en sortie × 25 $/M — rien n'a été relu.
      costUsd: 0.229,
      durationMs: 7_400,
      createdAt: TOUR_2,
    },
    // Tour 3 — 9 secondes plus tard, le cache tient : 4,5 fois moins cher.
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      jobId: alfredJobId,
      source: 'job',
      turn: 3,
      modelEffective: 'claude-opus-5',
      provider: 'anthropic',
      inputTokens: 35_600,
      outputTokens: 180,
      cachedTokens: 35_400,
      cacheCreationTokens: 200,
      // 35 400 relus × 0,5 $/M + 200 écrits × 6,25 $/M + 180 en sortie × 25 $/M.
      costUsd: 0.02345,
      durationMs: 3_200,
      createdAt: TOUR_3,
    },
    // Le DÉLÉGUÉ a travaillé pendant l'écart, et ses appels sont dans la même
    // lecture que ceux du parent. Ils ne doivent pas se ranger entre deux
    // appels d'Alfred.
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      jobId: delegue!.id,
      source: 'job',
      turn: 1,
      modelEffective: 'claude-opus-5',
      provider: 'anthropic',
      inputTokens: 9_000,
      outputTokens: 900,
      cachedTokens: 0,
      cacheCreationTokens: 9_000,
      // 9 000 écrits × 6,25 $/M + 900 en sortie × 25 $/M.
      costUsd: 0.07875,
      durationMs: 60_000,
      createdAt: new Date('2026-08-21T14:20:00Z'),
    },
  ]);

  // Un second run, sans délégation : trois appels en une minute.
  const [serre] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      task: 'Résume cette page',
      status: 'completed',
      createdAt: TOUR_1,
      completedAt: new Date(TOUR_1.getTime() + 60_000),
    })
    .returning();
  serreJobId = serre!.id;
  await testDb.insert(llmCalls).values(
    [0, 30_000, 60_000].map((offset, i) => ({
      entityId: seed.entityId,
      agentId: seed.agentId,
      jobId: serreJobId,
      source: 'job',
      turn: i + 1,
      modelEffective: 'claude-opus-5',
      provider: 'anthropic',
      inputTokens: 35_200 + i * 200,
      outputTokens: 200,
      cachedTokens: i === 0 ? 0 : 35_200,
      cacheCreationTokens: i === 0 ? 35_200 : 200,
      costUsd: 0.01,
      durationMs: 2_000,
      createdAt: new Date(TOUR_1.getTime() + offset),
    })),
  );
});

describe('getSpaceConversationAction — cache perdu à la reprise @cap:voir-le-cout/moteur', () => {
  it('les trois appels du ticket #54 : UNE reprise, 35 200 jetons, 0,1584 $ de surcoût', async () => {
    const { getSpaceConversationAction } = await actions();
    const r = await getSpaceConversationAction(alfredJobId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Les quatre appels (parent + délégué) sont bien tous dans la lecture :
    // c'est ce qui rend le point suivant non trivial.
    expect(r.data.cost.totals.calls).toBe(4);

    expect(r.data.cost.cacheLost.resumes).toBe(1);
    expect(r.data.cost.cacheLost.tokens).toBe(35_200);
    expect(r.data.cost.cacheLost.unpricedResumes).toBe(0);
    // 35 200 jetons × (5,00 $/M en entrée fraîche − 0,50 $/M en lecture de
    // cache) = 0,1584 $ — le surcoût de la reprise, pas le prix des jetons.
    expect(r.data.cost.cacheLost.costUsd).toBeCloseTo(0.1584, 9);
  });

  it('la part perdue se compare à la facture du run : 0,1584 $ sur 0,5617 $ facturés', async () => {
    // Le ticket parle de « 21 % de la facture ». Ce test ne rejoue pas ce
    // pourcentage — il vient d'un run plus long que ces quatre appels — mais il
    // ancre les DEUX nombres côte à côte : le coût total tel que la base le
    // porte, et le surcoût que la règle en extrait. Les afficher ensemble est
    // tout l'objet de cette PR, et sur ces quatre appels la reprise pèse 28 %.
    const { getSpaceConversationAction } = await actions();
    const r = await getSpaceConversationAction(alfredJobId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 0,2305 + 0,229 + 0,02345 + 0,07875 = 0,5617 $.
    expect(r.data.cost.totals.costUsd).toBeCloseTo(0.5617, 4);
    expect(r.data.cost.cacheLost.costUsd).toBeCloseTo(0.1584, 9);
    const part = r.data.cost.cacheLost.costUsd! / r.data.cost.totals.costUsd!;
    expect(part).toBeCloseTo(0.282, 3);
  });

  it('trois appels rapprochés ne perdent RIEN : la ligne ne s’affiche pas', async () => {
    const { getSpaceConversationAction } = await actions();
    const r = await getSpaceConversationAction(serreJobId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.cost.totals.calls).toBe(3);
    expect(r.data.cost.cacheLost).toEqual({
      resumes: 0,
      tokens: 0,
      costUsd: null,
      unpricedResumes: 0,
    });
  });
});
