/**
 * delegation-outcome.spec.ts — what the USER sees when a delegation ends.
 *
 * Issue #107: a delegated sub-job signalled success having produced nothing,
 * the parent read "(no output)" as an answer and told the user "recherche
 * lancée, je te renvoie la synthèse dès que c'est prêt". Nothing ever arrived.
 *
 * What this file proves is the SCREEN half, and only that: given a delegation
 * that failed, the thread puts that failure in front of the user and never
 * shows a waiting promise instead; given one that delivered, the sub-agent's
 * own deliverable is reachable in the thread. Proving the CONTRACT — that the
 * runner refuses to finalize an empty delegation — belongs to the runner tests
 * (`apps/runner/src/tests/job/delegation-contract.test.ts`, LLM simulated, each
 * guard verified by mutation) and to `pnpm bench --section delegation` against
 * the real models. A screen can be green in front of an unplugged engine; that
 * is exactly why the two levels are separate.
 *
 * No model is involved here. The rows are seeded directly, as the other
 * database-driven specs do, so the journey runs on any stack — including CI,
 * where no LLM exists. Every row created is deleted in afterAll.
 */

import { test, expect, type Page } from '@playwright/test';
import { makeDbClient, requireLiveStack, resolveActingUser, testSlugSuffix } from './helpers.ts';

// Phrases a thread must never be left with when the work did not happen. The
// literal sentence from the incident, plus the shapes it takes in both
// languages. `(no output)` is the placeholder `compileChildResults` used to
// hand the parent — a failed delegation now reads as a failure, never as an
// agent that answered nothing.
const WAITING_PHRASES = [
  'je te renvoie',
  'dès que c’est prêt',
  "dès que c'est prêt",
  'en cours',
  'i’ll get back',
  "i'll get back",
  'in progress',
  '(no output)',
];

let acting: { userId: string; entityId: string };
const created: {
  jobIds: string[];
  conversationIds: string[];
  agentIds: string[];
} = { jobIds: [], conversationIds: [], agentIds: [] };

test.beforeAll(async () => {
  await requireLiveStack();
  acting = await resolveActingUser();
});

test.afterAll(async () => {
  const { agentJobs, chatMessages, conversations, agents, inArray } =
    await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  try {
    if (created.jobIds.length > 0) {
      await db.delete(chatMessages).where(inArray(chatMessages.jobId, created.jobIds));
    }
    if (created.conversationIds.length > 0) {
      await db
        .delete(chatMessages)
        .where(inArray(chatMessages.conversationId, created.conversationIds));
    }
    // Children first: parent_job_id references the head row.
    if (created.jobIds.length > 0) {
      await db.delete(agentJobs).where(inArray(agentJobs.parentJobId, created.jobIds));
      await db.delete(agentJobs).where(inArray(agentJobs.id, created.jobIds));
    }
    if (created.conversationIds.length > 0) {
      await db.delete(conversations).where(inArray(conversations.id, created.conversationIds));
    }
    if (created.agentIds.length > 0) {
      await db.delete(agents).where(inArray(agents.id, created.agentIds));
    }
  } finally {
    await close();
  }
});

/**
 * Seed one dashboard conversation: the user's request, a head job that has
 * finished, and the one sub-job it delegated to.
 *
 * The head job's transcript is left empty on purpose. `lastAgentTurnSpoke`
 * suppresses the derived answer when the transcript already carries assistant
 * prose, so a seeded transcript would silently remove the very item under test.
 */
async function seedDelegationThread(opts: {
  parentResult: string;
  childTask: string;
  childStatus: 'completed' | 'failed';
  childResult: string | null;
  childError: string | null;
}): Promise<{ conversationId: string; parentName: string; childName: string }> {
  const { agents, agentJobs, chatMessages, conversations } = await import('@nodal-agents/db');
  const { db, close } = makeDbClient();
  const suffix = testSlugSuffix();
  const parentName = `E2E Lead ${suffix}`;
  const childName = `E2E Specialist ${suffix}`;
  try {
    const [parentAgent] = await db
      .insert(agents)
      .values({
        entityId: acting.entityId,
        name: parentName,
        slug: `e2e-lead-${suffix}`,
        // NOT NULL with no default, and never read here: no model runs in this
        // journey. It is the row that matters, not what the agent would say.
        personality: 'E2E fixture — never executed.',
        role: 'orchestrator',
        active: true,
      })
      .returning({ id: agents.id });
    const [childAgent] = await db
      .insert(agents)
      .values({
        entityId: acting.entityId,
        name: childName,
        slug: `e2e-specialist-${suffix}`,
        personality: 'E2E fixture — never executed.',
        role: 'agent',
        active: true,
      })
      .returning({ id: agents.id });
    created.agentIds.push(parentAgent!.id, childAgent!.id);

    const [conversation] = await db
      .insert(conversations)
      .values({
        entityId: acting.entityId,
        agentId: parentAgent!.id,
        title: `Planck length ${suffix}`,
        origin: 'user',
        channel: 'dashboard',
      })
      .returning({ id: conversations.id });
    created.conversationIds.push(conversation!.id);

    const now = new Date();
    const [head] = await db
      .insert(agentJobs)
      .values({
        entityId: acting.entityId,
        agentId: parentAgent!.id,
        conversationId: conversation!.id,
        channel: 'dashboard',
        task: 'Fais une recherche sur la longueur de Planck',
        status: 'completed',
        result: opts.parentResult,
        messages: [],
        completedAt: now,
      })
      .returning({ id: agentJobs.id });
    created.jobIds.push(head!.id);

    await db.insert(agentJobs).values({
      entityId: acting.entityId,
      agentId: childAgent!.id,
      parentJobId: head!.id,
      channel: 'internal',
      task: opts.childTask,
      status: opts.childStatus,
      result: opts.childResult,
      error: opts.childError,
      messages: [],
      completedAt: now,
    });

    // Both rows matter, and the second one is not decoration: on a `dashboard`
    // conversation the thread walks `chat_messages`, and a head job is rendered
    // ONLY through the assistant row whose `job_id` points at it
    // (`conversation-thread.ts`, buildConversationThread). Without it the job
    // and its delegation are invisible — which is exactly how the runner
    // behaves: `run-chat-turn.ts` writes this acknowledgement when it escalates
    // a chat turn into a job. The wording is a plain "on it", never a promise
    // about a result: the promise is the thing under test.
    await db.insert(chatMessages).values([
      {
        entityId: acting.entityId,
        agentId: parentAgent!.id,
        conversationId: conversation!.id,
        role: 'user',
        content: 'Fais une recherche sur la longueur de Planck',
      },
      {
        entityId: acting.entityId,
        agentId: parentAgent!.id,
        conversationId: conversation!.id,
        role: 'assistant',
        content: 'On it.',
        jobId: head!.id,
      },
    ]);

    return { conversationId: conversation!.id, parentName, childName };
  } finally {
    await close();
  }
}

