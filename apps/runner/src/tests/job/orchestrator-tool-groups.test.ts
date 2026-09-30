// orchestrator-tool-groups.test.ts — an orchestrator holds the tools its owner
// switched on, like any agent (#636).
//
// The bug: the orchestrator branch of the job whitelist (execute.ts) never
// added the `requiredBuiltins` of the tool groups the agent holds. The Tools
// tab showed "Spreadsheet editing" ON for the root, the runner silently gave it
// no `xlsx_*`, and a spreadsheet request was delegated to an agent that
// scripted it in Python (bench trial 75bbf3d0). The mirror the roster reads
// (`resolveBuiltinToolNames`) copied the same omission.
//
// The general form: ONE list of tools for every agent. The orchestrator role
// ADDS delegation (when depth remains), it never removes anything. What is
// proven here, on the REAL path (executeJob, a real test database, the real
// LLM client, the HTTP body read at the fetch boundary):
//   - an orchestrator AND a worker holding spreadsheet-editing see xlsx_create
//     in their index, load it, and the call writes the workbook ON DISK;
//   - without the group, no xlsx tool anywhere;
//   - a worker's list is exactly what it was before (explicit, ordered);
//   - the mirror (resolveAgentToolNames) equals the runner's list, both roles,
//     several combinations of groups, with and without a team;
//   - a DELEGATED orchestrator loses dashboard_publish, like a delegated worker;
//   - on an Alfred-like root, the tool groups land in the deferred index: the
//     schemas sent on turn 1 are byte-identical with and without them.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _setMasterKeyForTests, encrypt } from '@nodal-agents/secrets';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentAssignments,
  agentJobs,
  agentSkillAssignments,
  agentSkills,
  agentWorkspaces,
  agents,
  entities,
  eq,
} from '@nodal-agents/db';
import {
  codeReviewSkill,
  codeTaskSkill,
  commandExecutionSkill,
  documentEditingSkill,
  officeEditingSkill,
  speechGenerationSkill,
  spreadsheetEditingSkill,
} from '@nodal-agents/catalog';
import type { SystemSkill } from '@nodal-agents/catalog';
import { resolveBuiltinToolNames } from '@nodal-agents/orchestration';
import type { JobId } from '@nodal-agents/orchestration';
import { executeJob } from '../../job/execute.ts';
import { resolveAgentToolNames } from '../../job/resolve-agent-tools.ts';
import {
  type Body,
  type ScriptedReply,
  jobRow as readJobRow,
  lastResult,
  makeDeps,
  offered,
  scriptProvider,
  seedJob,
  systemOf,
  toolResults,
} from './tool-loading-harness.ts';

// Provider calls leave through packages/llm's own transport (#609): routed back
// to the global fetch the harness stubs (vi.mock is hoisted per test file).
vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

const MODEL = 'openai/gpt-5.6-sol';
const XLSX: readonly string[] = spreadsheetEditingSkill.requiredBuiltins ?? [];

