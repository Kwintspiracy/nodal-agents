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
      // Un VRAI identifiant : la lecture joint les marqueurs de lecture de
      // cette personne (#209), et `user_id` est un uuid en base.
      userId: seed?.userId ?? 'mock-user-id',
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
    // La coupe elle-même : un prédicat borné, dont la valeur voyage en
    // PARAMÈTRE et n'est jamais collée dans le texte.
    //
    // Le NOM de la colonne de rang n'est pas épinglé : le renommer ne change
    // rien à ce que la requête fait, et un test qui rougirait pour ça
    // parlerait d'autre chose que de la borne (Reviewer C, passe 2).
    expect(requete).toMatch(/<= \$\d+/);
    expect(params).toContain(5);
    // Et la borne est bien la SEULE chose que le paramètre porte : un `limit`
    // ajouté par-dessus dirait que la fenêtre ne suffit pas.
    expect(requete).not.toContain('limit');
  });

  it('DEMANDE son ordre, au lieu de le tenir du plan d’exécution', async () => {
    const { folderChatsQuery } = await import('../folder-threads-sql.ts');
    const { sql } = folderChatsQuery(commeDb(testDb), seed.entityId, 5).toSQL();

    // La fenêtre porte son propre `order by` DANS son `over (…)` ; celui-là
    // classe le calcul du rang, pas les lignes rendues. On le retire donc
    // avant de chercher l'ordre de la requête elle-même.
    const sansFenetre = sql
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/over \([^)]*\)/g, 'over ()');
    expect(sansFenetre).toContain('order by');

    // POURQUOI cette assertion existe, et pas seulement le test d'ordre du
    // haut de fichier : retirer cet `order by` ne rougit PAS sur PGlite, qui
    // rend les lignes dans l'ordre où la fenêtre les a numérotées. L'ordre
    // n'en est pas garanti pour autant — aucune base ne le promet sans
    // `order by`, et un index qui change suffit à le défaire. Il se prouve
    // donc ici, sur le SQL émis, faute de pouvoir se prouver sur les lignes
    // (Reviewer C, passe 2 de la PR #206).
  });

  it('borne « Nodal chats » par un limit, et pas après coup', async () => {
    const { folderConversationsQuery } = await import('../folder-threads-sql.ts');
    const { sql, params } = folderConversationsQuery(
      commeDb(testDb),
      seed.entityId,
      seed.userId,
      5,
    ).toSQL();
    expect(sql.toLowerCase()).toContain('limit');
    expect(params).toContain(5);
  });
});

// ─── « Recent », tous canaux confondus (#230, 19/09/2026) ────────────────────
//
// Le panneau Talk montre, sous les dossiers, les cinq derniers fils D'OÙ QU'ILS
// VIENNENT. C'est la seule lecture de la barre qui traverse les dossiers, et
// c'est pour cela qu'elle a sa requête : celle de « Nodal chats » écarte tout
// ce qui porte un `chat_id`, celle des canaux classe DANS un canal.
//
// Mutation vérifiée : le `limit` retiré de `recentConversationsQuery` → le
// premier test rouge ; le filtre du dossier remis (`duDashboard()`) → le second.

