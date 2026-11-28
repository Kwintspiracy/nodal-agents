// tool-outcome.test.ts — the seam writes ONE outcome per call, declared by the
// tool, beside what the call acted on (#1184, #1206).
//
// Every assertion reads the ROW the seam wrote (`tool_calls.outcome`,
// `tool_calls.target`, `execution_started`) and the result the runner hands
// the model, never a call count. The built-in tools are the registry's own
// definitions, run for real in a temporary workspace.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, and, eq, toolCalls } from '@nodal-agents/db';
import { chatTarget, projectKey } from '@nodal-agents/shared';
import { createToolRegistry } from '../registry';
import { registerBuiltins } from '../builtin';
import { executeTool } from '../execute';
import { codeTaskTool } from '../builtin/code-task/index';
import { declareVerificationTool } from '../builtin/declare-verification';
import { outcomeOfCommand, outcomeOfOkFlag } from '../outcome';
import type { ApprovalRule, ExecuteOptions, ToolContext, ToolDefinition } from '../types';
import { aRow, autonomousRows } from './autonomy-rows-fixture';

const registry = createToolRegistry();
registerBuiltins(registry);

function outil(nom: string) {
  const t = registry.get(nom);
  if (!t) throw new Error(`outil absent du registre : ${nom}`);
  return t;
}

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let racine = '';

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  racine = await mkdtemp(join(tmpdir(), 'nodal-outcome-'));
});

afterEach(async () => {
  await rm(racine, { recursive: true, force: true }).catch(() => {});
});

async function jobNeuf(): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'api', task: 'outcome' })
    .returning();
  if (!job) throw new Error('job insert failed');
  return job.id;
}

function ctx(jobId: string, over: Partial<ToolContext> = {}): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId,
    jobChatId: null,
    workspaces: [{ label: 'shared', path: racine }],
    turn: 1,
    toolCallId: `call-${Math.random().toString(36).slice(2)}`,
    ...over,
  } as unknown as ToolContext;
}

function autonomous(extra: ApprovalRule[] = []): ExecuteOptions {
  const rules = registry.list().map((t) => aRow(t.name, 'auto_approve', seed)) as ApprovalRule[];
  return {
    approvalRules: [...extra, ...rules, ...autonomousRows(seed)],
    onApprovalRequired: async () => {},
  };
}

async function rowsOf(jobId: string) {
  return db
    .select({
      toolName: toolCalls.toolName,
      outcome: toolCalls.outcome,
      target: toolCalls.target,
      executionStarted: toolCalls.executionStarted,
      toolOutput: toolCalls.toolOutput,
    })
    .from(toolCalls)
    .where(eq(toolCalls.jobId, jobId))
    .orderBy(toolCalls.seq);
}

function fake<TOut>(
  name: string,
  def: Partial<ToolDefinition<z.ZodObject<{ value: z.ZodString }>, TOut>> & {
    execute: (input: { value: string }, ctx: ToolContext) => Promise<TOut>;
  },
): ToolDefinition<z.ZodObject<{ value: z.ZodString }>, TOut> {
  return {
    name,
    description: 'test tool',
    inputSchema: z.object({ value: z.string(), purpose: z.string().optional() }),
    riskLevel: 'write',
    ...def,
  };
}

const fakeOpts = (name: string): ExecuteOptions => ({
  approvalRules: [aRow(name, 'auto_approve', seed), ...autonomousRows(seed)],
  onApprovalRequired: async () => {},
});

