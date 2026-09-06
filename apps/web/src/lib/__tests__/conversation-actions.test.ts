// conversation-actions.test.ts — Chat, la maison de toutes les conversations
// (P7), contre une VRAIE base.
//
// Ce qui se prouve ici ne peut pas se prouver sur du pur : que les lignes
// écrites par le runner (une conversation de canal dont les tours sont des
// jobs, une conversation du dashboard dont les tours sont des messages)
// ressortent en UN seul fil, que la production d'un travail retrouve le projet
// où elle vit, et que le fil d'un voisin reste chez le voisin.
//
// Les assertions portent sur les items du fil et les lignes relues — jamais
// sur `result.ok` seul.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  agentJobs,
  chatMessages,
  codeProjects,
  conversations,
  entities,
  jobDeliverableVerificationState,
  toolCalls,
  users,
} from '@nodal-agents/db';
import { projectKey } from '@nodal-agents/shared';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** Les identités posées une fois pour toutes par le seed du fichier. */
const telegramConv = { id: '', jobA: '', jobB: '' };
const dashboardConv = { id: '' };
const projet = { id: '', path: '', name: 'Bilans mensuels' };
const voisin = { entityId: '', agentId: '', conversationId: '' };
const auditConv = { id: '' };
const longueConv = { id: '' };
const bavardeConv = { id: '' };
/** Un fil EXACTEMENT au plafond : ni un de plus, ni un de moins. */
const pileConv = { id: '' };
/** Un fil OUVERT DEPUIS UN PROJET (`origin = 'project'`, 0097). */
const projetConv = { id: '' };
const groupeConv = { id: '' };

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

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  // Un projet ENREGISTRÉ (registered_at NOT NULL) : c'est celui-là qu'un
  // encart doit nommer, avec son chemin.
  projet.path = '/terrain/bilans';
  const [p] = await testDb
    .insert(codeProjects)
    .values({
      entityId: seed.entityId,
      projectPath: projet.path,
      projectKey: projectKey(projet.path),
      displayName: projet.name,
      agentId: seed.agentId,
      registeredAt: new Date(),
      registeredFrom: 'spaces',
    })
    .returning({ id: codeProjects.id });
  projet.id = p!.id;

  // ── La conversation Telegram : deux jobs de tête, le second a produit ──────
  const [conv] = await testDb
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      title: '',
      origin: 'user',
      channel: 'telegram',
      chatId: '4242',
      createdAt: new Date('2026-09-01T10:00:00Z'),
      updatedAt: new Date('2026-09-01T12:00:00Z'),
    })
    .returning({ id: conversations.id });
  telegramConv.id = conv!.id;

  const [jobA] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '4242',
      conversationId: telegramConv.id,
      task: 'Quoi de neuf ?',
      status: 'completed',
      result: 'Rien de spécial.',
      messages: [
        { role: 'user', content: 'Quoi de neuf ?' },
        { role: 'assistant', content: 'Rien de spécial.' },
      ],
      createdAt: new Date('2026-09-01T10:00:00Z'),
      completedAt: new Date('2026-09-01T10:01:00Z'),
    })
    .returning({ id: agentJobs.id });
  telegramConv.jobA = jobA!.id;

  const [jobB] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '4242',
      conversationId: telegramConv.id,
      projectId: projet.id,
      task: 'Écris le bilan de septembre',
      status: 'completed',
      result: 'Bilan écrit.',
      messages: [
        { role: 'user', content: 'Écris le bilan de septembre' },
        { role: 'assistant', content: 'Voilà.' },
      ],
      createdAt: new Date('2026-09-01T11:00:00Z'),
      completedAt: new Date('2026-09-01T11:05:00Z'),
    })
    .returning({ id: agentJobs.id });
  telegramConv.jobB = jobB!.id;

  await testDb.insert(toolCalls).values({
    entityId: seed.entityId,
    jobId: telegramConv.jobB,
    toolName: 'file_write',
    card: 'files',
    presented: {
      card: 'files',
      files: [{ path: 'bilan-septembre.md', action: 'created' }],
      total: 1,
      truncated: false,
    },
    riskLevel: 'write',
    toolInput: { path: 'bilan-septembre.md' },
    toolOutput: 'written',
  });

  // ── La conversation du dashboard : un tour parlé, un tour escaladé ─────────
  const [conv2] = await testDb
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      title: '',
      origin: 'user',
      channel: 'dashboard',
      createdAt: new Date('2026-09-02T10:00:00Z'),
      updatedAt: new Date('2026-09-02T10:30:00Z'),
    })
    .returning({ id: conversations.id });
  dashboardConv.id = conv2!.id;

  const [jobC] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      conversationId: dashboardConv.id,
      task: 'Compter les lignes du bilan',
      status: 'completed',
      result: '42 lignes.',
      messages: [
        { role: 'user', content: 'Compter les lignes du bilan' },
        { role: 'assistant', content: '42 lignes.' },
      ],
      createdAt: new Date('2026-09-02T10:20:00Z'),
      completedAt: new Date('2026-09-02T10:21:00Z'),
    })
    .returning({ id: agentJobs.id });

  await testDb.insert(chatMessages).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: dashboardConv.id,
      role: 'user',
      content: 'salut',
      createdAt: new Date('2026-09-02T10:00:00Z'),
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: dashboardConv.id,
      role: 'assistant',
      content: 'salut !',
      createdAt: new Date('2026-09-02T10:01:00Z'),
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: dashboardConv.id,
      role: 'user',
      content: 'compte les lignes du bilan',
      createdAt: new Date('2026-09-02T10:19:00Z'),
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: dashboardConv.id,
      role: 'assistant',
      content: 'je regarde',
      jobId: jobC!.id,
      createdAt: new Date('2026-09-02T10:20:00Z'),
    },
  ]);

  // ── Deux jobs de tête, chacun avec SA ligne d'audit ───────────────────────
  // Les fils sont assemblés en trois requêtes groupées : ce fil prouve que la
  // répartition en mémoire ne mélange pas les lignes de deux travaux.
  const [convAudit] = await testDb
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      title: 'Deux travaux',
      origin: 'user',
      channel: 'telegram',
      chatId: '77',
      createdAt: new Date('2026-09-03T10:00:00Z'),
      updatedAt: new Date('2026-09-03T11:00:00Z'),
    })
    .returning({ id: conversations.id });
  auditConv.id = convAudit!.id;

  // Les lignes d'audit SANS `tool_call_id` : c'est la forme des lignes
  // anciennes, et la seule où le rattachement se fait par NOM, dans l'ordre.
  // C'est donc la seule qui rend le regroupement OBSERVABLE : si les lignes
  // des deux travaux étaient mises en commun, le premier prendrait celle du
  // second (elle est plus ancienne) et l'écran mentirait.
  const bloc = (n: number) => ({
    role: 'assistant',
    content: Array.from({ length: n }, () => ({
      type: 'tool-call',
      toolName: 'run_command',
      input: {},
    })),
  });
  const travaux = [
    { rang: 'premier', commandes: ['echo un'], creeA: '2026-09-03T10:10:00Z', audit: 40 },
    {
      rang: 'second',
      commandes: ['echo deux', 'echo trois'],
      creeA: '2026-09-03T10:20:00Z',
      audit: 10,
    },
  ] as const;
  for (const t of travaux) {
    const [j] = await testDb
      .insert(agentJobs)
      .values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId: '77',
        conversationId: auditConv.id,
        task: `travail ${t.rang}`,
        status: 'completed',
        result: `fini ${t.rang}`,
        messages: [{ role: 'user', content: `travail ${t.rang}` }, bloc(t.commandes.length)],
        createdAt: new Date(t.creeA),
        completedAt: new Date('2026-09-03T10:30:00Z'),
      })
      .returning({ id: agentJobs.id });
    await testDb.insert(toolCalls).values(
      t.commandes.map((commande, k) => ({
        entityId: seed.entityId,
        jobId: j!.id,
        toolName: 'run_command',
        card: 'terminal',
        presented: {
          card: 'terminal',
          command: commande,
          exitCode: 0,
          timedOut: false,
          stdoutTail: '',
          stdoutTruncated: false,
          stderrTail: '',
          stderrTruncated: false,
        },
        riskLevel: 'write',
        toolInput: {},
        toolOutput: 'ok',
        // Les lignes du SECOND sont les plus anciennes : mises en commun,
        // c'est le premier travail qui les prendrait.
        createdAt: new Date(Date.UTC(2026, 8, 3, 9, t.audit + k)),
      })),
    );
  }

  // ── Un fil de canal PLUS LONG que le plafond de jobs ──────────────────────
  const [convLongue] = await testDb
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      title: 'Fil tres long',
      origin: 'user',
      channel: 'telegram',
      chatId: '88',
      createdAt: new Date('2026-09-04T08:00:00Z'),
      updatedAt: new Date('2026-09-04T09:00:00Z'),
    })
    .returning({ id: conversations.id });
  longueConv.id = convLongue!.id;
  await testDb.insert(agentJobs).values(
    Array.from({ length: 101 }, (_, i) => ({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '88',
      conversationId: longueConv.id,
      task: `tour ${i + 1}`,
      status: 'completed',
      result: `fait ${i + 1}`,
      messages: [{ role: 'user', content: `tour ${i + 1}` }],
      createdAt: new Date(Date.UTC(2026, 8, 4, 8, i)),
      completedAt: new Date(Date.UTC(2026, 8, 4, 8, i, 30)),
    })),
  );

  // ── Un fil du dashboard PLUS LONG que le plafond de messages ──────────────
  const [convBavarde] = await testDb
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      title: 'Fil bavard',
      origin: 'user',
      channel: 'dashboard',
      createdAt: new Date('2026-09-05T08:00:00Z'),
      updatedAt: new Date('2026-09-05T09:00:00Z'),
    })
    .returning({ id: conversations.id });
  bavardeConv.id = convBavarde!.id;
  await testDb.insert(chatMessages).values(
    Array.from({ length: 502 }, (_, i) => ({
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: bavardeConv.id,
      role: 'user' as const,
      content: `m${i + 1}`,
      createdAt: new Date(Date.UTC(2026, 8, 5, 8, 0, i)),
    })),
  );

  // ── Un fil EXACTEMENT au plafond (500 messages) ───────────────────────────
  // Le cas que la lecture N+1 règle : un plafond ATTEINT n'est pas un plafond
  // MORDU. Avant, ce fil annonçait un début manquant qui n'existait pas.
  const [convPile] = await testDb
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      title: 'Fil pile au plafond',
      origin: 'user',
      channel: 'dashboard',
      createdAt: new Date('2026-09-05T10:00:00Z'),
      updatedAt: new Date('2026-09-05T11:00:00Z'),
    })
    .returning({ id: conversations.id });
  pileConv.id = convPile!.id;
  await testDb.insert(chatMessages).values(
    Array.from({ length: 500 }, (_, i) => ({
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: pileConv.id,
      role: 'user' as const,
      content: `p${i + 1}`,
      createdAt: new Date(Date.UTC(2026, 8, 5, 10, 0, i)),
    })),
  );

  // ── Un fil de GROUPE : la tache porte le prefixe de l'expediteur ──────────
  const [convGroupe] = await testDb
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      // Titre VIDE : c'est le repli sur la premiere demande qui est en jeu.
      title: '',
      origin: 'user',
      channel: 'slack',
      chatId: 'C42',
      createdAt: new Date('2026-09-06T08:00:00Z'),
      updatedAt: new Date('2026-09-06T08:30:00Z'),
    })
    .returning({ id: conversations.id });
  groupeConv.id = convGroupe!.id;
  await testDb.insert(agentJobs).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: 'slack',
    chatId: 'C42',
    conversationId: groupeConv.id,
    task: '[Message from Paul (@paul)]: redige le bilan de septembre',
    status: 'completed',
    result: 'fait',
    messages: [],
    createdAt: new Date('2026-09-06T08:10:00Z'),
    completedAt: new Date('2026-09-06T08:20:00Z'),
  });

  // L'entretien d'accueil — estampillé à la création, jamais dans la liste.
  await testDb.insert(conversations).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    title: 'Onboarding',
    origin: 'onboarding',
    channel: 'dashboard',
  });

  // Une conversation OUVERTE DEPUIS UN PROJET (0097). Elle reste une
  // conversation de l'utilisateur : elle appartient à la liste de Chat.
  const [convProjet] = await testDb
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      title: 'Depuis un projet',
      origin: 'project',
      channel: 'dashboard',
      createdAt: new Date('2026-09-05T12:00:00Z'),
      updatedAt: new Date('2026-09-05T12:30:00Z'),
    })
    .returning({ id: conversations.id });
  projetConv.id = convProjet!.id;

  // ── L'espace d'à côté : jamais celui de la session ─────────────────────────
  const [autreUser] = await testDb
    .insert(users)
    .values({ email: `voisin-conv-${Date.now()}@example.com` })
    .returning();
  const [autreEntite] = await testDb
    .insert(entities)
    .values({
      userId: autreUser!.id,
      name: 'Espace voisin',
      slug: `voisin-conv-${Date.now()}`,
    })
    .returning();
  voisin.entityId = autreEntite!.id;
  const [autreAgent] = await testDb
    .insert(agents)
    .values({
      entityId: voisin.entityId,
      name: 'Agent du voisin',
      slug: `agent-voisin-conv-${Date.now()}`,
      personality: 'Pas le vôtre.',
    })
    .returning();
  voisin.agentId = autreAgent!.id;
  const [convVoisin] = await testDb
    .insert(conversations)
    .values({
      entityId: voisin.entityId,
      agentId: voisin.agentId,
      title: 'Chez le voisin',
      origin: 'user',
      channel: 'slack',
      chatId: 'C999',
    })
    .returning({ id: conversations.id });
  voisin.conversationId = convVoisin!.id;
});

