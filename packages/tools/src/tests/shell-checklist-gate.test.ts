// shell-checklist-gate.test.ts — the autonomy checklist at the approval gate (#464).
//
// Run 06a949cb → b4b493e8 (23/09): workspace at `destructive_gate`, no rule on
// `run_command`, the agent wrote `shared/scripts/_analyze_gains_file.py` and ran
// it on four files in Downloads and Documents. It ran: nobody was asked. This
// file replays that shape on the REAL gate (`executeTool`), with real folders
// on disk (the "outside" check is the file tools' own resolver) and the real
// database (the approval row and its reasons are read back).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { eq } from '@nodal-agents/db';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { approvalRequests, toolCalls } from '@nodal-agents/db';
import { DEFAULT_SHELL_POLICY, type ShellPolicy } from '@nodal-agents/shared';
import { executeTool } from '../execute';
import type { ApprovalRule, ExecuteOptions, ToolContext, ToolDefinition } from '../types';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let root: string;
let folder: string;
let shared: string;
let outside: string;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
  root = await mkdtemp(join(tmpdir(), 'nodal-shell-checklist-'));
  folder = join(root, 'excel');
  shared = join(root, 'shared');
  outside = join(root, 'Downloads');
  for (const d of [folder, join(shared, 'scripts'), outside]) await mkdir(d, { recursive: true });
  await writeFile(join(shared, 'scripts', '_analyze_gains_file.py'), 'print(1)\n');
  await writeFile(join(outside, 'earnings_2026_statement.csv'), 'a,b\n');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces: [
      { label: 'excel', path: folder },
      { label: 'shared', path: shared },
    ],
    ...overrides,
  };
}

const runCommand: ToolDefinition<z.ZodObject<{ command: z.ZodString }>, string> = {
  name: 'run_command',
  description: 'run a shell command',
  inputSchema: z.object({ command: z.string(), purpose: z.string(), cwd: z.string().optional() }),
  riskLevel: 'write',
  defaultApproval: 'require_approval',
  execute: async (input: { command: string }) => `ran:${input.command}`,
};

const gate = (policy: ShellPolicy | undefined, rules: ApprovalRule[] = []): ExecuteOptions => ({
  approvalRules: rules,
  autonomy: 'destructive_gate',
  onApprovalRequired: async () => {},
  ...(policy ? { shellPolicy: policy } : {}),
});

const run = (command: string, opts: ExecuteOptions) =>
  executeTool(runCommand, { command, purpose: 'Analyse the gains.' }, ctx(), opts);

const script = () => join(shared, 'scripts', '_analyze_gains_file.py');
const outsideFile = () => join(outside, 'earnings_2026_statement.csv');

/** The agent wrote the script in THIS job, through the file tool. */
async function agentWroteTheScript(): Promise<void> {
  await db.insert(toolCalls).values({
    entityId: seed.entityId,
    jobId: seed.jobId,
    toolName: 'file_write',
    toolInput: { path: 'shared/scripts/_analyze_gains_file.py', content: 'print(1)\n' },
    toolOutput: '{"ok":true}',
    durationMs: 1,
  });
}

async function forgetWrites(): Promise<void> {
  await db.delete(toolCalls).where(eq(toolCalls.jobId, seed.jobId));
}

async function reasonsOf(approvalRequestId: string): Promise<unknown> {
  const [row] = await db
    .select({ gateReasons: approvalRequests.gateReasons })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, approvalRequestId));
  return row?.gateReasons;
}

