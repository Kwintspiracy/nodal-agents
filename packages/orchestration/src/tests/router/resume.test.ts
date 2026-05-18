// router/resume.test.ts — resumeDelegated DB tests
// Asserts on real DB message rows.

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from '@nodal-agents/db';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs } from '@nodal-agents/db';
import { resumeDelegated } from '../../router/resume';
import type { ToolKind } from '../../router/resume';
import { OrchestrationError } from '../../errors';
import type { JobId } from '../../types';
import type { TestDb } from '@nodal-agents/db/test-utils';

let db: TestDb;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
});

// ─── Seed helpers ──────────────────────────────────────────────────────────────

async function seedContext(db: TestDb) {
  const [user] = await db
    .insert((await import('@nodal-agents/db')).users)
    .values({ email: `test-r-${Date.now()}@ex.com` })
    .returning();
  const [entity] = await db
    .insert((await import('@nodal-agents/db')).entities)
    .values({ userId: user!.id, name: 'T', slug: `e-r-${Date.now()}` })
    .returning();

  const [orch] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: 'Test Orch R',
      slug: `test-orch-r-${Date.now()}`,
      personality: 'p',
      role: 'orchestrator',
      active: true,
    })
    .returning();

  return { entityId: entity!.id, orchId: orch!.id };
}

async function seedParentJob(
  db: TestDb,
  entityId: string,
  agentId: string,
  toolUseId: string,
  childJobId: string,
  sideToolResults?: Array<{
    type: string;
    tool_use_id: string;
    toolName?: string;
    content: string;
  }>,
) {
  const pendingDelegation: Record<string, unknown> = {
    type: 'single',
    toolUseId,
    toolName: 'assign_test_agent',
    subJobId: childJobId,
  };
  if (sideToolResults && sideToolResults.length > 0) {
    pendingDelegation['sideToolResults'] = sideToolResults;
  }

  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId,
      agentId,
      channel: 'api',
      task: 'parent task',
      status: 'awaiting_delegation',
      messages: [
        { role: 'user', content: 'parent task' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: toolUseId, name: `assign_test_agent`, input: {} }],
        },
      ],
      pendingDelegation,
    })
    .returning();
  return job!;
}

