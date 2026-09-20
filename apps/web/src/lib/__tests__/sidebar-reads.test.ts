// sidebar-reads.test.ts — LES LECTURES DES PANNEAUX Agents, Run et Approvals
// (#258).
//
// CE QUE CE FICHIER PROUVE, et pourquoi il vaut la peine d'exister. Les quatre
// listes de ces panneaux avaient déjà une action chacune —
// `listAgentsAction`, `listSchedulesAction`, `listWebhookTriggersAction`,
// `listApprovalsAction` — et aucune ne convenait, pour deux raisons de fond :
//
//   1. TROIS NE SONT PAS BORNÉES. Elles rendent toute la table de l'entité.
//      La barre en dessine dix lignes, sur chaque page du tableau de bord,
//      toutes les quinze secondes. C'est exactement le constat que la passe 1
//      de la revue de la PR #206 a retiré des sous-menus.
//   2. ELLES RENDENT TROP. Une ligne d'agent complète porte son jeton de bot
//      Telegram ; une ligne de webhook porte son secret ; une approbation
//      porte le `tool_input` de l'appel. Rien de tout cela n'est dessiné dans
//      une colonne de 300 px, et tout cela partirait dans le paquet du
//      navigateur.
//
// Quatre preuves, sur une VRAIE base (PGlite) :
//
//   1. chaque lecture respecte son plafond, et REFUSE un plafond absurde ;
//   2. l'ordre des agents est celui de la page `/agents` (`position`), pas
//      l'ordre d'insertion ;
//   3. une ligne ne porte QUE ce que le menu dessine — ni secret, ni jeton ;
//   4. « RECENTS » écarte ce qui attend encore, et retombe sur le nom de
//      l'outil quand l'agent a disparu, jamais sur un nom inventé.
//
// Mutations vérifiées, une par une, chacune remise ensuite : le `.limit()`
// retiré de la lecture des agents → « rend ce qu'on lui demande » rougit ;
// `agents.position` retiré de l'`orderBy` → « garde l'ordre de la PAGE »
// rougit ; `ne(status, 'pending')` retiré → « écarte ce qui ATTEND ENCORE »
// rougit.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  agentJobs,
  agentSchedules,
  approvalRequests,
  webhookTriggers,
} from '@nodal-agents/db';

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

/** Une date, en minutes depuis une origine fixe. Plus haut = plus récent. */
function quand(minutes: number): Date {
  return new Date(Date.UTC(2026, 8, 19, 0, minutes, 0));
}

