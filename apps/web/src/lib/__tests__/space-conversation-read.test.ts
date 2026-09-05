// space-conversation-read.test.ts — la lecture du fil d'un espace (P2) : des
// lignes RÉELLES écrites en base (job + messages, tool_calls avec carte et
// charge utile P1, llm_calls par tour, un enfant) et ce que l'action rend.
// Bornée à l'entité : le job d'une autre entité n'existe pas.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, toolCalls, llmCalls, entities, users } from '@nodal-agents/db';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let jobId: string;
let childId: string;
let foreignJobId: string;

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

const actions = () => import('../actions.ts');

const tablePayload = {
  card: 'table',
  tables: [
    {
      columns: ['fact', 'category'],
      header: 'columns',
      rows: [['Quentin aime les tableaux', 'preference']],
      total: 1,
      truncated: false,
      clipped: false,
    },
  ],
};
const sentPayload = { card: 'sent', channel: 'telegram', kind: 'message', target: '4242' };

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  const [job] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId: '4242',
      task: 'Rappelle-moi ce que j’aime',
      status: 'completed',
      result: 'Tu aimes les tableaux.',
      turn: 2,
      messages: [
        { role: 'user', content: 'Rappelle-moi ce que j’aime' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'La mémoire doit le savoir.' },
            {
              type: 'tool-call',
              toolCallId: 'c_qm',
              toolName: 'query_memory',
              input: { query: 'aime' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c_qm',
              toolName: 'query_memory',
              output: { type: 'json', value: [{ fact: 'Quentin aime les tableaux' }] },
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Tu aimes les tableaux.' },
            {
              type: 'tool-call',
              toolCallId: 'c_tg',
              toolName: 'telegram_send_message',
              input: { text: 'Tu aimes les tableaux.' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c_tg',
              toolName: 'telegram_send_message',
              output: { type: 'json', value: { messageId: '9' } },
            },
          ],
        },
      ],
    })
    .returning();
  jobId = job!.id;

  await testDb.insert(toolCalls).values([
    {
      entityId: seed.entityId,
      jobId,
      toolName: 'query_memory',
      toolInput: { query: 'aime' },
      toolOutput: JSON.stringify([{ fact: 'Quentin aime les tableaux', category: 'preference' }]),
      durationMs: 12,
      turn: 1,
      toolCallId: 'c_qm',
      card: 'table',
      presented: tablePayload,
    },
    {
      entityId: seed.entityId,
      jobId,
      toolName: 'telegram_send_message',
      toolInput: { text: 'Tu aimes les tableaux.' },
      toolOutput: JSON.stringify({ messageId: '9' }),
      durationMs: 830,
      turn: 2,
      toolCallId: 'c_tg',
      card: 'sent',
      presented: sentPayload,
    },
  ]);

  await testDb.insert(llmCalls).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      jobId,
      source: 'job',
      turn: 1,
      modelEffective: 'claude-opus-5',
      provider: 'anthropic',
      inputTokens: 1200,
      outputTokens: 40,
      cachedTokens: 1000,
      costUsd: 0.01,
      durationMs: 2100,
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      jobId,
      source: 'job',
      turn: 2,
      modelEffective: 'claude-opus-5',
      provider: 'anthropic',
      inputTokens: 1300,
      outputTokens: 30,
      cachedTokens: 1250,
      costUsd: 0.005,
      durationMs: 1500,
    },
  ]);

  const [child] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'internal',
      task: 'sous-tâche',
      status: 'completed',
      result: 'fait',
      parentJobId: jobId,
    })
    .returning();
  childId = child!.id;

  // Un job d'une AUTRE entité : il ne doit pas se lire depuis celle-ci.
  const [otherUser] = await testDb
    .insert(users)
    .values({ email: `other-${Date.now()}@example.com` })
    .returning();
  const [otherEntity] = await testDb
    .insert(entities)
    .values({ userId: otherUser!.id, name: 'Other', slug: `other-${Date.now()}` })
    .returning();
  const [foreign] = await testDb
    .insert(agentJobs)
    .values({ entityId: otherEntity!.id, channel: 'api', task: 'ailleurs', status: 'completed' })
    .returning();
  foreignJobId = foreign!.id;
});

describe('getSpaceConversationAction', () => {
  it('rend le fil depuis les lignes réelles : demande, tours, cartes persistées, enfant, réponse', async () => {
    const { getSpaceConversationAction } = await actions();
    const r = await getSpaceConversationAction(jobId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.data.job).toMatchObject({ id: jobId, channel: 'telegram', status: 'completed' });
    const kinds = r.data.feed.items.map((i) => i.kind);
    expect(kinds).toEqual(['request', 'turn', 'turn', 'child', 'answer']);

    const [request, t1, t2, child, answer] = r.data.feed.items;
    expect(request).toMatchObject({
      kind: 'request',
      text: 'Rappelle-moi ce que j’aime',
      origin: { channel: 'telegram', chatId: '4242', scheduleName: null },
    });

    // Tour 1 : raisonnement + query_memory (table à UNE ligne → carte seule), jetons du tour 1.
    expect(t1?.kind === 'turn' && t1.model).toBe('claude-opus-5');
    expect(t1?.kind === 'turn' && t1.usage).toMatchObject({
      inputTokens: 1200,
      outputTokens: 40,
      cachedTokens: 1000,
      costUsd: 0.01,
    });
    const t1Blocks = t1?.kind === 'turn' ? t1.blocks : [];
    expect(t1Blocks.map((b) => b.kind)).toEqual(['steps', 'card']);
    const stepsBlock = t1Blocks[0];
    expect(stepsBlock?.kind === 'steps' && stepsBlock.steps[0]).toEqual({
      kind: 'reasoning',
      text: 'La mémoire doit le savoir.',
    });
    const tableCard = t1Blocks[1];
    expect(tableCard?.kind === 'card' && tableCard.step.card).toBe('table');
    expect(tableCard?.kind === 'card' && tableCard.step.presented).toEqual(tablePayload);
    expect(tableCard?.kind === 'card' && tableCard.step.durationMs).toBe(12);

    // Tour 2 : prose puis l'envoi Telegram, charge utile persistée telle quelle.
    const t2Blocks = t2?.kind === 'turn' ? t2.blocks : [];
    expect(t2Blocks.map((b) => b.kind)).toEqual(['prose', 'card']);
    expect(t2Blocks[0]?.kind === 'prose' && t2Blocks[0].text).toBe('Tu aimes les tableaux.');
    expect(t2Blocks[1]?.kind === 'card' && t2Blocks[1].step.presented).toEqual(sentPayload);

    expect(child?.kind === 'child' && child.job.id).toBe(childId);
    expect(child?.kind === 'child' && child.job.status).toBe('completed');
    expect(answer).toEqual({ kind: 'answer', text: 'Tu aimes les tableaux.' });

    expect(r.data.feed.totals).toMatchObject({
      turns: 2,
      toolCalls: 2,
      inputTokens: 2500,
      outputTokens: 70,
      cachedTokens: 2250,
      costUsd: 0.015,
      models: ['claude-opus-5'],
    });
  });

  it("ne lit pas le job d'une autre entité, ni un id qui n'est pas un uuid", async () => {
    const { getSpaceConversationAction } = await actions();
    const foreign = await getSpaceConversationAction(foreignJobId);
    expect(foreign.ok).toBe(false);
    expect(!foreign.ok && foreign.code).toBe('not_found');
    const bad = await getSpaceConversationAction('pas-un-uuid');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.code).toBe('validation_failed');
  });
});