describe('listAllConversationsAction', () => {
  it('liste TOUS les canaux, compte les tours, et laisse dehors l’accueil et le voisin', async () => {
    const { listAllConversationsAction } = await actions();
    const r = await listAllConversationsAction();
    if (!r.ok) throw new Error(`échec inattendu : ${r.code} ${r.message}`);

    const ids = r.data.map((c) => c.id);
    expect(ids).toContain(telegramConv.id);
    expect(ids).toContain(dashboardConv.id);
    expect(ids).not.toContain(voisin.conversationId);
    expect(r.data.some((c) => c.title === 'Onboarding')).toBe(false);

    const tg = r.data.find((c) => c.id === telegramConv.id)!;
    expect(tg.channel).toBe('telegram');
    expect(tg.chatId).toBe('4242');
    // Deux jobs de tête = deux tours ; le titre de repli est la PREMIÈRE demande.
    expect(tg.turns).toBe(2);
    expect(tg.title).toBe('Quoi de neuf ?');
    expect(tg.lastPreview).toBe('Bilan écrit.');
    expect(tg.agentName).toBe('Test Agent');

    const db = r.data.find((c) => c.id === dashboardConv.id)!;
    // Deux messages `user` = deux tours ; l'aperçu est le dernier mot de l'agent.
    expect(db.turns).toBe(2);
    expect(db.title).toBe('salut');
    expect(db.lastPreview).toBe('je regarde');
  });
});