/** Le travail auquel les approbations semées se rattachent. */
let jobId = '';

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  // DOUZE agents de plus, insérés DANS LE DÉSORDRE de leur position : sans
  // cela, l'ordre d'insertion et l'ordre demandé se ressembleraient, et le
  // test d'ordre ne prouverait rien.
  const lignes: (typeof agents.$inferInsert)[] = [];
  for (const i of [12, 3, 7, 1, 9, 2, 11, 4, 8, 5, 10, 6]) {
    lignes.push({
      entityId: seed.entityId,
      name: `Agent ${String(i).padStart(2, '0')}`,
      slug: `agent-${i}`,
      personality: 'You are a test agent.',
      // La position que la personne a choisie sur la page `/agents`.
      position: i,
      // Un jeton de bot : il ne doit JAMAIS ressortir de la lecture du menu.
      telegramBotToken: 'secret-bot-token',
    });
  }
  await testDb.insert(agents).values(lignes);

  // Douze tâches planifiées, la plus récemment touchée en dernier.
  const crons: (typeof agentSchedules.$inferInsert)[] = [];
  for (let i = 1; i <= 12; i += 1) {
    crons.push({
      entityId: seed.entityId,
      agentId: seed.agentId,
      name: `Cron ${String(i).padStart(2, '0')}`,
      cronExpr: '0 9 * * *',
      updatedAt: quand(i),
    });
  }
  await testDb.insert(agentSchedules).values(crons);

  const hooks: (typeof webhookTriggers.$inferInsert)[] = [];
  for (let i = 1; i <= 12; i += 1) {
    hooks.push({
      entityId: seed.entityId,
      agentId: seed.agentId,
      name: `Hook ${String(i).padStart(2, '0')}`,
      slug: `hook-${i}`,
      taskTemplate: 'Do the thing',
      // Un secret de FIXTURE, et ce fichier existe pour prouver qu'il ne
      // ressort JAMAIS de la lecture du menu. Le crochet « no secrets » le
      // signale sur sa forme seule, qui est justement celle qu'il faut ici.
      secret: 'deadbeefdeadbeefdeadbeefdeadbeef', // secrets:allow
      updatedAt: quand(i),
    });
  }
  await testDb.insert(webhookTriggers).values(hooks);

  // Un travail, pour accrocher les approbations : la colonne est obligatoire.
  const [job] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      task: 'Do the thing',
      channel: 'dashboard',
      status: 'awaiting_approval',
    })
    .returning({ id: agentJobs.id });
  jobId = job?.id ?? '';
  expect(jobId, 'le travail porteur est semé').not.toBe('');

  await testDb.insert(approvalRequests).values([
    // ENCORE EN ATTENTE : elle appartient à l'autre section, et RECENTS ne
    // doit pas la montrer.
    {
      entityId: seed.entityId,
      jobId,
      agentId: seed.agentId,
      toolName: 'run_command',
      toolInput: { command: 'rm -rf /' },
      status: 'pending',
      requestedAt: quand(50),
    },
    {
      entityId: seed.entityId,
      jobId,
      agentId: seed.agentId,
      toolName: 'web_search',
      toolInput: {},
      status: 'approved',
      requestedAt: quand(20),
      resolvedAt: quand(21),
    },
    {
      entityId: seed.entityId,
      jobId,
      agentId: seed.agentId,
      toolName: 'send_message',
      toolInput: {},
      status: 'rejected',
      requestedAt: quand(30),
      resolvedAt: quand(31),
    },
    // SANS AGENT : la jointure ne rend rien, et la ligne doit tout de même
    // porter un nom — celui de l'outil, le seul fait qui reste.
    {
      entityId: seed.entityId,
      jobId,
      agentId: null,
      toolName: 'read_file',
      toolInput: {},
      status: 'expired',
      requestedAt: quand(40),
      resolvedAt: quand(41),
    },
  ]);
});

describe('la lecture du dossier Agents @cap:creer-agent/moteur', () => {
  it('rend ce qu’on lui demande, et pas plus, sur une base qui en porte treize', async () => {
    const { listSidebarAgentsAction } = await import('../sidebar-actions.ts');
    const r = await listSidebarAgentsAction(11);
    if (!r.ok) throw new Error(r.message);
    // ONZE : dix dessinés, et le onzième qui dit qu'il y en a d'autres.
    expect(r.data).toHaveLength(11);
  });

  it('garde l’ordre de la PAGE, celui que la personne a rangé à la main', async () => {
    // Un menu qui montrerait les agents dans un autre ordre que `/agents`
    // déferait sous les yeux le rangement qu'on vient d'y faire.
    const { listSidebarAgentsAction } = await import('../sidebar-actions.ts');
    const r = await listSidebarAgentsAction(4);
    if (!r.ok) throw new Error(r.message);
    // L'agent de `seedMinimal` porte la position 0 : il ouvre la liste.
    expect(r.data.map((a) => a.name)).toEqual(['Test Agent', 'Agent 01', 'Agent 02', 'Agent 03']);
  });

  it('ne rend QUE l’identifiant, le nom et l’activité, jamais le jeton du bot', async () => {
    // La ligne complète d'un agent porte son jeton Telegram et sa chaîne de
    // repli. Elle traverserait le réseau jusqu'au navigateur pour dessiner un
    // nom dans une colonne de 300 px.
    //
    // Mutation vérifiée : `select()` sans projection → ce cas rougit, le jeton
    // ressort.
    const { listSidebarAgentsAction } = await import('../sidebar-actions.ts');
    const r = await listSidebarAgentsAction(1);
    if (!r.ok) throw new Error(r.message);
    expect(Object.keys(r.data[0] ?? {}).sort()).toEqual(['id', 'name', 'running']);
    expect(JSON.stringify(r.data)).not.toContain('secret-bot-token');
  });
});

