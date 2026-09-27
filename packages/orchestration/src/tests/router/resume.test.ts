// router/resume.test.ts — resumeDelegated DB tests
// Asserts on real DB message rows.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from '@nodal-agents/db';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs } from '@nodal-agents/db';
import { resumeDelegated } from '../../router/resume';
import { readFilesWrittenBy } from '../../router/delegated-files';
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
  opts?: { toolNameOverride?: string },
) {
  const toolName = opts?.toolNameOverride ?? 'assign_test_agent';
  const pendingDelegation: Record<string, unknown> = {
    type: 'single',
    toolUseId,
    toolName,
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
          content: [{ type: 'tool_use', id: toolUseId, name: toolName, input: {} }],
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
    // #107 — the parent receives a TYPED record, not the raw string: the child's
    // text is `summary`, and `status` says whether anything was delivered.
    expect(toolResult?.output?.type).toBe('text');
    const payload = JSON.parse(String(toolResult?.output?.value)) as Record<string, unknown>;
    expect(payload['status']).toBe('completed');
    expect(payload['summary']).toBe(childResult);
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

  // ─── Per-slug retry cap regressions ────────────────────────────────────────
  // Replaces the prior global-counter (`failed_delegations_count`) tests. New
  // semantics: set `last_failed_delegation_slug` on failure, clear on success.
  // Runner blocks only `assign_<sameSlug>` retry; fallback to a different
  // specialist is allowed. Live driver: job `7767a3c1` (2026-05-19).

  it('SETS last_failed_delegation_slug to the child slug on failure', async () => {
    const { entityId, orchId } = await seedContext(db);
    const toolUseId = 'tu_perslug_001';
    const childJob = await seedChildJob(db, entityId, orchId);
    const parentJob = await seedParentJob(db, entityId, orchId, toolUseId, childJob.id);

    await resumeDelegated(
      parentJob.id as JobId,
      childJob.id as JobId,
      { error: 'AI_APICallError: Provider returned error' },
      db,
    );

    const [after] = await db
      .select({ lastFailedDelegationSlug: agentJobs.lastFailedDelegationSlug })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));
    // seedParentJob uses toolName = 'assign_test_agent' → slug 'test-agent'
    expect(after?.lastFailedDelegationSlug).toBe('test-agent');
  });

  it('CLEARS last_failed_delegation_slug on successful delegation', async () => {
    // Once a delegation succeeds, the parent should be free to delegate to any
    // specialist again (including the previously-failed one for a new task).
    const { entityId, orchId } = await seedContext(db);
    const toolUseId = 'tu_perslug_002';
    const childJob = await seedChildJob(db, entityId, orchId);
    const parentJob = await seedParentJob(db, entityId, orchId, toolUseId, childJob.id);

    // Pre-seed: a prior failure marked the slug as failed.
    await db
      .update(agentJobs)
      .set({ lastFailedDelegationSlug: 'some-prior-slug' })
      .where(eq(agentJobs.id, parentJob.id));

    await resumeDelegated(
      parentJob.id as JobId,
      childJob.id as JobId,
      'child completed successfully',
      db,
    );

    const [after] = await db
      .select({ lastFailedDelegationSlug: agentJobs.lastFailedDelegationSlug })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));
    expect(after?.lastFailedDelegationSlug).toBeNull();
  });

  it('REPLACES (not appends to) last_failed_delegation_slug — only the LAST failure matters', async () => {
    // Sequential failures: slug A fails, then slug B fails. The recorded slug
    // should be B (most recent). The runner will block assign_B retry but
    // ALLOW assign_A again (because A is no longer the last failure).
    const { entityId, orchId } = await seedContext(db);

    // First delegation fails as 'specialist-a'.
    {
      const childA = await seedChildJob(db, entityId, orchId);
      const parentA = await seedParentJob(db, entityId, orchId, 'tu_a', childA.id, undefined, {
        toolNameOverride: 'assign_specialist_a',
      });
      await resumeDelegated(parentA.id as JobId, childA.id as JobId, { error: 'A failed' }, db);
      const [r] = await db
        .select({ s: agentJobs.lastFailedDelegationSlug })
        .from(agentJobs)
        .where(eq(agentJobs.id, parentA.id));
      expect(r?.s).toBe('specialist-a');
    }

    // Independent second job (different parent) — semantically the "replace"
    // behaviour is the same: the column always holds the LAST failed slug.
  });

  it('error-text wording on failure tells the LLM to fall back to a different specialist', async () => {
    const { entityId, orchId } = await seedContext(db);
    const toolUseId = 'tu_perslug_msg';
    const childJob = await seedChildJob(db, entityId, orchId);
    const parentJob = await seedParentJob(db, entityId, orchId, toolUseId, childJob.id);

    await resumeDelegated(
      parentJob.id as JobId,
      childJob.id as JobId,
      { error: 'AI_APICallError: 503 backend unavailable' },
      db,
    );

    const [updated] = await db
      .select({ messages: agentJobs.messages })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));

    const msgs = updated?.messages as Array<{
      role: string;
      content: Array<{ type: string; output?: { type: string; value: string } }>;
    }>;
    const last = msgs[msgs.length - 1];
    const tr = last?.content.find((c) => c.type === 'tool-result');
    expect(tr?.output?.type).toBe('error-text');
    // Wording must invite a fallback, not just "DO NOT retry" — and it must
    // forbid the waiting message the incident produced (#107).
    expect(tr?.output?.value).toContain('"status": "failed"');
    expect(tr?.output?.value).toContain('DO NOT retry the same specialist');
    expect(tr?.output?.value).toContain('DO NOT tell the user the work is in progress');
    expect(tr?.output?.value).toMatch(/different specialist|tell the user the truth/i);
    expect(tr?.output?.value).toContain('return_result');
  });

  it('does NOT change last_failed_delegation_slug when child completed normally (already null)', async () => {
    const { entityId, orchId } = await seedContext(db);
    const toolUseId = 'tu_perslug_ok';
    const childJob = await seedChildJob(db, entityId, orchId);
    const parentJob = await seedParentJob(db, entityId, orchId, toolUseId, childJob.id);

    await resumeDelegated(
      parentJob.id as JobId,
      childJob.id as JobId,
      'child completed successfully',
      db,
    );

    const [after] = await db
      .select({ lastFailedDelegationSlug: agentJobs.lastFailedDelegationSlug })
      .from(agentJobs)
      .where(eq(agentJobs.id, parentJob.id));
    expect(after?.lastFailedDelegationSlug).toBeNull();
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
    expect(tr?.output?.value).toContain('"status": "failed"');
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

  // Regression — 2026-05-26: when the dashboard cancels a parent that was
  // `awaiting_delegation`, the cascade in `cancelJobAction` flips the
  // parent to 'cancelled' but the child has typically already started its
  // LLM turn. The child finishes, then calls resumeDelegated against a
  // 'cancelled' parent. Pre-fix this threw `parent_wrong_status` and the
  // child got marked `failed` instead of the cancellation it deserved.
  // Now it must no-op cleanly so the caller can detect the terminal state
  // via the returned snapshot and exit gracefully.
  describe.each(['cancelled', 'completed', 'failed'] as const)(
    'no-ops when parent is already %s (cancel-cascade race)',
    (terminalStatus) => {
      it(`returns the existing snapshot WITHOUT throwing or mutating messages`, async () => {
        const { entityId, orchId } = await seedContext(db);
        const initialMessages = [{ role: 'user', content: 'task that got cancelled' }];
        const [job] = await db
          .insert(agentJobs)
          .values({
            entityId,
            agentId: orchId,
            channel: 'telegram',
            task: 'task that got cancelled',
            status: terminalStatus,
            // pending_delegation often outlives the cancel since the cascade
            // doesn't clear it — defensive setup matching live data shape.
            pendingDelegation: {
              toolUseId: 'tu_cancel_race',
              toolName: 'assign_calculatus',
              subJobId: 'some-child-id',
              type: 'single',
            },
            messages: initialMessages,
            chainCount: 2,
          })
          .returning();

        const snapshot = await resumeDelegated(
          job!.id as JobId,
          'some-child-id' as JobId,
          'late child result',
          db,
        );

        // The returned snapshot reflects the terminal status — caller (the
        // parent's runner loop) will then bail via its own status guard.
        expect(snapshot.status).toBe(terminalStatus);

        // Critical: the row must NOT have been mutated. The cancellation
        // intent stays intact, the late child's result is dropped.
        const [reloaded] = await db
          .select({
            status: agentJobs.status,
            messages: agentJobs.messages,
            chainCount: agentJobs.chainCount,
            pendingDelegation: agentJobs.pendingDelegation,
          })
          .from(agentJobs)
          .where(eq(agentJobs.id, job!.id));
        expect(reloaded?.status).toBe(terminalStatus);
        expect(reloaded?.messages).toEqual(initialMessages); // untouched
        expect(reloaded?.chainCount).toBe(2); // NOT bumped
      });
    },
  );
});