describe('getConversationThreadAction — une conversation de canal', () => {
  it('rend les deux travaux en un seul fil, avec l’encart de production et son projet', async () => {
    const { getConversationThreadAction } = await actions();
    const r = await getConversationThreadAction(telegramConv.id);
    if (!r.ok) throw new Error(`échec inattendu : ${r.code} ${r.message}`);

    expect(r.data.canReply).toBe(false);
    expect(r.data.conversation.channel).toBe('telegram');

    const demandes = r.data.feed.items
      .filter((i) => i.kind === 'request')
      .map((i) => (i.kind === 'request' ? i.text : ''));
    expect(demandes).toEqual(['Quoi de neuf ?', 'Écris le bilan de septembre']);

    const produits = r.data.feed.items.filter((i) => i.kind === 'produced');
    expect(produits).toHaveLength(1);
    const encart = produits[0];
    if (encart?.kind !== 'produced') throw new Error('item produced attendu');
    expect(encart.jobId).toBe(telegramConv.jobB);
    expect(encart.verdict.isWork).toBe(true);
    expect(encart.verdict.items).toEqual([
      { kind: 'file', label: 'bilan-septembre.md', path: 'bilan-septembre.md' },
    ]);
    // Le NOM et le CHEMIN du projet, relus depuis le registre.
    expect(encart.project).toEqual({
      id: projet.id,
      name: projet.name,
      path: projet.path,
    });

    // L'encart suit le job qui a produit, jamais le premier.
    const rangEncart = r.data.feed.items.findIndex((i) => i.kind === 'produced');
    const rangSecondeDemande = r.data.feed.items.findIndex(
      (i) => i.kind === 'request' && i.text === 'Écris le bilan de septembre',
    );
    expect(rangEncart).toBeGreaterThan(rangSecondeDemande);
  });
});

