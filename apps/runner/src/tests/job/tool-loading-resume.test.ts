// tool-loading-resume.test.ts — a tool a job loaded stays offered, whatever
// happens to the job afterwards (#612, review pass 1).
//
// A job's loaded tools are part of its state. Each case below loads a tool the
// job never calls directly (so only the load can explain its presence), then
// puts the job through one event that rebuilds or rewrites what the runner
// reads, and checks the NEXT request still carries the tool's schema:
//   - a name written with spaces around it (the loader accepts it);
//   - context compaction, which elides a large tool-call input;
//   - an approval that suspends the job, then its resume;
//   - a delegation that suspends the job, then its return.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { _setMasterKeyForTests } from '@nodal-agents/secrets';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentAssignments, agentJobs, agents, approvalRequests, and, eq } from '@nodal-agents/db';
import type { JobId } from '@nodal-agents/orchestration';
import { executeJob } from '../../job/execute.ts';
import { resolveApprovalDecision } from '../../approvals/resolve.ts';
import {
  jobRow,
  lastResult,
  makeDeps,
  offered,
  scriptProvider,
  seedJob,
  testEnv,
  toolResults,
} from './tool-loading-harness.ts';

// Provider calls leave through packages/llm's own transport (#609), not the
// global fetch. Routed back to it here, so the harness's stub is still the
// fetch boundary and nothing leaves the machine. (vi.mock is hoisted per test
// file: it cannot live in the shared harness.)
vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

let db: TestDb;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  const result = await spinUpTestDb();
  db = result.db;
});

const savedEnv = { ...process.env };
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...savedEnv };
});

describe('a loaded tool stays offered across the life of its job @cap:assigner-outils/moteur', () => {
  it('a name with spaces around it is loaded, and its schema is sent on the next turn', async () => {
    const { jobId } = await seedJob(db, { model: 'openai/gpt-5.6-sol', role: 'orchestrator' });
    const bodies = scriptProvider([
      { calls: [{ name: 'load_tools', args: { names: ['  list_models '] } }] },
    ]);
    await executeJob(jobId as JobId, makeDeps(db));

    const [first, second] = bodies;
    expect(lastResult(second!)).toMatchObject({ loaded: ['list_models'], notHeld: [] });
    // What the result says is what is sent.
    expect(offered(second!)).toEqual([...offered(first!), 'list_models']);
  });

  it('compaction elides the large input of the load, and the schema is still sent', async () => {
    // Compact at every turn, keeping only the last tool message.
    process.env['LLM_COMPACTION_TOKENS'] = '5';
    process.env['LLM_COMPACTION_KEEP_TURNS'] = '1';
    const { jobId } = await seedJob(db, { model: 'openai/gpt-5.6-sol', role: 'orchestrator' });
    const bodies = scriptProvider([
      {
        calls: [
          {
            name: 'load_tools',
            // A stated reason long enough for compaction to elide the input.
            args: { names: ['list_models'], purpose: 'Need the model list. '.repeat(150) },
          },
        ],
      },
      { calls: [{ name: 'skill_view', args: { slug: 'none-a' } }] },
      { calls: [{ name: 'skill_view', args: { slug: 'none-b' } }] },
    ]);
    await executeJob(jobId as JobId, makeDeps(db));

    const last = bodies[3]!;
    // The load's input is gone from what the provider receives…
    expect(JSON.stringify(last.messages)).toContain('tool-call arguments elided');
    expect(JSON.stringify(last.messages)).not.toContain('Need the model list.');
    // …and the tool it loaded is still offered.
    expect(offered(last)).toContain('list_models');
    expect(offered(last)).toEqual(offered(bodies[1]!));
  });

  it('an approval suspends the job; on resume the loaded tools are still offered', async () => {
    const { jobId, agentSlug } = await seedJob(db, {
      model: 'openai/gpt-5.6-sol',
      role: 'orchestrator',
      root: true,
      autonomy: 'propose_confirm',
    });
    const bodies = scriptProvider([
      { calls: [{ name: 'load_tools', args: { names: ['list_models', 'create_schedule'] } }] },
      {
        calls: [
          {
            name: 'create_schedule',
            args: {
              agentSlug,
              name: 'Morning digest',
              atTimes: ['09:00'],
              task: 'Send the morning digest.',
              purpose: 'The owner asked for a daily digest at 9.',
            },
          },
        ],
      },
    ]);
    const deps = makeDeps(db);
    const suspended = await executeJob(jobId as JobId, deps, testEnv);
    expect(suspended.status).toBe('awaiting_approval');
    const beforeSuspend = offered(bodies[1]!);

    const [pending] = await db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.jobId, jobId), eq(approvalRequests.status, 'pending')));
    expect(pending?.toolName).toBe('create_schedule');
    await db.update(agentJobs).set({ status: 'awaiting_approval' }).where(eq(agentJobs.id, jobId));
    const resolved = await resolveApprovalDecision(deps, testEnv, {
      approvalRequestId: pending!.id,
      decision: 'approve',
      resolvedBy: 'api',
    });
    expect(resolved.ok).toBe(true);
    await executeJob(jobId as JobId, deps, testEnv);

    const resumed = bodies[2]!;
    expect(offered(resumed)).toEqual(beforeSuspend);
    expect(offered(resumed)).toEqual(expect.arrayContaining(['list_models', 'create_schedule']));
  });

  it('a delegation suspends the job; on its return the loaded tools are still offered', async () => {
    const { jobId, entityId, agentId, keyId } = await seedJob(db, {
      model: 'openai/gpt-5.6-sol',
      role: 'orchestrator',
    });
    const [child] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'Helper',
        slug: `helper-${randomUUID().slice(0, 6)}`,
        personality: 'You help.',
        role: 'agent',
        llmKeyId: keyId,
        model: 'openai/gpt-5.6-sol',
      })
      .returning();
    await db
      .insert(agentAssignments)
      .values({ orchestratorId: agentId, subAgentId: child!.id, entityId });
    const assignTool = `assign_${child!.slug.replace(/-/g, '_')}`;

    const bodies = scriptProvider([
      { calls: [{ name: 'load_tools', args: { names: ['list_models'] } }] },
      { calls: [{ name: assignTool, args: { task: 'Help with this.' } }] },
    ]);
    // The delegation suspends the parent, runs the child (its own job, its own
    // requests), and resumes the parent with the child's result.
    await executeJob(jobId as JobId, makeDeps(db), testEnv);
    const beforeSuspend = offered(bodies[1]!);
    expect(beforeSuspend).toContain('list_models');

    const [childJob] = await db.select().from(agentJobs).where(eq(agentJobs.parentJobId, jobId));
    expect(childJob?.status).toBe('completed');
    // The child is another job: it has its own tool list, not the parent's loads.
    const childBodies = bodies.slice(2).filter((b) => !offered(b).includes(assignTool));
    expect(childBodies.length).toBeGreaterThan(0);
    for (const b of childBodies) expect(offered(b)).not.toContain('list_models');

    const returned = bodies.slice(2).find((b) => offered(b).includes(assignTool));
    expect(returned, 'the parent asked the model again after the return').toBeDefined();
    expect(toolResults(returned!).at(-1) ?? '').toContain('completed');
    expect(offered(returned!)).toEqual(beforeSuspend);
    expect((await jobRow(db, jobId)).error ?? '').not.toMatch(/whitelist_violation/);
  });
});
