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

  // L'entretien d'accueil — estampillé à la création, jamais dans la liste.
  await testDb.insert(conversations).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    title: 'Onboarding',
    origin: 'onboarding',
    channel: 'dashboard',
  });

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