describe('getConversationThreadAction — une conversation du dashboard', () => {
  it('mêle le tour parlé et le tour escaladé, et laisse répondre', async () => {
    const { getConversationThreadAction } = await actions();
    const r = await getConversationThreadAction(dashboardConv.id);
    if (!r.ok) throw new Error(`échec inattendu : ${r.code} ${r.message}`);

    expect(r.data.canReply).toBe(true);
    expect(r.data.feed.items.map((i) => i.kind)).toEqual([
      'request',
      'turn',
      'request',
      'turn',
      'handoff',
      'turn',
      'answer',
    ]);
    const consigne = r.data.feed.items.find((i) => i.kind === 'handoff');
    if (consigne?.kind !== 'handoff') throw new Error('item handoff attendu');
    expect(consigne.text).toBe('Compter les lignes du bilan');
    // Aucun travail n'est sorti du chat : pas d'encart.
    expect(r.data.feed.items.some((i) => i.kind === 'produced')).toBe(false);
  });
});

describe('getConversationThreadAction — les bornes', () => {
  it('la conversation d’une AUTRE entité est introuvable', async () => {
    const { getConversationThreadAction } = await actions();
    const r = await getConversationThreadAction(voisin.conversationId);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('not_found');
  });

  it('un identifiant qui n’est pas un GUID est refusé', async () => {
    const { getConversationThreadAction } = await actions();
    const r = await getConversationThreadAction('pas-un-guid');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('validation_failed');
  });
});