describe('the seam writes the outcome a tool declares @cap:verifier-un-livrable/moteur', () => {
  it('a file tool that RETURNS its failure (`ok: false`) is failed, on the file it named', async () => {
    const jobId = await jobNeuf();
    await writeFile(join(racine, 'a.txt'), 'hello\n');
    const res = await executeTool(
      outil('file_edit'),
      { purpose: 'edit', path: 'a.txt', old_string: 'absent', new_string: 'x' },
      ctx(jobId),
      autonomous(),
    );
    // What the model reads is still the tool's result: the reason is in it.
    expect(res.outcome).toBe('success');
    expect(res.callOutcome).toBe('failed');
    const [row] = await rowsOf(jobId);
    expect(row).toMatchObject({
      toolName: 'file_edit',
      outcome: 'failed',
      target: `file:${projectKey(join(racine, 'a.txt'))}`,
      executionStarted: true,
    });
    expect(JSON.parse(row!.toolOutput!)).toMatchObject({ ok: false });
  });

  it('the same tool that did its work is done, on the same file', async () => {
    const jobId = await jobNeuf();
    await writeFile(join(racine, 'a.txt'), 'hello\n');
    await executeTool(
      outil('file_edit'),
      { purpose: 'edit', path: 'a.txt', old_string: 'hello', new_string: 'bye' },
      ctx(jobId),
      autonomous(),
    );
    const [row] = await rowsOf(jobId);
    expect(row).toMatchObject({
      outcome: 'done',
      target: `file:${projectKey(join(racine, 'a.txt'))}`,
    });
  });

  it('a command killed at its timeout is failed; a non-zero exit is data, done', async () => {
    const jobId = await jobNeuf();
    await mkdir(join(racine, 'w'), { recursive: true });
    const killed = await executeTool(
      outil('run_command'),
      {
        purpose: 'wait',
        command: 'node -e "setTimeout(() => {}, 20000)"',
        timeout_seconds: 1,
      },
      ctx(jobId),
      autonomous(),
    );
    expect(killed.callOutcome).toBe('failed');
    const exited = await executeTool(
      outil('run_command'),
      { purpose: 'exit', command: 'node -e "process.exit(3)"' },
      ctx(jobId),
      autonomous(),
    );
    expect(exited.callOutcome).toBe('done');
    const rows = await rowsOf(jobId);
    expect(rows.map((r) => [r.toolName, r.outcome])).toEqual([
      ['run_command', 'failed'],
      ['run_command', 'done'],
    ]);
    // A command is keyed by itself (its arguments), never by its folder.
    expect(rows[0]!.target).toMatch(/^input:run_command:/);
    expect(rows[0]!.target).not.toBe(rows[1]!.target);
  }, 30_000);

  it('the declarations of the other shapes, on their outputs', () => {
    const run = { stdout: '', stderr: '', truncated: false, cwd: '/', paths: '' };
    expect(outcomeOfCommand({ ...run, exitCode: null })).toBe('failed');
    expect(outcomeOfCommand({ ...run, exitCode: 1 })).toBe('done');
    expect(
      codeTaskTool.outcomeOf!({ isError: true } as Parameters<
        NonNullable<typeof codeTaskTool.outcomeOf>
      >[0]),
    ).toBe('failed');
    expect(
      codeTaskTool.outcomeOf!({ isError: false } as Parameters<
        NonNullable<typeof codeTaskTool.outcomeOf>
      >[0]),
    ).toBe('done');
    expect(declareVerificationTool.outcomeOf!({ declared: false, reason: 'no write seen' })).toBe(
      'failed',
    );
    expect(declareVerificationTool.outcomeOf!({ declared: true, project: 'p', commands: 1 })).toBe(
      'done',
    );
    expect(outcomeOfOkFlag({ ok: false, reason: 'x' })).toBe('failed');
    expect(outcomeOfOkFlag({ ok: true })).toBe('done');
    expect(outcomeOfOkFlag('plain text')).toBe('done');
  });

  it('every built-in that returns `ok: false` declares it (no tool left to the default)', () => {
    // The tools whose result type carries `ok: false` are the file, office,
    // skill and meta tools: each must have a declaration, or the seam would
    // write `done` over a refusal.
    const declared = registry
      .list()
      .filter((t) => t.outcomeOf !== undefined)
      .map((t) => t.name);
    for (const name of [
      'file_edit',
      'file_write',
      'file_read',
      'file_move',
      'file_list',
      'run_command',
      'run_skill_script',
      'declare_verification',
      'code_task',
      'review_verdict',
      'render_pdf',
      'generate_speech',
    ]) {
      expect(declared, name).toContain(name);
    }
  });
});