let db: TestDb;
let workDir: string;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  db = (await spinUpTestDb()).db;
  workDir = await mkdtemp(path.join(tmpdir(), 'nodal-636-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Switch a tool group on for an agent, as the Tools tab does: a skill row + its assignment. */
async function holdGroup(agentId: string, entityId: string, skill: SystemSkill): Promise<void> {
  const [row] = await db
    .insert(agentSkills)
    .values({
      entityId,
      slug: `${skill.slug}-${randomUUID().slice(0, 8)}`,
      name: `${skill.name} ${randomUUID().slice(0, 6)}`,
      description: skill.description,
      content: skill.content,
      requiredBuiltins: [...(skill.requiredBuiltins ?? [])],
    })
    .returning();
  if (!row) throw new Error('failed to seed the tool group');
  await db.insert(agentSkillAssignments).values({ entityId, agentId, skillId: row.id });
}

/** A worker on the orchestrator's team. */
async function addTeammate(orchestratorId: string, entityId: string): Promise<void> {
  const [w] = await db
    .insert(agents)
    .values({
      entityId,
      name: `Mate ${randomUUID().slice(0, 6)}`,
      slug: `mate-${randomUUID().slice(0, 8)}`,
      personality: 'A teammate.',
      role: 'agent',
      active: true,
    })
    .returning();
  if (!w) throw new Error('failed to seed the teammate');
  await db.insert(agentAssignments).values({ orchestratorId, subAgentId: w.id, entityId });
}

/** No approval card: the workspace is fully autonomous, without making the agent its root. */
async function fullyAutonomous(entityId: string): Promise<void> {
  await db
    .update(entities)
    .set({ rootGrants: { autonomy: 'fully_autonomous' } })
    .where(eq(entities.id, entityId));
}

async function run(jobId: string, script: ScriptedReply[]): Promise<Body[]> {
  const bodies = scriptProvider(script);
  await executeJob(jobId as JobId, makeDeps(db));
  return bodies;
}

const jobRow = (jobId: string) => readJobRow(db, jobId);

/** The system prompt as text, whether it is sent as a string or as parts. */
function systemText(body: Body): string {
  const content = body.messages.find((m) => m.role === 'system')?.content;
  if (Array.isArray(content)) {
    return content
      .map((p: { text?: unknown }) => (typeof p.text === 'string' ? p.text : ''))
      .join('');
  }
  return systemOf(body);
}

/** The prompt's deferred-tool index, heading included, up to the next section. */
function indexOf(body: Body): string {
  const sys = systemText(body);
  const start = sys.indexOf('## Tools on demand');
  if (start === -1) return '';
  const next = sys.indexOf('\n## ', start + 1);
  return sys.slice(start, next === -1 ? undefined : next);
}

describe('an orchestrator holds the tools its owner switched on @cap:assigner-outils/moteur', () => {
  for (const role of ['orchestrator', 'agent'] as const) {
    it(`${role} with spreadsheet-editing: xlsx_create is in the index, and the call writes the workbook on disk`, async () => {
      const seeded = await seedJob(db, { model: MODEL, role });
      await fullyAutonomous(seeded.entityId);
      const dir = path.join(workDir, `${role}-${randomUUID().slice(0, 6)}`);
      await mkdir(dir, { recursive: true });
      await db.insert(agentWorkspaces).values({
        entityId: seeded.entityId,
        agentId: seeded.agentId,
        label: 'work',
        path: dir,
      });
      await holdGroup(seeded.agentId, seeded.entityId, spreadsheetEditingSkill);

      const bodies = await run(seeded.jobId, [
        { calls: [{ name: 'load_tools', args: { names: ['xlsx_create'] } }] },
        { calls: [{ name: 'xlsx_create', args: { path: 'work/ventes-bench.xlsx' } }] },
      ]);
      const [first, second, third] = bodies as [Body, Body, Body];

      // Turn 1: held, indexed, not sent — deferred like any group tool.
      expect(indexOf(first)).toContain('- `xlsx_create`: ');
      expect(offered(first)).not.toContain('xlsx_create');
      // The loader loads it: the job holds it.
      expect(lastResult(second)).toMatchObject({ loaded: ['xlsx_create'], notHeld: [] });
      expect(offered(second)).toEqual([...offered(first), 'xlsx_create']);

      // The call ran, and the workbook exists on disk (a zip: "PK").
      const result = toolResults(third).at(-1) ?? '';
      expect(result).not.toMatch(/not available to you/);
      const bytes = await readFile(path.join(dir, 'ventes-bench.xlsx')).catch((err: unknown) => {
        throw new Error(`no workbook on disk (${String(err)}); the tool answered: ${result}`);
      });
      expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');

      const row = await jobRow(seeded.jobId);
      expect(row.systemPromptTools).toEqual(expect.arrayContaining([...XLSX]));
      expect(row.error ?? '').not.toMatch(/whitelist_violation/);
    });
  }

  it('the same orchestrator without the group holds no xlsx tool at all', async () => {
    const seeded = await seedJob(db, { model: MODEL, role: 'orchestrator' });
    await holdGroup(seeded.agentId, seeded.entityId, commandExecutionSkill);

    const bodies = await run(seeded.jobId, [
      { calls: [{ name: 'load_tools', args: { names: ['xlsx_create'] } }] },
    ]);
    const [first, second] = bodies as [Body, Body];

    expect(indexOf(first)).not.toContain('xlsx_');
    expect(lastResult(second)).toMatchObject({ loaded: [], notHeld: ['xlsx_create'] });
    const row = await jobRow(seeded.jobId);
    expect((row.systemPromptTools ?? []).filter((n) => n.startsWith('xlsx_'))).toEqual([]);
    // …while the group it DOES hold is there.
    expect(row.systemPromptTools).toContain('run_command');
  });
});

describe("a worker's list is exactly what it was @cap:assigner-outils/moteur", () => {
  // Written against origin/main a09d3a69, BEFORE the unification: the ordered
  // eager schemas of turn 1 and the recorded whitelist of a worker. The fix
  // must not move a single name.
  const WORKER_EAGER = [
    'return_result',
    'ask_user',
    'register_project',
    'skill_view',
    'list_schedules',
    'save_memory',
    'query_memory',
    'nodal_docs',
    'mark_memory_outdated',
    'web_search',
    'dashboard_publish',
    'file_read',
    'file_write',
    'file_edit',
    'file_list',
    'file_search',
    'load_tools',
  ];
  const WORKER_ALL = [
    ...WORKER_EAGER,
    'declare_verification',
    'list_models',
    'search_history',
    'mark_memory_helpful',
    ...XLSX,
    'run_command',
  ].sort();

  it('non-delegated worker with spreadsheet-editing + command-execution', async () => {
    const seeded = await seedJob(db, { model: MODEL, role: 'agent' });
    await holdGroup(seeded.agentId, seeded.entityId, spreadsheetEditingSkill);
    await holdGroup(seeded.agentId, seeded.entityId, commandExecutionSkill);

    const [first] = (await run(seeded.jobId, [])) as [Body];

    expect(offered(first)).toEqual(WORKER_EAGER);
    expect((await jobRow(seeded.jobId)).systemPromptTools).toEqual(WORKER_ALL);
  });

  it('delegated worker: the same list, without dashboard_publish', async () => {
    const seeded = await seedJob(db, { model: MODEL, role: 'agent' });
    await holdGroup(seeded.agentId, seeded.entityId, spreadsheetEditingSkill);
    await holdGroup(seeded.agentId, seeded.entityId, commandExecutionSkill);
    const childJobId = await delegatedJobFor(seeded.agentId, seeded.entityId, seeded.jobId);

    const [first] = (await run(childJobId, [])) as [Body];

    expect(offered(first)).toEqual(WORKER_EAGER.filter((n) => n !== 'dashboard_publish'));
    expect((await jobRow(childJobId)).systemPromptTools).toEqual(
      WORKER_ALL.filter((n) => n !== 'dashboard_publish'),
    );
  });
});

/** A job for `agentId` delegated by `parentJobId` (one hop down). */
async function delegatedJobFor(
  agentId: string,
  entityId: string,
  parentJobId: string,
): Promise<string> {
  await db.update(agentJobs).set({ status: 'completed' }).where(eq(agentJobs.id, parentJobId));
  const [child] = await db
    .insert(agentJobs)
    .values({
      entityId,
      agentId,
      channel: 'api',
      task: 'Do the delegated thing.',
      status: 'pending',
      messages: [],
      chainCount: 0,
      parentJobId,
      delegationDepth: 1,
    })
    .returning();
  if (!child) throw new Error('failed to seed the delegated job');
  return child.id;
}

describe('the mirror and the runner compute the same list @cap:assigner-outils/moteur', () => {
  const COMBINATIONS: Array<{ label: string; groups: SystemSkill[] }> = [
    { label: 'no group', groups: [] },
    { label: 'spreadsheet', groups: [spreadsheetEditingSkill] },
    { label: 'shell + speech', groups: [commandExecutionSkill, speechGenerationSkill] },
    {
      label: 'office + document + code-task + code-review',
      groups: [officeEditingSkill, documentEditingSkill, codeTaskSkill, codeReviewSkill],
    },
  ];
  const SHAPES = [
    { role: 'agent' as const, team: 0 },
    { role: 'orchestrator' as const, team: 0 },
    { role: 'orchestrator' as const, team: 2 },
  ];

  for (const { label, groups } of COMBINATIONS) {
    for (const { role, team } of SHAPES) {
      it(`${role} (team of ${team}), ${label}`, async () => {
        const seeded = await seedJob(db, { model: MODEL, role });
        for (const g of groups) await holdGroup(seeded.agentId, seeded.entityId, g);
        for (let i = 0; i < team; i++) await addTeammate(seeded.agentId, seeded.entityId);

        await run(seeded.jobId, []);
        const runner = (await jobRow(seeded.jobId)).systemPromptTools ?? [];

        const mirror = await resolveAgentToolNames(db, seeded.agentId);
        expect([...mirror, 'load_tools'].sort()).toEqual(runner);
        // The built-in half the roster reads is the same rule.
        const builtins = await resolveBuiltinToolNames(db, seeded.agentId);
        for (const n of builtins.names) expect(runner).toContain(n);
        for (const g of groups)
          for (const n of g.requiredBuiltins ?? []) expect(runner).toContain(n);
      });
    }
  }
});

describe('a delegated orchestrator delivers nothing itself @cap:assigner-outils/moteur', () => {
  it('holds its groups but not dashboard_publish; the same orchestrator top-level keeps it', async () => {
    const seeded = await seedJob(db, { model: MODEL, role: 'orchestrator' });
    await holdGroup(seeded.agentId, seeded.entityId, spreadsheetEditingSkill);
    await addTeammate(seeded.agentId, seeded.entityId);

    const [top] = (await run(seeded.jobId, [])) as [Body];
    expect(offered(top)).toContain('dashboard_publish');

    const childJobId = await delegatedJobFor(seeded.agentId, seeded.entityId, seeded.jobId);
    const [first] = (await run(childJobId, [])) as [Body];
    const row = await jobRow(childJobId);

    expect(offered(first)).not.toContain('dashboard_publish');
    expect(row.systemPromptTools).not.toContain('dashboard_publish');
    expect(row.systemPromptTools).toEqual(expect.arrayContaining([...XLSX]));
    // Depth remains (1 of 3): it still delegates.
    expect(offered(first).some((n) => n.startsWith('assign_'))).toBe(true);
  });
});

describe('an Alfred-like root: the groups land in the index, turn 1 does not grow @cap:assigner-outils/moteur', () => {
  /** A root with every grant, a Telegram bot, a team of ten; `groups` switched on. */
  async function alfredLike(groups: SystemSkill[]) {
    const seeded = await seedJob(db, { model: MODEL, role: 'orchestrator', root: true });
    await db
      .update(entities)
      .set({
        rootGrants: {
          createAgent: true,
          updateAgent: true,
          attachAgent: true,
          createSkill: true,
          updateSkill: true,
          assignSkill: true,
          createMcp: true,
          attachMcp: true,
          createConnector: true,
          attachConnector: true,
          manageSchedules: true,
          autonomy: 'fully_autonomous',
        },
      })
      .where(eq(entities.id, seeded.entityId));
    await db
      .update(agents)
      .set({ mayChangeTeam: true, telegramBotToken: encrypt('123456:test-token') })
      .where(eq(agents.id, seeded.agentId));
    for (let i = 0; i < 10; i++) await addTeammate(seeded.agentId, seeded.entityId);
    for (const g of groups) await holdGroup(seeded.agentId, seeded.entityId, g);
    const [first] = (await run(seeded.jobId, [])) as [Body];
    const row = await jobRow(seeded.jobId);
    return { first, allowed: row.systemPromptTools ?? [] };
  }

  it('spreadsheet + shell + speech: +18 allowed, same eager schemas, index grows', async () => {
    const without = await alfredLike([]);
    const withGroups = await alfredLike([
      spreadsheetEditingSkill,
      commandExecutionSkill,
      speechGenerationSkill,
    ]);

    expect(withGroups.allowed.length - without.allowed.length).toBe(XLSX.length + 2);
    for (const n of [...XLSX, 'run_command', 'generate_speech']) {
      expect(withGroups.allowed).toContain(n);
      expect(indexOf(withGroups.first)).toContain(`- \`${n}\`: `);
    }
    // Turn 1 carries the same schemas, byte for byte, apart from the ten
    // teammates' random names and slugs (two seeds): compared with those masked.
    const masked = (b: Body) =>
      JSON.stringify(b.tools ?? []).replace(/[Mm]ate[-_ ][0-9a-f]{6,8}/g, 'mate');
    expect(masked(withGroups.first)).toBe(masked(without.first));
    // The groups' 18 tools are indexed, not sent: the index grows instead.
    expect(indexOf(withGroups.first).length).toBeGreaterThan(indexOf(without.first).length);
  });
});
