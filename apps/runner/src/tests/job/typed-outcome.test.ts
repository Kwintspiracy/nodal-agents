// typed-outcome.test.ts — a job is not green over a call that failed, and a
// call whose effect is unknown is never redone blindly (#1184, #1206).
//
// Driven on the real job loop with a scripted model. Each tool here is the
// registry's definition of a product tool with only its `execute` replaced, so
// its DECLARATION (`outcomeOf`) is the product's; or a test tool granted
// through a skill, as any tool is. Assertions on the tool-call rows the seam
// wrote, the job's final row, and what the model read: never a call count.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText } from 'ai';
import { z } from 'zod';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agentSkills,
  agentSkillAssignments,
  approvalRules,
  eq,
  toolCalls,
} from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import type { ToolDefinition } from '@nodal-agents/tools';
import { createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { chatItemTarget, chatTarget, unresolvedCalls } from '@nodal-agents/shared';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';
import { executeJob } from '../../job/execute.ts';
import { callOutcomeRows, jobUnresolvedCalls } from '../../job/call-outcomes.ts';
import type { JobId } from '@nodal-agents/orchestration';

// ─── Interceptions ────────────────────────────────────────────────────────────

const { getActiveLlmClient, setActiveLlmClient, transitions } = vi.hoisted(() => {
  let active: RunnerDeps['llmClient'] | null = null;
  return {
    getActiveLlmClient: () => active,
    setActiveLlmClient: (c: RunnerDeps['llmClient']) => {
      active = c;
    },
    transitions: [] as Array<{ jobId: string; event: unknown }>,
  };
});

vi.mock('@nodal-agents/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/llm')>();
  return {
    ...actual,
    createLlmClient: () => {
      const c = getActiveLlmClient();
      if (!c) throw new Error('typed-outcome test: no active LLM client');
      return c;
    },
  };
});

// What the harness says on the chat of a coding run (FV1-03), captured.
vi.mock('../../notify/code-transitions.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../notify/code-transitions.ts')>();
  return {
    ...actual,
    notifyCodeTransition: async (_db: unknown, jobId: string, event: unknown) => {
      transitions.push({ jobId, event });
    },
  };
});

// ─── Scripted model ───────────────────────────────────────────────────────────

interface Reply {
  text?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>;
}

function scriptedModel(replies: Reply[], prompts: unknown[]): RunnerDeps['llmClient'] {
  let i = 0;
  const model = new MockLanguageModelV3({
    provider: 'mock',
    modelId: 'mock',
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      const reply = replies[i] ?? replies[replies.length - 1]!;
      i += 1;
      const content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool-call'; toolCallId: string; toolName: string; input: string }
      > = [];
      if (reply.text) content.push({ type: 'text', text: reply.text });
      for (const tc of reply.toolCalls ?? []) {
        content.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: JSON.stringify(tc.args),
        });
      }
      const calls = (reply.toolCalls?.length ?? 0) > 0;
      return {
        content,
        finishReason: calls
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
      structuredOutputs: false,
      streaming: false,
    },
    generateText: (args) =>
      generateText({ ...args, model } as Parameters<typeof generateText>[0]) as ReturnType<
        RunnerDeps['llmClient']['generateText']
      >,
    streamText: () => {
      throw new Error('streamText not supported in mock');
    },
    generateObject: () => {
      throw new Error('generateObject not supported in mock');
    },
  };
}

// ─── Fixture ──────────────────────────────────────────────────────────────────

const testEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'mock',
  LLM_API_KEY: 'test-key',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'local-trust',
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
  SKILL_UPDATE_CHECK_INTERVAL_HOURS: 24,
  SKILL_UPDATE_CHECK_BATCH_SIZE: 10,
  NODALAI_APPROVAL_GRACE_MS: 0,
};

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** The tools this file grants the agent, through a skill, as any tool is granted. */
const GRANTED = ['code_task', 'run_command', 'deliver_item'];

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  const ts = Date.now();
  const [skill] = await db
    .insert(agentSkills)
    .values({
      entityId: seed.entityId,
      name: `Typed outcome ${ts}`,
      slug: `typed-outcome-${ts}`,
      content: 'code, run commands, deliver items',
      requiredBuiltins: GRANTED,
    })
    .returning();
  await db
    .insert(agentSkillAssignments)
    .values({ entityId: seed.entityId, agentId: seed.agentId, skillId: skill!.id });
  for (const toolName of [...GRANTED, 'dashboard_publish']) {
    await db
      .insert(approvalRules)
      .values({ entityId: seed.entityId, agentId: seed.agentId, toolName, action: 'auto_approve' })
      .onConflictDoNothing();
  }
});

