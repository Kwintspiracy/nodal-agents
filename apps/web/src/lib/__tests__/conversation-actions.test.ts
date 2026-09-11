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
  llmCalls,
  toolCalls,
  users,
  and,
  desc,
  eq,
  sql,
} from '@nodal-agents/db';
import { projectKey } from '@nodal-agents/shared';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** Les identités posées une fois pour toutes par le seed du fichier. */
const telegramConv = { id: '', jobA: '', jobB: '', child: '' };
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
/** Un fil de chat PUR : aucun job, deux appels LLM rattachés par 0100. */
const chatPurConv = { id: '' };

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

  // P2bis — un DÉLÉGUÉ du job A, avec une lecture (pas une production : le
  // verdict du job A reste « chat »). Son fil doit arriver jusqu'à la carte de
  // délégation, avec l'étape qu'il a faite.
  const [child] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'internal',
      chatId: null,
      conversationId: telegramConv.id,
      parentJobId: telegramConv.jobA,
      task: 'Relis les notes',
      status: 'completed',
      result: 'Rien à signaler dans les notes.',
      messages: [
        { role: 'user', content: 'Relis les notes' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Rien à signaler dans les notes.' },
            {
              type: 'tool-call',
              toolCallId: 'read-notes-1',
              toolName: 'file_read',
              input: { path: 'notes.md' },
            },
          ],
        },
      ],
      createdAt: new Date('2026-09-01T10:00:20Z'),
      completedAt: new Date('2026-09-01T10:00:40Z'),
    })
    .returning({ id: agentJobs.id });
  telegramConv.child = child!.id;
  await testDb.insert(toolCalls).values({
    entityId: seed.entityId,
    jobId: telegramConv.child,
    toolCallId: 'read-notes-1',
    toolName: 'file_read',
    card: 'read',
    presented: { card: 'read', path: 'notes.md', excerpt: '# notes', chars: 7, truncated: false },
    riskLevel: 'read',
    toolInput: { path: 'notes.md' },
    toolOutput: '# notes',
  });

  // P2bis, passe 49 — vingt et un délégués PLUS ANCIENS du même job A, sans
  // production : seuls les CHILD_FEEDS_MAX (20) plus récents de la page
  // ouvrent leur fil ; le délégué de 10:00:20 ci-dessus est le plus récent.
  for (let i = 0; i < 21; i++) {
    await testDb.insert(agentJobs).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'internal',
      chatId: null,
      conversationId: telegramConv.id,
      parentJobId: telegramConv.jobA,
      task: `Relecture ${i}`,
      status: 'completed',
      result: `Relu ${i}.`,
      messages: [
        { role: 'user', content: `Relecture ${i}` },
        { role: 'assistant', content: `Relu ${i}.` },
      ],
      createdAt: new Date(`2026-09-01T09:${String(i).padStart(2, '0')}:00Z`),
      completedAt: new Date(`2026-09-01T09:${String(i).padStart(2, '0')}:30Z`),
    });
  }

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

  // ── Un fil de chat PUR : l'agent répond sans jamais créer de job ──────────
  // C'est le cas le plus courant (« tu es la ? »), et celui dont TOUS les
  // compteurs étaient sautés : la barre d'état disait « 0 tokens, n/a » sous
  // une vraie réponse (Quentin, 07/09).
  const [convChat] = await testDb
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      title: 'tu es la ?',
      origin: 'user',
      channel: 'dashboard',
      createdAt: new Date('2026-09-07T14:49:00Z'),
      updatedAt: new Date('2026-09-07T14:49:52Z'),
    })
    .returning({ id: conversations.id });
  chatPurConv.id = convChat!.id;
  await testDb.insert(chatMessages).values([
    {
      entityId: seed.entityId,
      conversationId: chatPurConv.id,
      agentId: seed.agentId,
      role: 'user',
      content: 'tu es la ?',
      createdAt: new Date('2026-09-07T14:49:45Z'),
    },
    {
      entityId: seed.entityId,
      conversationId: chatPurConv.id,
      agentId: seed.agentId,
      role: 'assistant',
      content: 'Ouais, je suis là !',
      createdAt: new Date('2026-09-07T14:49:52Z'),
    },
  ]);
  // Les deux appels du tour de chat : `source = 'chat'`, AUCUN job — rattachés
  // à la conversation par la colonne de la migration 0100.
  await testDb.insert(llmCalls).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      jobId: null,
      conversationId: chatPurConv.id,
      source: 'chat',
      modelEffective: 'z-ai/glm-5.3',
      provider: 'openrouter',
      inputTokens: 9130,
      outputTokens: 22,
      cachedTokens: 4000,
      costUsd: 0.0103,
      durationMs: 3349,
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      jobId: null,
      conversationId: chatPurConv.id,
      source: 'chat',
      modelEffective: 'z-ai/glm-5.3',
      provider: 'openrouter',
      inputTokens: 9254,
      outputTokens: 41,
      cachedTokens: 5000,
      costUsd: 0.0022,
      durationMs: 2838,
    },
  ]);

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
  it('le fil d’un DÉLÉGUÉ arrive sous sa carte de délégation, avec ses étapes (P2bis)', async () => {
    const { getConversationThreadAction } = await actions();
    const r = await getConversationThreadAction(telegramConv.id);
    if (!r.ok) throw new Error(`échec inattendu : ${r.code} ${r.message}`);

    const child = r.data.feed.items.find(
      (i) => i.kind === 'child' && i.job.id === telegramConv.child,
    );
    if (child?.kind !== 'child') throw new Error('item child attendu');
    // Le fil de l'enfant est assemblé : sa prose ET l'étape de lecture, avec
    // la carte persistée sur sa ligne d'audit — pas seulement son texte.
    const nested = child.job.feed;
    if (nested === undefined) throw new Error('le fil du délégué manque');
    const turn = nested.items.find((i) => i.kind === 'turn');
    if (turn?.kind !== 'turn') throw new Error('tour du délégué attendu');
    expect(turn.blocks.some((b) => b.kind === 'prose' && b.text.includes('Rien à signaler'))).toBe(
      true,
    );
    const steps = turn.blocks.flatMap((b) => (b.kind === 'steps' ? b.steps : []));
    expect(steps.map((s) => (s.kind === 'tool' ? [s.toolName, s.card] : ['reasoning']))).toEqual([
      ['file_read', 'read'],
    ]);
    // Un seul niveau : le délégué n'a pas d'enfant ici, et s'il en avait, leur
    // fil ne serait pas assemblé (CHILD_FEED_DEPTH).
    expect(nested.items.filter((i) => i.kind === 'child')).toHaveLength(0);
  });

  it('seules les 20 délégations les plus récentes ouvrent leur fil ; les plus anciennes gardent leur texte (passe 49)', async () => {
    const { getConversationThreadAction } = await actions();
    const r = await getConversationThreadAction(telegramConv.id);
    if (!r.ok) throw new Error(`échec inattendu : ${r.code} ${r.message}`);
    const children = r.data.feed.items.filter((i) => i.kind === 'child');
    // 22 délégués du job A : le récent (10:00:20) et 21 anciens (09:00 → 09:20).
    expect(children).toHaveLength(22);
    const withFeed = children.filter((c) => c.kind === 'child' && c.job.feed !== undefined);
    expect(withFeed).toHaveLength(20);
    // Les deux plus anciens (09:00, 09:01) n'ont pas de fil, mais gardent
    // tâche et résultat — la carte a toujours quelque chose à montrer.
    const oldest = children.slice(0, 2);
    for (const c of oldest) {
      if (c.kind !== 'child') throw new Error('child attendu');
      expect(c.job.feed).toBeUndefined();
      expect(c.job.result).toMatch(/^Relu [01]\.$/);
    }
    // Le plus récent, lui, a son fil.
    const newest = children.at(-1);
    if (newest?.kind !== 'child') throw new Error('child attendu');
    expect(newest.job.id).toBe(telegramConv.child);
    expect(newest.job.feed).toBeDefined();
  });

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
    ]);
    // P2bis — la réponse du travail (« 42 lignes. ») EST la dernière prose du
    // tour : le fil ne la répète plus en item `answer`. Elle est dite une fois.
    const proses = r.data.feed.items.flatMap((i) =>
      i.kind === 'turn' ? i.blocks.filter((b) => b.kind === 'prose').map((b) => b.text) : [],
    );
    expect(proses.filter((t) => t === '42 lignes.')).toHaveLength(1);
    expect(r.data.feed.items.some((i) => i.kind === 'answer')).toBe(false);
    const consigne = r.data.feed.items.find((i) => i.kind === 'handoff');
    if (consigne?.kind !== 'handoff') throw new Error('item handoff attendu');
    expect(consigne.text).toBe('Compter les lignes du bilan');
    // Aucun travail n'est sorti du chat : pas d'encart.
    expect(r.data.feed.items.some((i) => i.kind === 'produced')).toBe(false);
  });
});