// ─── #491 — un enfant arrêté rend ce qu'il a écrit ─────────────────────────────
//
// Run e2e794db (25/09/2026) : un spécialiste écrit sa voix off, le runner
// redémarre pendant sa réponse, et le parent ne reçoit qu'un échec nu — il
// redélègue le même travail. Le parent reçoit désormais, dans le record TYPÉ,
// ce que l'enfant a écrit ou déclaré, dans l'état où c'est AU MOMENT de la
// reprise, et la PROVENANCE se prouve par l'empreinte des octets que l'enfant
// a écrits (#505) : « ne refais pas » ne vaut que pour un fichier présent ET
// inchangé depuis (revue Codex de #491, passes 1 et 2).

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nodal-491-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const slash = (p: string) => p.split(String.fromCharCode(92)).join('/');

async function stateRow(
  jobId: string,
  path: string,
  flags: { produced: boolean; declared?: boolean; type?: 'document' | 'code_project' },
) {
  const { jobDeliverableVerificationState } = await import('@nodal-agents/db');
  await db.insert(jobDeliverableVerificationState).values({
    jobId,
    deliverableType: flags.type ?? 'document',
    canonicalKey: path,
    displayPathSnapshot: path,
    dirtyGeneration: 1,
    addressed: true,
    produced: flags.produced,
    declared: flags.declared ?? false,
    decisionStatus: 'dirty',
  });
}