async function seedChildJob(
  db: TestDb,
  entityId: string,
  agentId: string,
  parentJobId?: string,
  toolsUsed: string[] = [],
) {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId,
      agentId,
      channel: 'internal',
      task: 'child task',
      status: 'completed',
      toolsUsed,
      ...(parentJobId ? { parentJobId } : {}),
    })
    .returning();
  return job!;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('resumeDelegated', () => {
  it('injects tool_result with correct tool_use_id into parent messages', async () => {
    const { entityId, orchId } = await seedContext(db);
    const toolUseId = 'tu_resume_001';
    const childResult = 'The analysis is complete.';

    const childJob = await seedChildJob(db, entityId, orchId);
    const parentJob = await seedParentJob(db, entityId, orchId, toolUseId, childJob.id);

    await resumeDelegated(parentJob.id as JobId, childJob.id as JobId, childResult, db);

    const [updatedParent] = await db
      .select({ messages: agentJobs.messages, status: agentJobs.status })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));

    expect(updatedParent?.status).toBe('pending');

    // The last message should be a tool-role message with tool-result parts
    // (AI SDK v6 ModelMessage format — output is a discriminated union now).
    const msgs = updatedParent?.messages as Array<{
      role: string;
      content: unknown;
    }>;
    const lastMsg = msgs[msgs.length - 1];
    expect(lastMsg?.role).toBe('tool');

    const content = lastMsg?.content as Array<{
      type: string;
      toolCallId?: string;
      toolName?: string;
      output?: { type: string; value: unknown };
    }>;
    expect(Array.isArray(content)).toBe(true);

    const toolResult = content.find((b) => b.type === 'tool-result');
    expect(toolResult).toBeDefined();
    expect(toolResult?.toolCallId).toBe(toolUseId);
    expect(toolResult?.toolName).toBe('assign_test_agent');
    expect(toolResult?.output).toEqual({ type: 'text', value: childResult });
  });

  it('sets parent status back to pending', async () => {
    const { entityId, orchId } = await seedContext(db);
    const childJob = await seedChildJob(db, entityId, orchId);
    const parentJob = await seedParentJob(db, entityId, orchId, 'tu_resume_002', childJob.id);

    const updatedJob = await resumeDelegated(
      parentJob.id as JobId,
      childJob.id as JobId,
      'child result',
      db,
    );

    expect(updatedJob.status).toBe('pending');
  });

  it('clears pending_delegation after resume', async () => {
    const { entityId, orchId } = await seedContext(db);
    const childJob = await seedChildJob(db, entityId, orchId);
    const parentJob = await seedParentJob(db, entityId, orchId, 'tu_resume_003', childJob.id);

    await resumeDelegated(parentJob.id as JobId, childJob.id as JobId, 'result', db);

    const [row] = await db
      .select({ pendingDelegation: agentJobs.pendingDelegation })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));

    expect(row?.pendingDelegation).toBeNull();
  });

  it('includes sideToolResults in the injected tool message (message-integrity)', async () => {
    const { entityId, orchId } = await seedContext(db);
    const toolUseId = 'tu_resume_004';
    const sideResults = [
      {
        type: 'tool_result',
        tool_use_id: 'tu_deferred_side',
        toolName: 'assign_other_agent',
        content: 'Deferred — another handoff took priority',
      },
    ];

    const childJob = await seedChildJob(db, entityId, orchId);
    const parentJob = await seedParentJob(
      db,
      entityId,
      orchId,
      toolUseId,
      childJob.id,
      sideResults,
    );

    await resumeDelegated(parentJob.id as JobId, childJob.id as JobId, 'main result', db);

    const [row] = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));

    const msgs = row?.messages as Array<{ role: string; content: unknown }>;
    const lastMsg = msgs[msgs.length - 1];
    expect(lastMsg?.role).toBe('tool');
    const content = lastMsg?.content as Array<{
      type: string;
      toolCallId?: string;
      toolName?: string;
    }>;

    // Should have both: main tool-result + side tool-result
    expect(content).toHaveLength(2);
    const sideResult = content.find((b) => b.toolCallId === 'tu_deferred_side');
    expect(sideResult).toBeDefined();
    expect(sideResult?.toolName).toBe('assign_other_agent');
  });

  // Test helper: build a ToolKindLookup from a simple map. Mirrors what the
  // runner does in production — `(name) => deps.toolRegistry.get(name)?.riskLevel`.
  const kindOfFromMap = (map: Record<string, ToolKind>) => (name: string) => map[name];

  it('bumps failedDelegationsCount when failed child WROTE side effects', async () => {
    const { entityId, orchId } = await seedContext(db);
    const toolUseId = 'tu_resume_count_001';
    // Child that crashed AFTER calling file_write — a retry would risk a
    // duplicate file, so we burn the retry budget.
    const childJob = await seedChildJob(db, entityId, orchId, undefined, [
      'file_list',
      'tavily_search',
      'file_write',
    ]);
    const parentJob = await seedParentJob(db, entityId, orchId, toolUseId, childJob.id);

    const [before] = await db
      .select({ failedDelegationsCount: agentJobs.failedDelegationsCount })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));
    expect(before?.failedDelegationsCount).toBe(0);

    await resumeDelegated(
      parentJob.id as JobId,
      childJob.id as JobId,
      { error: 'AI_APICallError: Provider returned error' },
      db,
      {
        kindOf: kindOfFromMap({
          file_list: 'read',
          tavily_search: 'read',
          file_write: 'write',
        }),
      },
    );

    const [after] = await db
      .select({ failedDelegationsCount: agentJobs.failedDelegationsCount })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));
    expect(after?.failedDelegationsCount).toBe(1);
  });

  it('does NOT bump failedDelegationsCount when failed child only READ', async () => {
    // Live regression: job `b3a67cee` (2026-05-18) — Summarizus crashed after
    // only file_list / file_read / tavily_search / query_memory (all reads).
    // Without the smart-cap behaviour the dumb cap refused the retry and the
    // user got no deliverable when a 2nd attempt would have been safe.
    const { entityId, orchId } = await seedContext(db);
    const toolUseId = 'tu_resume_count_001b';
    const childJob = await seedChildJob(db, entityId, orchId, undefined, [
      'file_list',
      'file_read',
      'tavily_search',
      'query_memory',
    ]);
    const parentJob = await seedParentJob(db, entityId, orchId, toolUseId, childJob.id);

    await resumeDelegated(
      parentJob.id as JobId,
      childJob.id as JobId,
      { error: 'AI_APICallError: Provider returned error' },
      db,
      {
        kindOf: kindOfFromMap({
          file_list: 'read',
          file_read: 'read',
          tavily_search: 'read',
          query_memory: 'read',
        }),
      },
    );

    const [after] = await db
      .select({ failedDelegationsCount: agentJobs.failedDelegationsCount })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));
    expect(after?.failedDelegationsCount).toBe(0);
  });

  it('treats dashboard_publish as a side-effect write (user-visible result surface)', async () => {
    const { entityId, orchId } = await seedContext(db);
    const toolUseId = 'tu_resume_count_001c';
    const childJob = await seedChildJob(db, entityId, orchId, undefined, [
      'file_list',
      'dashboard_publish',
    ]);
    const parentJob = await seedParentJob(db, entityId, orchId, toolUseId, childJob.id);

    await resumeDelegated(
      parentJob.id as JobId,
      childJob.id as JobId,
      { error: 'AI_APICallError: Provider returned error' },
      db,
      {
        kindOf: kindOfFromMap({
          file_list: 'read',
          dashboard_publish: 'write',
        }),
      },
    );

    const [after] = await db
      .select({ failedDelegationsCount: agentJobs.failedDelegationsCount })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));
    expect(after?.failedDelegationsCount).toBe(1);
  });

  it('bumps on ADAPTER write tools (gmail_send_email, airtable_create_records, …) — declarative riskLevel', async () => {
    // Refactor regression: the old hardcoded `SIDE_EFFECT_WRITE_TOOLS` set
    // only knew about 6 builtins and would have silently classified
    // `gmail_send_email` as read → retried → duplicate emails sent. With the
    // declarative `riskLevel` lookup, any tool the registry knows about as
    // `write` or `destructive` counts.
    const { entityId, orchId } = await seedContext(db);
    const toolUseId = 'tu_resume_count_adapter';
    const childJob = await seedChildJob(db, entityId, orchId, undefined, [
      'gmail_list_messages',
      'gmail_send_email',
    ]);
    const parentJob = await seedParentJob(db, entityId, orchId, toolUseId, childJob.id);

    await resumeDelegated(
      parentJob.id as JobId,
      childJob.id as JobId,
      { error: 'AI_APICallError: Provider returned error' },
      db,
      {
        kindOf: kindOfFromMap({
          gmail_list_messages: 'read',
          gmail_send_email: 'write',
        }),
      },
    );

    const [after] = await db
      .select({ failedDelegationsCount: agentJobs.failedDelegationsCount })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));
    expect(after?.failedDelegationsCount).toBe(1);
  });

  it('treats DESTRUCTIVE tools the same as write (gmail_delete_message)', async () => {
    const { entityId, orchId } = await seedContext(db);
    const toolUseId = 'tu_resume_count_destructive';
    const childJob = await seedChildJob(db, entityId, orchId, undefined, ['gmail_delete_message']);
    const parentJob = await seedParentJob(db, entityId, orchId, toolUseId, childJob.id);

    await resumeDelegated(
      parentJob.id as JobId,
      childJob.id as JobId,
      { error: 'AI_APICallError: Provider returned error' },
      db,
      { kindOf: kindOfFromMap({ gmail_delete_message: 'destructive' }) },
    );

    const [after] = await db
      .select({ failedDelegationsCount: agentJobs.failedDelegationsCount })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));
    expect(after?.failedDelegationsCount).toBe(1);
  });

  it('treats UNKNOWN tools as side-effect (safe default — no silent free retries)', async () => {
    // If the registry doesn't know a tool (typo, unregistered, race condition),
    // we err on the safe side and treat it as a write. Better to burn one
    // retry budget than to grant unbounded retries on a tool whose effect we
    // can't classify.
    const { entityId, orchId } = await seedContext(db);
    const toolUseId = 'tu_resume_count_unknown';
    const childJob = await seedChildJob(db, entityId, orchId, undefined, [
      'mystery_tool_not_in_registry',
    ]);
    const parentJob = await seedParentJob(db, entityId, orchId, toolUseId, childJob.id);

    await resumeDelegated(
      parentJob.id as JobId,
      childJob.id as JobId,
      { error: 'AI_APICallError: Provider returned error' },
      db,
      { kindOf: () => undefined }, // explicit: lookup returns undefined for everything
    );

    const [after] = await db
      .select({ failedDelegationsCount: agentJobs.failedDelegationsCount })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));
    expect(after?.failedDelegationsCount).toBe(1);
  });

  it('treats NO LOOKUP (legacy callers) as side-effect (safe default)', async () => {
    // Same safe default applies when `opts.kindOf` is omitted entirely.
    // Protects unit-test callers and any code that pre-dates the refactor.
    const { entityId, orchId } = await seedContext(db);
    const toolUseId = 'tu_resume_count_nolookup';
    const childJob = await seedChildJob(db, entityId, orchId, undefined, ['file_read']);
    const parentJob = await seedParentJob(db, entityId, orchId, toolUseId, childJob.id);

    await resumeDelegated(
      parentJob.id as JobId,
      childJob.id as JobId,
      { error: 'AI_APICallError: Provider returned error' },
      db,
      // no opts → no kindOf → safe default
    );

    const [after] = await db
      .select({ failedDelegationsCount: agentJobs.failedDelegationsCount })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));
    expect(after?.failedDelegationsCount).toBe(1);
  });

  it('does NOT bump failedDelegationsCount when child completed normally', async () => {
    const { entityId, orchId } = await seedContext(db);
    const toolUseId = 'tu_resume_count_002';
    const childJob = await seedChildJob(db, entityId, orchId);
    const parentJob = await seedParentJob(db, entityId, orchId, toolUseId, childJob.id);

    await resumeDelegated(
      parentJob.id as JobId,
      childJob.id as JobId,
      'child completed successfully',
      db,
    );

    const [after] = await db
      .select({ failedDelegationsCount: agentJobs.failedDelegationsCount })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));
    expect(after?.failedDelegationsCount).toBe(0);
  });

  it('escalates the error-text message when failure count reaches the soft threshold (>= 2)', async () => {
    // Live regression: job `29981b47` (2026-05-18) — Conciergus retried 3 times
    // on rate-limited DeepSeek and wrote 3 versions of the same note. The 2nd
    // and later failure injections must tell the LLM explicitly to STOP.
    // Child here needs a write tool so the smart cap actually bumps.
    const { entityId, orchId } = await seedContext(db);
    const toolUseId = 'tu_resume_count_003';
    const childJob = await seedChildJob(db, entityId, orchId, undefined, ['file_write']);
    const parentJob = await seedParentJob(db, entityId, orchId, toolUseId, childJob.id);

    // Pre-seed the counter to 1 so the next resume crosses the threshold to 2.
    await db
      .update(agentJobs)
      .set({ failedDelegationsCount: 1 })
      .where(eq(agentJobs.id, parentJob.id));

    await resumeDelegated(
      parentJob.id as JobId,
      childJob.id as JobId,
      { error: 'AI_APICallError: 503 backend unavailable' },
      db,
      { kindOf: kindOfFromMap({ file_write: 'write' }) },
    );

    const [updated] = await db
      .select({
        messages: agentJobs.messages,
        failedDelegationsCount: agentJobs.failedDelegationsCount,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));
    expect(updated?.failedDelegationsCount).toBe(2);

    const msgs = updated?.messages as Array<{
      role: string;
      content: Array<{ type: string; output?: { type: string; value: string } }>;
    }>;
    const last = msgs[msgs.length - 1];
    const tr = last?.content.find((c) => c.type === 'tool-result');
    expect(tr?.output?.type).toBe('error-text');
    // Escalated wording instructs the LLM to give up
    expect(tr?.output?.value).toContain('DO NOT retry');
    expect(tr?.output?.value).toContain('telegram_send_message');
    expect(tr?.output?.value).toContain('return_result');
  });

  it('injects an error-text tool_result when child failed (DelegationOutcome={error})', async () => {
    // Regression for live job `56a3a1b5` (2026-05-17): Conciergus delegated
    // to Summarizus, child failed at turn 5 with "Retry exhausted", the parent
    // died silently with `child_failed:...` and the user got NO Telegram
    // message back after 8 minutes of work.
    //
    // The fix: pass `{error}` to resumeDelegated so the parent's LLM receives
    // an `error-text` tool_result and can react (notify the user via
    // telegram_send_message, try another sub-agent, return_result blocked).
    const { entityId, orchId } = await seedContext(db);
    const toolUseId = 'tu_resume_fail_001';
    const childJob = await seedChildJob(db, entityId, orchId);
    const parentJob = await seedParentJob(db, entityId, orchId, toolUseId, childJob.id);

    await resumeDelegated(
      parentJob.id as JobId,
      childJob.id as JobId,
      { error: 'Retry exhausted after 4 attempts; last: TimeoutError: signal timed out' },
      db,
    );

    const [updatedParent] = await db
      .select({
        messages: agentJobs.messages,
        status: agentJobs.status,
        chainCount: agentJobs.chainCount,
      })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));

    // Parent is back in flight and the anti-loop counter advanced.
    expect(updatedParent?.status).toBe('pending');
    expect(updatedParent?.chainCount).toBeGreaterThanOrEqual(1);

    // The injected tool_result must carry `error-text` (AI SDK v6 discriminated
    // union) so the LLM treats the result as a tool failure and reasons over it.
    const msgs = updatedParent?.messages as Array<{
      role: string;
      content: Array<{
        type: string;
        toolCallId?: string;
        toolName?: string;
        output?: { type: string; value: string };
      }>;
    }>;
    const last = msgs[msgs.length - 1];
    expect(last?.role).toBe('tool');
    const tr = last?.content.find((c) => c.type === 'tool-result' && c.toolCallId === toolUseId);
    expect(tr?.output?.type).toBe('error-text');
    expect(tr?.output?.value).toContain('Delegation failed');
    expect(tr?.output?.value).toContain('Retry exhausted');
  });

  it('throws OrchestrationError if parent not found', async () => {
    await expect(
      resumeDelegated(
        '00000000-0000-0000-0000-000000000001' as JobId,
        '00000000-0000-0000-0000-000000000002' as JobId,
        'result',
        db,
      ),
    ).rejects.toThrow(OrchestrationError);
  });

  it('throws OrchestrationError if parent is not awaiting_delegation', async () => {
    const { entityId, orchId } = await seedContext(db);
    // Create a job that is NOT awaiting_delegation
    const [job] = await db
      .insert(agentJobs)
      .values({
        entityId,
        agentId: orchId,
        channel: 'api',
        task: 'processing job',
        status: 'processing', // wrong status
        pendingDelegation: { toolUseId: 'tu_bad', subJobId: 'some-id', type: 'single' },
      })
      .returning();

    await expect(
      resumeDelegated(job!.id as JobId, 'some-child-id' as JobId, 'result', db),
    ).rejects.toThrow(OrchestrationError);
  });
});
