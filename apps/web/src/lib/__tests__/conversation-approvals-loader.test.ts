// conversation-approvals-loader.test.ts — the approvals a conversation shows (#469).
//
// The thread carries the pending approvals of ITS runs: the root job and its
// delegates, which all carry the conversation's id (run ae424ac0, 24/09: the
// Excel agent was a delegate of the root's job in conversation 12f28838). What
// this proves, on a real database: `listApprovalsAction({ conversationId })`
// returns exactly those, and nothing of another conversation.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, approvalRequests, conversations, entities, users } from '@nodal-agents/db';

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
    requireAuth: async () => ({ userId: seed?.userId ?? 'u', entityId: seed?.entityId ?? 'e' }),
  };
});

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
});

async function conversation(): Promise<string> {
  const [row] = await testDb
    .insert(conversations)
    .values({ entityId: seed.entityId, agentId: seed.agentId, title: 'c' })
    .returning({ id: conversations.id });
  return row!.id;
}

async function job(conversationId: string, parentJobId: string | null = null): Promise<string> {
  const [row] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      task: 't',
      status: 'awaiting_approval',
      conversationId,
      parentJobId,
    })
    .returning({ id: agentJobs.id });
  return row!.id;
}

async function pendingApproval(jobId: string, command: string): Promise<void> {
  await testDb.insert(approvalRequests).values({
    entityId: seed.entityId,
    jobId,
    agentId: seed.agentId,
    toolName: 'run_command',
    toolInput: { command, purpose: 'p' },
    status: 'pending',
  });
}

describe('listApprovalsAction by conversation (#469) @cap:approuver-une-action/moteur', () => {
  it("returns the pending approvals of the conversation's runs, delegates included, and no other", async () => {
    const mine = await conversation();
    const other = await conversation();
    const root = await job(mine);
    const delegate = await job(mine, root);
    await pendingApproval(root, 'echo root');
    await pendingApproval(delegate, 'python shared/scripts/x.py');
    await pendingApproval(await job(other), 'echo elsewhere');
    const { listApprovalsAction } = await import('../actions.ts');

    const res = await listApprovalsAction({ status: 'pending', conversationId: mine });

    expect(res.ok).toBe(true);
    const commands = res.ok
      ? res.data.map((r) => (r.toolInput as { command: string }).command).sort()
      : [];
    expect(commands).toEqual(['echo root', 'python shared/scripts/x.py']);
  });

  // Review of PR #482 (Reviewer A, P3): another workspace, even with a job that
  // carries the same conversation id, never shows here.
  it('never shows a request of another workspace, even one carrying the same conversation id', async () => {
    const mine = await conversation();
    const [otherUser] = await testDb
      .insert(users)
      .values({ email: 'other-482@test.local' })
      .returning({ id: users.id });
    const [otherEntity] = await testDb
      .insert(entities)
      .values({ userId: otherUser!.id, name: 'Other', slug: 'other-482' })
      .returning({ id: entities.id });
    const [foreignJob] = await testDb
      .insert(agentJobs)
      .values({
        entityId: otherEntity!.id,
        channel: 'dashboard',
        task: 't',
        status: 'awaiting_approval',
        conversationId: mine,
      })
      .returning({ id: agentJobs.id });
    await testDb.insert(approvalRequests).values({
      entityId: otherEntity!.id,
      jobId: foreignJob!.id,
      toolName: 'run_command',
      toolInput: { command: 'echo foreign', purpose: 'p' },
      status: 'pending',
    });
    await pendingApproval(await job(mine), 'echo mine');
    const { listApprovalsAction } = await import('../actions.ts');

    const res = await listApprovalsAction({ status: 'pending', conversationId: mine });

    expect(res.ok).toBe(true);
    const commands = res.ok
      ? res.data.map((r) => (r.toolInput as { command: string }).command)
      : [];
    expect(commands).toEqual(['echo mine']);
  });
});
