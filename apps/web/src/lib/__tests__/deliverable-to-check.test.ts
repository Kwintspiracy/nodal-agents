// deliverable-to-check.test.ts — « un livrable attend un regard », côté
// LECTURE et côté EFFACEMENT, contre une vraie base (#255).
//
// @cap:verifier-un-livrable/moteur
//
// Le runner POSE le fait (`apps/runner/src/tests/job/deliverable-to-check.test.ts`).
// Ce fichier prouve l'autre moitié, celle que le tableau de bord tient :
//
//   1. LA PASTILLE LE COMPTE, dans le bon dossier. `getChatFoldersAction` rend
//      une entrée par run qui attend, avec d'où il vient — le canal de sa
//      conversation d'abord, le sien ensuite, la même règle que pour une
//      approbation en attente.
//   2. LA LIGNE LE DIT AUSSI. Les mêmes runs sortent par leur identifiant et
//      par celui de leur fil : sans cela, la pastille afficherait un nombre
//      au-dessus de lignes toutes éteintes, et rien ne dirait quoi ouvrir.
//   3. OUVRIR LE FIL L'ÉTEINT. C'est le geste que la note de `chat-folders.ts`
//      décrivait, et il tombe au même endroit que le marqueur de lecture.
//   4. OUVRIR LE RUN L'ÉTEINT AUSSI. C'est la page qui MONTRE les livrables.
//   5. LES DEUX GESTES SONT PRÉCIS : ouvrir un fil n'éteint pas le run d'à
//      côté, ouvrir un run n'éteint pas celui de son voisin.
//   6. LA LECTURE EST BORNÉE. Elle repart toutes les 15 secondes sur toutes les
//      pages du tableau de bord : une pastille n'est pas une raison de balayer
//      une table. Ce cas vient EN DERNIER — il sème 205 runs en attente, qui
//      repousseraient les autres hors du plafond.
//
// Mutations vérifiées :
//   - l'`UPDATE` retiré de `markConversationRead` → le point 3 rougit (le run
//      attend encore après que son fil a été ouvert) ;
//   - l'`UPDATE` retiré de `getSpaceConversationAction` → le point 4 rougit ;
//   - `deliverablesToCheck` rendu comme tableau vide → le point 1 rougit ;
//   - le `limit(DELIVERABLE_CHECK_MAX)` retiré de la lecture → le point 6
//      rougit (205 lignes rendues au lieu de 200).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, conversations, eq } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** Le fil du tableau de bord, et le run qui y a livré. */
const filNodal = { id: '' };
const runDuFil = { id: '' };
/** Un fil Telegram, son run : deux dossiers différents dans le même menu. */
const filTelegram = { id: '' };
const runTelegram = { id: '' };
/** Un run venu de dehors : aucun fil, il ne se range que par son canal. */
const runDehors = { id: '' };

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

const conversationActions = () => import('../conversation-actions.ts');
const actions = () => import('../actions.ts');

/** Pose le fait sur un run, comme la porte terminale du runner le ferait. */
async function faireAttendre(jobId: string): Promise<void> {
  await testDb
    .update(agentJobs)
    .set({ deliverableCheckDueAt: new Date() })
    .where(eq(agentJobs.id, jobId));
}

/** Les runs qui attendent encore un regard, lus en base. */
async function attendentEncore(): Promise<Set<string>> {
  const rows = await testDb
    .select({ id: agentJobs.id, due: agentJobs.deliverableCheckDueAt })
    .from(agentJobs);
  return new Set(rows.filter((r) => r.due !== null).map((r) => r.id));
}

/** Ce que la barre latérale lit. */
async function menu() {
  const { getChatFoldersAction } = await conversationActions();
  const r = await getChatFoldersAction();
  if (!r.ok) throw new Error(r.message);
  return r.data;
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  const [a, b] = await testDb
    .insert(conversations)
    .values([
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        origin: 'user',
        channel: 'dashboard',
        chatId: null,
        title: 'Le rapport',
      },
      {
        entityId: seed.entityId,
        agentId: seed.agentId,
        origin: 'user',
        channel: 'telegram',
        chatId: '4242',
        title: 'Depuis Telegram',
      },
    ])
    .returning({ id: conversations.id });
  filNodal.id = a!.id;
  filTelegram.id = b!.id;

  const commun = {
    entityId: seed.entityId,
    agentId: seed.agentId,
    status: 'completed',
    result: 'fait',
  };
  const [j1, j2, j3] = await testDb
    .insert(agentJobs)
    .values([
      { ...commun, channel: 'dashboard', conversationId: filNodal.id, task: 'écrire le rapport' },
      { ...commun, channel: 'telegram', conversationId: filTelegram.id, task: 'faire le tableau' },
      { ...commun, channel: 'mcp', task: 'produire le fichier' },
    ])
    .returning({ id: agentJobs.id });
  runDuFil.id = j1!.id;
  runTelegram.id = j2!.id;
  runDehors.id = j3!.id;
});

