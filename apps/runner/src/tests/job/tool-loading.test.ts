// tool-loading.test.ts — a job sends the schemas of its eager tools, then of the
// tools it loads, and can call every tool of its whitelist at every turn (#612).
//
// Proven on the REAL path: executeJob, a real test database, the REAL LLM
// client built from the agent's key, and the HTTP body read at the fetch
// boundary — what the provider actually receives. The model is scripted: each
// request is answered with the next scripted reply (tool calls or text).
//
// What is proven, for more than the ticket's scenario:
//   - the first request carries the eager schemas and `load_tools`, and NOT a
//     deferred tool the job holds; the prompt names that tool in its index;
//   - after `load_tools`, the next request carries its schema, appended AFTER
//     the list sent before (the prefix does not move);
//   - a direct call to a deferred tool of the whitelist runs — builtin
//     (`list_schedules`) and meta-tool (`create_schedule`, a DB row) — and its
//     schema is sent from then on;
//   - a tool outside the whitelist stays refused, directly and via load_tools;
//   - for an orchestrator and a worker, on two models.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { _setMasterKeyForTests } from '@nodal-agents/secrets';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentSchedules, eq } from '@nodal-agents/db';
import type { JobId } from '@nodal-agents/orchestration';
import { executeJob } from '../../job/execute.ts';
import { ACTION_RECHECK } from '../../llm/action-recheck.ts';
import {
  type Body,
  type ScriptedReply,
  jobRow as readJobRow,
  lastMessageText,
  lastResult,
  makeDeps,
  offered,
  scriptProvider,
  seedJob,
  systemOf,
  toolResults,
} from './tool-loading-harness.ts';

let db: TestDb;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  const result = await spinUpTestDb();
  db = result.db;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One job, run to its end against the script. */
async function runJob(opts: {
  model: string;
  role: 'orchestrator' | 'agent';
  root?: boolean;
  /** The replies, or a function of the agent's slug that returns them. */
  script: ScriptedReply[] | ((agentSlug: string) => ScriptedReply[]);
}): Promise<{ bodies: Body[]; jobId: string; entityId: string }> {
  const seeded = await seedJob(db, opts);
  const bodies = scriptProvider(
    typeof opts.script === 'function' ? opts.script(seeded.agentSlug) : opts.script,
  );
  await executeJob(seeded.jobId as JobId, makeDeps(db));
  return { bodies, jobId: seeded.jobId, entityId: seeded.entityId };
}

const jobRow = (jobId: string) => readJobRow(db, jobId);

const MODELS = ['openai/gpt-5.6-sol', 'xiaomi/mimo-v2.6-pro'] as const;
const ROLES = ['orchestrator', 'agent'] as const;