describe('the autonomy checklist at the gate (#464) @cap:executer-une-commande/moteur', () => {
  it('the 23/09 command is held, with the outside path and the self-written script named', async () => {
    await forgetWrites();
    await agentWroteTheScript();

    const res = await run(`python "${script()}" "${outsideFile()}"`, gate(DEFAULT_SHELL_POLICY));

    expect(res.outcome).toBe('awaiting_approval');
    if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
    expect(await reasonsOf(res.approvalRequestId)).toEqual([
      { category: 'outside_folders', state: 'ask', details: [outsideFile()] },
      { category: 'own_script', state: 'ask', details: [script()] },
    ]);
  });

  it('a script it did not write, on files inside its folders, runs as before', async () => {
    await forgetWrites();

    const res = await run(
      `python "${script()}" "${join(folder, 'report.xlsx')}"`,
      gate(DEFAULT_SHELL_POLICY),
    );

    expect(res.outcome).toBe('success');
  });

  it('its own script inside its folders asks, naming the script only', async () => {
    await forgetWrites();
    await agentWroteTheScript();

    const res = await run(`python "${script()}"`, gate(DEFAULT_SHELL_POLICY));

    expect(res.outcome).toBe('awaiting_approval');
    if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
    expect(await reasonsOf(res.approvalRequestId)).toEqual([
      { category: 'own_script', state: 'ask', details: [script()] },
    ]);
  });

  it('"never" blocks, tells the agent what and where, and asks no one', async () => {
    await forgetWrites();
    const before = await db.select({ id: approvalRequests.id }).from(approvalRequests);

    const res = await run(
      `type "${outsideFile()}"`,
      gate({ ...DEFAULT_SHELL_POLICY, outside_folders: 'never' }),
    );

    expect(res.outcome).toBe('error');
    if (res.outcome !== 'error') throw new Error('unreachable');
    expect(res.error).toContain(
      'blocked: the owner does not allow this agent to read or change files outside its folders',
    );
    expect(res.error).toContain(outsideFile());
    const after = await db.select({ id: approvalRequests.id }).from(approvalRequests);
    expect(after).toHaveLength(before.length);
  });

  it('a Yolo rule does not reopen the folders: outside still asks', async () => {
    await forgetWrites();
    const yolo: ApprovalRule = {
      id: 'yolo',
      toolName: 'run_command',
      action: 'auto_approve',
      agentId: seed.agentId,
      entityId: seed.entityId,
    };

    const res = await run(
      `type "${outsideFile()}"`,
      gate({ ...DEFAULT_SHELL_POLICY, delete_files: 'allow' }, [yolo]),
    );

    expect(res.outcome).toBe('awaiting_approval');
  });

  it('what the owner allows runs: a deletion allowed for this agent is not asked', async () => {
    await forgetWrites();

    const allowed = await run(
      'rm -rf ./build',
      gate({ ...DEFAULT_SHELL_POLICY, delete_files: 'allow' }),
    );
    const asked = await run('rm -rf ./build', gate(DEFAULT_SHELL_POLICY));

    expect(allowed.outcome).toBe('success');
    expect(asked.outcome).toBe('awaiting_approval');
  });

  it('without a checklist (a replay a human approved), the command is not judged again', async () => {
    await forgetWrites();
    const humanApproved: ApprovalRule = {
      id: 'resume-bypass',
      toolName: 'run_command',
      action: 'auto_approve',
      agentId: null,
      entityId: seed.entityId,
    };

    const res = await run(`type "${outsideFile()}"`, gate(undefined, [humanApproved]));

    expect(res.outcome).toBe('success');
  });

  it('a declared proof is judged the same way: its commands will run unasked later', async () => {
    await forgetWrites();
    const declare: ToolDefinition<z.ZodTypeAny, string> = {
      name: 'declare_verification',
      description: 'declare how a project is proven',
      inputSchema: z.object({
        project_path: z.string(),
        commands: z.array(z.object({ command: z.string() })),
        purpose: z.string(),
      }),
      riskLevel: 'write',
      execute: async () => 'declared',
    };

    const res = await executeTool(
      declare,
      {
        project_path: 'excel',
        commands: [{ command: `type "${outsideFile()}"` }],
        purpose: 'Declare the proof.',
      },
      ctx(),
      gate({ ...DEFAULT_SHELL_POLICY, outside_folders: 'never' }),
    );

    expect(res.outcome).toBe('error');
  });
});
