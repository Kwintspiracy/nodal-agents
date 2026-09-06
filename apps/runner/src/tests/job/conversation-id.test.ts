// conversation-id.test.ts — l'IDENTITÉ d'un fil (P6).
//
// Ce que ces tests protègent :
//   - un premier message CRÉE une ligne `conversations` relue en base, avec son
//     canal, son chat et son agent ;
//   - une semaine de silence ne change RIEN : c'est la même conversation, parce
//     que personne n'en a ouvert une autre (c'était l'inverse avant P6) ;
//   - `/new` ouvre une ligne neuve sans toucher à l'ancienne ni à ses jobs ;
//   - un autre chat, ou un autre agent (le cas `/ask`), est un autre fil ;
//   - le titre est posé UNE fois, et `updated_at` bouge à chaque tour ;
//   - `parseNewConversationCommand` ne prend pas `/newer` pour `/new` ;
//   - `loadConversationContext` compte les tours de TÊTE, respecte
//     `excludeJobId`, nomme le projet courant, et retire le tour courant sur le
//     dashboard.
//
// Aucune assertion sur une valeur de retour seule : chaque cas relit la base.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agents,
  chatMessages,
  conversations,
  codeProjects,
  entities,
  users,
  eq,
  and,
} from '@nodal-agents/db';
import { projectKey } from '@nodal-agents/shared';
import {
  resolveConversation,
  openNewConversation,
  touchConversation,
  parseNewConversationCommand,
  loadConversationContext,
} from '../../job/conversation-id.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  await db.delete(agentJobs);
  await db.delete(conversations);
});

/** La clé d'un fil Telegram — le tuple que le canal donne au runner. */
function key(chatId: string, agentId = seed.agentId) {
  return {
    db: db as unknown as Parameters<typeof resolveConversation>[0]['db'],
    entityId: seed.entityId,
    agentId,
    channel: 'telegram',
    chatId,
  };
}

/** La ligne `conversations`, relue. */
async function relireConversation(id: string) {
  const [row] = await db
    .select({
      id: conversations.id,
      channel: conversations.channel,
      chatId: conversations.chatId,
      agentId: conversations.agentId,
      entityId: conversations.entityId,
      title: conversations.title,
      origin: conversations.origin,
      currentProjectId: conversations.currentProjectId,
      updatedAt: conversations.updatedAt,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(eq(conversations.id, id));
  return row ?? null;
}

/** Un job de TÊTE dans une conversation, éventuellement vieilli. */
async function insererJob(opts: {
  conversationId: string;
  chatId: string;
  task?: string;
  minutesAgo?: number;
  parentJobId?: string;
}): Promise<string> {
  const createdAt = opts.minutesAgo ? new Date(Date.now() - opts.minutesAgo * 60_000) : new Date();
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      task: opts.task ?? 'un tour',
      chatId: opts.chatId,
      status: 'completed',
      conversationId: opts.conversationId,
      createdAt,
      completedAt: createdAt,
      ...(opts.parentJobId !== undefined ? { parentJobId: opts.parentJobId } : {}),
    })
    .returning({ id: agentJobs.id });
  if (!row) throw new Error('insert job');
  return row.id;
}

/** Vieillit une conversation ET son job : le cas « une semaine plus tard ». */
async function vieillirDUneSemaine(conversationId: string): Promise<void> {
  const ilYAUneSemaine = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  await db
    .update(conversations)
    .set({ createdAt: ilYAUneSemaine, updatedAt: ilYAUneSemaine })
    .where(eq(conversations.id, conversationId));
  await db
    .update(agentJobs)
    .set({ createdAt: ilYAUneSemaine, completedAt: ilYAUneSemaine })
    .where(eq(agentJobs.conversationId, conversationId));
}