describe('getConversationThreadAction — les fils assembles ensemble', () => {
  it('chaque travail ne porte QUE ses propres lignes d’audit', async () => {
    // Les enfants, les tool_calls et les llm_calls sont charges en trois
    // requetes pour TOUS les jobs de tete, puis repartis en memoire (revue
    // Codex, passe 29, doute 2) : une repartition fautive melangerait les deux.
    const { getConversationThreadAction } = await actions();
    const r = await getConversationThreadAction(auditConv.id);
    if (!r.ok) throw new Error(`echec inattendu : ${r.code} ${r.message}`);

    const commandes = r.data.feed.items.flatMap((i) =>
      i.kind === 'turn'
        ? i.blocks.flatMap((b) =>
            b.kind === 'card' && b.step.presented?.card === 'terminal'
              ? [b.step.presented.command]
              : [],
          )
        : [],
    );
    expect(commandes).toEqual(['echo un', 'echo deux', 'echo trois']);
    expect(r.data.feed.items.filter((i) => i.kind === 'produced')).toHaveLength(2);
  });
});

describe('getConversationThreadAction — les plafonds gardent la FIN du fil', () => {
  it('101 travaux : les 100 DERNIERS, et le fil dit que le debut manque', async () => {
    const { getConversationThreadAction } = await actions();
    const r = await getConversationThreadAction(longueConv.id);
    if (!r.ok) throw new Error(`echec inattendu : ${r.code} ${r.message}`);

    expect(r.data.truncated.jobs).toBe(true);
    expect(r.data.feed.items[0]).toEqual({
      kind: 'note',
      text: 'Older turns are not shown (100 shown).',
    });
    const demandes = r.data.feed.items
      .filter((i) => i.kind === 'request')
      .map((i) => (i.kind === 'request' ? i.text : ''));
    expect(demandes).toHaveLength(100);
    // Le tour 1 est tombe ; le 2 ouvre le fil, le 101 le ferme.
    expect(demandes[0]).toBe('tour 2');
    expect(demandes.at(-1)).toBe('tour 101');
  });

  it('502 messages : les 500 DERNIERS, dans l’ordre', async () => {
    const { getConversationThreadAction } = await actions();
    const r = await getConversationThreadAction(bavardeConv.id);
    if (!r.ok) throw new Error(`echec inattendu : ${r.code} ${r.message}`);

    expect(r.data.truncated.messages).toBe(true);
    expect(r.data.feed.items[0]).toEqual({
      kind: 'note',
      text: 'Older turns are not shown (500 shown).',
    });
    const demandes = r.data.feed.items
      .filter((i) => i.kind === 'request')
      .map((i) => (i.kind === 'request' ? i.text : ''));
    expect(demandes).toHaveLength(500);
    expect(demandes[0]).toBe('m3');
    expect(demandes.at(-1)).toBe('m502');
  });

  it('EXACTEMENT 500 messages : rien ne manque, et le fil ne prétend pas le contraire', async () => {
    const { getConversationThreadAction } = await actions();
    const r = await getConversationThreadAction(pileConv.id);
    if (!r.ok) throw new Error(`echec inattendu : ${r.code} ${r.message}`);

    // Le plafond est ATTEINT, pas MORDU : la lecture N + 1 fait la différence.
    expect(r.data.truncated.messages).toBe(false);
    expect(r.data.feed.items[0]?.kind).toBe('request');
    const demandes = r.data.feed.items
      .filter((i) => i.kind === 'request')
      .map((i) => (i.kind === 'request' ? i.text : ''));
    // Les 500 sont là, du premier au dernier : rien n'a été coupé.
    expect(demandes).toHaveLength(500);
    expect(demandes[0]).toBe('p1');
    expect(demandes.at(-1)).toBe('p500');
    expect(r.data.feed.items.some((i) => i.kind === 'note')).toBe(false);
  });

  it('un fil court ne parle jamais de coupe', async () => {
    const { getConversationThreadAction } = await actions();
    const r = await getConversationThreadAction(telegramConv.id);
    if (!r.ok) throw new Error(`echec inattendu : ${r.code} ${r.message}`);
    expect(r.data.truncated).toEqual({ messages: false, jobs: false });
    expect(r.data.feed.items[0]?.kind).toBe('request');
  });
});