const itemInput = z.object({ item: z.string(), chat: z.string(), purpose: z.string().optional() });

/**
 * A tool that delivers ONE item to a chat, reporting what it acts on the way
 * the product's send tools do (`chatItemTarget`): it fails for `fails` items,
 * and throws after "transmitting" for `ambiguous` ones.
 */
function deliverItem(fails: readonly string[], ambiguous: readonly string[] = []) {
  return {
    name: 'deliver_item',
    description: 'Delivers one item to a chat.',
    inputSchema: itemInput,
    riskLevel: 'write',
    execute: async (
      input: z.infer<typeof itemInput>,
      ctx: { reportTarget?: (t: string) => void },
    ) => {
      ctx.reportTarget?.(chatItemTarget('telegram', input.chat, input.item));
      if (fails.includes(input.item)) throw new Error('file_too_large');
      if (ambiguous.includes(input.item)) {
        const err = new Error('send timed out after the request was sent');
        (err as { mayHaveDelivered?: boolean }).mayHaveDelivered = true;
        throw err;
      }
      return { sent: true };
    },
  } as unknown as ToolDefinition<z.ZodTypeAny, unknown>;
}

function deps(
  client: RunnerDeps['llmClient'],
  overrides: Array<ToolDefinition<z.ZodTypeAny, unknown>>,
): RunnerDeps {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  for (const t of overrides) registry.register(t);
  setActiveLlmClient(client);
  return {
    db: db as RunnerDeps['db'],
    llmClient: client,
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };
}

/** A product tool of the registry, with its declaration, and only its effect replaced. */
function withEffect(
  name: string,
  execute: () => Promise<unknown>,
): ToolDefinition<z.ZodTypeAny, unknown> {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  const real = registry.get(name);
  if (!real) throw new Error(`no builtin ${name}`);
  return {
    ...real,
    // The effect only: no workspace, no CLI, no process.
    mutatesWorkspace: false,
    reportsHarnessWrites: false,
    preflight: undefined,
    resolveMutationTargets: undefined,
    execute,
  } as ToolDefinition<z.ZodTypeAny, unknown>;
}

async function newJob(task: string): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task,
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning();
  return job!.id;
}

async function jobRow(id: string) {
  const [row] = await db
    .select({ status: agentJobs.status, error: agentJobs.error, result: agentJobs.result })
    .from(agentJobs)
    .where(eq(agentJobs.id, id));
  return row!;
}

async function rowsOf(jobId: string) {
  return db
    .select({ toolName: toolCalls.toolName, outcome: toolCalls.outcome, target: toolCalls.target })
    .from(toolCalls)
    .where(eq(toolCalls.jobId, jobId))
    .orderBy(toolCalls.seq);
}

const done = (id: string, text = 'All done.'): Reply => ({
  text,
  toolCalls: [{ toolCallId: id, toolName: 'return_result', args: { status: 'success' } }],
});

