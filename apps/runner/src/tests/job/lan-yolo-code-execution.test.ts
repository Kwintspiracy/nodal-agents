// lan-yolo-code-execution.test.ts — Fix #6 (audit finding EX-1 / plan item #6):
// the workspace Yolo master-switch (`entities.lan_command_yolo`) must gate ALL
// code-execution builtins — run_command, run_skill_script, skill_file_write —
// not just run_command. Before the fix, run_skill_script and skill_file_write
// had no matched approval rule on LAN, so the autonomy relaxation in
// executeTool (`destructive_gate`/`fully_autonomous`, guarded by `!matchedRule`)
// auto-approved them regardless of the switch — code ran on LAN even though the
// owner believed the switch turned it off.
//
// This test proves run_skill_script now gets an injected require_approval rule
// (execute.ts step 8b) under: non-local-trust + lanCommandYolo=false +
// destructive_gate autonomy — so the job suspends instead of auto-executing.
// Harness copied verbatim from run-command-flow.test.ts.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq } from '@nodal-agents/db';
import {
  agentJobs,
  agents,
  approvalRequests,
  agentSkills,
  agentSkillAssignments,
  agentWorkspaces,
  entities,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { DEFAULT_ROOT_GRANTS } from '@nodal-agents/shared';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import type { JobId } from '@nodal-agents/orchestration';

// ─── LLM client interception (verbatim from run-command-flow.test.ts) ────────

const { getActiveLlmClient, setActiveLlmClient } = vi.hoisted(() => {
  let _activeLlmClient: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => _activeLlmClient,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      _activeLlmClient = c;
    },
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: (..._args: Parameters<typeof actual.createLlmClient>) => {
      const active = getActiveLlmClient();
      if (!active)
        throw new Error(
          'lan-yolo-code-execution.test: no active LLM client — call setActiveLlmClient() first',
        );
      return active;
    },
  };
});

interface MockResponse {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
}

function makeMockLlmClient(responses: MockResponse[]): RunnerDeps['llmClient'] {
  let callIndex = 0;

  const mockModel = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async () => {
      const response = responses[callIndex] ?? responses[responses.length - 1]!;
      callIndex++;

      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
      > = [];
      if (response.text) content.push({ type: 'text', text: response.text });
      if (response.toolCalls) {
        for (const tc of response.toolCalls) {
          content.push({
            type: 'tool-call',
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: JSON.stringify(tc.args),
          });
        }
      }

      const isToolCalls = (response.toolCalls?.length ?? 0) > 0;
      return {
        content,
        finishReason: isToolCalls
          ? { unified: 'tool-calls' as const, raw: 'tool-calls' }
          : { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });

  return {
    config: { provider: 'anthropic', model: 'mock' },
    capabilities: {
      toolUse: true,
      promptCaching: false,
      vision: false,
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) =>
      generateText({ ...args, model: mockModel } as Parameters<
        typeof generateText
      >[0]) as ReturnType<RunnerDeps['llmClient']['generateText']>,
    streamText: () => {
      throw new Error('streamText not supported in mock');
    },
    generateObject: () => {
      throw new Error('generateObject not supported in mock');
    },
  };
}

// local-auth = non-local-trust: the LAN master-switch is actually enforced.
const lanEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'mock',
  LLM_API_KEY: 'test-key',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'local-auth',
  WORKER_SECRET: 'test-secret',
  BEARER_TOKEN: undefined,
  PORT: 3099,
  BIND: '127.0.0.1',
  APP_URL: 'http://localhost:3099',
  NODE_ENV: 'test',
  REFLECTION_ENABLED: 'false',
  REFLECTION_MAX_PER_HOUR: 6,
  REFLECTION_MAX_TURNS: 3,
  CURATOR_STALE_DAYS: 30,
  CURATOR_ARCHIVE_DAYS: 90,
  CURATOR_MIN_SKILLS: 5,
  CURATOR_INTERVAL_DAYS: 7,
  CURATOR_MAX_TURNS: 4,
  CURATOR_MEMORY_STALE_DAYS: 60,
  CURATOR_MEMORY_IMPORTANCE_MAX: 2,
  CURATOR_MEMORY_MIN: 8,
  MEMORY_CURATION_ENABLED: '',
  RETENTION_DAYS: 0,
  NODALAI_APPROVAL_GRACE_MS: 0,
};

