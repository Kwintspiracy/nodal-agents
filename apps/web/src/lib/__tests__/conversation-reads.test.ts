// conversation-reads.test.ts — L'ÉTAT NON LU, contre une VRAIE base (#209).
//
// CE QUE CE FICHIER PROUVE, et pourquoi chaque preuve vaut la peine d'exister.
//
//   1. OUVRIR UN FIL LE MARQUE COMME LU. Le marqueur est écrit par l'action
//      qui charge le fil sur le tableau de bord, et par elle seule. Rouvrir le
//      fil AVANCE le marqueur au lieu d'en empiler un second.
//   2. NON LU EST UNE COMPARAISON DE DATES, pas un drapeau qu'on pose. Jamais
//      ouvert : non lu. Ouvert après la dernière activité : lu. Reparti après
//      l'ouverture — une réponse d'agent, un message entrant : non lu de
//      nouveau. C'est le cas qui fait exister la fonctionnalité.
//   3. LE MARQUEUR NE DÉBORDE PAS. Ouvrir un fil ne marque que celui-là, et
//      n'écrit rien pour une autre personne.
//   4. CE N'EST JAMAIS UNE LECTURE PAR FIL. Les mêmes lectures groupées
//      répondent pour douze fils avec EXACTEMENT le même nombre de requêtes
//      que pour deux. C'est la propriété que #206 a passé deux revues à
//      obtenir, et qu'une jointure de plus ne doit pas défaire.
//
// Mutations vérifiées :
//   - `>` changé en `<` dans `unreadColumn` → les trois cas du point 2 rougissent ;
//   - `IS NULL` retiré de `unreadColumn` → « jamais ouvert » rougit ;
//   - `markConversationRead` retiré de `getConversationThreadAction` → le
//     point 1 rougit ;
//   - la jointure remplacée par une requête par fil → le point 4 rougit.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  and,
  conversationReads,
  conversations,
  eq,
  users,
  type ConversationReadRow,
} from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** Une seconde personne, pour prouver qu'un marqueur appartient à quelqu'un. */
let autreUserId = '';

/** Les fils semés par ce fichier, nommés par ce qu'ils prouvent. */
const jamaisOuverte = { id: '' };
const lueApresCoup = { id: '' };
const repartieApresLecture = { id: '' };
const voisine = { id: '' };

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

const actions = () => import('../conversation-actions.ts');

/** Un instant fixe : les dates de ces tests ne dépendent pas de l'heure. */
function quand(jour: number, heure: number): Date {
  return new Date(Date.UTC(2026, 8, jour, heure, 0, 0));
}

/** Le marqueur d'une personne sur un fil, ou `null` s'il n'y en a aucun. */
async function marqueur(
  userId: string,
  conversationId: string,
): Promise<ConversationReadRow | null> {
  const rows = await testDb
    .select()
    .from(conversationReads)
    .where(
      and(
        eq(conversationReads.userId, userId),
        eq(conversationReads.conversationId, conversationId),
      ),
    );
  return rows[0] ?? null;
}

/** Le drapeau `unread` d'un fil, tel que la LISTE le rend. */
async function nonLuDansLaListe(id: string): Promise<boolean> {
  const { listAllConversationsAction } = await actions();
  const r = await listAllConversationsAction();
  if (!r.ok) throw new Error(r.message);
  const ligne = r.data.find((c) => c.id === id);
  if (ligne === undefined) throw new Error(`le fil ${id} est absent de la liste`);
  return ligne.unread;
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  const [autre] = await testDb
    .insert(users)
    .values({ email: `voisin-${Date.now()}@example.com` })
    .returning({ id: users.id });
  autreUserId = autre!.id;

  const commun = {
    entityId: seed.entityId,
    agentId: seed.agentId,
    origin: 'user',
    channel: 'dashboard',
    chatId: null,
  };
  const [a, b, c, d] = await testDb
    .insert(conversations)
    .values([
      { ...commun, title: 'Jamais ouverte', updatedAt: quand(18, 9) },
      { ...commun, title: 'Lue après coup', updatedAt: quand(18, 10) },
      { ...commun, title: 'Repartie après lecture', updatedAt: quand(18, 11) },
      { ...commun, title: 'Celle du voisin de liste', updatedAt: quand(18, 12) },
    ])
    .returning({ id: conversations.id });
  jamaisOuverte.id = a!.id;
  lueApresCoup.id = b!.id;
  repartieApresLecture.id = c!.id;
  voisine.id = d!.id;
});