describe('getConversationThreadAction — un fil de chat PUR, sans aucun job', () => {
  it('compte quand même ses jetons, son coût et son agent (migration 0100)', async () => {
    const { getConversationThreadAction } = await actions();
    const r = await getConversationThreadAction(chatPurConv.id);
    if (!r.ok) throw new Error(`échec inattendu : ${r.code} ${r.message}`);

    // Les deux appels du tour de chat, additionnés — c'est ce que la barre
    // d'état affiche. Zéro ici voulait dire « une réponse gratuite et
    // instantanée », ce qui était faux (Quentin, 07/09).
    expect(r.data.cost.totals.inputTokens).toBe(18_384);
    expect(r.data.cost.totals.outputTokens).toBe(63);
    expect(r.data.cost.totals.costUsd).toBeCloseTo(0.0125, 5);
    // Le temps de CALCUL, pas le temps écoulé depuis l'ouverture du fil.
    expect(r.data.cost.totals.llmDurationMs).toBe(6187);
    // Et l'agent qui a répondu est compté : « 0 agents » sous un tour d'Alfred
    // contredisait l'en-tête, qui en annonçait un.
    expect(r.data.cost.byAgent).toHaveLength(1);
    expect(r.data.cost.byAgent[0]?.models).toEqual(['z-ai/glm-5.3']);
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
      origin: 'thread',
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
      origin: 'thread',
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
  it('charge TOUS les livrables office_file et document, `dirty` compris, un état par (job, clé)', async () => {
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
      // Le MÊME fichier que la ligne verte du job B, écrit aussi par le job A
      // et pas vérifié là : les deux états sont rendus, chacun avec son job —
      // la carte du job A ne doit pas hériter du « Verified » du job B
      // (revue Codex PR #46, passe 46).
      {
        jobId: telegramConv.jobA,
        deliverableType: 'office_file',
        canonicalKey: cleVerte,
        displayPathSnapshot: 'bilans/aout.xlsx',
        dirtyGeneration: 1,
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
      // Un DOCUMENT (« Créer, c'est prouver ») : un fichier hors projet, vérifié
      // sans pouvoir. Sa carte lit son état exactement comme celle d'un classeur.
      {
        jobId: telegramConv.jobB,
        deliverableType: 'document',
        canonicalKey: projectKey('/terrain/skills/SKILL.md'),
        displayPathSnapshot: 'skills/SKILL.md',
        dirtyGeneration: 1,
        verifiedGeneration: 1,
        decisionStatus: 'green',
      },
    ]);

    const { getConversationThreadAction } = await actions();
    const r = await getConversationThreadAction(telegramConv.id);
    if (!r.ok) throw new Error(`échec inattendu : ${r.code} ${r.message}`);

    // Les QUATRE états sont là — `dirty` et `green` aussi, alors que la section
    // de preuve (P3) ne s'intéresse qu'aux livrables non configurés — et le
    // même fichier vu par deux jobs donne DEUX états, jamais un « dernier ».
    const [jobBas, jobHaut] = [telegramConv.jobA, telegramConv.jobB].sort();
    const statusOf = (jobId: string) => (jobId === telegramConv.jobB ? 'green' : 'dirty');
    expect(r.data.verification.deliverables).toEqual([
      { jobId: jobBas, canonicalKey: cleVerte, status: statusOf(jobBas) },
      { jobId: jobHaut, canonicalKey: cleVerte, status: statusOf(jobHaut) },
      { jobId: telegramConv.jobB, canonicalKey: cleNonConfig, status: 'not_configured' },
      { jobId: telegramConv.jobA, canonicalKey: cleDirty, status: 'dirty' },
      {
        jobId: telegramConv.jobB,
        canonicalKey: projectKey('/terrain/skills/SKILL.md'),
        status: 'green',
      },
    ]);

    // Et la section de preuve, elle, ne voit toujours QUE le non configuré :
    // un document `dirty` n'est pas un trou de configuration.
    expect(r.data.verification.unconfigured.map((u) => u.canonicalKey)).toEqual([cleNonConfig]);
  });
});

// ─── La DÉSIGNATION du fil courant, contre une vraie base ────────────────────
//
// Revue Codex PR #48, passes 5 à 7. La règle vit en SQL parce qu'elle ne peut
// pas vivre ailleurs : la liste est plafonnée, les `Date` de JavaScript
// tronquent les microsecondes de `timestamptz`, et `created_at` est nullable —
// or `ORDER BY … DESC` place les NULL DEVANT en PostgreSQL. Trois pièges que
// deux correctifs successifs en TypeScript n'ont pas su éviter.
//
// Ces tests exercent donc la REQUÊTE, pas une mise en scène : chaque cas insère
// de vraies lignes et relit ce que la base désigne.
describe('listCurrentThreadByChatAction — la base désigne, avec la règle du runner', () => {
  /**
   * Un chat neuf, à l'écart des fils du seed.
   *
   * Chaque fil pose SES trois valeurs — `id`, `createdAt`, `updatedAt` — et
   * aucune n'est laissée au hasard. La passe 8 de la revue a montré pourquoi :
   * avec des UUID aléatoires et un `updated_at` par défaut, l'ordre
   * d'INSERTION coïncidait avec le résultat attendu, si bien qu'un tri fautif
   * par `updated_at DESC` passait ces tests aussi. Ils vérifiaient leur propre
   * mise en scène.
   *
   * Chaque cas est donc ADVERSE : la date de modification et l'identifiant sont
   * choisis pour désigner l'AUTRE fil que celui attendu. Un tri par
   * `updated_at`, ou un départage par identifiant croissant, rougit.
   */
  async function chatAvec(
    chatId: string,
    fils: ReadonlyArray<{ id: string; createdAt: Date | null; updatedAt: Date }>,
  ): Promise<void> {
    for (const f of fils) {
      await testDb.insert(conversations).values({
        id: f.id,
        entityId: seed.entityId,
        agentId: seed.agentId,
        channel: 'telegram',
        chatId,
        origin: 'user',
        createdAt: f.createdAt,
        updatedAt: f.updatedAt,
      });
    }
  }

  const cle = (chatId: string): string => `${seed.agentId}:telegram:${chatId}`;

  it('désigne le dernier fil OUVERT, pas le dernier remué', async () => {
    // Le fil récemment OUVERT porte la date de modification la plus ANCIENNE :
    // c'est la séquence réelle — un rattachement de projet remue le vieux fil
    // pendant que le neuf attend son premier message. Un tri par `updated_at`
    // désignerait l'ancien.
    const attendu = '11111111-0000-4000-8000-000000000002';
    await chatAvec('desig-1', [
      {
        id: '11111111-0000-4000-8000-000000000001',
        createdAt: new Date('2026-09-01T10:00:00Z'),
        updatedAt: new Date('2026-09-09T10:00:00Z'),
      },
      {
        id: attendu,
        createdAt: new Date('2026-09-08T10:00:00Z'),
        updatedAt: new Date('2026-09-08T10:00:00Z'),
      },
    ]);

    const { listCurrentThreadByChatAction } = await actions();
    const r = await listCurrentThreadByChatAction();
    if (!r.ok) throw new Error(`echec inattendu : ${r.code} ${r.message}`);
    expect(r.data.current[cle('desig-1')]).toBe(attendu);
  });

  it('départage deux fils de la même MICROSECONDE, sous la résolution d’une Date', async () => {
    // Une `Date` JavaScript ne distingue pas ces deux instants : côté écran ils
    // paraissaient égaux, et le départage par identifiant se déclenchait sur une
    // égalité qui n'existe pas en base.
    //
    // Le fil ATTENDU (le plus tardif de 800 µs) porte le plus PETIT identifiant
    // et la date de modification la plus ancienne : ni un tri par `updated_at`,
    // ni un départage par identifiant décroissant ne peuvent le désigner par
    // accident.
    const attendu = '22222222-0000-4000-8000-00000000000a';
    const autre = '22222222-0000-4000-8000-00000000000f';
    await chatAvec('desig-2', [
      {
        id: autre,
        createdAt: new Date('2026-09-08T09:00:00Z'),
        updatedAt: new Date('2026-09-09T12:00:00Z'),
      },
      {
        id: attendu,
        createdAt: new Date('2026-09-08T09:00:00Z'),
        updatedAt: new Date('2026-09-08T09:00:00Z'),
      },
    ]);
    await testDb.execute(
      sql`UPDATE conversations SET created_at = timestamptz '2026-09-08 09:00:00.123100+00' WHERE id = ${autre}`,
    );
    await testDb.execute(
      sql`UPDATE conversations SET created_at = timestamptz '2026-09-08 09:00:00.123900+00' WHERE id = ${attendu}`,
    );

    const { listCurrentThreadByChatAction } = await actions();
    const r = await listCurrentThreadByChatAction();
    if (!r.ok) throw new Error(`echec inattendu : ${r.code} ${r.message}`);
    expect(r.data.current[cle('desig-2')]).toBe(attendu);
  });

  it('à `created_at` strictement ÉGAUX, le plus GRAND identifiant gagne', async () => {
    // Le départage lui-même, isolé : deux fils à la microseconde près, et rien
    // d'autre pour les séparer. Aucun autre test ne l'exerçait — l'écart de
    // 800 µs du test précédent tranche AVANT d'arriver à l'identifiant.
    const petit = '33333333-0000-4000-8000-00000000000a';
    const grand = '33333333-0000-4000-8000-00000000000f';
    await chatAvec('desig-3', [
      // Le GRAND identifiant porte la date de modification la plus ancienne :
      // un tri par `updated_at` désignerait l'autre.
      {
        id: grand,
        createdAt: new Date('2026-09-08T09:00:00Z'),
        updatedAt: new Date('2026-09-08T09:00:00Z'),
      },
      {
        id: petit,
        createdAt: new Date('2026-09-08T09:00:00Z'),
        updatedAt: new Date('2026-09-09T12:00:00Z'),
      },
    ]);
    await testDb.execute(
      sql`UPDATE conversations SET created_at = timestamptz '2026-09-08 09:00:00.500000+00' WHERE chat_id = 'desig-3'`,
    );

    const { listCurrentThreadByChatAction } = await actions();
    const r = await listCurrentThreadByChatAction();
    if (!r.ok) throw new Error(`echec inattendu : ${r.code} ${r.message}`);
    expect(r.data.current[cle('desig-3')]).toBe(grand);
  });

  it('un fil SANS date de création gagne — c’est ce que fait le runner, et on le copie', async () => {
    // `ORDER BY created_at DESC` place les NULL DEVANT en PostgreSQL. Ce n'est
    // pas le choix qu'on ferait de zéro, mais c'est CELUI DU RUNNER : diverger
    // « en mieux » ferait ouvrir à l'écran un fil que le message n'alimentera
    // pas, et c'est le défaut qu'on répare.
    //
    // Le fil sans date est inséré EN PREMIER, porte le plus petit identifiant
    // et la date de modification la plus ancienne : rien d'autre que la règle
    // des nuls ne peut le désigner.
    const sansDate = '44444444-0000-4000-8000-00000000000a';
    await chatAvec('desig-4', [
      { id: sansDate, createdAt: null, updatedAt: new Date('2026-09-01T10:00:00Z') },
      {
        id: '44444444-0000-4000-8000-00000000000f',
        createdAt: new Date('2026-09-08T10:00:00Z'),
        updatedAt: new Date('2026-09-09T12:00:00Z'),
      },
    ]);

    const { listCurrentThreadByChatAction } = await actions();
    const r = await listCurrentThreadByChatAction();
    if (!r.ok) throw new Error(`echec inattendu : ${r.code} ${r.message}`);
    expect(r.data.current[cle('desig-4')]).toBe(sansDate);
  });

  it('les chats ÉLIGIBLES : un témoin par filtre, et pas un de plus', async () => {
    // Revue Codex PR #48, passes 10 puis 11. La première version de ce test
    // n'exerçait QUE le filtre d'origine : retirer `channel != dashboard`,
    // `chat_id != ''` ou le filtre d'entité le laissait vert, faute de témoin.
    // Un test qui annonce quatre règles et n'en verrouille qu'une est pire
    // qu'un test absent — il dit que c'est couvert.
    //
    // Chaque filtre a donc SA ligne, et une seule assertion la vise.
    const base = {
      entityId: seed.entityId,
      agentId: seed.agentId,
      createdAt: new Date('2026-09-01T10:00:00Z'),
      updatedAt: new Date('2026-09-01T10:00:00Z'),
    };
    await testDb.insert(conversations).values([
      // Éligible : origine `user`.
      {
        ...base,
        id: '66666666-0000-4000-8000-000000000001',
        channel: 'telegram',
        chatId: 'elig-user',
        origin: 'user',
      },
      // Éligible AUSSI : origine `project` — la liste l'accepte, et restreindre
      // les origines à `user` seul doit faire rougir ce test.
      {
        ...base,
        id: '66666666-0000-4000-8000-000000000002',
        channel: 'telegram',
        chatId: 'elig-projet',
        origin: 'project',
      },
      // Écarté : origine que la liste refuse.
      {
        ...base,
        id: '66666666-0000-4000-8000-000000000003',
        channel: 'telegram',
        chatId: 'elig-accueil',
        origin: 'onboarding',
      },
      // Écarté : le dashboard n'est pas un chat de canal — et il porte ici un
      // `chatId`, sans quoi un AUTRE filtre l'exclurait et ce témoin ne
      // prouverait rien.
      {
        ...base,
        id: '66666666-0000-4000-8000-000000000004',
        channel: 'dashboard',
        chatId: 'elig-dash',
        origin: 'user',
      },
      // Écarté : `chat_id` vide.
      {
        ...base,
        id: '66666666-0000-4000-8000-000000000005',
        channel: 'telegram',
        chatId: '',
        origin: 'user',
      },
    ]);
    // Écarté : une autre ENTITÉ. Le voisin a son propre agent (seedé par ce
    // fichier) — sans lui, retirer le filtre d'entité passerait inaperçu.
    await testDb.insert(conversations).values({
      ...base,
      id: '66666666-0000-4000-8000-000000000006',
      entityId: voisin.entityId,
      agentId: voisin.agentId,
      channel: 'telegram',
      chatId: 'elig-voisin',
      origin: 'user',
    });

    const { listCurrentThreadByChatAction } = await actions();
    const r = await listCurrentThreadByChatAction();
    if (!r.ok) throw new Error(`echec inattendu : ${r.code} ${r.message}`);

    expect(r.data.listable, 'origine user').toContain(cle('elig-user'));
    expect(r.data.listable, 'origine project').toContain(cle('elig-projet'));
    // L'accueil est DÉSIGNÉ — la désignation copie le runner, qui ne filtre pas
    // l'origine — mais il n'est PAS listable. C'est cette distinction qui
    // empêche l'écran de réclamer un chat qu'il ne montrera jamais.
    expect(r.data.current[cle('elig-accueil')]).toBe('66666666-0000-4000-8000-000000000003');
    expect(r.data.listable, 'origine onboarding').not.toContain(cle('elig-accueil'));
    // La clé porte le CANAL : viser `telegram:elig-dash` ne prouvait rien,
    // puisque cette conversation est sur `dashboard` — la mutation qui retire
    // ce filtre restait verte (constaté en la faisant tourner).
    expect(r.data.listable, 'canal dashboard').not.toContain(`${seed.agentId}:dashboard:elig-dash`);
    expect(
      r.data.listable.some((k) => k.endsWith(':')),
      'chat vide',
    ).toBe(false);
    expect(
      r.data.listable.some((k) => k.includes('elig-voisin')),
      'une autre entité',
    ).toBe(false);
  });

  it('UNE seule ligne par chat, et aucune pour le dashboard', async () => {
    // Ce test pose SES propres données : il dépendait des trois précédents, et
    // échouait donc exécuté seul (revue Codex, PR #48, passe 8).
    const dernier = '55555555-0000-4000-8000-00000000000c';
    await chatAvec('desig-5', [
      {
        id: '55555555-0000-4000-8000-00000000000a',
        createdAt: new Date('2026-09-01T10:00:00Z'),
        updatedAt: new Date('2026-09-09T12:00:00Z'),
      },
      {
        id: '55555555-0000-4000-8000-00000000000b',
        createdAt: new Date('2026-09-02T10:00:00Z'),
        updatedAt: new Date('2026-09-09T11:00:00Z'),
      },
      {
        id: dernier,
        createdAt: new Date('2026-09-03T10:00:00Z'),
        updatedAt: new Date('2026-09-01T10:00:00Z'),
      },
    ]);

    const { listCurrentThreadByChatAction } = await actions();
    const r = await listCurrentThreadByChatAction();
    if (!r.ok) throw new Error(`echec inattendu : ${r.code} ${r.message}`);

    // Trois fils, UNE désignation — et c'est le dernier ouvert, alors qu'il
    // porte la date de modification la plus ancienne des trois.
    expect(r.data.current[cle('desig-5')]).toBe(dernier);
    // Un dictionnaire écrase les doublons : le compte des lignes rendues par la
    // requête se vérifie à la source, pas sur lui.
    const lignes = await testDb
      .selectDistinctOn([conversations.agentId, conversations.channel, conversations.chatId], {
        id: conversations.id,
      })
      .from(conversations)
      .where(and(eq(conversations.entityId, seed.entityId), eq(conversations.chatId, 'desig-5')))
      .orderBy(
        conversations.agentId,
        conversations.channel,
        conversations.chatId,
        desc(conversations.createdAt),
        desc(conversations.id),
      );
    expect(lignes).toHaveLength(1);
    expect(lignes[0]?.id).toBe(dernier);
    // Aucune clé ne désigne un fil du dashboard : ils n'ont pas de chat.
    expect(Object.keys(r.data.current).some((k) => k.includes(':dashboard:'))).toBe(false);
  });
});