describe('what the seam writes itself @cap:verifier-un-livrable/moteur', () => {
  it('thrown is failed; thrown after the request was sent is unknown, said to the model with its target', async () => {
    const jobId = await jobNeuf();
    const send = fake('fake_send', {
      execute: async (_input, c) => {
        c.reportTarget?.(chatTarget('telegram', '42'));
        const err = new Error('send timed out');
        (err as { mayHaveDelivered?: boolean }).mayHaveDelivered = true;
        throw err;
      },
    });
    const res = await executeTool(send, { value: 'x' }, ctx(jobId), fakeOpts('fake_send'));
    expect(res).toMatchObject({
      outcome: 'error',
      callOutcome: 'unknown',
      target: 'chat:telegram:42',
    });
    if (res.outcome === 'error') {
      expect(res.error).toContain('OUTCOME UNKNOWN (target: chat:telegram:42)');
      expect(res.error).toContain('Do NOT call this tool again');
    }
    const plain = fake('fake_fail', {
      execute: async () => {
        throw new Error('ECONNRESET');
      },
    });
    await executeTool(plain, { value: 'y' }, ctx(jobId), fakeOpts('fake_fail'));
    expect((await rowsOf(jobId)).map((r) => [r.toolName, r.outcome, r.target])).toEqual([
      ['fake_send', 'unknown', 'chat:telegram:42'],
      ['fake_fail', 'failed', expect.stringMatching(/^input:fake_fail:/)],
    ]);
  });

  it('while a tool that changes something runs, its row says unknown: a runner dead mid-call leaves no success', async () => {
    const jobId = await jobNeuf();
    let seenWhileRunning: Array<{ outcome: string | null; target: string | null }> = [];
    const slow = fake('fake_slow', {
      execute: async () => {
        seenWhileRunning = await db
          .select({ outcome: toolCalls.outcome, target: toolCalls.target })
          .from(toolCalls)
          .where(and(eq(toolCalls.jobId, jobId), eq(toolCalls.toolName, 'fake_slow')));
        return 'ok';
      },
    });
    await executeTool(slow, { value: 'z' }, ctx(jobId), fakeOpts('fake_slow'));
    expect(seenWhileRunning).toEqual([
      { outcome: 'unknown', target: expect.stringMatching(/^input:fake_slow:/) },
    ]);
    expect((await rowsOf(jobId))[0]!.outcome).toBe('done');
  });

  it('a result a tool declares unknown is written unknown; a declaration that throws is unknown, never done', async () => {
    const jobId = await jobNeuf();
    const running = fake<{ status: string }>('fake_running', {
      outcomeOf: (o) => (o.status === 'running' ? 'unknown' : 'done'),
      execute: async () => ({ status: 'running' }),
    });
    const broken = fake<string>('fake_broken', {
      outcomeOf: () => {
        throw new Error('bug in the declaration');
      },
      execute: async () => 'x',
    });
    expect(
      (await executeTool(running, { value: 'a' }, ctx(jobId), fakeOpts('fake_running')))
        .callOutcome,
    ).toBe('unknown');
    expect(
      (await executeTool(broken, { value: 'b' }, ctx(jobId), fakeOpts('fake_broken'))).callOutcome,
    ).toBe('unknown');
    expect((await rowsOf(jobId)).map((r) => r.outcome)).toEqual(['unknown', 'unknown']);
  });

  it('the gate: an invalid input is failed and never started; a block is refused; a held call waits', async () => {
    const jobId = await jobNeuf();
    const tool = fake('fake_gated', { execute: async () => 'ran' });
    await executeTool(tool, { nope: 1 }, ctx(jobId), fakeOpts('fake_gated'));
    await executeTool(tool, { value: 'b' }, ctx(jobId), {
      approvalRules: [aRow('fake_gated', 'block', seed), ...autonomousRows(seed)],
      onApprovalRequired: async () => {},
    });
    await executeTool(tool, { value: 'c', purpose: 'why' }, ctx(jobId), {
      approvalRules: [aRow('fake_gated', 'require_approval', seed), ...autonomousRows(seed)],
      onApprovalRequired: async () => {},
    });
    expect((await rowsOf(jobId)).map((r) => [r.outcome, r.executionStarted])).toEqual([
      ['failed', false],
      ['refused', false],
      ['awaiting_approval', false],
    ]);
  });
});
