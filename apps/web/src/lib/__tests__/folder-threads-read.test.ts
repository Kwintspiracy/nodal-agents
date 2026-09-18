// folder-threads-read.test.ts — le PLAFOND DE CINQ est en SQL
// (Reviewer C, passe 1 de la PR #206).
//
// CE QUE CE FICHIER PROUVE, et pourquoi il vaut la peine d'exister. Le
// sous-menu d'un dossier ne montre que cinq lignes. Il les prenait sur la
// lecture de la page de liste — jusqu'à deux cents conversations avec leurs
// deux agrégats `array_agg` — puis coupait à cinq en TypeScript. Le premier
// dépliage payait donc la page entière pour quinze lignes.
//
// Deux preuves, et il en faut DEUX :
//
//   1. sur une VRAIE base (PGlite) portant douze chats dans un canal et douze
//      conversations dans « Nodal chats », la lecture rend cinq lignes par
//      dossier — les cinq plus récentes, dans l'ordre de la liste ;
//   2. la borne est dans le SQL ÉMIS, et pas dans un `slice` : la requête est
//      lue telle qu'elle part (`.toSQL()`), et elle porte sa fenêtre et son
//      `row_number`. Sans ce second test, retirer la borne et couper en
//      TypeScript rendrait le premier vert alors que la base aurait tout lu.
//
// Mutation vérifiée : le `where rn <= …` retiré de `folderChatsQuery`, et le
// `limit` retiré de `folderConversationsQuery` → les deux tests rouges.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { conversations } from '@nodal-agents/db';

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

/** Le pilote qu'attendent les constructeurs de requêtes. */
type QueryDb = Parameters<typeof import('../folder-threads-sql.ts').folderChatsQuery>[0];

/**
 * La base de test, vue comme celle de production.
 *
 * PGlite et postgres-js ne diffèrent, POUR LE TYPAGE, que par la forme du
 * RÉSULTAT d'une requête — jamais par la façon de la construire. Ces deux
 * constructeurs ne font que bâtir un `select` ; la conversion le dit ici,
 * plutôt que d'élargir la signature du code de production pour un test.
 */
function commeDb(db: TestDb): QueryDb {
  return db as unknown as QueryDb;
}

/** Une date, en minutes depuis une origine fixe. Plus le rang est haut, plus c'est récent. */
function quand(minutes: number): Date {
  return new Date(Date.UTC(2026, 8, 19, 0, minutes, 0));
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  // DOUZE chats Telegram, un par interlocuteur, du plus ancien au plus récent.
  // Et douze conversations de « Nodal chats », de même.
  const lignes = [];
  for (let i = 1; i <= 12; i += 1) {
    lignes.push({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: `chat-${String(i).padStart(2, '0')}`,
      origin: 'user',
      title: `telegram ${i}`,
      updatedAt: quand(i),
    });
    lignes.push({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      chatId: null,
      origin: 'user',
      title: `nodal ${i}`,
      updatedAt: quand(i),
    });
  }
  await testDb.insert(conversations).values(lignes);
});

describe('la lecture du sous-menu @cap:reprendre-conversation/moteur', () => {
  it('ne rend que CINQ chats par canal, les plus récents, sur une base qui en porte douze', async () => {
    const { listFolderThreadReadsAction } = await import('../conversation-actions.ts');
    const r = await listFolderThreadReadsAction(5);
    if (!r.ok) throw new Error(r.message);

    expect(r.data.chats).toHaveLength(5);
    // Les cinq derniers, du plus récent au plus ancien — l'ordre de la liste.
    expect(r.data.chats.map((c) => c.chatId)).toEqual([
      'chat-12',
      'chat-11',
      'chat-10',
      'chat-09',
      'chat-08',
    ]);
    expect(r.data.chats.every((c) => c.channel === 'telegram')).toBe(true);
  });

  it('ne rend que CINQ conversations de « Nodal chats », avec leur titre', async () => {
    const { listFolderThreadReadsAction } = await import('../conversation-actions.ts');
    const r = await listFolderThreadReadsAction(5);
    if (!r.ok) throw new Error(r.message);

    expect(r.data.conversations).toHaveLength(5);
    expect(r.data.conversations.map((c) => c.title)).toEqual([
      'nodal 12',
      'nodal 11',
      'nodal 10',
      'nodal 9',
      'nodal 8',
    ]);
  });

  it('rend AUTANT de lignes qu’on lui en demande, et pas plus', async () => {
    // Le plafond est un paramètre, pas une constante cachée dans la requête :
    // le menu demande cinq, ce test en demande deux, et la base répond deux.
    const { listFolderThreadReadsAction } = await import('../conversation-actions.ts');
    const r = await listFolderThreadReadsAction(2);
    if (!r.ok) throw new Error(r.message);
    expect(r.data.chats.map((c) => c.chatId)).toEqual(['chat-12', 'chat-11']);
    expect(r.data.conversations.map((c) => c.title)).toEqual(['nodal 12', 'nodal 11']);
  });
});

describe('la borne est dans le SQL ÉMIS @cap:reprendre-conversation/moteur', () => {
  it('classe les chats DANS leur canal et coupe la fenêtre en base', async () => {
    const { folderChatsQuery } = await import('../folder-threads-sql.ts');
    const { sql, params } = folderChatsQuery(commeDb(testDb), seed.entityId, 5).toSQL();
    const requete = sql.toLowerCase().replace(/\s+/g, ' ');

    // Une fenêtre PAR CANAL, et sa coupe : c'est ce qui fait qu'un canal de
    // plus ne coûte pas une requête de plus, et que douze lignes ne remontent
    // jamais pour en dessiner cinq.
    expect(requete).toContain('row_number() over');
    expect(requete).toContain('partition by');
    expect(requete).toMatch(/"rn" <= \$\d+/);
    // Le plafond voyage en PARAMÈTRE, jamais collé dans le texte.
    expect(params).toContain(5);
  });

  it('borne « Nodal chats » par un limit, et pas après coup', async () => {
    const { folderConversationsQuery } = await import('../folder-threads-sql.ts');
    const { sql, params } = folderConversationsQuery(commeDb(testDb), seed.entityId, 5).toSQL();
    expect(sql.toLowerCase()).toContain('limit');
    expect(params).toContain(5);
  });
});