// ─── 1. Ouvrir un fil, c'est le lire ─────────────────────────────────────────

describe('ouvrir un fil pose son marqueur @cap:reprendre-conversation/moteur', () => {
  it('écrit le marqueur de CETTE personne sur CE fil, et sur aucun autre', async () => {
    const { getConversationThreadAction } = await actions();
    expect(await marqueur(seed.userId, lueApresCoup.id), 'un marqueur existait déjà').toBeNull();

    const r = await getConversationThreadAction(lueApresCoup.id);
    if (!r.ok) throw new Error(r.message);
    expect(r.data.conversation.id).toBe(lueApresCoup.id);

    const pose = await marqueur(seed.userId, lueApresCoup.id);
    expect(pose, 'aucun marqueur après l’ouverture du fil').not.toBeNull();
    // Il date de l'ouverture, donc d'APRÈS la dernière activité du fil.
    expect(pose!.readAt.getTime()).toBeGreaterThan(quand(18, 10).getTime());

    // Le fil d'à côté n'a rien reçu : ouvrir n'est pas « tout marquer lu ».
    expect(await marqueur(seed.userId, voisine.id)).toBeNull();
    // Et le voisin non plus : un marqueur appartient à celui qui a lu.
    expect(await marqueur(autreUserId, lueApresCoup.id)).toBeNull();
  });

  it('rouvrir AVANCE le marqueur au lieu d’en empiler un second', async () => {
    const { getConversationThreadAction } = await actions();
    // Une première lecture reculée dans le temps, pour que l'avancée se voie.
    await testDb
      .update(conversationReads)
      .set({ readAt: quand(10, 8) })
      .where(
        and(
          eq(conversationReads.userId, seed.userId),
          eq(conversationReads.conversationId, lueApresCoup.id),
        ),
      );

    const r = await getConversationThreadAction(lueApresCoup.id);
    if (!r.ok) throw new Error(r.message);

    const tous = await testDb
      .select()
      .from(conversationReads)
      .where(eq(conversationReads.conversationId, lueApresCoup.id));
    expect(tous, 'deux marqueurs pour la même personne sur le même fil').toHaveLength(1);
    expect(tous[0]!.readAt.getTime()).toBeGreaterThan(quand(10, 8).getTime());
  });

  it('un fil qui n’appartient pas à l’entité ne laisse AUCUNE trace de lecture', async () => {
    const { getConversationThreadAction } = await actions();
    const [etrangere] = await testDb
      .insert(conversations)
      .values({
        entityId: null,
        agentId: seed.agentId,
        title: 'Pas de chez nous',
        origin: 'user',
        channel: 'dashboard',
        updatedAt: quand(18, 13),
      })
      .returning({ id: conversations.id });

    const r = await getConversationThreadAction(etrangere!.id);
    expect(r.ok).toBe(false);
    expect(await marqueur(seed.userId, etrangere!.id), 'un fil refusé a été marqué lu').toBeNull();
  });
});

// ─── 2. Non lu est une comparaison de dates ──────────────────────────────────