// ─── Test state ───────────────────────────────────────────────────────────────

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let workspaceDir: string;

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  await db.update(agents).set({ role: 'agent' }).where(eq(agents.id, seed.agentId));

  workspaceDir = await realpath(await mkdtemp(join(tmpdir(), 'nodal-lanyolo-')));
  await db.insert(agentWorkspaces).values({
    agentId: seed.agentId,
    entityId: seed.entityId,
    label: 'ws',
    path: workspaceDir,
    position: 0,
  });

  // Skill with scripts_authorized=true for this agent — the ONLY thing that
  // makes run_skill_script show up in the agent's whitelist (execute.ts
  // scriptAuthorizedSkillSlugs). Slug/name suffixed to stay unique across runs.
  const ts = Date.now();
  const [skillRow] = await db
    .insert(agentSkills)
    .values({
      entityId: seed.entityId,
      name: `Lan yolo script skill ${ts}`,
      slug: `lan-yolo-script-skill-${ts}`,
      content: 'a skill with a bundled script',
    })
    .returning();
  if (!skillRow) throw new Error('Failed to insert skill');

  await db.insert(agentSkillAssignments).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    skillId: skillRow.id,
    scriptsAuthorized: true,
  });

  // A second skill, files_writable=true — the ONLY thing that makes
  // skill_file_write show up in the agent's whitelist (execute.ts
  // fileWritableSkillSlugs), for the skill_file_write master-switch coverage.
  const [writableSkillRow] = await db
    .insert(agentSkills)
    .values({
      entityId: seed.entityId,
      name: `Lan yolo writable skill ${ts}`,
      slug: `lan-yolo-writable-skill-${ts}`,
      content: 'a skill with writable files',
    })
    .returning();
  if (!writableSkillRow) throw new Error('Failed to insert writable skill');

  await db.insert(agentSkillAssignments).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    skillId: writableSkillRow.id,
    filesWritable: true,
  });

  // destructive_gate autonomy: WITHOUT the fix, this is exactly the level that
  // relaxes run_skill_script to auto_approve (isHeavy=false for that tool in
  // packages/tools/src/execute.ts) once no rule matches it.
  await db
    .update(entities)
    .set({ rootGrants: { ...DEFAULT_ROOT_GRANTS, autonomy: 'destructive_gate' } })
    .where(eq(entities.id, seed.entityId));
});