describe('resolveConversation / openNewConversation', () => {
  it('un premier message CRÉE la ligne, avec son canal, son chat et son agent', async () => {
    const ref = await resolveConversation(key('chat-1'));

    const row = await relireConversation(ref.id);
    expect(row).toMatchObject({
      channel: 'telegram',
      chatId: 'chat-1',
      agentId: seed.agentId,
      entityId: seed.entityId,
      origin: 'user',
      title: '',
      currentProjectId: null,
    });
    expect(ref.currentProjectId).toBeNull();
  });

  it('une SEMAINE plus tard, c’est toujours la même conversation', async () => {
    // C'est LA règle que P6 inverse : le silence ne coupe plus rien. Avant, un
    // écart de plus de 4 h frappait un nouvel uuid sans que personne n'ait rien
    // demandé.
    const premier = await resolveConversation(key('chat-2'));
    await insererJob({ conversationId: premier.id, chatId: 'chat-2' });
    await vieillirDUneSemaine(premier.id);

    const second = await resolveConversation(key('chat-2'));

    expect(second.id).toBe(premier.id);
    const lignes = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.chatId, 'chat-2'), eq(conversations.channel, 'telegram')));
    expect(lignes).toHaveLength(1);
  });

  it('openNewConversation ouvre une ligne NEUVE ; l’ancienne et ses jobs sont intacts', async () => {
    const ancienne = await resolveConversation(key('chat-3'));
    const jobAncien = await insererJob({ conversationId: ancienne.id, chatId: 'chat-3' });

    const nouvelle = await openNewConversation(key('chat-3'));

    expect(nouvelle.id).not.toBe(ancienne.id);
    // L'ancienne existe toujours — ouvrir un fil n'efface pas le précédent.
    expect(await relireConversation(ancienne.id)).not.toBeNull();
    const [job] = await db
      .select({ conversationId: agentJobs.conversationId })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobAncien));
    expect(job?.conversationId).toBe(ancienne.id);

    // Et c'est bien la NEUVE que le fil rend désormais.
    const suivante = await resolveConversation(key('chat-3'));
    expect(suivante.id).toBe(nouvelle.id);
  });

  it('deux lignes au MÊME created_at : le fil rendu est déterministe', async () => {
    // Deux `/new` en rafale, ou un backfill qui pose la même date : sans
    // départage, la conversation courante devenait indéterminée et le fil
    // pouvait changer d'un message à l'autre (revue Codex, passe 28).
    //
    // Les id sont CHOISIS, et le PLUS PETIT est inséré en premier : sans
    // `id DESC`, un parcours séquentiel rend la première ligne physique — donc
    // le petit id — et ce test rougit. C'est ce qui le rend probant.
    const meme = new Date('2026-09-01T10:00:00.000Z');
    const petit = '00000000-0000-4000-8000-000000000001';
    const grand = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    for (const id of [petit, grand]) {
      await db.insert(conversations).values({
        id,
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: 'chat-ex-aequo',
        origin: 'user',
        createdAt: meme,
      });
    }

    for (let i = 0; i < 3; i++) {
      expect((await resolveConversation(key('chat-ex-aequo'))).id).toBe(grand);
    }
    // Et rien n'a été créé au passage : le fil existait déjà.
    const lignes = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.chatId, 'chat-ex-aequo'));
    expect(lignes).toHaveLength(2);
  });

  it('un autre chat_id est un autre fil', async () => {
    const a = await resolveConversation(key('chat-A'));
    const b = await resolveConversation(key('chat-B'));

    expect(b.id).not.toBe(a.id);
    expect((await relireConversation(b.id))?.chatId).toBe('chat-B');
  });

  it('un autre AGENT sur le même chat est un autre fil (le cas /ask)', async () => {
    const [autre] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Second Agent',
        slug: `second-${Date.now()}`,
        personality: 'p',
        role: 'agent',
      })
      .returning({ id: agents.id });
    if (!autre) throw new Error('insert agent');

    const premier = await resolveConversation(key('chat-partage'));
    const second = await resolveConversation(key('chat-partage', autre.id));

    expect(second.id).not.toBe(premier.id);
    expect((await relireConversation(second.id))?.agentId).toBe(autre.id);
  });

  it('la conversation neuve n’HÉRITE pas du projet courant de la précédente', async () => {
    const ancienne = await resolveConversation(key('chat-projet'));
    const [projet] = await db
      .insert(codeProjects)
      .values({
        entityId: seed.entityId,
        projectPath: '/tmp/p6/app',
        projectKey: projectKey('/tmp/p6/app'),
        registeredAt: new Date(),
        registeredFrom: 'spaces',
      })
      .returning({ id: codeProjects.id });
    if (!projet) throw new Error('insert projet');
    await db
      .update(conversations)
      .set({ currentProjectId: projet.id })
      .where(eq(conversations.id, ancienne.id));

    const nouvelle = await openNewConversation(key('chat-projet'));

    expect(nouvelle.currentProjectId).toBeNull();
    expect((await relireConversation(nouvelle.id))?.currentProjectId).toBeNull();
  });

  it('resolveConversation rend le projet courant du fil, pour que le job le porte', async () => {
    const ref = await resolveConversation(key('chat-porte'));
    const [projet] = await db
      .insert(codeProjects)
      .values({
        entityId: seed.entityId,
        projectPath: '/tmp/p6/porte',
        projectKey: projectKey('/tmp/p6/porte'),
        registeredAt: new Date(),
        registeredFrom: 'spaces',
      })
      .returning({ id: codeProjects.id });
    if (!projet) throw new Error('insert projet');
    await db
      .update(conversations)
      .set({ currentProjectId: projet.id })
      .where(eq(conversations.id, ref.id));

    const suivant = await resolveConversation(key('chat-porte'));
    expect(suivant.currentProjectId).toBe(projet.id);
  });
});