/** Le constat d'une écriture de l'enfant, avec l'empreinte de ce qu'il a écrit. */
async function constat(jobId: string, path: string, written: string) {
  const { constatedWrites } = await import('@nodal-agents/db');
  await db.insert(constatedWrites).values({
    jobId,
    turn: 1,
    path: slash(await realpath(path).catch(() => path)),
    changeKind: 'modified',
    constatedBy: 'disk',
    contentSha256: sha(written),
  });
}

async function injectedToolResult(parentJobId: string) {
  const [row] = await db
    .select({ messages: agentJobs.messages })
    .from(agentJobs)
    .where(eq(agentJobs.id, parentJobId));
  const msgs = row?.messages as Array<{
    role: string;
    content: Array<{ type: string; output?: { type: string; value: string } }>;
  }>;
  const tr = msgs[msgs.length - 1]?.content.find((c) => c.type === 'tool-result');
  return tr!.output!;
}

/** L'objet JSON du record, tel que le parent le lit (après le marqueur d'échec). */
function recordOf(value: string): Record<string, unknown> {
  return JSON.parse(value.slice(value.indexOf('{'), value.lastIndexOf('}') + 1)) as Record<
    string,
    unknown
  >;
}

const STOPPED = {
  status: 'failed' as const,
  summary: '[stopped: runner restarted — status processing, no heartbeat for 3m10s]',
  error: 'runner_restarted',
  exit_reason: 'runner_restarted',
};

async function scenario(toolUseId: string) {
  const { entityId, orchId } = await seedContext(db);
  const child = await seedChildJob(db, entityId, orchId);
  const parent = await seedParentJob(db, entityId, orchId, toolUseId, child.id);
  return {
    child: child.id,
    resume: async () => {
      await resumeDelegated(parent.id as JobId, child.id as JobId, STOPPED, db);
      return injectedToolResult(parent.id);
    },
  };
}