describe('les lectures du panneau Run @cap:planifier-une-tache/moteur', () => {
  it('borne les deux listes, et classe la plus récemment touchée d’abord', async () => {
    const { listSidebarCronAction, listSidebarWebhooksAction } =
      await import('../sidebar-actions.ts');
    const crons = await listSidebarCronAction(11);
    if (!crons.ok) throw new Error(crons.message);
    expect(crons.data).toHaveLength(11);
    expect(crons.data[0]?.name).toBe('Cron 12');

    const hooks = await listSidebarWebhooksAction(11);
    if (!hooks.ok) throw new Error(hooks.message);
    expect(hooks.data).toHaveLength(11);
    expect(hooks.data[0]?.name).toBe('Hook 12');
  });

  it('ne laisse PAS sortir le secret d’un webhook', async () => {
    // Le secret signe les appels entrants. Une liste de menu n'a aucune raison
    // de le porter, et il ne doit pas exister de chemin par lequel il arrive
    // dans le navigateur.
    const { listSidebarWebhooksAction } = await import('../sidebar-actions.ts');
    const r = await listSidebarWebhooksAction(50);
    if (!r.ok) throw new Error(r.message);
    expect(Object.keys(r.data[0] ?? {}).sort()).toEqual(['id', 'name']);
    expect(JSON.stringify(r.data)).not.toContain('deadbeef');
  });
});

describe('la lecture de RECENTS @cap:approuver-une-action/moteur', () => {
  it('écarte ce qui ATTEND ENCORE, et garde les trois réponses rendues', async () => {
    // « Recents » est ce qui a reçu une réponse : approuvé, refusé, ou expiré.
    // Une demande en attente appartient à la section du dessus, et la montrer
    // deux fois ferait croire à deux demandes.
    //
    // Mutation vérifiée : `ne(status, 'pending')` retiré → ce cas rougit, la
    // demande en attente apparaît dans les deux sections.
    const { listSidebarRecentApprovalsAction } = await import('../sidebar-actions.ts');
    const r = await listSidebarRecentApprovalsAction(50);
    if (!r.ok) throw new Error(r.message);
    expect(r.data).toHaveLength(3);
    expect(r.data.map((a) => a.toolName)).not.toContain('run_command');
  });

  it('classe par date de RÉPONSE, la dernière rendue d’abord', async () => {
    const { listSidebarRecentApprovalsAction } = await import('../sidebar-actions.ts');
    const r = await listSidebarRecentApprovalsAction(50);
    if (!r.ok) throw new Error(r.message);
    expect(r.data.map((a) => a.toolName)).toEqual(['read_file', 'send_message', 'web_search']);
  });

  it('retombe sur le nom de l’OUTIL quand l’agent a disparu', async () => {
    // L'agent supprimé laisse `agent_id` à NULL. Inventer un nom afficherait
    // un fait que rien ne vérifie (invariant #4) ; l'outil, lui, est écrit sur
    // la ligne et reste vrai.
    const { listSidebarRecentApprovalsAction } = await import('../sidebar-actions.ts');
    const r = await listSidebarRecentApprovalsAction(50);
    if (!r.ok) throw new Error(r.message);
    const orpheline = r.data.find((a) => a.toolName === 'read_file');
    expect(orpheline?.name).toBe('read_file');
    // Et celles qui ont un agent portent SON nom, comme la planche l'écrit.
    expect(r.data.find((a) => a.toolName === 'web_search')?.name).toBe('Test Agent');
  });
});

describe('les quatre lectures REFUSENT un plafond absurde @cap:installer-et-demarrer/moteur', () => {
  it('rejette zéro, un négatif, un décimal et cinquante-et-un', async () => {
    // Une action serveur est une porte publique : le menu lui passe une
    // constante aujourd'hui, mais un zéro, un négatif ou dix mille ferait soit
    // une requête absurde, soit la lecture non bornée que ces actions existent
    // justement pour éviter.
    //
    // Mutation vérifiée : la validation retirée d'une des quatre → ce cas
    // rougit, et `limit(0)` rend une liste vide au lieu d'une erreur.
    const actions = await import('../sidebar-actions.ts');
    const lectures = [
      actions.listSidebarAgentsAction,
      actions.listSidebarCronAction,
      actions.listSidebarWebhooksAction,
      actions.listSidebarRecentApprovalsAction,
    ];
    for (const lire of lectures) {
      for (const mauvais of [0, -1, 1.5, 51]) {
        const r = await lire(mauvais);
        expect(r.ok, `limite ${mauvais}`).toBe(false);
        if (!r.ok) expect(r.code).toBe('validation_failed');
      }
      // Et les bornes elles-mêmes passent : un refus trop large serait aussi
      // faux qu'une absence de refus.
      expect((await lire(1)).ok).toBe(true);
      expect((await lire(50)).ok).toBe(true);
    }
  });
});