/** The whole rendered thread as plain text — what the user can actually read. */
async function threadText(page: Page): Promise<string> {
  const scroller = page.locator('[data-thread-scroller]');
  await expect(scroller).toBeVisible();
  return (await scroller.innerText()).toLowerCase();
}

test.describe('what the thread says when a delegation ends @cap:organiser-equipe/ecran', () => {
  test('a delegation that produced nothing shows its reason, never a promise', async ({ page }) => {
    // The reason is deliberately specific: a generic one could be matched by
    // accident, and a user reading "empty_deliverable" learns nothing.
    const reason = 'The specialist signalled completion without writing any deliverable.';
    const honestAnswer =
      'I could not get the Planck length research back: the specialist returned nothing. ' +
      'Nothing is running now — ask again and I will do the search myself.';

    const { conversationId, childName } = await seedDelegationThread({
      parentResult: honestAnswer,
      childTask: 'Recherche sur la longueur de Planck',
      childStatus: 'failed',
      childResult: null,
      childError: reason,
    });

    await page.goto(`/chat/${conversationId}`);

    // 1. The thread carries the parent's honest answer, not a waiting note.
    await expect(page.getByText('the specialist returned nothing')).toBeVisible();

    // 2. The delegation is on screen and marked as NOT ok — a red dot, which is
    //    what tells a reader at a glance that this handoff did not land.
    const delegation = page.locator('[data-delegation]').first();
    await expect(delegation).toBeVisible();
    await expect(delegation.getByText(`Delegated to ${childName}`)).toBeVisible();
    await expect(delegation.locator('span.bg-err')).toBeVisible();

    // 3. The reason itself is one click away, and it is the reason — not the
    //    "(no output)" placeholder that made #107 look like an answer.
    await delegation.getByRole('button').first().click();
    await expect(delegation.getByText(reason)).toBeVisible();

    // 4. Nothing anywhere in the thread tells the user to wait.
    const text = await threadText(page);
    for (const phrase of WAITING_PHRASES) {
      expect(text, `the thread must not promise "${phrase}"`).not.toContain(phrase.toLowerCase());
    }
  });

  test('a delegation that delivered puts the specialist’s own work in the thread', async ({
    page,
  }) => {
    const deliverable =
      'Planck length: 1.616255e-35 m, derived from the reduced Planck constant, G and c. ' +
      'Source: NIST CODATA 2022.';
    const parentAnswer = 'Here is what the specialist found on the Planck length.';

    const { conversationId, childName } = await seedDelegationThread({
      parentResult: parentAnswer,
      childTask: 'Recherche sur la longueur de Planck',
      childStatus: 'completed',
      childResult: deliverable,
      childError: null,
    });

    await page.goto(`/chat/${conversationId}`);

    await expect(page.getByText('Here is what the specialist found')).toBeVisible();

    const delegation = page.locator('[data-delegation]').first();
    await expect(delegation).toBeVisible();
    await expect(delegation.getByText(`Delegated to ${childName}`)).toBeVisible();
    await expect(delegation.locator('span.bg-ok').first()).toBeVisible();

    // Closed, the row already shows the head of what came back — proof there is
    // something rather than the "No result yet" a missing deliverable earns.
    await expect(delegation.getByText('Planck length: 1.616255e-35')).toBeVisible();

    // Opened, the WHOLE deliverable is there. The assertion deliberately lands
    // on the tail of the text: `delegationTitle` truncates the closed line at 80
    // characters, so anything past it can only come from the sub-agent's own
    // reply in the body — the thing that was empty in #107.
    await delegation.getByRole('button').first().click();
    await expect(delegation.getByText('NIST CODATA 2022')).toBeVisible();

    const text = await threadText(page);
    expect(text).not.toContain('(no output)');
  });
});