describe('a job reads the schemas it needs and keeps its whole whitelist @cap:assigner-outils/moteur', () => {
  for (const model of MODELS) {
    for (const role of ROLES) {
      it(`${role} on ${model}: eager schemas first, a loaded schema appended after load_tools`, async () => {
        const { bodies, jobId } = await runJob({
          model,
          role,
          script: [
            { calls: [{ name: 'load_tools', args: { names: ['list_schedules'] } }] },
            { calls: [{ name: 'list_schedules', args: {} }] },
          ],
        });

        expect(bodies.length).toBeGreaterThanOrEqual(3);
        const [first, second, third] = bodies as [Body, Body, Body];

        // Turn 1: the eager schemas and the loader — not the deferred tool.
        expect(offered(first)).toContain('return_result');
        expect(offered(first)).toContain('load_tools');
        expect(offered(first)).not.toContain('list_schedules');
        // …which the prompt names in its index, in place of the old list.
        expect(systemOf(first)).toContain('## Tools on demand');
        expect(systemOf(first)).toContain('- `list_schedules`: ');
        expect(systemOf(first)).not.toContain('## Built-in capabilities');

        // Turn 2: the loaded schema is appended; what was sent before is untouched.
        expect(offered(second)).toEqual([...offered(first), 'list_schedules']);
        expect(lastResult(second)).toMatchObject({ loaded: ['list_schedules'], notHeld: [] });

        // Turn 3: the call ran and returned its real output.
        const listed = toolResults(third).at(-1) ?? '';
        expect(listed).toContain('"schedules"');
        expect(listed).not.toMatch(/unavailable|not available/i);
        expect(offered(third)).toEqual(offered(second));

        // The whole whitelist is still recorded for the job, loader included.
        const row = await jobRow(jobId);
        expect(row.systemPromptTools).toEqual(
          expect.arrayContaining(['list_schedules', 'load_tools', 'return_result']),
        );
        expect(row.error ?? '').not.toMatch(/whitelist_violation/);
      });
    }
  }

  it('a direct call to a deferred tool of the whitelist runs, without load_tools first', async () => {
    const { bodies, jobId } = await runJob({
      model: 'xiaomi/mimo-v2.6-pro',
      role: 'orchestrator',
      script: [{ calls: [{ name: 'list_schedules', args: {} }] }],
    });

    const [first, second] = bodies as [Body, Body];
    expect(offered(first)).not.toContain('list_schedules');
    const result = toolResults(second).at(-1) ?? '';
    expect(result).toContain('"schedules"');
    expect(result).not.toMatch(/unavailable|not available/i);
    // Called once, sent from then on: the transcript names it.
    expect(offered(second)).toEqual([...offered(first), 'list_schedules']);
    expect((await jobRow(jobId)).error ?? '').not.toMatch(/whitelist_violation/);
  });

  it("the root's first direct create_schedule, a deferred meta-tool, creates the schedule", async () => {
    const { bodies, jobId, entityId } = await runJob({
      model: 'openai/gpt-5.6-sol',
      role: 'orchestrator',
      root: true,
      script: (agentSlug) => [
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
      ],
    });

    const [first] = bodies as [Body];
    expect(offered(first)).not.toContain('create_schedule');
    expect(systemOf(first)).toContain('- `create_schedule`: ');

    const row = await jobRow(jobId);
    expect(row.error ?? '').not.toMatch(/whitelist_violation/);
    const schedules = await db
      .select()
      .from(agentSchedules)
      .where(eq(agentSchedules.entityId, entityId));
    expect(schedules.map((s) => s.name)).toEqual(['Morning digest']);
  });

  it('a direct call with guessed arguments gets a readable tool error, and the schema from then on', async () => {
    const { bodies, jobId, entityId } = await runJob({
      model: 'openai/gpt-5.6-sol',
      role: 'orchestrator',
      root: true,
      script: [{ calls: [{ name: 'create_schedule', args: { when: 'tomorrow' } }] }],
    });

    const [first, second] = bodies as [Body, Body];
    expect(offered(first)).not.toContain('create_schedule');
    // The call reached the tool, which said what is wrong with its input…
    const result = toolResults(second).at(-1) ?? '';
    expect(result).toContain('invalid_input');
    expect(result).toContain('agentSlug');
    expect(result).not.toContain('is not available to you');
    // …and the model now reads the schema it lacked.
    expect(offered(second)).toEqual([...offered(first), 'create_schedule']);
    expect((await jobRow(jobId)).error ?? '').not.toMatch(/whitelist_violation/);
    const schedules = await db
      .select()
      .from(agentSchedules)
      .where(eq(agentSchedules.entityId, entityId));
    expect(schedules).toEqual([]);
  });

  it('a tool outside the whitelist stays refused, called directly or through load_tools', async () => {
    const { bodies, jobId } = await runJob({
      model: 'openai/gpt-5.6-sol',
      role: 'orchestrator',
      script: [
        { calls: [{ name: 'load_tools', args: { names: ['run_command'] } }] },
        { calls: [{ name: 'run_command', args: { command: 'echo hi' } }] },
      ],
    });

    const [first, second, third] = bodies as [Body, Body, Body];
    expect(systemOf(first)).not.toContain('`run_command`');
    // load_tools loads nothing it does not hold…
    expect(lastResult(second)).toMatchObject({ loaded: [], notHeld: ['run_command'] });
    expect(offered(second)).toEqual(offered(first));
    // …and the direct call is answered as unavailable, never run.
    expect(toolResults(third).at(-1) ?? '').toContain(
      'The tool \\"run_command\\" is not available to you.',
    );
    expect(offered(third)).not.toContain('run_command');
    // Never run, never offered for approval either.
    const row = await jobRow(jobId);
    expect(row.status).not.toBe('awaiting_approval');
  });

  // #604's action recheck re-asks the model with "the job's tools". It must be
  // the tools offered on THIS turn (eager + loaded + load_tools), never the
  // whole whitelist: otherwise every recheck would carry every schema again.
  it('the action recheck offers exactly the tools of its turn, loaded ones included', async () => {
    const { bodies } = await runJob({
      model: 'openai/gpt-5.6-sol',
      role: 'orchestrator',
      script: [
        { calls: [{ name: 'load_tools', args: { names: ['list_schedules'] } }] },
        { text: 'I will now list the schedules.' },
        { text: 'Nothing to run.' },
      ],
    });

    const recheck = bodies.find((b) => lastMessageText(b) === ACTION_RECHECK);
    expect(recheck, 'the prose turn was rechecked').toBeDefined();
    const turn = bodies[bodies.indexOf(recheck!) - 1]!;
    expect(offered(recheck!)).toEqual(offered(turn));
    expect(offered(recheck!)).toContain('list_schedules');
    expect(offered(recheck!)).toContain('load_tools');
    expect(offered(recheck!)).not.toContain('list_models');
  });
});