describe('touchConversation', () => {
  it('pose le titre UNE seule fois — la première ligne, tronquée à 60', async () => {
    const ref = await resolveConversation(key('chat-titre'));
    const longue = 'a'.repeat(80);

    await touchConversation(db, ref.id, `${longue}\nseconde ligne ignorée`);
    const apresPremier = await relireConversation(ref.id);
    expect(apresPremier?.title).toBe('a'.repeat(60) + '…');

    await touchConversation(db, ref.id, 'un tout autre message');
    expect((await relireConversation(ref.id))?.title).toBe('a'.repeat(60) + '…');
  });

  it('ne garde que la PREMIÈRE ligne, sans ellipse quand ça tient', async () => {
    const ref = await resolveConversation(key('chat-titre-court'));
    await touchConversation(db, ref.id, 'rédige le plan\nles détails suivent');
    expect((await relireConversation(ref.id))?.title).toBe('rédige le plan');
  });

  it('le préfixe de GROUPE ne nomme pas le fil — il nomme un expéditeur', async () => {
    // Dans un salon, chaque tâche est préfixée `[Message from Untel]: ` pour
    // que le modèle sache qui parle. Le titre, lui, doit dire de quoi ça parle
    // (revue Codex, passe 29, doute 1). La TÂCHE n'est pas touchée.
    const ref = await resolveConversation(key('chat-titre-groupe'));
    await touchConversation(
      db,
      ref.id,
      '[Message from Paul (@paul)]: rédige le bilan de septembre',
    );
    expect((await relireConversation(ref.id))?.title).toBe('rédige le bilan de septembre');
  });

  it('un texte qui commence par des crochets SANS être un préfixe reste entier', async () => {
    const ref = await resolveConversation(key('chat-titre-crochets'));
    await touchConversation(db, ref.id, '[URGENT] la prod est tombée');
    expect((await relireConversation(ref.id))?.title).toBe('[URGENT] la prod est tombée');
  });

  it('fait bouger updated_at à chaque tour', async () => {
    const ref = await resolveConversation(key('chat-touch'));
    const vieux = new Date(Date.now() - 60 * 60_000);
    await db
      .update(conversations)
      .set({ updatedAt: vieux, title: 'déjà nommée' })
      .where(eq(conversations.id, ref.id));

    await touchConversation(db, ref.id, 'un nouveau tour');

    const row = await relireConversation(ref.id);
    expect(row?.title).toBe('déjà nommée');
    expect(new Date(row?.updatedAt as unknown as string).getTime()).toBeGreaterThan(
      vieux.getTime(),
    );
  });
});