// ─── 1 et 2. Ce que la barre latérale lit ────────────────────────────────────

describe('la pastille compte un livrable à vérifier @cap:verifier-un-livrable/moteur', () => {
  it('ne compte rien tant qu’aucun run n’a livré', async () => {
    const vu = await menu();
    expect(vu.deliverablesToCheck).toEqual([]);
    expect(vu.deliverableCheckJobIds).toEqual([]);
    expect(vu.deliverableCheckConversationIds).toEqual([]);
  });

  it('range chaque run qui attend dans le dossier d’où il vient', async () => {
    await faireAttendre(runDuFil.id);
    await faireAttendre(runTelegram.id);
    await faireAttendre(runDehors.id);

    const vu = await menu();

    const { chatFolders, chatWaitingTotal } = await import('../chat-folders.ts');
    const entree = {
      channels: ['telegram'],
      waiting: vu.deliverablesToCheck,
      running: {},
      externalRuns: 1,
    };
    const parDossier = Object.fromEntries(
      chatFolders({ ...entree, pathname: '/chat', folderParam: null }).map((f) => [
        f.key,
        f.waiting,
      ]),
    );
    // Un par dossier : celui du tableau de bord, celui de Telegram, celui des
    // runs venus de dehors. C'est la règle de `folderOfWork`, appliquée aux
    // mêmes entrées qu'une approbation en attente.
    expect(parDossier).toMatchObject({ dashboard: 1, telegram: 1, mcp: 1 });
    expect(chatWaitingTotal(entree)).toBe(3);

    // ET LES LIGNES : sans elles, la pastille dirait « 1 » au-dessus de fils
    // tous éteints.
    expect(new Set(vu.deliverableCheckJobIds)).toEqual(
      new Set([runDuFil.id, runTelegram.id, runDehors.id]),
    );
    expect(new Set(vu.deliverableCheckConversationIds)).toEqual(
      new Set([filNodal.id, filTelegram.id]),
    );
  });
});

// ─── 3, 4 et 5. Les deux gestes qui sont des regards ─────────────────────────

describe('regarder éteint l’attente @cap:verifier-un-livrable/moteur', () => {
  it('ouvrir le FIL éteint son run, et lui seul', async () => {
    const { getConversationThreadAction } = await conversationActions();

    const avant = await attendentEncore();
    expect(avant.has(runDuFil.id), 'le run n’attendait pas avant l’ouverture').toBe(true);

    const r = await getConversationThreadAction(filNodal.id);
    if (!r.ok) throw new Error(r.message);

    const apres = await attendentEncore();
    expect(apres.has(runDuFil.id), 'le run attend encore après que son fil a été ouvert').toBe(
      false,
    );
    // Les voisins n'ont pas bougé : ouvrir un fil n'est pas « tout marquer vu ».
    expect(apres.has(runTelegram.id)).toBe(true);
    expect(apres.has(runDehors.id)).toBe(true);

    // Et la barre latérale le dit sans rien recalculer d'autre.
    const vu = await menu();
    expect(vu.deliverableCheckConversationIds).toEqual([filTelegram.id]);
  });

  it('ouvrir le RUN éteint son attente, et lui seul', async () => {
    const { getSpaceConversationAction } = await actions();

    expect((await attendentEncore()).has(runDehors.id)).toBe(true);

    const r = await getSpaceConversationAction(runDehors.id);
    if (!r.ok) throw new Error(r.message);
    expect(r.data.job.id).toBe(runDehors.id);

    const apres = await attendentEncore();
    expect(apres.has(runDehors.id), 'le run attend encore après avoir été ouvert').toBe(false);
    expect(apres.has(runTelegram.id), 'ouvrir un run a éteint celui d’à côté').toBe(true);
  });
});

// ─── Le plafond de la lecture ────────────────────────────────────────────────

describe('la lecture de la pastille est BORNÉE @cap:verifier-un-livrable/moteur', () => {
  it('ne rapporte jamais plus que son plafond, même avec plus de runs en attente', async () => {
    // Cette lecture repart toutes les 15 secondes sur toutes les pages du
    // tableau de bord : une pastille n'est pas une raison de balayer une table.
    // Sans ce test, retirer le `limit` ne rougirait rien (constat mineur 11b de
    // la revue C, passe 1).
    const trop = 205;
    await testDb.insert(agentJobs).values(
      Array.from({ length: trop }, (_, i) => ({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'dashboard',
        task: `run de masse ${i}`,
        status: 'completed',
        deliverableCheckDueAt: new Date(),
      })),
    );

    const vu = await menu();
    expect(vu.deliverablesToCheck.length).toBe(200);
    expect(vu.deliverableCheckJobIds.length).toBe(200);
  });
});