describe('a job is not a plain success over a call that failed @cap:verifier-un-livrable/moteur', () => {
  it('a coding run that returns its error flag is failed: the job ends not done, and the harness never says it finished', async () => {
    const jobId = await newJob('fix the bug');
    const codeTask = withEffect('code_task', async () => ({
      provider: 'claude',
      mode: 'write',
      isError: true,
      errorDetail: 'the CLI stopped on an error',
      resultText: 'I could not apply the fix.',
      exitCode: 1,
      timedOut: false,
    }));
    const prompts: unknown[] = [];
    const client = scriptedModel(
      [
        {
          toolCalls: [
            {
              toolCallId: 'ct',
              toolName: 'code_task',
              args: { purpose: 'Fix the bug', task: 'fix it', provider: 'claude', mode: 'write' },
            },
          ],
        },
        done('rr', 'The bug is fixed.'),
      ],
      prompts,
    );
    const result = await executeJob(jobId as JobId, deps(client, [codeTask]), testEnv);

    expect(result.status).toBe('failed');
    expect((await rowsOf(jobId)).map((r) => [r.toolName, r.outcome])).toEqual([
      ['code_task', 'failed'],
    ]);
    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('calls_not_done (1 unresolved: code_task)');
    expect(row.result).toBe(
      'The bug is fixed.\n\n[stopped: tool calls not done — code_task: failed]',
    );
    // FV1-03: the platform's line on the chat is the tool's declared outcome.
    expect(transitions.filter((t) => t.jobId === jobId).map((t) => t.event)).toEqual([
      expect.objectContaining({ kind: 'code_task_done', success: false }),
    ]);
  });

  it('a command killed at its timeout is failed, and the job ends not done', async () => {
    const jobId = await newJob('render the film');
    const runCommand = withEffect('run_command', async () => ({
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: true,
      truncated: false,
      cwd: '/w',
      paths: '',
    }));
    const client = scriptedModel(
      [
        {
          toolCalls: [
            {
              toolCallId: 'rc',
              toolName: 'run_command',
              args: { purpose: 'render', command: 'render.sh' },
            },
          ],
        },
        done('rr', 'Render complete.'),
      ],
      [],
    );
    await executeJob(jobId as JobId, deps(client, [runCommand]), testEnv);
    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('calls_not_done (1 unresolved: run_command)');
  });

  it('a command that exited non-zero RAN: its status is data, and the job completes', async () => {
    const jobId = await newJob('search the logs');
    const runCommand = withEffect('run_command', async () => ({
      exitCode: 1,
      stdout: '',
      stderr: '',
      timedOut: false,
      truncated: false,
      cwd: '/w',
      paths: '',
    }));
    const client = scriptedModel(
      [
        {
          toolCalls: [
            {
              toolCallId: 'rc',
              toolName: 'run_command',
              args: { purpose: 'grep', command: 'grep x log' },
            },
          ],
        },
        done('rr', 'No match in the logs.'),
      ],
      [],
    );
    await executeJob(jobId as JobId, deps(client, [runCommand]), testEnv);
    expect((await jobRow(jobId)).status).toBe('completed');
    expect((await rowsOf(jobId))[0]).toMatchObject({ toolName: 'run_command', outcome: 'done' });
  });

  it('file A fails, file B succeeds to the same chat: A is still unresolved, named in the line', async () => {
    const jobId = await newJob('send me the report and the cover');
    const client = scriptedModel(
      [
        {
          toolCalls: [
            { toolCallId: 'a', toolName: 'deliver_item', args: { item: 'report.pdf', chat: '99' } },
          ],
        },
        {
          toolCalls: [
            { toolCallId: 'b', toolName: 'deliver_item', args: { item: 'cover.png', chat: '99' } },
          ],
        },
        done('rr', 'Both files are sent.'),
      ],
      [],
    );
    await executeJob(jobId as JobId, deps(client, [deliverItem(['report.pdf'])]), testEnv);
    expect((await rowsOf(jobId)).map((r) => [r.outcome, r.target])).toEqual([
      ['failed', chatItemTarget('telegram', '99', 'report.pdf')],
      ['done', chatItemTarget('telegram', '99', 'cover.png')],
    ]);
    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.result).toContain(
      '[stopped: tool calls not done — deliver_item → chat:telegram:99 report.pdf: failed]',
    );
  });

  it('a failure then a done call on the SAME target is resolved: the job completes', async () => {
    const jobId = await newJob('send me the report');
    let attempts = 0;
    const flaky = {
      ...deliverItem([]),
      execute: async (
        input: { item: string; chat: string },
        ctx: { reportTarget?: (t: string) => void },
      ) => {
        ctx.reportTarget?.(chatItemTarget('telegram', input.chat, input.item));
        attempts += 1;
        if (attempts === 1) throw new Error('rate limited');
        return { sent: true };
      },
    } as unknown as ToolDefinition<z.ZodTypeAny, unknown>;
    const client = scriptedModel(
      [
        {
          toolCalls: [
            {
              toolCallId: 'a1',
              toolName: 'deliver_item',
              args: { item: 'report.pdf', chat: '99' },
            },
          ],
        },
        {
          toolCalls: [
            {
              toolCallId: 'a2',
              toolName: 'deliver_item',
              args: { item: 'report.pdf', chat: '99' },
            },
          ],
        },
        done('rr', 'Sent, on the second try.'),
      ],
      [],
    );
    await executeJob(jobId as JobId, deps(client, [flaky]), testEnv);
    expect((await rowsOf(jobId)).map((r) => r.outcome)).toEqual(['failed', 'done']);
    expect((await jobRow(jobId)).status).toBe('completed');
  });
});

