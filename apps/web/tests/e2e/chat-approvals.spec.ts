/**
 * chat-approvals.spec.ts — an approval is answered in the conversation (#469).
 *
 * Quentin, 24/09, testing #464 (run ae424ac0): the Excel agent's command was
 * held for approval, and answering meant leaving the conversation for the
 * Approvals page "just to click a button". What this journey proves, in a
 * browser against the real database: a pending approval of a DELEGATE of the
 * conversation's run shows in the conversation itself, as the full card — the
 * agent's reason, the checklist reason, the three answers — below the thread.
 *
 * Answering is not played here: it goes through the runner, which this
 * journey does not start. That the card's "Approve once" answers from the
 * thread and re-reads it is proven in `ConversationApprovals.test.tsx`; that
 * the answer resumes the run, in the runner's approval tests.
 */

import { test, expect } from '@playwright/test';
import { requireLiveStack, makeDbClient, resolveActingUser, testSlugSuffix } from './helpers.ts';

let agentId = '';
let conversationId = '';

test.beforeAll(async () => {
  await requireLiveStack();
  const acting = await resolveActingUser();
  const { agents, agentJobs, approvalRequests, conversations, chatMessages } =
    await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        entityId: acting.entityId,
        name: `Excel ${testSlugSuffix()}`,
        slug: `e2e-chat-approvals-${testSlugSuffix()}`,
        personality: 'E2E fixture, never executed.',
        active: true,
      })
      .returning({ id: agents.id });
    agentId = agent!.id;
    const [conv] = await db
      .insert(conversations)
      .values({ entityId: acting.entityId, agentId, title: `Approvals ${testSlugSuffix()}` })
      .returning({ id: conversations.id });
    conversationId = conv!.id;
    await db.insert(chatMessages).values({
      entityId: acting.entityId,
      agentId,
      conversationId,
      role: 'user',
      content: 'Inspect the export in my Downloads folder.',
    });
    const [rootJob] = await db
      .insert(agentJobs)
      .values({
        entityId: acting.entityId,
        agentId,
        channel: 'dashboard',
        task: 'Inspect the export',
        status: 'processing',
        conversationId,
      })
      .returning({ id: agentJobs.id });
    // The delegate that asks, like ae424ac0 under its root.
    const [delegate] = await db
      .insert(agentJobs)
      .values({
        entityId: acting.entityId,
        agentId,
        channel: 'dashboard',
        task: 'Read the workbook',
        status: 'awaiting_approval',
        conversationId,
        parentJobId: rootJob!.id,
      })
      .returning({ id: agentJobs.id });
    await db.insert(approvalRequests).values({
      entityId: acting.entityId,
      jobId: delegate!.id,
      agentId,
      toolName: 'run_command',
      toolInput: {
        command: 'rm -rf shared/scratch',
        purpose: 'Clear the scratch folder.',
      },
      status: 'pending',
      gateReasons: [{ category: 'delete_files', state: 'ask', details: ['rm -rf shared/scratch'] }],
    });
  } finally {
    await close();
  }
});

test.afterAll(async () => {
  if (!agentId) return;
  const { agents, eq } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    // Conversation, jobs and approvals go with the agent (cascade).
    await db.delete(agents).where(eq(agents.id, agentId));
  } finally {
    await close();
  }
});

test.describe('approvals in the conversation @cap:approuver-une-action/ecran', () => {
  test("a delegate's pending approval is answered from the conversation", async ({ page }) => {
    await page.goto(`/chat/${conversationId}`);

    const inThread = page.getByTestId('conversation-approvals');
    await expect(inThread).toBeVisible({ timeout: 30_000 });
    const card = inThread.getByTestId('approval-card');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Clear the scratch folder.');
    await expect(card).toContainText('Delete files or discard changes');
    await expect(card.getByTestId('approval-approve-once')).toBeVisible();
    // Still on the conversation: nothing sent the person elsewhere.
    expect(new URL(page.url()).pathname).toBe(`/chat/${conversationId}`);
  });
});