describe('listAllConversationsAction — quelles origines entrent dans la liste', () => {
  it('une conversation ouverte depuis un projet est dans la liste, l’accueil non', async () => {
    const { listAllConversationsAction } = await actions();
    const r = await listAllConversationsAction();
    if (!r.ok) throw new Error(`echec inattendu : ${r.code} ${r.message}`);

    const ids = r.data.map((c) => c.id);
    // Une conversation de projet est une conversation de l'utilisateur : son
    // origine sert à désigner le fil que la page du projet prolonge, rien de
    // plus. La cacher de Chat la rendrait introuvable.
    expect(ids).toContain(projetConv.id);
    // L'entretien d'accueil, lui, reste dehors.
    expect(r.data.map((c) => c.title)).not.toContain('Onboarding');
  });
});

describe('listAllConversationsAction — le titre de repli', () => {
  it('le prefixe de groupe ne devient PAS le nom du fil', async () => {
    const { listAllConversationsAction } = await actions();
    const r = await listAllConversationsAction();
    if (!r.ok) throw new Error(`echec inattendu : ${r.code} ${r.message}`);
    const groupe = r.data.find((c) => c.id === groupeConv.id);
    expect(groupe?.title).toBe('redige le bilan de septembre');
  });
});

// ─── P12 — l'état de vérification des DOCUMENTS du fil ────────────────────────