describe('ce que « non lu » veut dire @cap:reprendre-conversation/moteur', () => {
  it('un fil JAMAIS ouvert est non lu', async () => {
    expect(await marqueur(seed.userId, jamaisOuverte.id)).toBeNull();
    expect(await nonLuDansLaListe(jamaisOuverte.id)).toBe(true);
  });

  it('un fil ouvert APRÈS sa dernière activité est lu', async () => {
    // `lueApresCoup` a été ouverte par le premier bloc, donc après `quand(18, 10)`.
    expect(await nonLuDansLaListe(lueApresCoup.id)).toBe(false);
  });

  it('un fil qui REPART après l’ouverture redevient non lu', async () => {
    // Le cas qui fait exister la fonctionnalité : on a lu, puis l'agent a
    // répondu — ou un message est arrivé d'un canal. `updated_at` avance, le
    // marqueur non.
    await testDb.insert(conversationReads).values({
      userId: seed.userId,
      conversationId: repartieApresLecture.id,
      readAt: quand(18, 12),
    });
    expect(await nonLuDansLaListe(repartieApresLecture.id)).toBe(false);

    await testDb
      .update(conversations)
      .set({ updatedAt: quand(18, 14) })
      .where(eq(conversations.id, repartieApresLecture.id));
    expect(await nonLuDansLaListe(repartieApresLecture.id)).toBe(true);
  });

  it('le marqueur d’une AUTRE personne ne rend rien lu', async () => {
    await testDb
      .insert(conversationReads)
      .values({ userId: autreUserId, conversationId: jamaisOuverte.id, readAt: quand(19, 9) })
      .onConflictDoNothing();
    // La lecture du voisin est postérieure à toute activité du fil, et pourtant
    // il reste non lu POUR NOUS : un état de lecture appartient à une personne.
    expect(await nonLuDansLaListe(jamaisOuverte.id)).toBe(true);
  });
});

// ─── 3. Jamais une lecture par fil ───────────────────────────────────────────

describe('le non-lu ne coûte AUCUNE requête par fil @cap:reprendre-conversation/moteur', () => {
  /** Les méthodes par lesquelles une requête part vers la base. */
  const DEPARTS = ['select', 'selectDistinct', 'selectDistinctOn', 'execute'] as const;

  /** Combien de requêtes les trois lectures groupées émettent, telles quelles. */
  async function requetesEmises(): Promise<number> {
    const {
      listAllConversationsAction,
      listCurrentThreadByChatAction,
      listFolderThreadReadsAction,
    } = await actions();
    const espions = DEPARTS.map((m) => vi.spyOn(testDb, m));
    try {
      const [liste, courants, sousMenu] = await Promise.all([
        listAllConversationsAction(),
        listCurrentThreadByChatAction(),
        listFolderThreadReadsAction(5),
      ]);
      // Les trois lectures ont bien RÉPONDU : un compte de requêtes sur trois
      // lectures en échec ne prouverait rien.
      if (!liste.ok) throw new Error(liste.message);
      if (!courants.ok) throw new Error(courants.message);
      if (!sousMenu.ok) throw new Error(sousMenu.message);
      return espions.reduce((n, e) => n + e.mock.calls.length, 0);
    } finally {
      for (const e of espions) e.mockRestore();
    }
  }

  /** Ajoute `n` fils titrés dans un canal, et `n` dans « Nodal chats ». */
  async function semer(n: number, depuis: number): Promise<void> {
    const lignes = [];
    for (let i = 0; i < n; i += 1) {
      const rang = depuis + i;
      lignes.push({
        entityId: seed.entityId,
        agentId: seed.agentId,
        origin: 'user',
        channel: 'telegram',
        chatId: `chat-${String(rang).padStart(2, '0')}`,
        title: `telegram ${rang}`,
        updatedAt: quand(17, 1),
      });
      lignes.push({
        entityId: seed.entityId,
        agentId: seed.agentId,
        origin: 'user',
        channel: 'dashboard',
        chatId: null,
        title: `nodal ${rang}`,
        updatedAt: quand(17, 2),
      });
    }
    await testDb.insert(conversations).values(lignes);
  }

  it('répond pour DOUZE fils avec exactement le même nombre de requêtes que pour deux', async () => {
    await semer(2, 1);
    const pourDeux = await requetesEmises();
    expect(pourDeux, 'aucune requête émise — les lectures n’ont rien fait').toBeGreaterThan(0);

    await semer(10, 3);
    const pourDouze = await requetesEmises();

    expect(pourDouze, 'le nombre de requêtes suit le nombre de fils').toBe(pourDeux);
  });
});
