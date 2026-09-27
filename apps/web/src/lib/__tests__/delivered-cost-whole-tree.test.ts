// delivered-cost-whole-tree.test.ts — #508, contre une VRAIE base.
//
// Le run du ticket (e4925b15, 25/09) : Alfred délègue à Montage. La carte
// « Delivered » disait le coût d'Alfred seul (0,068 $) pendant que la barre
// d'état montait avec Montage (0,83 $) : deux prix pour un seul run, et une
// carte qui liste le travail des délégués sans le compter dans son prix.
//
// LA RÈGLE : le coût d'un run est la somme des `llm_calls` du job de tête ET de
// toute sa descendance, lue par la même fonction que la barre d'état
// (`costOfCalls`, `space-cost.ts`). Jamais `agent_jobs.total_cost_usd`, qui
// traîne derrière les appels enregistrés (0,898 $ contre 0,970 $ sur le run du
// ticket) : les compteurs de ce fichier sont semés en retard exprès.
//
// Ce que ce fichier prouve, par les DEUX chargeurs qui posent la carte :
//   1. le fil d'une conversation : carte = barre, petit-enfant compris ;
//   2. la page d'un run : carte = barre ;
//   3. la carte MONTE quand un délégué dépense, pendant que la tête attend.
//
// Mutations vérifiées :
//   - `costUsd: job.cost.costUsd` remplacé par `job.feed.totals.costUsd` dans
//     `deliverySummary` → les trois cas rougissent (0,0679 au lieu de 0,9679) ;
//   - le rangement par racine retiré dans `conversation-actions.ts` (les
//     appels du seul job de tête) → les cas 1 et 3 rougissent.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, constatedWrites, conversations, llmCalls, toolCalls } from '@nodal-agents/db';
import type { FeedItem } from '../conversation-feed.ts';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

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

let conversationId = '';
let rootId = '';
let childId = '';

const appel = (jobId: string, turn: number, costUsd: number) => ({
  entityId: seed.entityId,
  agentId: seed.agentId,
  jobId,
  source: 'job',
  turn,
  modelEffective: 'claude-opus-5',
  provider: 'anthropic',
  inputTokens: 1_000,
  outputTokens: 100,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  costUsd,
  durationMs: 1_000,
  createdAt: new Date(Date.UTC(2026, 8, 25, 10, turn)),
});

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  const [conv] = await testDb
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      title: 'Monte la vidéo',
      origin: 'user',
      // Un fil de CANAL : ses tours sont ses jobs, sans `chat_messages` à semer.
      channel: 'telegram',
      chatId: 'montage-508',
    })
    .returning({ id: conversations.id });
  conversationId = conv!.id;

  // La tête ATTEND son délégué, comme Alfred pendant que Montage travaille.
  // Son compteur dit son propre coût, en retard sur rien : c'est le seul
  // chiffre que la carte montrait.
  const [root] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: 'montage-508',
      conversationId,
      task: 'Monte la vidéo',
      status: 'awaiting_delegation',
      totalCostUsd: 0.0679,
    })
    .returning({ id: agentJobs.id });
  rootId = root!.id;

  // Le délégué : son compteur (0,8297) TRAÎNE derrière ses appels (0,83).
  const [child] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'internal',
      task: 'Assemble les plans',
      status: 'processing',
      parentJobId: rootId,
      totalCostUsd: 0.8297,
    })
    .returning({ id: agentJobs.id });
  childId = child!.id;

  // Un petit-enfant : le fil n'assemble qu'un niveau de délégués, la carte
  // doit pourtant compter ce qu'il a dépensé.
  const [grandchild] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'internal',
      task: 'Exporte le rendu',
      status: 'completed',
      parentJobId: childId,
      completedAt: new Date(),
    })
    .returning({ id: agentJobs.id });

  // Ce qui fait paraître la carte : une commande du petit-enfant dont
  // l'écriture est constatée — un travail, rangé sous la tête.
  await testDb.insert(toolCalls).values({
    entityId: seed.entityId,
    jobId: grandchild!.id,
    toolName: 'run_command',
    toolInput: { command: 'ffmpeg -i plans.txt rendu.mp4' },
    toolOutput: 'done',
    durationMs: 12,
    turn: 1,
    toolCallId: 'c_rendu',
    card: 'terminal',
    presented: {
      card: 'terminal',
      command: 'ffmpeg -i plans.txt rendu.mp4',
      exitCode: 0,
      timedOut: false,
      stdoutTail: 'done',
      stdoutTruncated: false,
      stderrTail: '',
      stderrTruncated: false,
    },
  });
  await testDb.insert(constatedWrites).values({
    jobId: grandchild!.id,
    turn: 1,
    path: 'D:/montage/rendu.mp4',
    changeKind: 'added',
    constatedBy: 'git',
  });

  await testDb
    .insert(llmCalls)
    .values([
      appel(rootId, 1, 0.0679),
      appel(childId, 2, 0.5),
      appel(childId, 3, 0.33),
      appel(grandchild!.id, 4, 0.07),
    ]);
});

function carte(items: readonly FeedItem[]): Extract<FeedItem, { kind: 'produced' }> {
  const found = items.find(
    (i): i is Extract<FeedItem, { kind: 'produced' }> => i.kind === 'produced',
  );
  if (found === undefined) throw new Error('pas de carte Delivered dans le fil');
  return found;
}

describe('Carte Delivered — le coût du run est celui de tout l’arbre (#508) @cap:voir-le-cout/moteur', () => {
  it('le fil d’une conversation : la carte dit le prix de la barre, petit-enfant compris', async () => {
    const { getConversationThreadAction } = await import('../conversation-actions.ts');
    const r = await getConversationThreadAction(conversationId);
    if (!r.ok) throw new Error(`${r.code} ${r.message}`);
    // 0,0679 + 0,5 + 0,33 + 0,07 : les appels ENREGISTRÉS, pas les compteurs.
    expect(r.data.cost.totals.costUsd).toBeCloseTo(0.9679, 9);
    expect(carte(r.data.feed.items).summary.costUsd).toBeCloseTo(0.9679, 9);
  });

  it('la page d’un run : la carte dit le prix de la barre', async () => {
    const { getSpaceConversationAction } = await import('../actions.ts');
    const r = await getSpaceConversationAction(rootId);
    if (!r.ok) throw new Error(`${r.code} ${r.message}`);
    expect(r.data.cost.totals.costUsd).toBeCloseTo(0.9679, 9);
    expect(carte(r.data.feed.items).summary.costUsd).toBeCloseTo(0.9679, 9);
  });

  it('la carte MONTE quand le délégué dépense, pendant que la tête attend', async () => {
    const { getConversationThreadAction } = await import('../conversation-actions.ts');
    await testDb.insert(llmCalls).values(appel(childId, 5, 0.25));
    const r = await getConversationThreadAction(conversationId);
    if (!r.ok) throw new Error(`${r.code} ${r.message}`);
    expect(carte(r.data.feed.items).summary.costUsd).toBeCloseTo(1.2179, 9);
    expect(r.data.cost.totals.costUsd).toBeCloseTo(1.2179, 9);
  });
});