describe('parseNewConversationCommand', () => {
  it('/new nu ouvre un fil et ne laisse aucun reste', () => {
    expect(parseNewConversationCommand('/new')).toEqual({ opensNew: true, rest: '' });
    expect(parseNewConversationCommand('  /new  ')).toEqual({ opensNew: true, rest: '' });
  });

  it('/new suivi d’un texte rend le texte trimé', () => {
    expect(parseNewConversationCommand('/new  bonjour')).toEqual({
      opensNew: true,
      rest: 'bonjour',
    });
  });

  it('/newer n’est PAS /new — la frontière est un espace', () => {
    expect(parseNewConversationCommand('/newer')).toEqual({ opensNew: false, rest: '/newer' });
    expect(parseNewConversationCommand('/newsletter du mois')).toEqual({
      opensNew: false,
      rest: '/newsletter du mois',
    });
  });

  it('un /new AU MILIEU d’une phrase ne fait rien', () => {
    expect(parseNewConversationCommand('x /new')).toEqual({ opensNew: false, rest: 'x /new' });
  });
});

describe('loadConversationContext', () => {
  it('rend null quand la ligne n’existe pas (un uuid d’avant P6)', async () => {
    const ctx = await loadConversationContext(db, '00000000-0000-0000-0000-000000000000');
    expect(ctx).toBeNull();
  });

  it('compte les jobs de TÊTE, hors excludeJobId — les enfants ne sont pas des tours', async () => {
    const ref = await resolveConversation(key('chat-tours'));
    await insererJob({ conversationId: ref.id, chatId: 'chat-tours', minutesAgo: 30 });
    const parent = await insererJob({
      conversationId: ref.id,
      chatId: 'chat-tours',
      minutesAgo: 20,
    });
    await insererJob({
      conversationId: ref.id,
      chatId: 'chat-tours',
      minutesAgo: 19,
      parentJobId: parent,
    });
    const courant = await insererJob({ conversationId: ref.id, chatId: 'chat-tours' });

    const ctx = await loadConversationContext(db, ref.id, { excludeJobId: courant });

    // 2 tours : le premier et le parent. L'enfant ne compte pas, le courant est exclu.
    // `toMatchObject` et non `toEqual` : depuis P10b le contexte porte aussi
    // les projets déclarés, dont ce cas-ci ne dit rien.
    expect(ctx).toMatchObject({
      id: ref.id,
      priorTurns: 2,
      openedByCommand: false,
      currentProject: null,
    });
  });

  it('sans excludeJobId, le tour courant compte lui aussi', async () => {
    const ref = await resolveConversation(key('chat-sans-exclude'));
    await insererJob({ conversationId: ref.id, chatId: 'chat-sans-exclude' });
    const ctx = await loadConversationContext(db, ref.id);
    expect(ctx?.priorTurns).toBe(1);
  });

  it('le projet courant porte son display_name quand il en a un', async () => {
    const ref = await resolveConversation(key('chat-nom'));
    const [projet] = await db
      .insert(codeProjects)
      .values({
        entityId: seed.entityId,
        projectPath: 'D:/APPS/mon-app',
        projectKey: projectKey('D:/APPS/mon-app'),
        displayName: 'Le Grand Projet',
        kind: 'documents',
        registeredAt: new Date(),
        registeredFrom: 'spaces',
      })
      .returning({ id: codeProjects.id });
    if (!projet) throw new Error('insert projet');
    await db
      .update(conversations)
      .set({ currentProjectId: projet.id })
      .where(eq(conversations.id, ref.id));

    const ctx = await loadConversationContext(db, ref.id);
    expect(ctx?.currentProject).toEqual({
      name: 'Le Grand Projet',
      path: 'D:/APPS/mon-app',
      kind: 'documents',
    });
  });

  it('sans display_name, le nom est celui du DOSSIER', async () => {
    const ref = await resolveConversation(key('chat-basename'));
    const [projet] = await db
      .insert(codeProjects)
      .values({
        entityId: seed.entityId,
        projectPath: 'D:/APPS/sans-nom-choisi',
        projectKey: projectKey('D:/APPS/sans-nom-choisi'),
        registeredAt: new Date(),
        registeredFrom: 'spaces',
      })
      .returning({ id: codeProjects.id });
    if (!projet) throw new Error('insert projet');
    await db
      .update(conversations)
      .set({ currentProjectId: projet.id })
      .where(eq(conversations.id, ref.id));

    const ctx = await loadConversationContext(db, ref.id);
    expect(ctx?.currentProject).toEqual({
      name: 'sans-nom-choisi',
      path: 'D:/APPS/sans-nom-choisi',
      kind: 'code',
    });
  });

  it('une conversation DASHBOARD compte ses messages user MOINS le tour courant', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, origin: 'user' })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('insert conversation');

    // Deux échanges complets, puis le tour courant qui vient d'être inséré.
    for (const [role, content] of [
      ['user', 'un'],
      ['assistant', 'réponse un'],
      ['user', 'deux'],
      ['assistant', 'réponse deux'],
      ['user', 'trois — le tour courant'],
    ] as const) {
      await db.insert(chatMessages).values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        conversationId: conv.id,
        role,
        content,
      });
    }

    const ctx = await loadConversationContext(db, conv.id);
    expect(ctx?.priorTurns).toBe(2);
  });

  it('openedByCommand : vrai pour un /new NU au premier tour', async () => {
    // « Premier tour » ne dit pas « /new » : un premier message naturel a le
    // même contexte. Le fait est transporté, pas deviné (revue Codex, passe 28).
    const ref = await resolveConversation(key('chat-new-nu'));
    const ctx = await loadConversationContext(db, ref.id, { task: '/new' });
    expect(ctx?.openedByCommand).toBe(true);
    expect(ctx?.priorTurns).toBe(0);
  });

  it('openedByCommand : FAUX pour /new suivi d’un texte', async () => {
    // Les handlers ont déjà remplacé la tâche par le reste : c'est ce reste qui
    // arrive ici, et c'est une vraie demande.
    const ref = await resolveConversation(key('chat-new-texte'));
    const ctx = await loadConversationContext(db, ref.id, { task: 'rédige le plan' });
    expect(ctx?.openedByCommand).toBe(false);
  });

  it('openedByCommand : FAUX pour /new quand un tour précède', async () => {
    // Ailleurs qu'au premier tour, un message qui vaut `/new` est une
    // coïncidence sans conséquence — le fil, lui, n'est pas neuf.
    const ref = await resolveConversation(key('chat-new-tardif'));
    await insererJob({ conversationId: ref.id, chatId: 'chat-new-tardif' });
    const ctx = await loadConversationContext(db, ref.id, { task: '/new' });
    expect(ctx?.priorTurns).toBe(1);
    expect(ctx?.openedByCommand).toBe(false);
  });

  it('openedByCommand : FAUX quand aucune tâche n’est passée', async () => {
    const ref = await resolveConversation(key('chat-sans-tache'));
    const ctx = await loadConversationContext(db, ref.id);
    expect(ctx?.openedByCommand).toBe(false);
  });

  it('un premier message du dashboard donne bien ZÉRO tour précédent', async () => {
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: seed.entityId, agentId: seed.agentId, origin: 'user' })
      .returning({ id: conversations.id });
    if (!conv) throw new Error('insert conversation');
    await db.insert(chatMessages).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: conv.id,
      role: 'user',
      content: 'le tout premier message',
    });

    const ctx = await loadConversationContext(db, conv.id);
    expect(ctx?.priorTurns).toBe(0);
  });
});

