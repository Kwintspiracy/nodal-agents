// outbound-read-models.test.ts — every read model of the dashboard that hands a
// browser the text of a job or a chat hands it masked: real rows written in
// the database (a request, a reply, an error, a delegate's brief, a chat
// message, a conversation title, a tool call's input and output, a waiting
// request's input, a delivery's payload), each carrying a credential-shaped
// value, and what each action RETURNS. The rows themselves stay as written.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  approvalRequests,
  chatMessages,
  conversations,
  eq,
  jobDeliveries,
  toolCalls,
} from '@nodal-agents/db';
import { REDACTED_TEXT } from '@nodal-agents/shared';
import { fakeBearer, fakeSecret } from '@nodal-agents/test-kit';

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

// One value per place it is written, so a failure names the column that leaked.
/** 36 characters of the key alphabet, tagged so each value is its own. */
const body = (tag: string): string =>
  Array.from({ length: 12 }, (_, i) => `${tag}${i % 10}`).join('');
const KEY = {
  request: fakeSecret('github', body('Rq')),
  reply: fakeSecret('github', body('Rp')),
  error: fakeSecret('github', body('Er')),
  brief: fakeSecret('github', body('Br')),
  briefReply: fakeSecret('github', body('Bp')),
  chatUser: fakeSecret('github', body('Cu')),
  chatAgent: fakeSecret('github', body('Ca')),
  title: fakeSecret('github', body('Ti')),
  toolInput: fakeSecret('github', body('In')),
  toolOutput: fakeSecret('github', body('Ou')),
  approvalInput: fakeBearer(body('Ap')),
  payload: fakeSecret('github', body('Pa')),
};

let conversationId: string;
let headId: string;
let childId: string;

/** Every value of `KEY` found in `value`, by name. */
function leaked(value: unknown): string[] {
  const text = JSON.stringify(value);
  return Object.entries(KEY)
    .filter(([, secret]) => text.includes(secret))
    .map(([name]) => name);
}

beforeAll(async () => {
  testDb = (await spinUpTestDb()).db;
  seed = await seedMinimal(testDb);

  const [conv] = await testDb
    .insert(conversations)
    .values({ entityId: seed.entityId, agentId: seed.agentId, title: `Deploy with ${KEY.title}` })
    .returning({ id: conversations.id });
  conversationId = conv!.id;

  const [head] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      conversationId,
      status: 'failed',
      task: `Deploy with this token: ${KEY.request}`,
      result: `Deployed. I used ${KEY.reply}.`,
      error: `push refused for ${KEY.error}`,
      messages: [{ role: 'user', content: `Deploy with this token: ${KEY.request}` }],
    })
    .returning({ id: agentJobs.id });
  headId = head!.id;

  const [child] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      conversationId,
      parentJobId: headId,
      status: 'completed',
      task: `Push the release with ${KEY.brief}`,
      result: `Pushed with ${KEY.briefReply}`,
    })
    .returning({ id: agentJobs.id });
  childId = child!.id;

  await testDb.insert(chatMessages).values([
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId,
      role: 'user',
      content: `Here is the key: ${KEY.chatUser}`,
    },
    {
      entityId: seed.entityId,
      agentId: seed.agentId,
      conversationId,
      role: 'assistant',
      content: `Noted, ${KEY.chatAgent}`,
    },
  ]);

  await testDb.insert(toolCalls).values({
    entityId: seed.entityId,
    jobId: headId,
    toolName: 'run_command',
    toolInput: { command: `git push https://example.test --token ${KEY.toolInput}` },
    toolOutput: `remote: token ${KEY.toolOutput} accepted`,
    durationMs: 5,
    turn: 1,
    toolCallId: 'c_push',
  });

  await testDb.insert(approvalRequests).values({
    entityId: seed.entityId,
    jobId: headId,
    agentId: seed.agentId,
    toolName: 'run_command',
    toolInput: { command: `curl -H 'Authorization: ${KEY.approvalInput}' https://example.test` },
    status: 'pending',
  });

  await testDb.insert(jobDeliveries).values({
    jobId: headId,
    channel: 'telegram',
    chatId: '4242',
    payload: `Deployed. I used ${KEY.payload}.`,
    outcome: 'attempted',
    idempotencyKey: `outbound-${headId}`,
    attempts: 1,
  });
});

const actions = () => import('../actions.ts');
const conversationActions = () => import('../conversation-actions.ts');
const sidebarActions = () => import('../sidebar-actions.ts');

describe('the dashboard read models hand job and chat text masked @cap:suivre-execution/moteur', () => {
  it('the conversation page: the job answer, its error and every chat message', async () => {
    const { getConversationThreadAction } = await conversationActions();
    const res = await getConversationThreadAction(conversationId);
    expect(res.ok).toBe(true);
    expect(leaked(res)).toEqual([]);
    expect(JSON.stringify(res)).toContain(REDACTED_TEXT);
    // The text around the value is still there: masked, not dropped.
    expect(JSON.stringify(res)).toContain('Noted, ');
  });

  it('the run page: the result beside the feed, the delegate’s brief, the calls, the deliveries', async () => {
    const { getSpaceConversationAction } = await actions();
    const res = await getSpaceConversationAction(headId);
    expect(res.ok).toBe(true);
    expect(leaked(res)).toEqual([]);
    expect(JSON.stringify(res)).toContain('Push the release with ');
  });

  it('the job status polled by a page', async () => {
    const { getJobStatusAction } = await actions();
    const res = await getJobStatusAction(headId);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.result).toBe(`Deployed. I used ${REDACTED_TEXT}.`);
    expect(res.data.error).toBe(`push refused for ${REDACTED_TEXT}`);
  });

  it('the job detail: the whole row and its children', async () => {
    const { getJobDetailAction } = await actions();
    const res = await getJobDetailAction(headId);
    expect(res.ok).toBe(true);
    expect(leaked(res)).toEqual([]);
  });

  it('the lists that print a job’s request: runs, activity, conversations', async () => {
    const { listJobsAction, listActivityRunsAction, listRunCallsAction } = await actions();
    const { listAllConversationsAction } = await conversationActions();
    for (const res of [
      await listJobsAction({}),
      await listActivityRunsAction({}),
      await listRunCallsAction({ jobId: headId }),
      await listAllConversationsAction(),
    ]) {
      expect(res.ok).toBe(true);
      expect(leaked(res)).toEqual([]);
    }
  });

  it('the waiting requests: the approvals page and the sidebar', async () => {
    const { listApprovalsAction } = await actions();
    const { listSidebarRecentApprovalsAction } = await sidebarActions();
    const page = await listApprovalsAction({ status: 'pending' });
    const sidebar = await listSidebarRecentApprovalsAction(10);
    for (const res of [page, sidebar]) {
      expect(res.ok).toBe(true);
      expect(leaked(res)).toEqual([]);
    }
    expect(JSON.stringify(page)).toContain('Bearer ');
  });

  it('the rows stay as they were written', async () => {
    const [head] = await testDb.select().from(agentJobs).where(eq(agentJobs.id, headId));
    const [child] = await testDb.select().from(agentJobs).where(eq(agentJobs.id, childId));
    expect(head!.result).toContain(KEY.reply);
    expect(child!.task).toContain(KEY.brief);
  });
});
