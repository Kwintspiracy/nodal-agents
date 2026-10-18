// approval-creation-order.test.ts — #801, côté web, sur de VRAIES lignes. Les
// demandes créées dans la même milliseconde (heure forcée identique) sortent
// des lecteurs web dans l'ordre de CRÉATION, jamais au hasard de leurs uuid :
//   - `listApprovalsAction` (/approvals) : la plus récente d'abord, y compris à
//     la coupe de la limite ;
//   - le fil d'une conversation (`getConversationThreadAction` → job-feed) : les
//     élicitations dans l'ordre où le serveur MCP les a posées ;
//   - `listSidebarRecentApprovalsAction` : à heure de réponse égale, la plus
//     récemment créée d'abord.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, approvalRequests, chatMessages, conversations } from '@nodal-agents/db';

process.env['RUNNER_URL'] = 'http://localhost:3001';
process.env['WORKER_SECRET'] = 'test-bearer-approval-order';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

vi.mock('server-only', () => ({}));
vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
  requireUserWithEntity: async () => ({ userId: seed.userId, entityId: seed.entityId }),
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

const SAME_INSTANT = new Date('2026-10-18T10:00:00.000Z');
const SCHEMA = {
  type: 'object',
  properties: { paper: { type: 'string', title: 'Paper', enum: ['A4', 'Letter'] } },
  required: ['paper'],
};
const COUNT = 14;

const ids = {
  conv: '',
  job: '',
  approvals: [] as string[],
  elicitations: [] as string[],
  resolved: [] as string[],
};

async function insertTied(
  kind: 'approval' | 'elicitation',
  status: 'pending' | 'approved',
  extra: Record<string, unknown> = {},
): Promise<string[]> {
  const created: string[] = [];
  for (let i = 0; i < COUNT; i++) {
    const [row] = await testDb
      .insert(approvalRequests)
      .values({
        entityId: seed.entityId,
        jobId: ids.job,
        agentId: seed.agentId,
        toolName: kind === 'elicitation' ? 'printer__request_print' : 'run_command',
        toolInput:
          kind === 'elicitation'
            ? { server: 'printer', message: `Question ${i}`, requestedSchema: SCHEMA }
            : { command: `echo ${i}`, purpose: 'look' },
        toolCallId: `call_${kind}_${status}_${i}_${Math.random()}`,
        kind,
        status,
        requestedAt: SAME_INSTANT,
        ...(kind === 'elicitation' ? { executedAt: new Date() } : {}),
        ...extra,
      })
      .returning({ id: approvalRequests.id });
    created.push(row!.id);
  }
  return created;
}

beforeAll(async () => {
  testDb = (await spinUpTestDb()).db;
  seed = await seedMinimal(testDb);
  const [conv] = await testDb
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      title: 'Ordre',
      origin: 'user',
      channel: 'dashboard',
    })
    .returning({ id: conversations.id });
  ids.conv = conv!.id;
  const [job] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      conversationId: ids.conv,
      task: 'Do it',
      status: 'processing',
      messages: [],
    })
    .returning({ id: agentJobs.id });
  ids.job = job!.id;
  await testDb.insert(chatMessages).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: ids.conv,
      role: 'user',
      content: 'Do it',
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId: ids.conv,
      role: 'assistant',
      content: 'On it.',
      jobId: ids.job,
    },
  ]);
  ids.approvals = await insertTied('approval', 'pending');
  ids.elicitations = await insertTied('elicitation', 'pending');
  ids.resolved = await insertTied('approval', 'approved', {
    resolvedAt: SAME_INSTANT,
    resolvedBy: 'api',
    executedAt: new Date(),
  });
});

describe('web readers order approval requests by creation @cap:approuver-une-action/moteur', () => {
  it('/approvals lists same-millisecond requests newest created first', async () => {
    const { listApprovalsAction } = await import('../actions.ts');
    const r = await listApprovalsAction({ status: 'pending' });
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
    if (!r.ok) return;
    const mine = new Set([...ids.approvals, ...ids.elicitations]);
    // Les deux lots ont été créés l'un après l'autre : toute la rangée est
    // l'inverse de la création, approbations et élicitations mêlées.
    const listed = r.data.map((a) => a.id).filter((id) => mine.has(id));
    expect(listed).toEqual([...ids.approvals, ...ids.elicitations].reverse());
  });

  it('the conversation feed shows elicitations in the order they were asked', async () => {
    const { getConversationThreadAction } = await import('../conversation-actions.ts');
    const r = await getConversationThreadAction(ids.conv);
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
    if (!r.ok) return;
    const asked = r.data.feed.items
      .filter((i) => i.kind === 'elicitation')
      .map((i) => (i.kind === 'elicitation' ? i.elicitation.approvalRequestId : ''));
    expect(asked).toEqual(ids.elicitations);
  });

  it('the sidebar recents break a same-second answer tie by creation, newest first', async () => {
    const { listSidebarRecentApprovalsAction } = await import('../sidebar-actions.ts');
    const r = await listSidebarRecentApprovalsAction(50);
    expect(r.ok, r.ok ? '' : r.message).toBe(true);
    if (!r.ok) return;
    const mine = new Set(ids.resolved);
    expect(r.data.map((a) => a.id).filter((id) => mine.has(id))).toEqual(
      [...ids.resolved].reverse(),
    );
  });
});