// ─── P10b : les projets DÉCLARÉS, options de la question « où écrire ? » ──────
//
// Ce que ces cas protègent : la liste ne contient QUE des projets déclarés de
// CETTE entité, jamais une ligne de comptabilité ni un projet masqué, et elle
// disparaît dès que le fil a un projet courant.
describe('loadConversationContext — les projets déclarés (P10b)', () => {
  beforeEach(async () => {
    await db.delete(codeProjects);
  });

  /** Une ligne `code_projects`, telle que l'appelant la veut. */
  async function projet(o: {
    path: string;
    entityId?: string;
    displayName?: string;
    kind?: 'code' | 'documents';
    registered?: boolean;
    hidden?: boolean;
  }): Promise<string> {
    const [row] = await db
      .insert(codeProjects)
      .values({
        entityId: o.entityId ?? seed.entityId,
        projectPath: o.path,
        projectKey: projectKey(o.path),
        ...(o.displayName ? { displayName: o.displayName } : {}),
        kind: o.kind ?? 'documents',
        hidden: o.hidden ?? false,
        ...(o.registered === false
          ? {}
          : { registeredAt: new Date(), registeredFrom: 'spaces' as const }),
      })
      .returning({ id: codeProjects.id });
    if (!row) throw new Error('insert projet');
    return row.id;
  }

  it('rend les projets déclarés de l’entité, avec leur nom et leur genre', async () => {
    const ref = await resolveConversation(key('chat-p10b'));
    await projet({ path: 'D:/Terrain/veille-ia', displayName: 'Veille IA' });
    await projet({ path: 'D:/APPS/NodalAI', kind: 'code' });

    const ctx = await loadConversationContext(db, ref.id);
    expect(ctx?.registeredProjects).toEqual(
      expect.arrayContaining([
        { name: 'Veille IA', path: 'D:/Terrain/veille-ia', kind: 'documents' },
        { name: 'NodalAI', path: 'D:/APPS/NodalAI', kind: 'code' },
      ]),
    );
    expect(ctx?.registeredProjects).toHaveLength(2);
  });

  it('ignore les lignes de COMPTABILITÉ et les projets masqués', async () => {
    const ref = await resolveConversation(key('chat-p10b-compta'));
    await projet({ path: 'D:/Terrain/vrai', displayName: 'Vrai' });
    // Une ligne posée par un renommage ou une intention de mutation : elle
    // n'est pas un projet qu'on peut proposer.
    await projet({ path: 'D:/Terrain/compta', displayName: 'Compta', registered: false });
    // Masquer retire du bloc Runtime ; le proposer ici le ramènerait.
    await projet({ path: 'D:/Terrain/range', displayName: 'Rangé', hidden: true });

    const ctx = await loadConversationContext(db, ref.id);
    expect(ctx?.registeredProjects).toEqual([
      { name: 'Vrai', path: 'D:/Terrain/vrai', kind: 'documents' },
    ]);
  });

  it('ne rend jamais les projets d’une AUTRE entité', async () => {
    const ref = await resolveConversation(key('chat-p10b-voisin'));
    const [user] = await db
      .insert(users)
      .values({ email: `voisin-p10b-${Date.now()}@example.com` })
      .returning({ id: users.id });
    if (!user) throw new Error('insert user');
    const [autre] = await db
      .insert(entities)
      .values({ userId: user.id, name: 'Voisine', slug: `voisine-p10b-${Date.now()}` })
      .returning({ id: entities.id });
    if (!autre) throw new Error('insert entity');
    await projet({ path: 'D:/Voisin/secret', displayName: 'Secret', entityId: autre.id });
    await projet({ path: 'D:/Terrain/mien', displayName: 'Mien' });

    const ctx = await loadConversationContext(db, ref.id);
    expect(ctx?.registeredProjects).toEqual([
      { name: 'Mien', path: 'D:/Terrain/mien', kind: 'documents' },
    ]);
  });

  it('n’est pas chargé quand le fil a déjà un projet courant', async () => {
    const ref = await resolveConversation(key('chat-p10b-courant'));
    const courant = await projet({ path: 'D:/Terrain/courant', displayName: 'Courant' });
    await projet({ path: 'D:/Terrain/autre', displayName: 'Autre' });
    await db
      .update(conversations)
      .set({ currentProjectId: courant })
      .where(eq(conversations.id, ref.id));

    const ctx = await loadConversationContext(db, ref.id);
    expect(ctx?.currentProject?.name).toBe('Courant');
    expect(ctx?.registeredProjects).toBeUndefined();
  });
});
