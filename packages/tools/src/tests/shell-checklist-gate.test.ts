// shell-checklist-gate.test.ts — the autonomy checklist at the approval gate (#464).
//
// Run 06a949cb → b4b493e8 (23/09): workspace at `destructive_gate`, no rule on
// `run_command`, the agent wrote `shared/scripts/_analyze_gains_file.py` and ran
// it on four files in Downloads and Documents. It ran: nobody was asked. This
// file replays that shape on the REAL gate (`executeTool`), with real folders
// on disk (the "outside" check is the file tools' own resolver) and the real
// database (the approval row and its reasons are read back).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { eq } from '@nodal-agents/db';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, approvalRequests, toolCalls } from '@nodal-agents/db';
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
  // A link INSIDE the agent's folder that leads outside it (a junction on
  // Windows needs no privilege).
  await symlink(outside, join(folder, 'downloads-link'), 'junction');
  // The job began AFTER these files existed: they are not the agent's.
  await setJobStart(new Date(Date.now() + 5_000));
});

async function setJobStart(at: Date): Promise<void> {
  await db.update(agentJobs).set({ createdAt: at }).where(eq(agentJobs.id, seed.jobId));
}

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

  it('a plain relative path through a link inside the folder is judged where it leads (Codex, P1)', async () => {
    await forgetWrites();

    const res = await run(
      'type "downloads-link/earnings_2026_statement.csv"',
      gate({ ...DEFAULT_SHELL_POLICY, outside_folders: 'never' }),
    );

    expect(res.outcome).toBe('error');
    if (res.outcome !== 'error') throw new Error('unreachable');
    expect(res.error).toContain('downloads-link/earnings_2026_statement.csv');
  });

  it("a write that failed does not make a script the agent's own (Codex, P2)", async () => {
    await forgetWrites();
    await db.insert(toolCalls).values({
      entityId: seed.entityId,
      jobId: seed.jobId,
      toolName: 'file_edit',
      toolInput: { path: 'shared/scripts/_analyze_gains_file.py', old: 'x', new: 'y' },
      toolOutput: JSON.stringify({ outcome: 'error', error: 'match_not_found' }),
      durationMs: 1,
    });

    const res = await run(
      `python "${script()}"`,
      gate({ ...DEFAULT_SHELL_POLICY, own_script: 'never' }),
    );

    expect(res.outcome).toBe('success');
  });

  it('a script made by the shell during the run is its own too (Codex pass 2, P1)', async () => {
    await forgetWrites();
    const never = gate({ ...DEFAULT_SHELL_POLICY, own_script: 'never' });

    // Created and run in the same command: it does not exist yet.
    const sameCommand = await run('printf "print(1)" > fresh.py && python fresh.py', never);
    // Written by an earlier command of this run: changed after the job began.
    await setJobStart(new Date(Date.now() - 60_000));
    await writeFile(join(folder, 'made-by-shell.py'), 'print(2)\n');
    const earlierCommand = await run('python made-by-shell.py', never);
    await setJobStart(new Date(Date.now() + 5_000));

    expect(sameCommand.outcome).toBe('error');
    expect(earlierCommand.outcome).toBe('error');
  });

  it('a path built by the shell is judged outside: nobody checked where it leads (Codex pass 2, P1)', async () => {
    await forgetWrites();

    const res = await run(
      'cat "${SECRET_DIR}/id_rsa"',
      gate({ ...DEFAULT_SHELL_POLICY, outside_folders: 'never' }),
    );

    expect(res.outcome).toBe('error');
    if (res.outcome !== 'error') throw new Error('unreachable');
    expect(res.error).toContain('${SECRET_DIR}/id_rsa');
  });

  it('a split command word is read as the program it runs (Codex pass 2, P1)', async () => {
    await forgetWrites();

    const res = await run(
      'r""m -rf ./build',
      gate({ ...DEFAULT_SHELL_POLICY, delete_files: 'never' }),
    );

    expect(res.outcome).toBe('error');
  });

  it('an unquoted glob is judged outside: it may reach a link that leads out (Codex pass 3, P1)', async () => {
    await forgetWrites();

    const res = await run('type d*', gate({ ...DEFAULT_SHELL_POLICY, outside_folders: 'never' }));

    expect(res.outcome).toBe('error');
  });

  it('inline code counts as leaving the folders when that is restricted (Codex pass 3, P1)', async () => {
    await forgetWrites();

    const res = await run(
      `python -c "print(open('/etc/passwd').read())"`,
      gate({ ...DEFAULT_SHELL_POLICY, own_script: 'allow', outside_folders: 'never' }),
    );

    expect(res.outcome).toBe('error');
    if (res.outcome !== 'error') throw new Error('unreachable');
    expect(res.error).toContain('read or change files outside its folders');
  });

  it('a script without extension, run by its path, is judged like any script (Codex pass 3, P1)', async () => {
    await forgetWrites();
    await setJobStart(new Date(Date.now() - 60_000));
    await writeFile(join(folder, 'build'), '#!/bin/sh\necho hi\n');
    const res = await run('./build', gate({ ...DEFAULT_SHELL_POLICY, own_script: 'never' }));
    await setJobStart(new Date(Date.now() + 5_000));

    expect(res.outcome).toBe('error');
  });

  it("a path written INSIDE the agent's own script is judged too (Quentin's test, 24/09, run ae424ac0)", async () => {
    await forgetWrites();
    // The run of 24/09: the command names no path, the script does.
    const inspect = join(shared, 'scripts', '_inspect_exports_generation.py');
    await writeFile(inspect, `PATH = r"${outsideFile().replace(/\\/g, '/')}"\nprint(PATH)\n`);
    await db.insert(toolCalls).values({
      entityId: seed.entityId,
      jobId: seed.jobId,
      toolName: 'file_write',
      toolInput: { path: 'shared/scripts/_inspect_exports_generation.py', content: '…' },
      toolOutput: '{"ok":true}',
      durationMs: 1,
    });
    const command = 'python shared/scripts/_inspect_exports_generation.py';

    const asked = await run(command, gate(DEFAULT_SHELL_POLICY));
    const refused = await run(command, gate({ ...DEFAULT_SHELL_POLICY, outside_folders: 'never' }));

    expect(asked.outcome).toBe('awaiting_approval');
    if (asked.outcome !== 'awaiting_approval') throw new Error('unreachable');
    expect(await reasonsOf(asked.approvalRequestId)).toEqual([
      {
        category: 'own_script',
        state: 'ask',
        details: ['shared/scripts/_inspect_exports_generation.py'],
      },
      {
        category: 'outside_folders',
        state: 'ask',
        details: [
          `${outsideFile().replace(/\\/g, '/')} (in shared/scripts/_inspect_exports_generation.py)`,
        ],
      },
    ]);
    expect(refused.outcome).toBe('error');
  });

  it('an OLD script that names a path outside is judged too, whoever wrote it (run 2fb6bfca, 24/09)', async () => {
    await forgetWrites();
    // Written by an earlier run: older than this job, no file_write here.
    const old = join(shared, 'scripts', '_inspect_old.py');
    await writeFile(old, `PATH = r"${outsideFile().replace(/\\/g, '/')}"\n`);

    const res = await run(
      'python shared/scripts/_inspect_old.py',
      gate({ ...DEFAULT_SHELL_POLICY, outside_folders: 'never' }),
    );

    expect(res.outcome).toBe('error');
    if (res.outcome !== 'error') throw new Error('unreachable');
    expect(res.error).toContain('(in shared/scripts/_inspect_old.py)');
  });

  it('a script that is not there, and that the command does not create, is not "its own" (run 2fb6bfca)', async () => {
    await forgetWrites();

    // Named once, nowhere on disk: python will fail, there is nothing to ask.
    const res = await run('python "_nowhere.py"', gate(DEFAULT_SHELL_POLICY));

    expect(res.outcome).toBe('success');
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

  // ── Review of PR #474 (Reviewer A) ─────────────────────────────────────────

  it('a script the command creates under another spelling is still its own (P1)', async () => {
    await forgetWrites();
    const res = await run(
      'printf "print(1)" > t474.py && python ./t474.py',
      gate({ ...DEFAULT_SHELL_POLICY, own_script: 'never', outside_folders: 'allow' }),
    );
    expect(res.outcome).toBe('error');
    if (res.outcome !== 'error') throw new Error('unreachable');
    expect(res.error).toContain('run code it wrote itself');
  });

  it('what a script does through its interpreter API is judged, whoever wrote it (P1)', async () => {
    await forgetWrites();
    await writeFile(join(folder, 'cleanup474.py'), "import shutil\nshutil.rmtree('build')\n");
    const res = await run(
      'python cleanup474.py',
      gate({
        ...DEFAULT_SHELL_POLICY,
        delete_files: 'never',
        own_script: 'allow',
        outside_folders: 'allow',
      }),
    );
    expect(res.outcome).toBe('error');
    if (res.outcome !== 'error') throw new Error('unreachable');
    expect(res.error).toContain('delete files or discard work (cleanup474.py)');
  });

  it('a migrated Yolo agent is not stopped by inline code that stays inside (P2)', async () => {
    await forgetWrites();
    const yolo: ApprovalRule = {
      id: 'yolo474',
      toolName: 'run_command',
      action: 'auto_approve',
      agentId: seed.agentId,
      entityId: seed.entityId,
    };
    // What migration 0125 gives a Yolo agent: everything allowed but leaving
    // its folders, which asks.
    const migrated: ShellPolicy = {
      outside_folders: 'ask',
      own_script: 'allow',
      delete_files: 'allow',
      install_software: 'allow',
      download: 'allow',
      stop_programs: 'allow',
      system_settings: 'allow',
    };
    const res = await run(
      `node -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf8')))"`,
      gate(migrated, [yolo]),
    );
    expect(res.outcome).toBe('success');
  });

  it('a mention of rm in a commit message does not refuse the commit (P1, false red)', async () => {
    await forgetWrites();
    const res = await run(
      'git commit -m "rm old refs"',
      gate({ ...DEFAULT_SHELL_POLICY, delete_files: 'never', outside_folders: 'allow' }),
    );
    expect(res.outcome).not.toBe('error');
  });
});