describe('getConversationThreadAction — l’état des documents (P12)', () => {
  it('charge TOUS les livrables office_file, `dirty` compris, rangés par clé', async () => {
    const cleDirty = projectKey('/terrain/bilans/septembre.xlsx');
    const cleVerte = projectKey('/terrain/bilans/aout.xlsx');
    const cleNonConfig = projectKey('/terrain/bilans/juillet.xlsx');
    await testDb.insert(jobDeliverableVerificationState).values([
      {
        jobId: telegramConv.jobA,
        deliverableType: 'office_file',
        canonicalKey: cleDirty,
        displayPathSnapshot: 'bilans/septembre.xlsx',
        dirtyGeneration: 3,
        verifiedGeneration: 1,
        decisionStatus: 'dirty',
      },
      {
        jobId: telegramConv.jobB,
        deliverableType: 'office_file',
        canonicalKey: cleVerte,
        displayPathSnapshot: 'bilans/aout.xlsx',
        dirtyGeneration: 2,
        verifiedGeneration: 2,
        decisionStatus: 'green',
      },
      {
        jobId: telegramConv.jobB,
        deliverableType: 'office_file',
        canonicalKey: cleNonConfig,
        displayPathSnapshot: 'bilans/juillet.xlsx',
        dirtyGeneration: 1,
        decisionStatus: 'not_configured',
      },
      // Un PROJET DE CODE du même fil : il n'est pas un document, il n'a rien
      // à faire sur la carte d'un classeur.
      {
        jobId: telegramConv.jobB,
        deliverableType: 'code_project',
        canonicalKey: projectKey('/terrain/bilans'),
        displayPathSnapshot: '/terrain/bilans',
        dirtyGeneration: 5,
        decisionStatus: 'dirty',
      },
    ]);

    const { getConversationThreadAction } = await actions();
    const r = await getConversationThreadAction(telegramConv.id);
    if (!r.ok) throw new Error(`échec inattendu : ${r.code} ${r.message}`);

    // Les TROIS états sont là — `dirty` et `green` aussi, alors que la section
    // de preuve (P3) ne s'intéresse qu'aux livrables non configurés.
    expect(r.data.verification.deliverables).toEqual([
      { canonicalKey: cleVerte, status: 'green' },
      { canonicalKey: cleNonConfig, status: 'not_configured' },
      { canonicalKey: cleDirty, status: 'dirty' },
    ]);

    // Et la section de preuve, elle, ne voit toujours QUE le non configuré :
    // un document `dirty` n'est pas un trou de configuration.
    expect(r.data.verification.unconfigured.map((u) => u.canonicalKey)).toEqual([cleNonConfig]);
  });
});