afterAll(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

function makeDeps(llmClient: RunnerDeps['llmClient']): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  setActiveLlmClient(llmClient);

  return {
    db: db as RunnerDeps['db'],
    llmClient,
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

async function createJob(): Promise<{ id: string }> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'run a skill script',
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning();
  if (!job) throw new Error('Failed to create test job');
  return job;
}

describe('LAN Yolo master-switch — code-execution tools beyond run_command', () => {
  it('run_skill_script under destructive_gate + lanCommandYolo=false → suspends for approval (never auto-executes)', async () => {
    // Workspace has NOT opted into LAN Yolo — the master switch is off.
    await db.update(entities).set({ lanCommandYolo: false }).where(eq(entities.id, seed.entityId));

    const job = await createJob();

    const llmClient = makeMockLlmClient([
      {
        toolCalls: [
          {
            toolCallId: 'tc-rss-1',
            toolName: 'run_skill_script',
            args: {
              purpose: 'run the skill script for the test',
              skill: 'does-not-need-to-exist-on-disk', // never resolved — gate blocks before execute()
              script: 'scripts/run.py',
            },
          },
        ],
      },
      {
        toolCalls: [
          { toolCallId: 'tc-rr-1', toolName: 'return_result', args: { status: 'success' } },
        ],
      },
    ]);

    // With the fix, execute.ts step 8b injects a require_approval rule for
    // run_skill_script (no matched rule existed before), which ALSO defeats the
    // destructive_gate relaxation in executeTool (guarded by `!matchedRule`).
    // Without the fix, this call would run straight through to 'completed'.
    const result = await executeJob(job.id as JobId, makeDeps(llmClient), lanEnv);
    expect(result.status).toBe('awaiting_approval');

    const approvalRows = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, job.id));
    const pending = approvalRows.find(
      (r) => r.toolName === 'run_skill_script' && r.status === 'pending',
    );
    expect(pending).toBeDefined();
    // Never reached executeTool's execute() branch, so it was never stamped run.
    expect(pending!.executedAt).toBeNull();
  });

  it('run_skill_script under fully_autonomous + lanCommandYolo=true → the master switch no longer forces approval', async () => {
    // Sanity check on the OTHER side of the switch: once the owner opts the
    // workspace in, execute.ts step 8b skips the inject entirely, so the
    // workspace's own autonomy relaxation applies again and the tool runs
    // without a human. Proves the fix gates on the switch, not on the tool
    // unconditionally.
    //
    // Uses fully_autonomous here (not destructive_gate): audit fix M-8 made
    // run_skill_script's content-opaque posture unconditional under
    // destructive_gate (isHeavy = riskLevel === 'destructive', always true for
    // this tool — a skill script can shell out to anything without ever
    // calling run_command, so destructive_gate can no longer judge it
    // "ordinary" and relax it). fully_autonomous is the one level that still
    // relaxes EVERY require_approval unconditionally (no riskLevel check), so
    // it's the one this master-switch test needs to isolate the switch's own
    // effect from that unrelated M-8 change.
    await db
      .update(entities)
      .set({
        lanCommandYolo: true,
        rootGrants: { ...DEFAULT_ROOT_GRANTS, autonomy: 'fully_autonomous' },
      })
      .where(eq(entities.id, seed.entityId));

    try {
      const job = await createJob();

      const llmClient = makeMockLlmClient([
        {
          toolCalls: [
            {
              toolCallId: 'tc-rss-2',
              toolName: 'run_skill_script',
              args: {
                purpose: 'run the skill script for the test',
                skill: 'nonexistent-skill-slug',
                script: 'scripts/run.py',
              },
            },
          ],
        },
        {
          toolCalls: [
            { toolCallId: 'tc-rr-2', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]);

      const result = await executeJob(job.id as JobId, makeDeps(llmClient), lanEnv);
      // No suspension: the tool actually ran (and errored — the skill isn't
      // installed on disk — but that's a tool_result, not an approval gate).
      expect(result.status).toBe('completed');

      const pendingApprovals = await db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.jobId, job.id));
      expect(pendingApprovals.find((r) => r.status === 'pending')).toBeUndefined();
    } finally {
      await db
        .update(entities)
        .set({
          lanCommandYolo: false,
          rootGrants: { ...DEFAULT_ROOT_GRANTS, autonomy: 'destructive_gate' },
        })
        .where(eq(entities.id, seed.entityId));
    }
  });

  it('skill_file_write under fully_autonomous + lanCommandYolo=false → suspends for approval (never auto-executes)', async () => {
    // skill_file_write declares riskLevel:'destructive', so destructive_gate
    // ALREADY gates it on its own (isHeavy = tool.riskLevel === 'destructive'
    // for any tool that isn't run_command/run_skill_script) — that path doesn't
    // exercise the master switch. fully_autonomous is the level that relaxes
    // EVERY require_approval unconditionally (no riskLevel check at all), so
    // it's the one that would auto-execute skill_file_write on LAN without
    // this fix.
    await db
      .update(entities)
      .set({
        rootGrants: { ...DEFAULT_ROOT_GRANTS, autonomy: 'fully_autonomous' },
        lanCommandYolo: false,
      })
      .where(eq(entities.id, seed.entityId));

    try {
      const job = await createJob();

      const llmClient = makeMockLlmClient([
        {
          toolCalls: [
            {
              toolCallId: 'tc-sfw-1',
              toolName: 'skill_file_write',
              args: {
                purpose: 'write a file into the skill for the test',
                skill: 'does-not-need-to-exist-on-disk', // never resolved — gate blocks before execute()
                path: 'workflows/whatever.json',
                content: '{}',
              },
            },
          ],
        },
        {
          toolCalls: [
            { toolCallId: 'tc-rr-3', toolName: 'return_result', args: { status: 'success' } },
          ],
        },
      ]);

      // With the fix, execute.ts step 8b injects a require_approval rule for
      // skill_file_write too, defeating the fully_autonomous relaxation.
      // Without the fix, this call would run straight through to 'completed'.
      const result = await executeJob(job.id as JobId, makeDeps(llmClient), lanEnv);
      expect(result.status).toBe('awaiting_approval');

      const approvalRows = await db
        .select()
        .from(approvalRequests)
        .where(eq(approvalRequests.jobId, job.id));
      const pending = approvalRows.find(
        (r) => r.toolName === 'skill_file_write' && r.status === 'pending',
      );
      expect(pending).toBeDefined();
      expect(pending!.executedAt).toBeNull();
    } finally {
      // Restore the shared fixture state for any test that runs after this one.
      await db
        .update(entities)
        .set({
          rootGrants: { ...DEFAULT_ROOT_GRANTS, autonomy: 'destructive_gate' },
          lanCommandYolo: false,
        })
        .where(eq(entities.id, seed.entityId));
    }
  });
});