describe('la lecture de « Recent » @cap:reprendre-conversation/moteur', () => {
  beforeAll(async () => {
    // Six fils PLUS RÉCENTS que tout ce qui précède, sur deux canaux dont
    // aucun test au-dessus ne dépend. Des horodatages strictement croissants :
    // l'ordre attendu ne se joue jamais sur un départage.
    const lignes = [];
    for (let i = 1; i <= 3; i += 1) {
      lignes.push({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'discord',
        chatId: `discord-${i}`,
        origin: 'user',
        title: `discord ${i}`,
        updatedAt: quand(100 + i * 2),
      });
      lignes.push({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'slack',
        chatId: `slack-${i}`,
        origin: 'user',
        title: `slack ${i}`,
        updatedAt: quand(101 + i * 2),
      });
    }
    await testDb.insert(conversations).values(lignes);
  });

  it('rend les CINQ derniers fils, de plusieurs canaux à la fois', async () => {
    const { listRecentThreadReadsAction } = await import('../conversation-actions.ts');
    const r = await listRecentThreadReadsAction(5);
    if (!r.ok) throw new Error(r.message);

    // Les cinq plus récents de la base, du plus récent au plus ancien — et ils
    // ne viennent pas tous du même endroit, ce qu'aucune des deux autres
    // lectures ne sait faire.
    expect(r.data.map((c) => c.title)).toEqual([
      'slack 3',
      'discord 3',
      'slack 2',
      'discord 2',
      'slack 1',
    ]);
  });

  it('ne s’arrête PAS au dossier « Nodal chats »', async () => {
    const { listRecentThreadReadsAction } = await import('../conversation-actions.ts');
    const r = await listRecentThreadReadsAction(5);
    if (!r.ok) throw new Error(r.message);
    // Aucun des cinq ne vient du tableau de bord : la base porte douze
    // conversations « Nodal chats », toutes plus anciennes, et la lecture ne
    // les a pas préférées. Si elle gardait le filtre du dossier, elle aurait
    // rendu « nodal 12 » et les suivantes.
    expect(r.data.some((c) => c.title.startsWith('nodal'))).toBe(false);
  });

  it('borne en SQL, et jamais après coup', async () => {
    const { recentConversationsQuery } = await import('../folder-threads-sql.ts');
    const { sql, params } = recentConversationsQuery(
      commeDb(testDb),
      seed.entityId,
      seed.userId,
      5,
    ).toSQL();
    const requete = sql.toLowerCase().replace(/\s+/g, ' ');
    expect(requete).toContain('limit');
    expect(requete).toContain('order by');
    expect(params).toContain(5);
  });
});

// ─── Le dernier recours d'un titre, écrit UNE fois (Reviewer C, passe 1 de #235)

describe('un fil que personne n’a nommé @cap:reprendre-conversation/moteur', () => {
  /** L'identifiant du fil sans titre, semé pour ce bloc seul. */
  let anonyme = '';

  beforeAll(async () => {
    // Aucun titre, aucune première demande : ni message, ni job de tête ne se
    // rattachent à cette conversation. C'est le seul cas où le repli parle.
    // Posée au plus ANCIEN, pour ne déranger aucun des blocs au-dessus.
    const [ligne] = await testDb
      .insert(conversations)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'dashboard',
        chatId: null,
        origin: 'user',
        title: '',
        updatedAt: quand(0),
      })
      .returning({ id: conversations.id });
    anonyme = ligne?.id ?? '';
    expect(anonyme, 'le fil anonyme est semé').not.toBe('');
  });

  it('s’appelle « Untitled », et pareil pour les DEUX lectures', async () => {
    // Le repli vivait chez chaque appelant — le sous-menu d'un dossier et la
    // section « Recent » l'écrivaient chacun de son côté. Il vit maintenant
    // dans le chemin de nommage partagé, donc les deux lectures rendent le
    // même nom pour le même fil, par construction.
    //
    // Mutation vérifiée : le `=== '' ? 'Untitled'` retiré de `nommerLesFils`
    // → ce test rougit, les deux lectures rendent une chaîne vide.
    const { listRecentThreadReadsAction, listFolderThreadReadsAction } =
      await import('../conversation-actions.ts');

    const recent = await listRecentThreadReadsAction(50);
    if (!recent.ok) throw new Error(recent.message);
    expect(recent.data.find((c) => c.id === anonyme)?.title).toBe('Untitled');

    const sousMenu = await listFolderThreadReadsAction(50);
    if (!sousMenu.ok) throw new Error(sousMenu.message);
    expect(sousMenu.data.conversations.find((c) => c.id === anonyme)?.title).toBe('Untitled');
  });
});