describe('a call whose effect is unknown is never redone blindly @cap:verifier-un-livrable/moteur', () => {
  it('a send that timed out is unknown, told to the model with its target, not pushed to be redone, and stated at the end', async () => {
    const jobId = await newJob('post the update');
    const publish = withEffect('dashboard_publish', async () => {
      const err = new Error('publish timed out after the request was sent');
      (err as { mayHaveDelivered?: boolean }).mayHaveDelivered = true;
      throw err;
    });
    const prompts: unknown[] = [];
    const client = scriptedModel(
      [
        {
          toolCalls: [
            {
              toolCallId: 'dp',
              toolName: 'dashboard_publish',
              args: { text: 'Update: v2 shipped.' },
            },
          ],
        },
        done('rr', 'Published.'),
      ],
      prompts,
    );
    await executeJob(jobId as JobId, deps(client, [publish]), testEnv);
    expect((await rowsOf(jobId)).map((r) => [r.toolName, r.outcome])).toEqual([
      ['dashboard_publish', 'unknown'],
    ]);
    const read = JSON.stringify(prompts);
    // The model read it, in the seam's one text.
    expect(read).toContain('OUTCOME UNKNOWN');
    expect(read).toContain('Do NOT call this tool again with the same content');
    // The harness did not push it to redo the call (Guard 3b is for FAILED deliveries).
    expect(read).not.toContain("Ne déclare pas un succès qui n'a pas eu lieu");
    const row = await jobRow(jobId);
    expect(row.status).toBe('failed');
    expect(row.result).toContain('[stopped: tool calls not done — dashboard_publish: unknown]');
  });

  it('the item delivered to another chat whose send is unconfirmed carries its target to the model', async () => {
    const jobId = await newJob('send the cover to the team');
    const prompts: unknown[] = [];
    const client = scriptedModel(
      [
        {
          toolCalls: [
            { toolCallId: 'x', toolName: 'deliver_item', args: { item: 'cover.png', chat: '7' } },
          ],
        },
        done('rr', 'Sent to the team.'),
      ],
      prompts,
    );
    await executeJob(jobId as JobId, deps(client, [deliverItem([], ['cover.png'])]), testEnv);
    expect(JSON.stringify(prompts)).toContain(
      `OUTCOME UNKNOWN (target: ${chatItemTarget('telegram', '7', 'cover.png')})`,
    );
    expect((await rowsOf(jobId))[0]).toMatchObject({
      outcome: 'unknown',
      target: chatItemTarget('telegram', '7', 'cover.png'),
    });
  });
});

describe('one verdict, whoever reads it @cap:verifier-un-livrable/moteur', () => {
  it('the runner reading the rows gives the answer of the shared function on the same table', async () => {
    const jobId = await newJob('a table of rows');
    const chat = chatTarget('telegram', '5');
    const rows = [
      {
        toolName: 'deliver_item',
        outcome: 'failed',
        target: 'chat:telegram:5 a',
        riskLevel: 'write',
        executionStarted: true,
      },
      {
        toolName: 'deliver_item',
        outcome: 'done',
        target: 'chat:telegram:5 b',
        riskLevel: 'write',
        executionStarted: true,
      },
      {
        toolName: 'telegram_send_message',
        outcome: 'unknown',
        target: chat,
        riskLevel: 'write',
        executionStarted: true,
      },
      {
        toolName: 'file_read',
        outcome: 'failed',
        target: 'file:/x',
        riskLevel: 'read',
        executionStarted: true,
      },
      {
        toolName: 'file_write',
        outcome: 'failed',
        target: 'file:/y',
        riskLevel: 'write',
        executionStarted: false,
      },
      {
        toolName: 'file_edit',
        outcome: 'failed',
        target: 'file:/z',
        riskLevel: 'write',
        executionStarted: true,
      },
      {
        toolName: 'file_write',
        outcome: 'done',
        target: 'file:/z',
        riskLevel: 'write',
        executionStarted: true,
      },
      {
        toolName: 'gmail_send_email',
        outcome: null,
        target: null,
        riskLevel: 'write',
        executionStarted: true,
      },
    ];
    for (const r of rows) {
      await db.insert(toolCalls).values({ entityId: seed.entityId, jobId, toolOutput: '{}', ...r });
    }
    const fromRows = unresolvedCalls(await callOutcomeRows(db as never, jobId));
    expect(
      (await jobUnresolvedCalls(db as never, jobId)).map((c) => [c.toolName, c.outcome, c.target]),
    ).toEqual(fromRows.map((c) => [c.toolName, c.outcome, c.target]));
    expect(fromRows.map((c) => [c.toolName, c.outcome, c.target])).toEqual([
      ['deliver_item', 'failed', 'chat:telegram:5 a'],
      ['telegram_send_message', 'unknown', chat],
    ]);
    // The chat the harness answers on is made good by that delivery.
    expect((await jobUnresolvedCalls(db as never, jobId, chat)).map((c) => c.toolName)).toEqual([
      'deliver_item',
    ]);
  });
});