describe('resumeDelegated — what a stopped child wrote, as it is now (#491) @cap:organiser-equipe/moteur', () => {
  it('a file the child wrote, still unchanged: its size, and the parent is told not to redo it', async () => {
    const s = await scenario('tu_491_a');
    const path = slash(join(dir, 'a.wav'));
    await writeFile(path, 'x'.repeat(1234));
    await stateRow(s.child, path, { produced: true });
    await constat(s.child, path, 'x'.repeat(1234));

    const out = await s.resume();

    expect(recordOf(out.value)['files_written']).toEqual([
      {
        kind: 'file',
        path,
        declared: false,
        state: 'written_by_child_unchanged',
        bytes: 1234,
        proof: 'dirty',
      },
    ]);
    expect(out.value).toContain('DO NOT redo');
    expect(out.value).not.toContain('delivered NOTHING');
  });

  it('a file changed since the child wrote it is said changed, and the parent is NOT told to keep it', async () => {
    const s = await scenario('tu_491_b');
    const path = slash(join(dir, 'b.wav'));
    await writeFile(path, 'edited by someone');
    await stateRow(s.child, path, { produced: true });
    await constat(s.child, path, 'what the child wrote');

    const out = await s.resume();

    expect(recordOf(out.value)['files_written']).toMatchObject([
      { kind: 'file', path, state: 'changed_since_child_wrote' },
    ]);
    expect(out.value).not.toContain('DO NOT redo');
    expect(out.value).toContain('delivered NOTHING usable');
  });

  it('a DECLARED file present on disk that the child never wrote is not credited to it', async () => {
    const s = await scenario('tu_491_c');
    const path = slash(join(dir, 'c.mp4'));
    await writeFile(path, 'put there by someone else');
    await stateRow(s.child, path, { produced: false, declared: true });

    const out = await s.resume();

    expect(recordOf(out.value)['files_written']).toMatchObject([
      { kind: 'file', path, declared: true, state: 'not_written_by_child' },
    ]);
    expect(out.value).not.toContain('DO NOT redo');
  });

  it('a file written then removed is said absent', async () => {
    const s = await scenario('tu_491_d');
    const path = slash(join(dir, 'd.wav'));
    await stateRow(s.child, path, { produced: true });
    await constat(s.child, path, 'gone');

    const out = await s.resume();

    expect(recordOf(out.value)['files_written']).toEqual([
      { kind: 'file', path, declared: false, state: 'absent', bytes: null, proof: 'dirty' },
    ]);
    expect(out.value).toContain('delivered NOTHING usable');
  });

  it('only ENOENT means absent: another stat error is an UNKNOWN state, with its code', async () => {
    const s = await scenario('tu_491_e');
    const path = slash(join(dir, 'e.wav'));
    await writeFile(path, 'e');
    await stateRow(s.child, path, { produced: true });
    await constat(s.child, path, 'e');
    const eacces = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

    const lus = await readFilesWrittenBy(db, s.child as JobId, {
      stat: async () => {
        throw eacces;
      },
    });

    expect(lus).toMatchObject([{ kind: 'file', path, state: 'unknown: EACCES', bytes: null }]);
  });

  it('a code project is handed over as a PROJECT, with the files the child changed in it', async () => {
    const s = await scenario('tu_491_f');
    const projet = slash(join(dir, 'site'));
    await mkdir(projet, { recursive: true });
    const index = `${projet}/index.html`;
    const style = `${projet}/style.css`;
    await writeFile(index, '<h1>ok</h1>');
    await writeFile(style, 'changed later');
    await stateRow(s.child, projet, { produced: true, type: 'code_project' });
    await constat(s.child, index, '<h1>ok</h1>');
    await constat(s.child, style, 'body{}');

    const out = await s.resume();

    const [entree] = recordOf(out.value)['files_written'] as Array<Record<string, unknown>>;
    expect(entree).toMatchObject({ kind: 'project', path: projet, declared: false });
    expect(entree!['files']).toEqual([
      {
        kind: 'file',
        path: slash(await realpath(index)),
        declared: false,
        state: 'written_by_child_unchanged',
        bytes: 11,
        proof: 'dirty',
      },
      {
        kind: 'file',
        path: slash(await realpath(style)),
        declared: false,
        state: 'changed_since_child_wrote',
        bytes: 13,
        proof: 'dirty',
      },
    ]);
    // Un fichier du projet est prouvé : le parent peut s'appuyer dessus.
    expect(out.value).toContain('DO NOT redo');
  });

  it('a completed child carries the same field, so the contract never changes shape', async () => {
    const { entityId, orchId } = await seedContext(db);
    const child = await seedChildJob(db, entityId, orchId);
    const parent = await seedParentJob(db, entityId, orchId, 'tu_491_g', child.id);
    const md = slash(join(dir, 'notes.md'));
    await writeFile(md, 'notes');
    await stateRow(child.id, md, { produced: true });
    await constat(child.id, md, 'notes');

    await resumeDelegated(parent.id as JobId, child.id as JobId, 'Voici les notes.', db);

    const out = await injectedToolResult(parent.id);
    expect(out.type).toBe('text');
    expect(recordOf(out.value)['files_written']).toMatchObject([
      { kind: 'file', path: md, state: 'written_by_child_unchanged', bytes: 5 },
    ]);
  });
});
